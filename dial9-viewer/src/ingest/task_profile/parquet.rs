use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use arrow::array::{
    Array, ArrayRef, Float64Array, ListArray, ListBuilder, StringArray, StringBuilder, UInt8Array,
    UInt32Array, UInt64Array,
};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::{ArrowWriter, arrow_reader::ParquetRecordBatchReaderBuilder};
use parquet::file::properties::WriterProperties;
use parquet::format::KeyValue;

use super::{Frame, Kind, Row, Segment, Stack};
use crate::ingest::decode::clock::ClockOffset;

const METADATA_KEY: &str = "dial9.task_profile";

pub(crate) fn write(segment: &Segment) -> anyhow::Result<Vec<u8>> {
    let list_type = DataType::List(Arc::new(Field::new("item", DataType::Utf8, true)));
    let schema = Arc::new(Schema::new(vec![
        Field::new("kind", DataType::UInt8, false),
        Field::new("timestamp_ns", DataType::UInt64, false),
        Field::new("task_id", DataType::UInt64, true),
        Field::new("worker_id", DataType::UInt64, true),
        Field::new("tid", DataType::UInt32, true),
        Field::new("probability", DataType::Float64, true),
        Field::new("frames", list_type.clone(), false),
        Field::new("files", list_type, false),
    ]));
    let header = serde_json::to_string(&(
        &segment.recording_id,
        segment.clock_offset.map(|offset| offset.0.to_string()),
        &segment.metadata,
    ))?;
    let props = WriterProperties::builder()
        .set_compression(parquet::basic::Compression::SNAPPY)
        .set_key_value_metadata(Some(vec![KeyValue::new(METADATA_KEY.into(), header)]))
        .build();
    let mut writer = ArrowWriter::try_new(Vec::new(), schema.clone(), Some(props))?;
    for rows in segment.rows.chunks(1024) {
        let mut frames = ListBuilder::new(StringBuilder::new());
        let mut files = ListBuilder::new(StringBuilder::new());
        for row in rows {
            for frame in row.stack.iter() {
                frames.values().append_value(&frame.name);
                files.values().append_option(frame.file.as_deref());
            }
            frames.append(true);
            files.append(true);
        }
        let arrays: Vec<ArrayRef> = vec![
            Arc::new(UInt8Array::from_iter_values(
                rows.iter().map(|r| r.kind as u8),
            )),
            Arc::new(UInt64Array::from_iter_values(
                rows.iter().map(|r| r.timestamp_ns),
            )),
            Arc::new(UInt64Array::from_iter(rows.iter().map(|r| r.task_id))),
            Arc::new(UInt64Array::from_iter(rows.iter().map(|r| r.worker_id))),
            Arc::new(UInt32Array::from_iter(rows.iter().map(|r| r.tid))),
            Arc::new(Float64Array::from_iter(rows.iter().map(|r| r.probability))),
            Arc::new(frames.finish()),
            Arc::new(files.finish()),
        ];
        writer.write(&RecordBatch::try_new(schema.clone(), arrays)?)?;
    }
    Ok(writer.into_inner()?)
}

fn column<'a, T: 'static>(batch: &'a RecordBatch, name: &str) -> anyhow::Result<&'a T> {
    batch
        .column_by_name(name)
        .and_then(|column| column.as_any().downcast_ref())
        .with_context(|| format!("missing or invalid task profile column {name}"))
}

pub(crate) fn read(bytes: Bytes) -> anyhow::Result<Segment> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)?;
    let header = builder
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .and_then(|entries| entries.iter().find(|entry| entry.key == METADATA_KEY))
        .and_then(|entry| entry.value.as_deref())
        .context("missing task profile metadata")?;
    let (recording_id, offset, metadata): (String, Option<String>, _) =
        serde_json::from_str(header)?;
    let mut segment = Segment {
        recording_id,
        clock_offset: offset.map(|s| s.parse().map(ClockOffset)).transpose()?,
        metadata,
        rows: Vec::new(),
    };
    let mut stacks = HashMap::<Vec<Frame>, Stack>::new();
    for batch in builder.build()? {
        let batch = batch?;
        let kinds = column::<UInt8Array>(&batch, "kind")?;
        let timestamps = column::<UInt64Array>(&batch, "timestamp_ns")?;
        let tasks = column::<UInt64Array>(&batch, "task_id")?;
        let workers = column::<UInt64Array>(&batch, "worker_id")?;
        let tids = column::<UInt32Array>(&batch, "tid")?;
        let probabilities = column::<Float64Array>(&batch, "probability")?;
        let frames = column::<ListArray>(&batch, "frames")?;
        let files = column::<ListArray>(&batch, "files")?;
        for i in 0..batch.num_rows() {
            let frame_values = frames.value(i);
            let file_values = files.value(i);
            let names = frame_values
                .as_any()
                .downcast_ref::<StringArray>()
                .context("invalid frame names")?;
            let files = file_values
                .as_any()
                .downcast_ref::<StringArray>()
                .context("invalid frame files")?;
            anyhow::ensure!(names.len() == files.len(), "mismatched frame provenance");
            let stack: Vec<_> = (0..names.len())
                .map(|j| Frame {
                    name: names.value(j).to_string(),
                    file: (!files.is_null(j)).then(|| files.value(j).to_string()),
                })
                .collect();
            let stack = Arc::clone(stacks.entry(stack.clone()).or_insert_with(|| stack.into()));
            segment.rows.push(Row {
                kind: Kind::try_from(kinds.value(i))?,
                timestamp_ns: timestamps.value(i),
                task_id: (!tasks.is_null(i)).then(|| tasks.value(i)),
                worker_id: (!workers.is_null(i)).then(|| workers.value(i)),
                tid: (!tids.is_null(i)).then(|| tids.value(i)),
                probability: (!probabilities.is_null(i)).then(|| probabilities.value(i)),
                stack,
            });
        }
    }
    Ok(segment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_retains_probability_provenance_and_identity() {
        let input = Segment {
            recording_id: "process-a".into(),
            clock_offset: Some(ClockOffset(-42)),
            metadata: [("cpu.profile.frequency_hz".into(), "99".into())].into(),
            rows: vec![Row {
                kind: Kind::Capture,
                timestamp_ns: 123,
                task_id: Some(7),
                worker_id: None,
                tid: None,
                probability: Some(0.25),
                stack: vec![
                    Frame {
                        name: "root".into(),
                        file: None,
                    },
                    Frame {
                        name: "work".into(),
                        file: Some("src/main.rs".into()),
                    },
                ]
                .into(),
            }],
        };
        let output = read(write(&input).unwrap().into()).unwrap();
        assert_eq!(output.recording_id, input.recording_id);
        assert_eq!(output.clock_offset, input.clock_offset);
        assert_eq!(output.metadata, input.metadata);
        assert_eq!(output.rows[0].stack, input.rows[0].stack);
        assert_eq!(output.rows[0].probability, Some(0.25));
        assert_eq!(output.rows[0].task_id, Some(7));
        assert_eq!(output.rows[0].worker_id, None);
    }
}
