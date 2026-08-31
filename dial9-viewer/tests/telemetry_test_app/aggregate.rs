use super::expectations::{FixtureFeature, FunctionSymbol, SpanName};
use super::local_js::{Observations, ObservedSpan, ObservedSpanAssociation, ObservedStack};
use anyhow::{Context as _, Result, ensure};
use arrow::array::{
    Array as _, FixedSizeBinaryArray, ListArray, MapArray, StringArray, StructArray, UInt8Array,
};
use dial9_viewer::ingest::TelemetryTestParquetParts;
use parquet::arrow::arrow_reader::ParquetRecordBatchReader;
use std::collections::{BTreeMap, BTreeSet, HashMap};

type StackId = [u8; 16];

pub(crate) fn observe_aggregate_trace(segments: &[Vec<u8>]) -> Result<Observations> {
    let parts = segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            dial9_viewer::ingest::telemetry_test_decode_parquet(
                segment,
                &format!("fixture-segment-{index}.bin"),
            )
            .with_context(|| format!("aggregate fixture segment {index}"))
        })
        .collect::<Result<Vec<_>>>()?;
    observations_from_parquet(&parts)
}

fn observations_from_parquet(parts: &[TelemetryTestParquetParts]) -> Result<Observations> {
    let stacks = read_stack_dictionary(parts)?;
    let spans = read_spans(parts)?;
    let span_names: HashMap<_, _> = spans
        .iter()
        .map(|span| (span.uid, span.name.clone()))
        .collect();
    let measured_span_names: BTreeSet<_> = spans.iter().map(|span| span.name.clone()).collect();
    let mut stack_counts = BTreeMap::new();
    let mut associations = BTreeSet::new();

    for part in parts {
        read_sample_stacks(
            &part.samples,
            &stacks,
            &span_names,
            &mut stack_counts,
            &mut associations,
        )?;
        read_task_dump_stacks(
            &part.task_dumps,
            &stacks,
            &measured_span_names,
            &mut stack_counts,
            &mut associations,
        )?;
    }

    Ok(Observations {
        stacks: stack_counts
            .into_iter()
            .map(|((feature, frames), count)| ObservedStack {
                feature,
                frames,
                count,
            })
            .collect(),
        spans: spans
            .iter()
            .filter(|span| span.name.as_str().starts_with("dial9_fixture_span_"))
            .map(|span| ObservedSpan {
                name: span.name.clone(),
                parent: span.parent.and_then(|uid| span_names.get(&uid).cloned()),
                field_names: span.field_names.clone(),
            })
            .collect(),
        associations: associations
            .into_iter()
            .map(|(feature, symbol, active_span)| ObservedSpanAssociation {
                feature,
                symbol,
                active_span,
            })
            .collect(),
    })
}

fn read_stack_dictionary(
    parts: &[TelemetryTestParquetParts],
) -> Result<HashMap<StackId, Vec<String>>> {
    let mut stacks = HashMap::new();
    for part in parts {
        for batch in read_batches(&part.stacks)? {
            let ids = column::<FixedSizeBinaryArray>(&batch, "stack_id")?;
            let frames = column::<ListArray>(&batch, "frames")?;
            for row in 0..batch.num_rows() {
                let id = stack_id(ids.value(row))?;
                let values = frames.value(row);
                let values = values
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .context("frames items must be strings")?;
                stacks.insert(id, values.iter().flatten().map(ToOwned::to_owned).collect());
            }
        }
    }
    Ok(stacks)
}

#[derive(Clone)]
struct AggregateSpan {
    uid: StackId,
    name: SpanName,
    parent: Option<StackId>,
    field_names: Vec<String>,
}

fn read_spans(parts: &[TelemetryTestParquetParts]) -> Result<Vec<AggregateSpan>> {
    let mut spans = Vec::new();
    for part in parts {
        for batch in read_batches(&part.spans)? {
            let uids = column::<FixedSizeBinaryArray>(&batch, "span_uid")?;
            let names = column::<StringArray>(&batch, "name")?;
            let parents = column::<FixedSizeBinaryArray>(&batch, "parent_span_uid")?;
            let attributes = column::<MapArray>(&batch, "attributes")?;
            for row in 0..batch.num_rows() {
                let entries = attributes.value(row);
                let entries = entries
                    .as_any()
                    .downcast_ref::<StructArray>()
                    .context("span attributes must contain struct entries")?;
                let keys = entries
                    .column(0)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .context("span attribute keys must be strings")?;
                spans.push(AggregateSpan {
                    uid: stack_id(uids.value(row))?,
                    name: SpanName::new(names.value(row)),
                    parent: (!parents.is_null(row))
                        .then(|| stack_id(parents.value(row)))
                        .transpose()?,
                    field_names: keys.iter().flatten().map(ToOwned::to_owned).collect(),
                });
            }
        }
    }
    Ok(spans)
}

