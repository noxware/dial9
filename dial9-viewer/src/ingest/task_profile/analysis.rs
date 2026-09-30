use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::{Kind, Row, Segment, selection};
use crate::ingest::decode::{
    clock::{ClockOffset, MonoNs},
    events::{PollEnd, PollStart, TraceEvent, WorkerPark, WorkerUnpark},
    polls::{PollIndex, PollTimeline},
};

pub(crate) struct Request<'a> {
    pub task_id: u64,
    pub recording_id: Option<&'a str>,
    pub start_ns: u64,
    pub end_ns: u64,
}

#[derive(Default, Debug, Serialize)]
pub(crate) struct Node {
    pub name: String,
    pub weight_ns: f64,
    pub self_ns: f64,
    pub children: BTreeMap<String, Node>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub alternatives: BTreeSet<Vec<String>>,
}

impl Node {
    fn add(
        &mut self,
        stack: &[String],
        weight: f64,
        alternatives: impl IntoIterator<Item = Vec<String>>,
    ) {
        self.weight_ns += weight;
        match stack.split_first() {
            Some((name, rest)) => self
                .children
                .entry(name.clone())
                .or_insert_with(|| Node {
                    name: name.clone(),
                    ..Default::default()
                })
                .add(rest, weight, alternatives),
            None => {
                self.self_ns += weight;
                self.alternatives.extend(alternatives);
            }
        }
    }
}

#[derive(Default, Debug, Serialize)]
pub(crate) struct Response {
    pub unit: &'static str,
    pub task_id: String,
    pub recording_id: Option<String>,
    pub recordings: Vec<String>,
    pub start_ns: u64,
    pub end_ns: u64,
    pub effective_start_ns: Option<u64>,
    pub cpu_ns: f64,
    pub idle_ns: f64,
    pub cpu_samples: usize,
    pub capture_groups: usize,
    pub incomplete_capture_groups: usize,
    pub invalid_capture_groups: usize,
    pub limitations: Vec<&'static str>,
    pub unavailable_reason: Option<&'static str>,
    pub tree: Option<Node>,
}

impl Response {
    fn unavailable(mut self, reason: &'static str) -> Self {
        self.unavailable_reason = Some(reason);
        self
    }
}

fn boundary(row: &Row) -> Option<TraceEvent> {
    let timestamp_ns = row.timestamp_ns;
    let worker_id = row.worker_id?;
    Some(match row.kind {
        Kind::PollStart => TraceEvent::PollStart(PollStart {
            timestamp_ns,
            worker_id,
            task_id: row.task_id?,
            spawn_loc: None,
        }),
        Kind::PollEnd => TraceEvent::PollEnd(PollEnd {
            timestamp_ns,
            worker_id,
        }),
        Kind::Park => TraceEvent::WorkerPark(WorkerPark {
            timestamp_ns,
            worker_id,
            tid: row.tid?,
        }),
        Kind::Unpark => TraceEvent::WorkerUnpark(WorkerUnpark {
            timestamp_ns,
            worker_id,
            tid: row.tid?,
        }),
        _ => return None,
    })
}

