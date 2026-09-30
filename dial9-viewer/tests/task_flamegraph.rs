use std::sync::Arc;

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use dial9_trace_format::{
    encoder::Encoder,
    schema::FieldDef,
    types::{FieldType, FieldValue},
};
use dial9_viewer::{
    ingest::aggregate::AggContext,
    server::{AppState, router},
    storage::{LocalBackend, StorageBackend},
};
use serde_json::Value;
use tower::ServiceExt;

fn segment(second: bool, sampled: bool) -> Vec<u8> {
    let mut encoder = Encoder::new();
    let clock = encoder
        .register_schema(
            "ClockSyncEvent",
            vec![FieldDef::new("realtime_ns", FieldType::Varint)],
        )
        .unwrap();
    encoder
        .write_event(&clock, 1, &[FieldValue::Varint(10_001)])
        .unwrap();
    let metadata = encoder
        .register_schema(
            "SegmentMetadataEvent",
            vec![FieldDef::new("entries", FieldType::StringMap)],
        )
        .unwrap();
    let mut entries = vec![
        ("boot_id", "process-a"),
        ("cpu.profile.frequency_hz", "100000000"),
    ];
    if sampled {
        entries.extend([
            ("task_sampling.sampler", "per_worker_bernoulli_v1"),
            ("task_sampling.worker.0.sampling_started_at_ns", "50"),
        ]);
    }
    encoder
        .write_event(
            &metadata,
            1,
            &[FieldValue::StringMap(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
                    .collect(),
            )],
        )
        .unwrap();
    let symbol = encoder
        .register_schema(
            "SymbolTableEntry",
            vec![
                FieldDef::new("addr", FieldType::Varint),
                FieldDef::new("inline_depth", FieldType::Varint),
                FieldDef::new("symbol_name", FieldType::String),
                FieldDef::new("source_file", FieldType::String),
            ],
        )
        .unwrap();
    for (addr, name) in [
        (1, "service::root"),
        (2, "service::work"),
        (3, "tokio::time::sleep::Sleep"),
    ] {
        encoder
            .write_event(
                &symbol,
                1,
                &[
                    FieldValue::Varint(addr),
                    FieldValue::Varint(0),
                    FieldValue::String(name.into()),
                    FieldValue::String("src/main.rs".into()),
                ],
            )
            .unwrap();
    }
    let start = encoder
        .register_schema(
            "PollStartEvent",
            vec![
                FieldDef::new("worker_id", FieldType::Varint),
                FieldDef::new("task_id", FieldType::Varint),
            ],
        )
        .unwrap();
    let end = encoder
        .register_schema(
            "PollEndEvent",
            vec![FieldDef::new("worker_id", FieldType::Varint)],
        )
        .unwrap();
    if second {
        encoder
            .write_event(&end, 100, &[FieldValue::Varint(0)])
            .unwrap();
        encoder
            .write_event(&start, 200, &[FieldValue::Varint(0), FieldValue::Varint(7)])
            .unwrap();
        encoder
            .write_event(&end, 220, &[FieldValue::Varint(0)])
            .unwrap();
    } else {
        let park = encoder
            .register_schema(
                "WorkerUnparkEvent",
                vec![
                    FieldDef::new("worker_id", FieldType::Varint),
                    FieldDef::new("tid", FieldType::Varint),
                ],
            )
            .unwrap();
        encoder
            .write_event(&park, 2, &[FieldValue::Varint(0), FieldValue::Varint(42)])
            .unwrap();
        encoder
            .write_event(&start, 10, &[FieldValue::Varint(0), FieldValue::Varint(7)])
            .unwrap();
        let cpu = encoder
            .register_schema(
                "CpuSampleEvent",
                vec![
                    FieldDef::new("tid", FieldType::Varint),
                    FieldDef::new("source", FieldType::Varint),
                    FieldDef::new("callchain", FieldType::StackFrames),
                ],
            )
            .unwrap();
        encoder
            .write_event(
                &cpu,
                60,
                &[
                    FieldValue::Varint(42),
                    FieldValue::Varint(0),
                    FieldValue::StackFrames(vec![2, 1].into()),
                ],
            )
            .unwrap();
        let mut fields = vec![
            FieldDef::new("task_id", FieldType::Varint),
            FieldDef::new("callchain", FieldType::StackFrames),
        ];
        if sampled {
            fields.extend([
                FieldDef::new("inclusion_probability", FieldType::F64),
                FieldDef::new("idle_start_ns", FieldType::Varint),
                FieldDef::new("idle_end_ns", FieldType::Varint),
            ]);
        }
        let capture = encoder
            .register_schema(
                if sampled {
                    "TaskSampleEvent"
                } else {
                    "TaskDumpEvent"
                },
                fields,
            )
            .unwrap();
        for chain in [vec![2, 1], vec![3, 1]] {
            let mut values = vec![FieldValue::Varint(7), FieldValue::StackFrames(chain.into())];
            if sampled {
                values.extend([
                    FieldValue::F64(0.5),
                    FieldValue::Varint(100),
                    FieldValue::Varint(200),
                ]);
            }
            encoder.write_event(&capture, 210, &values).unwrap();
        }
    }
    encoder.finish()
}