fn read_sample_stacks(
    parquet: &[u8],
    stacks: &HashMap<StackId, Vec<String>>,
    span_names: &HashMap<StackId, SpanName>,
    counts: &mut BTreeMap<(FixtureFeature, Vec<FunctionSymbol>), u64>,
    associations: &mut BTreeSet<(FixtureFeature, FunctionSymbol, SpanName)>,
) -> Result<()> {
    for batch in read_batches(parquet)? {
        let ids = column::<FixedSizeBinaryArray>(&batch, "stack_id")?;
        let sources = column::<UInt8Array>(&batch, "source")?;
        let enclosing = column::<ListArray>(&batch, "enclosing_spans")?;
        for row in 0..batch.num_rows() {
            if sources.value(row) != 0 {
                continue;
            }
            let frames = fixture_frames(stack_for(stacks, ids.value(row))?);
            if frames.is_empty() {
                continue;
            }
            *counts
                .entry((FixtureFeature::Cpu, frames.clone()))
                .or_default() += 1;

            let values = enclosing.value(row);
            let values = values
                .as_any()
                .downcast_ref::<StructArray>()
                .context("enclosing_spans items must be structs")?;
            let span_uids = values
                .column(0)
                .as_any()
                .downcast_ref::<FixedSizeBinaryArray>()
                .context("enclosing span ids must be fixed-size binary")?;
            for span_uid in span_uids.iter().flatten() {
                if let Some(span_name) = span_names.get(&stack_id(span_uid)?) {
                    add_associations(associations, FixtureFeature::Cpu, &frames, span_name);
                }
            }
        }
    }
    Ok(())
}

fn read_task_dump_stacks(
    parquet: &[u8],
    stacks: &HashMap<StackId, Vec<String>>,
    span_names: &BTreeSet<SpanName>,
    counts: &mut BTreeMap<(FixtureFeature, Vec<FunctionSymbol>), u64>,
    associations: &mut BTreeSet<(FixtureFeature, FunctionSymbol, SpanName)>,
) -> Result<()> {
    for batch in read_batches(parquet)? {
        let ids = column::<FixedSizeBinaryArray>(&batch, "stack_id")?;
        for row in 0..batch.num_rows() {
            let frames = fixture_frames(stack_for(stacks, ids.value(row))?);
            if frames.is_empty() {
                continue;
            }
            *counts
                .entry((FixtureFeature::TaskDump, frames.clone()))
                .or_default() += 1;
            if let Some(span_name) = fixture_span_for_stack(&frames, span_names) {
                add_associations(associations, FixtureFeature::TaskDump, &frames, &span_name);
            }
        }
    }
    Ok(())
}

fn fixture_frames(raw_frames: &[String]) -> Vec<FunctionSymbol> {
    // The dictionary flattens inline symbols in wire order. The fixture's
    // mixed functions are callers and its weighted functions are leaves.
    let mut mixed = Vec::new();
    let mut weighted = Vec::new();
    for raw in raw_frames.iter().rev() {
        let mut offset = 0;
        while let Some(index) = raw[offset..].find("dial9_fixture_") {
            let start = offset + index;
            let end = raw[start..]
                .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .map_or(raw.len(), |length| start + length);
            let symbol = &raw[start..end];
            let destination = if symbol.starts_with("dial9_fixture_mixed_") {
                Some(&mut mixed)
            } else if symbol.starts_with("dial9_fixture_cpu_")
                || symbol.starts_with("dial9_fixture_wait_")
            {
                Some(&mut weighted)
            } else {
                None
            };
            if let Some(destination) = destination
                && !destination
                    .iter()
                    .any(|previous: &FunctionSymbol| previous.as_str() == symbol)
            {
                destination.push(FunctionSymbol::new(symbol));
            }
            offset = end;
        }
    }
    mixed.extend(weighted);
    mixed
}

fn fixture_span_for_stack(
    frames: &[FunctionSymbol],
    span_names: &BTreeSet<SpanName>,
) -> Option<SpanName> {
    frames.iter().rev().find_map(|frame| {
        frame
            .as_str()
            .strip_prefix("dial9_fixture_mixed_")
            .map(|suffix| SpanName::new(format!("dial9_fixture_span_{suffix}")))
            .filter(|span| span_names.contains(span))
    })
}

fn add_associations(
    associations: &mut BTreeSet<(FixtureFeature, FunctionSymbol, SpanName)>,
    feature: FixtureFeature,
    frames: &[FunctionSymbol],
    span_name: &SpanName,
) {
    for frame in frames {
        if frame.as_str().starts_with("dial9_fixture_cpu_")
            || frame.as_str().starts_with("dial9_fixture_wait_")
        {
            associations.insert((feature, frame.clone(), span_name.clone()));
        }
    }
}

fn stack_for<'a>(
    stacks: &'a HashMap<StackId, Vec<String>>,
    encoded: &[u8],
) -> Result<&'a [String]> {
    let id = stack_id(encoded)?;
    stacks
        .get(&id)
        .map(Vec::as_slice)
        .with_context(|| format!("stack dictionary is missing id {}", hex::encode(id)))
}

fn stack_id(bytes: &[u8]) -> Result<StackId> {
    ensure!(
        bytes.len() == 16,
        "expected 16-byte id, got {}",
        bytes.len()
    );
    let mut id = [0; 16];
    id.copy_from_slice(bytes);
    Ok(id)
}

fn read_batches(bytes: &[u8]) -> Result<Vec<arrow::record_batch::RecordBatch>> {
    ParquetRecordBatchReader::try_new(bytes::Bytes::copy_from_slice(bytes), 4096)?
        .collect::<Result<Vec<_>, _>>()
        .context("read aggregate Parquet")
}

fn column<'a, T: 'static>(
    batch: &'a arrow::record_batch::RecordBatch,
    name: &str,
) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .with_context(|| format!("Parquet batch is missing {name:?}"))?
        .as_any()
        .downcast_ref::<T>()
        .with_context(|| format!("Parquet column {name:?} has the wrong Arrow type"))
}
