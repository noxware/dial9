//! Inputs for task-scoped CPU/async profiles. Poll boundaries remain available
//! across part-files so rotation does not truncate a sampled wait.

pub(crate) mod analysis;
mod parquet;
pub(crate) mod selection;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::decode::clock::ClockOffset;
use super::decode::events::{TaskSample, TraceEvent};

pub(crate) use parquet::{read, write};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Frame {
    pub name: String,
    pub file: Option<String>,
}

/// Stacks are root-first, including expanded inline frames.
pub(crate) type Stack = Arc<[Frame]>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Kind {
    Cpu = 0,
    Capture = 1,
    PollStart = 2,
    PollEnd = 3,
    Park = 4,
    Unpark = 5,
}

impl TryFrom<u8> for Kind {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Cpu),
            1 => Ok(Self::Capture),
            2 => Ok(Self::PollStart),
            3 => Ok(Self::PollEnd),
            4 => Ok(Self::Park),
            5 => Ok(Self::Unpark),
            _ => anyhow::bail!("unknown task profile event kind {value}"),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Row {
    pub kind: Kind,
    pub timestamp_ns: u64,
    pub task_id: Option<u64>,
    pub worker_id: Option<u64>,
    pub tid: Option<u32>,
    pub probability: Option<f64>,
    pub stack: Stack,
}

#[derive(Clone, Default, Debug)]
pub(crate) struct Segment {
    pub recording_id: String,
    pub clock_offset: Option<ClockOffset>,
    pub metadata: BTreeMap<String, String>,
    pub rows: Vec<Row>,
}

impl Segment {
    pub(super) fn resolve(
        recording_id: String,
        clock_offset: Option<ClockOffset>,
        metadata: BTreeMap<String, String>,
        events: &[TraceEvent],
        captures: &[TaskSample],
        symbols: &HashMap<u64, Vec<(u64, Frame)>>,
    ) -> Self {
        let mut segment = Self {
            recording_id,
            clock_offset,
            metadata,
            rows: Vec::new(),
        };
        // CPU-only and legacy traces do not need a second copy of their polls.
        if captures.is_empty() && !segment.metadata.contains_key("task_sampling.sampler") {
            return segment;
        }
        let mut stacks = HashMap::<Vec<u64>, Stack>::new();
        let mut resolve_stack = |chain: &[u64]| {
            Arc::clone(stacks.entry(chain.to_vec()).or_insert_with(|| {
                chain
                    .iter()
                    .rev()
                    .flat_map(|addr| match symbols.get(addr) {
                        Some(frames) => {
                            let mut frames = frames.clone();
                            frames.sort_by_key(|(depth, _)| *depth);
                            frames.into_iter().map(|(_, frame)| frame).collect()
                        }
                        None => vec![Frame {
                            name: format!("0x{addr:x}"),
                            file: None,
                        }],
                    })
                    .collect::<Vec<_>>()
                    .into()
            }))
        };
        for event in events {
            let mut row = Row {
                kind: Kind::Cpu,
                timestamp_ns: event.timestamp_ns(),
                task_id: None,
                worker_id: None,
                tid: None,
                probability: None,
                stack: Arc::from([]),
            };
            match event {
                TraceEvent::CpuSample(s) if s.source == 0 => {
                    row.tid = Some(s.tid);
                    row.stack = resolve_stack(&s.callchain);
                }
                TraceEvent::PollStart(p) => {
                    row.kind = Kind::PollStart;
                    row.task_id = Some(p.task_id);
                    row.worker_id = Some(p.worker_id);
                }
                TraceEvent::PollEnd(p) => {
                    row.kind = Kind::PollEnd;
                    row.worker_id = Some(p.worker_id);
                }
                TraceEvent::WorkerPark(p) => {
                    row.kind = Kind::Park;
                    row.worker_id = Some(p.worker_id);
                    row.tid = Some(p.tid);
                }
                TraceEvent::WorkerUnpark(p) => {
                    row.kind = Kind::Unpark;
                    row.worker_id = Some(p.worker_id);
                    row.tid = Some(p.tid);
                }
                _ => continue,
            }
            segment.rows.push(row);
        }
        segment.rows.extend(captures.iter().map(|capture| Row {
            kind: Kind::Capture,
            timestamp_ns: capture.timestamp_ns,
            task_id: Some(capture.task_id),
            worker_id: None,
            tid: None,
            probability: Some(capture.inclusion_probability),
            stack: resolve_stack(&capture.callchain),
        }));
        segment
    }
}
