# Task Dump Capture Sampling and Mixed Flamegraphs

Status: proposed

## Summary

Task dumps currently capture an async stack after every instrumented poll that
returns `Pending`, then use an idle-time Poisson decision to choose which
captures to emit. Sampling only at emission limits trace volume, but it does
not limit the expensive stack captures.

Add an experimental alternative with one worker-local sampling decision before
stack capture, preserving the existing task-dump behavior:

```rust
TaskSamplingConfig::builder()
    .captures_per_second_per_worker(10)
    .build()
```

Each worker independently targets the configured capture rate across eligible
resumptions after `Pending`. A selected transition has no second emission-sampling
decision: if the `trace_with` re-poll remains pending, all captured callchains
are emitted immediately. Each `TaskSampleEvent` records its inclusion probability
so analysis can recover unbiased wait-time estimates.

The same statistical contract enables a task-scoped mixed flamegraph:

- on-CPU stacks are weighted from `cpu.profile.frequency_hz` segment metadata;
- async task dumps are weighted by observed idle duration divided by their
  inclusion probability.

Mixed flamegraphs are intentionally scoped to one task in the first version.
Process- or runtime-wide views would be biased when some tasks are not
task-dump instrumented: those tasks have zero inclusion probability, which no
weighting can correct.

Task scope applies only to the first mixed-flamegraph view. Capture itself is
not restricted to one task: every task wrapped by dial9 instrumentation on
every runtime worker configured with `TaskSamplingConfig` participates in that
worker's sampler.

## Goals

- Bound expected task-dump capture work as a simple function of runtime worker
  count.
- Sample eligible transitions from all dial9-instrumented tasks on all workers,
  without a task allow-list or a designated sampling worker.
- Put the sampling decision before `tokio::runtime::dump::trace_with`.
- Emit every usable selected capture; do not maintain a second emission
  sampler.
- Preserve enough sampling information for unbiased wait-time aggregation.
- Support a task-scoped flamegraph that combines on-CPU and async-idle stacks
  in time units.
- Keep the disabled and non-selected poll paths allocation-free.
- Preserve the existing `TaskDumpConfig` API and behavior.

## Non-goals

- A process-wide mixed flamegraph in the first version.
- Correcting for tasks that were not spawned through dial9 instrumentation.
- A strict maximum number of captures in every wall-clock second. The
  configured rate is a sampling target.
- Combining scheduler-event samples with on-CPU samples. Mixed flamegraphs use
  `CpuProfile` samples only.
- Changing Tokio's task-dump capture mechanism.

## Public API

With the `unstable-task-sampling` Cargo feature enabled:

```rust
use dial9::{TaskSamplingConfig, TokioAttachOptions};

let options = TokioAttachOptions::builder()
    .task_tracking_enabled(true)
    .task_sampling_config(
        TaskSamplingConfig::builder()
            .captures_per_second_per_worker(10)
            .build(),
    )
    .build();
```

`captures_per_second_per_worker` is a positive integer. `0` is rejected at
build time; callers disable task sampling by omitting `task_sampling_config`.

The default is 10 captures/s/worker. `rng_seed` remains available for
deterministic tests.

### Compatibility

`TaskDumpConfig`, `idle_threshold`, and the existing `DIAL9_TASK_DUMP_*`
variables retain their behavior. `TaskSamplingConfig` requires the opt-in
`unstable-task-sampling` Cargo feature, which enables `taskdump`. Its API and
behavior may change. The two configs cannot be enabled on the same runtime;
different runtimes may use different modes.

`DIAL9_TASK_SAMPLING_ENABLED` enables the experimental mode;
`DIAL9_TASK_SAMPLING_PER_WORKER_HZ` sets its target rate (default: 10).
It has no cap yet and can substantially exceed the target after a traffic
increase. Cost protection and data quality must be evaluated before production use.

Legacy `TaskDumpEvent` stays unchanged. `TaskSampleEvent` carries the sampled
stacks and their inclusion probability; analysis must distinguish the two.

## Cost Model

For:

- `W`: runtime workers,
- `r`: configured captures/s/worker,
- `c`: seconds per capture,

the expected cost is:

```text
captures/s = W * r
added CPU cores = W * r * c
runtime capacity fraction = r * c
```

