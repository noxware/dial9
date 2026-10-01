//! Check span facts persisted by the HTTP aggregation path, without re-decoding
//! events or reimplementing span attribution in the test.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result, ensure};
use arrow::{
    array::{
        Array, FixedSizeBinaryArray, Int64Array, ListArray, MapArray, StringArray, StructArray,
        UInt8Array, UInt64Array,
    },
    record_batch::RecordBatch,
};
use dial9_viewer::storage::StorageBackend;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

use super::expectations::{ExpectedModel, FixtureFeature};

struct Span {
    name: String,
    parent: Option<Vec<u8>>,
    start: i64,
    end: i64,
    fields: Vec<String>,
}

fn column<'a, T: 'static>(batch: &'a RecordBatch, name: &str) -> &'a T {
    batch
        .column_by_name(name)
        .expect("persisted column")
        .as_any()
        .downcast_ref()
        .expect("persisted column type")
}

fn strings(list: &ListArray, row: usize) -> Vec<String> {
    let values = list.value(row);
    values
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("string list")
        .iter()
        .map(|s| s.expect("non-null frame").to_owned())
        .collect()
}

pub(super) async fn check(
    output: &dyn StorageBackend,
    expected: &ExpectedModel,
    clock_offset: i128,
) -> Result<()> {
    let start = i64::try_from(expected.measurement.start_ns as i128 + clock_offset)?;
    let end = i64::try_from(expected.measurement.end_ns as i128 + clock_offset)?;
    let keys = output.list_objects_all("fixture", "aggregate/").await?;
    let mut tables = Vec::new();
    for object in keys {
        if !object.key.ends_with(".parquet") {
            continue;
        }
        let bytes = output.get_object("fixture", &object.key).await?;
        for batch in ParquetRecordBatchReaderBuilder::try_new(bytes::Bytes::from(bytes))?.build()? {
            tables.push((object.key.clone(), batch?));
        }
    }
    let mut spans = BTreeMap::new();
    let mut stacks = BTreeMap::new();
    for (key, batch) in &tables {
        if key.contains("/spans/") {
            let ids = column::<FixedSizeBinaryArray>(batch, "span_uid");
            let parents = column::<FixedSizeBinaryArray>(batch, "parent_span_uid");
            let names = column::<StringArray>(batch, "name");
            let starts = column::<Int64Array>(batch, "start_ns");
            let ends = column::<Int64Array>(batch, "end_ns");
            let attributes = column::<MapArray>(batch, "attributes");
            for i in 0..batch.num_rows() {
                let attrs = attributes.value(i);
                let fields = attrs
                    .column(0)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .context("span attribute keys")?
                    .iter()
                    .map(|s| s.expect("attribute key").to_owned())
                    .collect();
                spans.insert(
                    ids.value(i).to_vec(),
                    Span {
                        name: names.value(i).into(),
                        parent: (!parents.is_null(i)).then(|| parents.value(i).to_vec()),
                        start: starts.value(i),
                        end: ends.value(i),
                        fields,
                    },
                );
            }
        } else if key.contains("/dict/stacks/") {
            let ids = column::<FixedSizeBinaryArray>(batch, "stack_id");
            let frames = column::<ListArray>(batch, "frames");
            for i in 0..batch.num_rows() {
                stacks.insert(ids.value(i).to_vec(), strings(frames, i));
            }
        }
    }
    let measured = |span: &&Span| span.start >= start && span.end <= end;
    for name in &expected.spans {
        ensure!(
            spans
                .values()
                .filter(measured)
                .any(|s| s.name == name.as_str()),
            "Rust aggregate omitted span {}",
            name.as_str()
        );
    }
    for edge in &expected.span_edges {
        ensure!(
            spans
                .values()
                .filter(measured)
                .any(|s| s.name == edge.child.as_str()
                    && s.parent
                        .as_ref()
                        .and_then(|id| spans.get(id))
                        .is_some_and(|p| p.name == edge.parent.as_str())),
            "Rust aggregate omitted span edge {} -> {}",
            edge.parent.as_str(),
            edge.child.as_str()
        );
    }
    for span in spans
        .values()
        .filter(measured)
        .filter(|s| s.name == "dial9_fixture_span_cycle")
    {
        ensure!(
            span.fields.iter().any(|f| f == "cycle"),
            "Rust aggregate lost cycle field"
        );
    }

    let mut associations = std::collections::BTreeSet::new();
    let mut observe = |feature, frames: &[String], span: &Span| {
        for symbol in expected.symbols.iter().filter(|s| s.feature == feature) {
            if frames.iter().any(|f| f.contains(symbol.symbol.as_str())) {
                associations.insert((
                    feature,
                    symbol.symbol.as_str().to_owned(),
                    span.name.clone(),
                ));
            }
        }
    };
    for (key, batch) in &tables {
        if key.contains("/samples/") {
            let ts = column::<Int64Array>(batch, "timestamp_ns");
            let source = column::<UInt8Array>(batch, "source");
            let ids = column::<FixedSizeBinaryArray>(batch, "stack_id");
            let enclosing = column::<ListArray>(batch, "enclosing_spans");
            for i in 0..batch.num_rows() {
                if source.value(i) != 0 || ts.value(i) < start || ts.value(i) >= end {
                    continue;
                }
                let members = enclosing.value(i);
                let members = members
                    .as_any()
                    .downcast_ref::<StructArray>()
                    .context("span memberships")?;
                let uids = members
                    .column_by_name("span_uid")
                    .context("span UID")?
                    .as_any()
                    .downcast_ref::<FixedSizeBinaryArray>()
                    .context("span UID type")?;
                if let Some(span) = (0..uids.len())
                    .filter_map(|j| spans.get(uids.value(j)))
                    .min_by_key(|s| s.end - s.start)
                {
                    observe(
                        FixtureFeature::Cpu,
                        stacks.get(ids.value(i)).context("sample stack")?,
                        span,
                    );
                }
            }
        } else if key.contains("/task-profiles/") {
            let kind = column::<UInt8Array>(batch, "kind");
            let ts = column::<UInt64Array>(batch, "timestamp_ns");
            let frames = column::<ListArray>(batch, "frames");
            for i in 0..batch.num_rows() {
                if kind.value(i) != 1 {
                    continue;
                } // Capture row.
                let ts = i64::try_from(ts.value(i) as i128 + clock_offset)?;
                if ts < start || ts >= end {
                    continue;
                }
                // The fixture has one sampled task and strictly nested spans.
                // Capture occurs before advancing its suspended await.
                if let Some(span) = spans
                    .values()
                    .filter(|s| s.start <= ts && ts <= s.end)
                    .min_by_key(|s| s.end - s.start)
                {
                    observe(FixtureFeature::TaskDump, &strings(frames, i), span);
                }
            }
        }
    }
    for association in &expected.span_associations {
        let symbol = expected
            .symbols
            .iter()
            .find(|s| s.symbol == association.symbol)
            .context("declared association symbol")?;
        ensure!(
            associations.contains(&(
                symbol.feature,
                association.symbol.as_str().into(),
                association.active_span.as_str().into()
            )),
            "Rust aggregate did not associate {} with {}",
            association.symbol.as_str(),
            association.active_span.as_str()
        );
    }
    Ok(())
}