async fn app(sampled: bool) -> (axum::Router, tempfile::TempDir, tempfile::TempDir) {
    let source_dir = tempfile::tempdir().unwrap();
    let output_dir = tempfile::tempdir().unwrap();
    let source = Arc::new(LocalBackend::new(source_dir.path()));
    let output = Arc::new(LocalBackend::new(output_dir.path()));
    for part in 0..2 {
        source
            .put_object(
                "local",
                &format!("custom/prefix/service/host/trace.{part}.bin"),
                segment(part == 1, sampled),
            )
            .await
            .unwrap();
    }
    let state = AppState::new(source.clone(), None, None).with_agg(AggContext {
        source,
        output,
        source_bucket: "local".into(),
        source_is_local: true,
        output_bucket: "local".into(),
        output_prefix: "aggregate".into(),
        source_prefixes: vec!["custom/".into()],
        segment_duration_secs: 60,
    });
    (router(state), source_dir, output_dir)
}

async fn get(app: axum::Router, uri: &str) -> String {
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = String::from_utf8(
        to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(status.is_success(), "{status}: {body}");
    body
}

#[tokio::test]
async fn mixed_api_reads_cross_segment_polls_and_reuses_parquet_without_changing_cpu_counts() {
    let (app, _source, _output) = app(true).await;
    let uri = "/api/task-flamegraph?task_id=7&start_ns=10000&end_ns=10230";
    let first: Value = serde_json::from_str(&get(app.clone(), uri).await).unwrap();
    assert_eq!(first["unavailable_reason"], Value::Null);
    assert_eq!(first["unit"], "nanoseconds");
    assert_eq!(first["files_folded"], 2);
    assert_eq!(first["cpu_ns"], 10.0);
    assert_eq!(first["idle_ns"], 200.0);
    assert_eq!(first["capture_groups"], 1);
    assert_eq!(first["tree"]["children"]["[idle-at-await]"]["children"]["service::root"]["children"]["service::work"]["alternatives"].as_array().unwrap().len(), 2);
    let cached: Value = serde_json::from_str(&get(app.clone(), uri).await).unwrap();
    assert_eq!(first, cached);
    let cpu = get(app, "/api/flamegraph").await;
    let snapshot: Value = serde_json::from_str(
        cpu.lines()
            .filter_map(|s| s.strip_prefix("data: "))
            .next_back()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["total_samples"], 1);
    assert_eq!(snapshot["tree"]["count"], 1);
}

#[tokio::test]
async fn legacy_dumps_never_acquire_a_default_probability() {
    let (app, _source, _output) = app(false).await;
    let profile: Value = serde_json::from_str(
        &get(
            app,
            "/api/task-flamegraph?task_id=7&start_ns=10000&end_ns=10230",
        )
        .await,
    )
    .unwrap();
    assert_eq!(profile["unavailable_reason"], "no_task_samples");
    assert_eq!(profile["tree"], Value::Null);
}