The capacity fraction is independent of worker count. Using a conservative
10 us capture cost and the proposed 10 Hz default:

```text
runtime capacity fraction = 10/s * 10 us = 0.0001 = 0.01%
```

An eight-worker runtime takes approximately 80 captures/s and consumes 0.0008
CPU cores. This is the intended operational meaning of the API.

### Measurement basis

A standalone release-mode benchmark used Tokio's real `trace_with` API and
dial9's capture-plus-trim path. A synthetic future with 24 nested async levels
produced 27 trimmed frames, representative of the observed workload depth.
Four 20,000-capture runs measured a 7.65 us median capture-plus-trim cost.

The model uses 10 us per selected capture to leave room for event encoding,
stack interning, and host or workload variation.

### Representative workload

An anonymized eight-worker workload contained eight instrumented tasks,
11,727 polls/s, and 1.869 active CPU cores. Applying the 10 us planning cost
gives:

| Rate/worker | Total captures/s | Active CPU penalty | Runtime capacity |
|---:|---:|---:|---:|
| 1/s | 8 | 0.0043% | 0.001% |
| 5/s | 40 | 0.0214% | 0.005% |
| **10/s** | **80** | **0.0428%** | **0.010%** |
| 20/s | 160 | 0.0856% | 0.020% |

The separate wake-tracing benchmark measured a 94.2 ns median added cost per
wake/poll. Conservatively assuming one wake per observed poll gives 0.00111
added CPU cores, 0.059% of the workload's active CPU, or 0.0138% of the
eight-worker runtime's capacity.

At the recommended 10 captures/s/worker, normal wake tracing plus task-dump
capture is therefore expected to add approximately 0.102% relative to observed
active CPU, or 0.0238% of runtime capacity. These are planning estimates from
one representative workload, not universal bounds.

The sampling decision still runs on each eligible resumption. Its fast
path should be a worker-local counter update and branch; stack capture,
trimming, interning, and event encoding only run for selected transitions.
This per-transition cost is not included in the estimate above.

## Sampling Design

### Population

An eligible item is the resumption of an instrumented task after a normal
`Pending` poll, on a worker with `TaskSamplingConfig` enabled. The continuation
after a capture is excluded: it drives the future normally rather than
recapturing the same await.

Sampling is worker-local. Tasks may migrate between workers; the probability
stored on an event is the probability used by the worker that made that
capture.

### Worker ownership and thread handoffs