pub(crate) fn analyze(segments: &[Segment], request: Request<'_>) -> Response {
    let mut result = Response {
        unit: "nanoseconds",
        task_id: request.task_id.to_string(),
        start_ns: request.start_ns,
        end_ns: request.end_ns,
        limitations: vec![
            "Idle-at-await includes scheduler delay.",
            "Estimated total excludes synchronous off-CPU time inside polls.",
            "Only waits completed in the available trace are represented.",
        ],
        ..Default::default()
    };
    if request.start_ns >= request.end_ns {
        return result.unavailable("invalid_range");
    }
    let recordings: BTreeSet<_> = segments
        .iter()
        .filter(|s| request.recording_id.is_none_or(|id| s.recording_id == id))
        .filter(|s| s.rows.iter().any(|r| r.task_id == Some(request.task_id)))
        .map(|s| &s.recording_id)
        .collect();
    result.recordings = recordings.iter().map(|id| (*id).clone()).collect();
    if recordings.len() > 1 {
        return result.unavailable("ambiguous_task_id");
    }
    let Some(recording) = recordings.first() else {
        return result.unavailable("no_task_samples");
    };
    result.recording_id = Some((*recording).clone());
    let segments: Vec<_> = segments
        .iter()
        .filter(|s| &s.recording_id == *recording)
        .collect();
    if segments.iter().any(|s| s.clock_offset.is_none()) {
        return result.unavailable("missing_clock_sync");
    }
    // A process uses one monotonic clock across rotation; use a single sync
    // for the requested wall-clock range so small resync jitter cannot reorder polls.
    let offset = segments
        .iter()
        .filter_map(|s| s.rows.first().map(|r| (r.timestamp_ns, s.clock_offset)))
        .min_by_key(|(ts, _)| *ts)
        .and_then(|(_, offset)| offset);
    let Some(offset) = offset else {
        return result.unavailable("missing_clock_sync");
    };
    let Some((start, end)) = monotonic_range(&request, offset) else {
        return result.unavailable("invalid_range");
    };
    let mut events: Vec<_> = segments
        .iter()
        .flat_map(|s| s.rows.iter().filter_map(boundary))
        .collect();
    events.sort_by_key(TraceEvent::timestamp_ns);
    let timeline = PollTimeline::reconstruct(&events);
    let index = PollIndex::new(timeline.records());
    let polls: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            TraceEvent::PollStart(poll) if poll.task_id == request.task_id => Some(poll),
            _ => None,
        })
        .collect();
    if polls.is_empty() {
        return result.unavailable("missing_poll_boundaries");
    }

    let mut active_start = start;
    for worker in polls
        .iter()
        .map(|poll| poll.worker_id)
        .collect::<BTreeSet<_>>()
    {
        let key = format!("task_sampling.worker.{worker}.sampling_started_at_ns");
        let starts: BTreeSet<_> = segments
            .iter()
            .filter_map(|s| s.metadata.get(&key))
            .collect();
        if starts.len() != 1 {
            return result.unavailable("missing_or_conflicting_activation");
        }
        let Some(activation) = starts.first().and_then(|s| s.parse::<u64>().ok()) else {
            return result.unavailable("missing_or_conflicting_activation");
        };
        active_start = active_start.max(activation);
    }
    result.effective_start_ns = offset.checked_to_wall(MonoNs(active_start)).map(|ts| ts.0);
    if active_start >= end {
        return result.unavailable("outside_sampling_coverage");
    }

    let mut tree = Node {
        name: "[task]".into(),
        ..Default::default()
    };
    for segment in &segments {
        let frequency = segment
            .metadata
            .get("cpu.profile.frequency_hz")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|hz| hz.is_finite() && *hz > 0.0);
        let Some(frequency) = frequency else {
            return result.unavailable("missing_cpu_frequency");
        };
        let weight = 1_000_000_000.0 / frequency;
        if !weight.is_finite() {
            return result.unavailable("invalid_cpu_frequency");
        }
        for row in segment.rows.iter().filter(|r| {
            r.kind == Kind::Cpu && r.timestamp_ns >= active_start && r.timestamp_ns < end
        }) {
            let Some(tid) = row.tid else { continue };
            let timestamp = MonoNs(row.timestamp_ns);
            if timeline
                .worker_for_tid_at(tid, timestamp)
                .and_then(|worker| index.task_at(worker, timestamp))
                != Some(request.task_id)
            {
                continue;
            }
            if row.stack.is_empty() {
                continue;
            }
            let stack: Vec<_> = std::iter::once("[on-cpu]".into())
                .chain(row.stack.iter().map(|f| f.name.clone()))
                .collect();
            tree.add(&stack, weight, []);
            result.cpu_ns += weight;
            result.cpu_samples += 1;
        }
    }

    let mut groups: BTreeMap<u64, Vec<&Row>> = BTreeMap::new();
    for row in segments
        .iter()
        .flat_map(|s| &s.rows)
        .filter(|row| row.kind == Kind::Capture && row.task_id == Some(request.task_id))
    {
        groups.entry(row.timestamp_ns).or_default().push(row);
    }
    for (timestamp, group) in groups {
        let (Some(idle_start), Some(idle_end)) = (group[0].idle_start_ns, group[0].idle_end_ns)
        else {
            result.incomplete_capture_groups += 1;
            continue;
        };
        if idle_start > idle_end || idle_end > timestamp {
            result.invalid_capture_groups += 1;
            continue;
        }
        let overlap = idle_end
            .min(end)
            .saturating_sub(idle_start.max(active_start));
        if overlap == 0 {
            continue;
        }
        let Some(probability) = group[0]
            .probability
            .filter(|p| p.is_finite() && *p > 0.0 && *p <= 1.0)
        else {
            result.invalid_capture_groups += 1;
            continue;
        };
        if group.iter().any(|row| {
            row.probability != Some(probability)
                || row.stack.is_empty()
                || row.idle_start_ns != Some(idle_start)
                || row.idle_end_ns != Some(idle_end)
        }) {
            result.invalid_capture_groups += 1;
            continue;
        }
        let selected = selection::select(group.into_iter().map(|row| row.stack.clone()));
        let weight = overlap as f64 / probability;
        if !weight.is_finite() {
            result.invalid_capture_groups += 1;
            continue;
        }
        let stack: Vec<_> = std::iter::once("[idle-at-await]".into())
            .chain(selected.stack)
            .collect();
        tree.add(
            &stack,
            weight,
            selected
                .alternatives
                .into_iter()
                .map(|s| s.iter().map(|f| f.name.clone()).collect()),
        );
        result.capture_groups += 1;
        result.idle_ns += weight;
    }
    if result.capture_groups == 0 {
        if result.incomplete_capture_groups > 0 {
            return result.unavailable("missing_idle_intervals");
        }
        return result.unavailable("no_usable_task_samples");
    }
    if !tree.weight_ns.is_finite() {
        return result.unavailable("invalid_total_weight");
    }
    if result.incomplete_capture_groups > 0 {
        result
            .limitations
            .push("Older samples without completed idle intervals were excluded.");
    }
    if result.invalid_capture_groups > 0 {
        result.limitations.push(
            "Capture groups with invalid or inconsistent probabilities, intervals or stacks were excluded.",
        );
    }
    result.tree = Some(tree);
    result
}

