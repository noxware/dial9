use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
};

use anyhow::{Context as _, Result, ensure};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use dial9_trace_format::decoder::Decoder;
use dial9_viewer::{
    ingest::aggregate::AggContext,
    server::{AppState, router},
    storage::LocalBackend,
};
use serde::Deserialize;
use tower::ServiceExt;

use super::expectations::{ExpectedModel, FixtureFeature};

// A coarse E2E bound allows Bernoulli/CPU sampling variance and timer/scheduler
// delay. Deterministic analysis tests check exact weights and clipping separately.
const RELATIVE_TOLERANCE: f64 = 0.35;

#[derive(Deserialize)]
struct ClockSync {
    timestamp_ns: u64,
    realtime_ns: u64,
}

#[derive(Deserialize)]
struct TaskSample {
    task_id: u64,
    inclusion_probability: f64,
}

#[derive(Debug, Deserialize)]
struct Node {
    name: String,
    self_ns: f64,
    children: BTreeMap<String, Node>,
}

#[derive(Debug, Deserialize)]
struct Profile {
    unit: String,
    cpu_samples: usize,
    capture_groups: usize,
    unavailable_reason: Option<String>,
    tree: Option<Node>,
}

pub(crate) async fn check(
    trace_dir: &Path,
    raw_segments: &[Vec<u8>],
    expected: &ExpectedModel,
    require_sampling: bool,
) -> Result<()> {
    let mut offset = None;
    let mut tasks = BTreeSet::new();
    let mut sampled = false;
    for bytes in raw_segments {
        let mut decoder = Decoder::new(bytes).context("invalid fixture trace")?;
        decoder.for_each_event(|event| match event.name {
            "ClockSyncEvent" => {
                let clock: ClockSync = event.deserialize().expect("fixture clock sync");
                offset.get_or_insert(clock.realtime_ns as i128 - clock.timestamp_ns as i128);
            }
            "TaskSampleEvent" => {
                let sample: TaskSample = event.deserialize().expect("fixture sample");
                tasks.insert(sample.task_id);
                sampled |= sample.inclusion_probability < 1.0;
            }
            _ => {}
        })?;
    }
    ensure!(
        tasks.len() == 1,
        "expected one sampled fixture task, got {tasks:?}"
    );
    ensure!(
        !require_sampling || sampled,
        "low-rate fixture never exercised p < 1"
    );
    let offset = offset.context("fixture has no clock sync")?;
    let start = u64::try_from(expected.measurement.start_ns as i128 + offset)?;
    let end = u64::try_from(expected.measurement.end_ns as i128 + offset)?;
    let source = Arc::new(LocalBackend::new(trace_dir));
    let output_dir = tempfile::tempdir()?;
    let output = Arc::new(LocalBackend::new(output_dir.path()));
    let state = AppState::new(source.clone(), None, None).with_agg(AggContext {
        source,
        output: output.clone(),
        source_bucket: "fixture".into(),
        source_is_local: true,
        output_bucket: "fixture".into(),
        output_prefix: "aggregate".into(),
        source_prefixes: vec![String::new()],
        segment_duration_secs: 60,
    });
    let task = tasks.first().context("missing fixture task")?;
    let response = router(state)
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/task-flamegraph?task_id={task}&start_ns={start}&end_ns={end}"
                ))
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), 16 * 1024 * 1024).await?;
    ensure!(
        status.is_success(),
        "mixed API returned {status}: {}",
        String::from_utf8_lossy(&body)
    );
    // Each stack frame adds two JSON levels (node + children map).
    let mut decoder = serde_json::Deserializer::from_slice(&body);
    decoder.disable_recursion_limit();
    let profile = Profile::deserialize(&mut decoder)?;
    ensure!(
        profile.unavailable_reason.is_none(),
        "mixed profile unavailable: {:?}",
        profile.unavailable_reason
    );
    ensure!(
        profile.unit == "nanoseconds",
        "unexpected profile unit: {}",
        profile.unit
    );
    ensure!(
        profile.cpu_samples >= 100 && profile.capture_groups >= 100,
        "insufficient observations: {} CPU, {} captures",
        profile.cpu_samples,
        profile.capture_groups
    );
    super::aggregate_spans::check(output.as_ref(), expected, offset).await?;
    compare_weights(
        expected,
        profile.tree.as_ref().context("mixed profile has no tree")?,
    )
    .with_context(|| {
        format!(
            "{} CPU samples, {} captures",
            profile.cpu_samples, profile.capture_groups
        )
    })
}