During `block_in_place`, Tokio
[hands the worker's core to another thread](https://github.com/tokio-rs/tokio/blob/eb9cdf2ff012ec22d4efd74cf46d04222264cd8e/tokio/src/runtime/scheduler/multi_thread/worker.rs#L486-L506).
The original task can finish its poll concurrently with the replacement
worker. Keep one sampler per worker in `RuntimeContext`, with TLS caching a
reference. A per-worker mutex protects selection, never application polling,
capture, or emission. Contention must not discard sampling opportunities.
Pad each worker's mutable state to avoid false sharing, as in the CPU sampler.

Calibration survives thread changes, including `current_thread` driver changes.
Each task retains its poll's worker reference across nested runtimes that may
replace TLS. Selection reads the clock after acquiring the mutex at resumption.

### Coverage across tasks and workers

The capture budget is shared by all eligible transitions observed by one
worker; it is not assigned to a fixed subset of tasks. `TaskDumped<F>` wraps
every future created through dial9's instrumented spawn path, and each pending
transition consults the sampler on the worker currently polling it. Therefore:

- every worker in a runtime configured with `TaskSamplingConfig` has its own sampler;
- every eligible transition from every dial9-instrumented task has a nonzero
  inclusion probability after calibration;
- task migration is naturally handled by consulting the destination worker's
  sampler; and
- a low-volume worker may reach `p_w = 1` and capture every eligible
  transition, while a busy worker shares its configured budget across all of
  its eligible transitions.

This supports sampling a fixed set such as eight instrumented tasks across all
runtime workers without task-specific configuration. "All tasks" still means
all tasks wrapped through dial9 instrumentation. Tokio tasks spawned outside
that path cannot be retroactively wrapped by runtime hooks and have zero
task-dump inclusion probability.

### Rate calibration

Each worker maintains a count of eligible resumptions over a fixed
epoch. One second is a reasonable initial epoch.

For epoch `e + 1`, calculate:

```text
lambda_w = eligible transitions observed in epoch e / epoch duration
p_w = min(1, target captures per second / lambda_w)
```

Every eligible transition in the next epoch is selected independently with
probability `p_w`.

The random selection uses the current worker probability. Record that exact
probability for inverse-probability weighting of the completed wait.

The first epoch is calibration-only. Mixed-flamegraph queries must clip away
that warm-up interval. This avoids an arbitrary initial poll-rate estimate and
prevents an attach-time capture burst.

### Efficient Bernoulli selection

When `p_w` is constant for an epoch, use a geometric skip counter instead of a
fresh random draw on every poll:

```text
skip = number of failures before the next Bernoulli(p_w) success
```

Each eligible transition decrements `skip`. At zero, capture and draw the next
skip. Reset the skip counter when an epoch installs a new probability.

The worker-local state contains:

```text
epoch start
eligible count
current inclusion probability
geometric skip counter
PRNG
sampling-active timestamp
```

Use the existing `SplitMix64` PRNG and derive independent worker seeds from
`rng_seed` plus worker identity. There is no process-global RNG or capture
counter on the steady-state poll path.

### Bursts and overload

The cost model assumes workers have enough eligible transitions to reach the
target, with similar counts in successive epochs. Repeated rate changes can
keep the previous epoch's estimate stale and sustain an average above the target.

An emergency burst cap may protect against a stale rate estimate after a sharp
poll-rate increase, but hitting it makes that worker/epoch statistically
incomplete.

If a cap is implemented:

- record a dropped-capture count;
- mark the affected coverage interval;
- do not silently present that interval as an unbiased mixed profile.

The normal controller should target comfortably below the emergency cap so
this is an overload signal, not routine flow control.

## Capture and Emission

`TracedFuture` constructs the existing wrapper stack for every instrumented
task:

```rust
WakeTraced<TaskDumped<F>>
```

`WakeTraced` continues to record normal wake tracing for every instrumented
task. `TaskDumped` selects the legacy or experimental capture policy, each with
its own reusable frame buffer. Only the experimental policy uses a worker-local
sampler: its futures polled on one worker contribute to and draw from the same
budget. Legacy task dumps retain per-task idle-time sampling.

The experimental poll flow is:

1. On the first poll, or immediately after a capture, poll normally. Save the
   timestamp when that poll returns `Pending`.
2. On resumption, consult the current worker's sampler before advancing the
   future. If not selected, poll normally and update the pending timestamp.
3. When selected, run `trace_with` first. Tokio trace leaves return `Pending`
   before performing their operation, even when it is ready.
4. If capture returns `Ready` or yields no frames, emit no sample. Otherwise
   emit the callchains with the completed idle interval, actual capture
   timestamp, and selection probability. Never poll a completed future again.
5. The capture-induced wake schedules a normal continuation. Exclude that
   continuation from sampling to prevent a capture loop.

Capture-to-next-poll timing measures Tokio's synthetic wake rather than the
application wait. Completed interval bounds avoid that ambiguity. An outer-task
wake cannot replace Tokio's deferred wakes of combinators' separate leaves.

**Unresolved:** `trace_with` does not stop non-Tokio futures.
On resumption, a completed non-Tokio await can advance into a later Tokio await,
misattributing the preceding wait to that later stack:

```rust
external_wait().await; // 200 ms; does not use Tokio's tracing hooks
tokio::time::sleep(Duration::from_millis(5)).await;
```

The 200 ms wait can be attributed to the later sleep.
The current API exposes no await identity to verify this association. Reliable
stack attribution requires a separate capture/instrumentation solution; the
Tokio-sleep E2E fixture does not establish correctness for arbitrary futures.

Only completed waits are represented. A task aborted without resuming, or a
wait still open at the end of the available trace, contributes no inferred
idle duration. Selected resumptions without usable captured frames are also
omitted. Explicit bounds also let a later capture describe a wait that
started in an earlier trace segment. Older experimental events without those
bounds remain readable but cannot provide correct mixed-profile weights.

One `trace_with` call can produce more than one callchain. All callchains from
the same capture share task ID, timestamp, and inclusion probability. Treat
them as one capture group keyed by `(task_id, timestamp_ns)`, not as independent
samples. The timestamp is read once and reused while emitting the group.

### Multi-callchain selection

Multiple callchains usually mean the task is waiting on several leaves in a
`select!`, `timeout`, graceful-shutdown wrapper, or nested future tree. The idle
interval belongs to the task once; it does not belong independently to every
leaf.

The checked-in demo trace validates that this is the normal case:

| Shape | Captures | Share of all captures |
|---|---:|---:|
| More than one callchain | 12,233 | 99.935% |
| I/O plus graceful-shutdown notification | 11,053 | 90.295% |
| I/O, shutdown, request operation, and timer | 624 | 5.098% |
| I/O, shutdown, and application semaphore | 524 | 4.281% |

The largest group is an active connection wait paired with a persistent
graceful-shutdown `Notify`. Equal weighting would incorrectly attribute about
half of normal connection idle time to shutdown handling. Do not divide a
capture's weight equally across its callchains.

Choose one representative stack for the time-weighted flamegraph:

1. Normalize and deduplicate the callchains, then find their longest common
   root-side suffix.
2. Mark a branch as control flow only from its surrounding stack structure:
   - a deadline `Sleep` is secondary when it is under a timeout combinator and
     a sibling represents the operation guarded by that same timeout;
   - a cancellation or graceful-shutdown wait is secondary when its stack
     traverses the cancellation/shutdown wrapper and another work branch
     exists.
3. Never demote a branch solely because its leaf is `Sleep` or `Notify`; either
   can be the task's primary work.
4. If one non-control branch remains, use it.
5. Otherwise, prefer a unique branch whose pre-common-suffix portion contains
   more application-owned frames than its siblings. Application ownership
   comes from symbol/source provenance, excluding the Rust sysroot, dependency
   registry, Tokio, and dial9 capture plumbing.
6. If no unique winner remains, represent the set with one synthetic
   `[awaiting any of N]` stack rooted at the common suffix. Include stable,
   sorted leaf labels in the synthetic frame and retain every raw callchain for
   the inspector.

This deliberately handles `timeout(operation, deadline)` differently from a
genuine `select!` over peer operations. The former normally selects the
operation stack; the latter remains an explicit ambiguous wait set unless one
branch is provably control flow or uniquely application-specific.

Selection must be deterministic and independent of callback order because
Tokio may change or randomize branch poll order. Whether a capture resolves to
a primary stack or a synthetic wait set, it contributes its idle weight exactly
once.

## Trace Contract

Add a separate `TaskSampleEvent`:

```rust
struct TaskSampleEvent {
    timestamp_ns: u64,
    task_id: TaskId,
    callchain: InternedStackFrames,
    inclusion_probability: f64,
    idle_start_ns: u64,
    idle_end_ns: u64,
}
```

Keep the legacy `TaskDumpEvent` schema unchanged. The JS decoder accepts both
events; only sampled events carry an inclusion probability.

`TokioRuntimesSource::segment_metadata` must emit the task-dump sampling
configuration as source-owned segment metadata:

```text
task_sampling.worker.<worker_id>.captures_per_second = "10"
task_sampling.sampler = "per_worker_bernoulli_v1"
task_sampling.worker.<worker_id>.sampling_started_at_ns = "<monotonic timestamp>"
```

These are entries in the `SegmentMetadataEvent` written into each trace
segment. They are not fields on `TaskSampleEvent`, recorder-level user metadata,
or metadata supplied by the application. The Tokio source owns them because it
owns the attached-runtime configuration and worker set. As with existing
runtime-to-worker metadata, the source adds them to the writer's merged
metadata cache, which carries them across segment rotation.

Always emit rates per worker. The writer's metadata merge is additive: a global
rate would become stale if a runtime with a different rate attached later.
A worker publishes `sampling_started_at_ns` once, when its calibration epoch ends.
That update survives thread handoffs and is collected by the Tokio source
without taking the sampling mutex. The `inclusion_probability` on each event
remains the authoritative value for statistical weighting.

The CPU profiling source already emits these separate segment-metadata
entries:

```text
cpu.profile.frequency_hz
cpu.profile.backend
cpu.profile.event_source
```

No new `CpuSampleEvent` field is required for the initial mixed flamegraph.

## Statistical Contract

For eligible resumption after `Pending`, `j`:

- `I_j` is 1 when selected and 0 otherwise;
- `p_j` is the recorded inclusion probability;
- `d_j` is the task's idle duration represented by that capture;
- `stack_j` is the representative primary or synthetic async stack selected
  from that capture's callchain group.

The Horvitz-Thompson contribution is:

```text
wait weight_j = I_j * d_j / p_j
```

For any stack group `G`:

```text
estimated wait time(G) = sum(wait weight_j where stack_j belongs to G)
```

Conditional on the completed wait and the probability used for its random selection:

```text
E[I_j * d_j / p_j] = d_j
```

The estimator remains unbiased when probabilities differ by worker or epoch,
provided each event records its selection probability and the stack genuinely
represents that wait. The unresolved capture-attribution issue above prevents
claiming this guarantee for arbitrary instrumented futures.

Do not use raw task-dump counts as time weights. Faster-polling tasks produce
more eligible transitions, and changing traffic changes `p_j`.

## Task-Scoped Mixed Flamegraph

### Why task scope is required

Task dumps only exist for tasks spawned through dial9's instrumented APIs on a
runtime with task dumps enabled. An uninstrumented task has inclusion
probability zero.

A runtime-wide graph that combines:

- CPU samples from every task, and
- async stacks from only instrumented tasks

systematically overstates on-CPU time for uninstrumented tasks and understates
their idle time. Inverse-probability weighting cannot recover a population
with zero-probability members.

The first mixed-flamegraph UI must therefore be reachable from a single task's
detail view and include only:

- CPU samples attributed to polls of that task;
- task dumps whose `task_id` is that task.

If the task has no dumps in the selected window, show insufficient data rather
than a CPU-only graph labeled mixed. A future multi-task view requires explicit
task-dump eligibility metadata and must reject partially eligible selections.

Clip the selected task's CPU and idle inputs to the sampling-active timestamps
published for workers that polled the task. If the task migrated, use the
latest activation timestamp among those workers as the effective range start.
Do not offer a mixed view when the required activation metadata is missing.

### CPU weights

Read the sampling frequency from segment metadata:

```text
frequency_hz = Number(segmentMetadata["cpu.profile.frequency_hz"])
cpu weight = 1_000_000_000 / frequency_hz
```

Use only `CpuProfile` samples attached to the selected task's poll intervals.
Each sample contributes the same expected nanoseconds at the configured
frequency.

If the metadata is absent or invalid, the viewer cannot put CPU samples and
task dumps in common time units. Keep the existing count-based CPU flamegraph,
but do not offer the mixed view.

### Task-dump weights

For each selected capture group:

1. read the completed interval `[idle_start_ns, idle_end_ns)`;
2. reject missing, invalid, or inconsistent bounds within a capture group;
3. intersect the interval with the selected time window;
4. select its representative stack using the multi-callchain rules above; and
5. divide the overlap duration by `inclusion_probability`.

When wake data can reliably distinguish the external wake from capture-induced
wakes, split the interval into:

- `[async-wait]`: poll end to external wake;
- `[runnable]`: external wake to next poll start.

Until then, use one `[idle-at-await]` category for poll-end to next-poll and
state that it includes scheduler delay.

The representative primary or synthetic stack receives the full
inverse-probability weight once:

```text
capture weight = idle overlap / inclusion_probability
```

### Tree construction

Prefix the two stack domains with synthetic frames:

```text
[on-cpu]
[idle-at-await]
```

This prevents equal symbol names in physical CPU stacks and logical async
stacks from merging accidentally.

`buildFlamegraphTree` already accepts a numeric `weight` on each sample. Pass
the computed nanoseconds directly. Do not expand a weighted sample into
repeated objects.

The root total is estimated task time represented by the two sampled domains.
Synchronous off-CPU time inside a poll is not represented by either source and
remains a documented limitation.

## Rejected Alternatives

### Sample only at emission

This is the current behavior. It limits trace bytes but still takes a stack
dump on every pending poll, so it does not bound capture overhead.

### Wall-clock timer, capture the next pending transition

This controls the rough rate but gives transitions unequal inclusion
probabilities based on the preceding inter-poll gap. The resulting
inverse-probability estimator has unnecessarily high variance.

Calibrated Bernoulli sampling keeps probabilities approximately uniform within
each worker epoch while still targeting captures per second.

### Fixed fraction of pending polls

A fixed fraction has simple statistics but no stable cost. Capture rate scales
directly with workload poll rate, which is the quantity the API is intended to
decouple from overhead.

### Per-task capture budget

A per-task rate makes total cost scale with task count and allows many
short-lived tasks to exceed the intended runtime budget. Worker-local budgets
match where capture CPU is spent and keep runtime-capacity cost stable.

### Process-wide mixed flamegraph

CPU profiling covers more tasks and threads than task dumps. Joining those
populations without explicit eligibility produces structural bias, not merely
sampling noise. Task scope is the correct first interface.

## Implementation Plan

1. Add `TaskSamplingConfig` alongside the unchanged `TaskDumpConfig`.
2. Initialize worker-local sampler state for the experimental mode through
   runtime hooks, retaining the legacy per-task path.
3. Sample on resumption after `Pending`, before advancing the future in
   `FrameBuf::capture`, and record the completed idle interval.
4. Emit selected captures immediately; legacy task dumps retain delayed
   idle-time emission.
5. Add `TaskSampleEvent` with `inclusion_probability` and decode both event types.
6. Have `TokioRuntimesSource` emit task-dump configuration and per-worker
   sampling-active segment metadata.
7. Group sibling callchains and implement deterministic representative-stack
   selection with an explicit ambiguous-wait fallback.
8. Land the minimal
   [telemetry integration test application](telemetry-integration-test-app.md),
   proving that one self-described, mixed CPU/span/task-dump trace reaches both
   parsing paths.
9. Use that trace's declared CPU/wait weights while adding task-scoped
   mixed-flamegraph construction with CPU frequency metadata and
   inverse-probability task-dump weights.
10. Keep old traces on their current unweighted task-dump rendering path.

## Telemetry Integration Test Prerequisite

The minimal
[telemetry integration test application](telemetry-integration-test-app.md)
provides one runnable workload and one local/aggregate integration test. It
mixes CPU profiling and task dumps under the same nested spans and describes
the expected structure through names and trace events.

That tracer bullet must land before task-dump mixed flamegraphs. Flamegraph
work should consume its declared weights and add a branch case only if the
end-to-end test needs one. No sidecar manifest or task-dump-specific test
application should be introduced.

## Test Plan

### Focused tests

- Builder default, nonzero validation, legacy compatibility, and deterministic
  seed tests.
- Sampler tests showing the long-run per-worker rate converges to the configured
  target over different pending-poll rates.
- Statistical tests showing each selected event records the probability used
  and inverse-probability totals converge to known synthetic wait totals.
- Regression test proving non-selected polls do not call `trace_with`.
- Regression test proving every selected capture whose re-poll remains pending
  emits and no second emission sampler remains.
- Existing no-extra-wake/no-extra-poll and completed-on-repoll tests.
- Worker calibration and metadata survive thread handoffs, concurrent pending
  completions, and nested runtimes.
- Calibration uses the eligible resumption time, not the preceding poll start.
- Trace round-trip tests for both legacy and sampled events.
- JS parser test for old events where `inclusion_probability` is undefined.
- Viewer tests that mixed profiles:
  - use `cpu.profile.frequency_hz`;
  - include only CPU samples and dumps for the selected task;
  - reject missing CPU metadata or missing task dumps;
  - group sibling callchains by task ID and capture timestamp;
  - select timeout operations over their paired deadline timers;
  - select work over recognized cancellation/shutdown branches;
  - preserve standalone timer and notification waits;
  - produce an order-independent synthetic wait set for ambiguous peer
    branches;
  - apply one full inverse-probability weight per capture group;
  - clip idle duration to the selected window;
  - pass numeric weights directly to the flamegraph builder.

### Integration conformance

The prerequisite application encodes its CPU/wait weights and enclosing spans
in the trace itself. As part of mixed-flamegraph implementation, consume those
declarations to prove:

- frequency and inverse-probability weights are applied;
- the expected CPU and async-idle symbols appear in the mixed graph;
- the whole-cycle and inner-subtree mixes match their declared relationships;
  and
- local and aggregate parsing agree on the declared structure.

Keep timeout, cancellation, ambiguous-peer selection, sampler convergence, and
worker coverage in the focused tests above unless an end-to-end regression
demonstrates that the app also needs one of those cases.