fn monotonic_range(request: &Request<'_>, offset: ClockOffset) -> Option<(u64, u64)> {
    let end = u64::try_from(request.end_ns as i128 - offset.0).ok()?;
    // A wall range may start before this process's monotonic epoch.
    let start = (request.start_ns as i128 - offset.0).max(0);
    Some((u64::try_from(start).ok()?, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::task_profile::{Frame, Stack};

    fn row(kind: Kind, ts: u64) -> Row {
        let stack: Stack = vec![Frame {
            name: "service::work".into(),
            file: Some("src/main.rs".into()),
        }]
        .into();
        Row {
            kind,
            timestamp_ns: ts,
            task_id: matches!(kind, Kind::PollStart | Kind::Capture).then_some(7),
            worker_id: Some(0),
            tid: Some(42),
            probability: (kind == Kind::Capture).then_some(0.5),
            idle_start_ns: (kind == Kind::Capture).then_some(100),
            idle_end_ns: (kind == Kind::Capture).then_some(200),
            stack,
        }
    }

    fn fixture() -> Segment {
        Segment {
            recording_id: "a".into(),
            clock_offset: Some(ClockOffset(10_000)),
            metadata: [
                ("cpu.profile.frequency_hz".into(), "100000000".into()),
                (
                    "task_sampling.worker.0.sampling_started_at_ns".into(),
                    "50".into(),
                ),
            ]
            .into(),
            rows: vec![
                row(Kind::Unpark, 0),
                row(Kind::PollStart, 10),
                row(Kind::Cpu, 20),
                row(Kind::Cpu, 60),
                row(Kind::Capture, 210),
                row(Kind::PollEnd, 100),
                row(Kind::PollStart, 200),
                row(Kind::PollEnd, 220),
            ],
        }
    }

    fn request(start: u64, end: u64) -> Request<'static> {
        Request {
            task_id: 7,
            recording_id: None,
            start_ns: start + 10_000,
            end_ns: end + 10_000,
        }
    }

    #[test]
    fn weights_group_once_and_joins_polls_across_parquet_parts() {
        let mut a = fixture();
        a.rows.insert(5, row(Kind::Capture, 210)); // a duplicate sibling
        let mut b = fixture();
        b.rows = a.rows.split_off(6); // poll end is in the following part
        let segments = [a, b]
            .iter()
            .map(|s| super::super::read(super::super::write(s).unwrap().into()).unwrap())
            .collect::<Vec<_>>();
        let result = analyze(&segments, request(0, 230));
        assert_eq!(result.unavailable_reason, None);
        assert_eq!(result.effective_start_ns, Some(10_050));
        assert_eq!(result.cpu_samples, 1);
        assert_eq!(result.cpu_ns, 10.0);
        assert_eq!(result.capture_groups, 1);
        assert_eq!(result.idle_ns, 200.0);
        let tree = result.tree.unwrap();
        assert_eq!(tree.weight_ns, 210.0);
        assert_eq!(tree.children.len(), 2);
    }

    #[test]
    fn includes_a_capture_after_the_range_and_clips_both_ends() {
        let result = analyze(&[fixture()], request(120, 180));
        assert_eq!(result.idle_ns, 120.0);
        assert_eq!(result.cpu_ns, 0.0);
        assert_eq!(result.capture_groups, 1);
    }

    #[test]
    fn migration_uses_latest_activation_and_requires_each_workers_metadata() {
        let mut segment = fixture();
        segment.rows[6].worker_id = Some(1);
        segment.rows[7].worker_id = Some(1);
        assert_eq!(
            analyze(&[segment.clone()], request(0, 230)).unavailable_reason,
            Some("missing_or_conflicting_activation")
        );
        segment.metadata.insert(
            "task_sampling.worker.1.sampling_started_at_ns".into(),
            "150".into(),
        );
        let result = analyze(&[segment], request(0, 230));
        assert_eq!(result.effective_start_ns, Some(10_150));
        assert_eq!(result.idle_ns, 100.0);
        assert_eq!(result.cpu_ns, 0.0);
    }

    #[test]
    fn invalid_probability_or_inconsistent_siblings_do_not_get_default_weights() {
        for probability in [
            None,
            Some(0.0),
            Some(-1.0),
            Some(1.1),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            let mut segment = fixture();
            segment.rows[4].probability = probability;
            let result = analyze(&[segment], request(0, 230));
            assert_eq!(result.invalid_capture_groups, 1);
            assert!(result.tree.is_none());
        }
        let mut segment = fixture();
        let mut sibling = row(Kind::Capture, 210);
        sibling.probability = Some(0.25);
        segment.rows.push(sibling);
        assert_eq!(
            analyze(&[segment], request(0, 230)).invalid_capture_groups,
            1
        );
    }

    #[test]
    fn cpu_only_and_missing_metadata_are_not_presented_as_mixed() {
        let mut segment = fixture();
        segment.rows.retain(|r| r.kind != Kind::Capture);
        assert_eq!(
            analyze(&[segment], request(0, 230)).unavailable_reason,
            Some("no_usable_task_samples")
        );
        let mut segment = fixture();
        segment.metadata.remove("cpu.profile.frequency_hz");
        assert_eq!(
            analyze(&[segment], request(0, 230)).unavailable_reason,
            Some("missing_cpu_frequency")
        );
    }

    #[test]
    fn identical_task_ids_in_different_processes_must_be_disambiguated() {
        let a = fixture();
        let mut b = fixture();
        b.recording_id = "b".into();
        assert_eq!(
            analyze(&[a.clone(), b.clone()], request(0, 230)).unavailable_reason,
            Some("ambiguous_task_id")
        );
        let mut request = request(0, 230);
        request.recording_id = Some("a");
        let result = analyze(&[a, b], request);
        assert_eq!(result.capture_groups, 1);
        assert_eq!(result.idle_ns, 200.0);
    }

    #[test]
    fn old_samples_without_interval_bounds_are_not_guessed() {
        let mut segment = fixture();
        segment.rows[4].idle_start_ns = None;
        segment.rows[4].idle_end_ns = None;
        let result = analyze(&[segment], request(0, 230));
        assert_eq!(result.incomplete_capture_groups, 1);
        assert_eq!(result.idle_ns, 0.0);
        assert!(result.tree.is_none());
    }

    #[test]
    fn a_capture_wake_does_not_shorten_the_completed_wait() {
        let mut segment = fixture();
        segment
            .rows
            .extend([row(Kind::PollStart, 221), row(Kind::PollEnd, 222)]);
        let result = analyze(&[segment], request(0, 230));
        assert_eq!(result.capture_groups, 1);
        assert_eq!(result.idle_ns, 200.0);
        assert_eq!(result.incomplete_capture_groups, 0);
    }
}