fn compare_weights(expected: &ExpectedModel, tree: &Node) -> Result<()> {
    let mut stacks = Vec::new();
    fn visit<'a>(node: &'a Node, path: &mut Vec<&'a str>, stacks: &mut Vec<(Vec<&'a str>, f64)>) {
        path.push(&node.name);
        if node.self_ns > 0.0 {
            stacks.push((path.clone(), node.self_ns));
        }
        for child in node.children.values() {
            visit(child, path, stacks);
        }
        path.pop();
    }
    visit(tree, &mut Vec::new(), &mut stacks);
    let mut weights = BTreeMap::new();
    for symbol in &expected.symbols {
        let domain = match symbol.feature {
            FixtureFeature::Cpu => "[on-cpu]",
            FixtureFeature::TaskDump => "[idle-at-await]",
            FixtureFeature::Span => continue,
        };
        let weight: f64 = stacks
            .iter()
            .filter(|(path, _)| {
                path.contains(&domain)
                    && path
                        .iter()
                        .any(|name| name.contains(symbol.symbol.as_str()))
            })
            .map(|(_, weight)| *weight)
            .sum();
        ensure!(weight > 0.0, "mixed API omitted {}", symbol.symbol.as_str());
        weights.insert(symbol.symbol.as_str(), weight);
    }
    for edge in &expected.stack_edges {
        ensure!(
            stacks.iter().any(|(path, _)| {
                let parent = path
                    .iter()
                    .position(|name| name.contains(edge.parent.as_str()));
                let child = path
                    .iter()
                    .position(|name| name.contains(edge.child.as_str()));
                matches!((parent, child), (Some(parent), Some(child)) if parent < child)
            }),
            "mixed API omitted {} -> {}",
            edge.parent.as_str(),
            edge.child.as_str()
        );
    }
    // Ratios come from the fixture's declarations, including cross-domain
    // pairs such as inner CPU:wait. No fixture-specific weight table lives here.
    let symbols: Vec<_> = expected
        .symbols
        .iter()
        .filter(|s| s.feature != FixtureFeature::Span)
        .collect();
    for (i, left) in symbols.iter().enumerate() {
        for right in &symbols[i + 1..] {
            let observed = weights[left.symbol.as_str()] / weights[right.symbol.as_str()];
            let prescribed = left.weight.get() as f64 / right.weight.get() as f64;
            ensure!(
                (observed / prescribed - 1.0).abs() < RELATIVE_TOLERANCE,
                "{}:{} ratio {observed:.3}, expected {prescribed:.3}; weights={weights:?}",
                left.symbol.as_str(),
                right.symbol.as_str()
            );
        }
    }
    let totals = |feature| -> (f64, f64) {
        symbols.iter().filter(|s| s.feature == feature).fold(
            (0.0, 0.0),
            |(observed, prescribed), s| {
                (
                    observed + weights[s.symbol.as_str()],
                    prescribed + s.weight.get() as f64,
                )
            },
        )
    };
    let (cpu, cpu_target) = totals(FixtureFeature::Cpu);
    let (idle, idle_target) = totals(FixtureFeature::TaskDump);
    ensure!(
        (cpu / idle / (cpu_target / idle_target) - 1.0).abs() < RELATIVE_TOLERANCE,
        "CPU:idle ratio {:.3}, expected {:.3}",
        cpu / idle,
        cpu_target / idle_target
    );
    Ok(())
}
