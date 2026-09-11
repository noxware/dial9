//! `TaskDumped<F>` wraps a future and captures async backtraces at yield
//! points selected by a worker-local capture budget.
//!
//! This wrapper is intentionally separate from the wake-event wrapper: wake
//! capture runs on every instrumented spawn regardless of the `taskdump`
//! feature, while task-dump capture is gated behind the `taskdump` feature and
//! its own runtime toggle. Typical stacking is `WakeTraced<TaskDumped<F>>`.
//!
//! # Sampling model
//!
//! All instrumented tasks on a worker share a calibrated Bernoulli sampler.
//! Non-selected transitions do no capture work. Selected pending captures emit
//! every usable callchain immediately, with the probability used for selection.
//!
//! # Capture mechanics
//!
//! After a normal poll returns `Pending`, capture runs a second `poll` of the
//! inner future under the real waker inside [`tokio::runtime::dump::trace_with`].
//! Tokio may defer a wake for each captured leaf. To avoid a wake-and-capture
//! loop, the poll immediately following a capture polls the future normally
//! but skips capture.
//! On Tokio versions without capture-induced wakes, this also skips capture
//! on the next real wake; it never skips the normal poll.
//!
//! # Allocation
//!
//! Captured instruction pointers are stored flat in [`FrameBuf`] across all
//! yield points hit during a capture, with offsets recording each callchain's
//! start. The buffers are reused across polls.

use crate::primitives::sync::Arc;
use crate::task_dump_sampler::TaskDumpSampler;
use crate::telemetry::format::TaskDumpEvent;
use crate::telemetry::task_dump_config::TaskDumpConfig;
use crate::telemetry::task_metadata::TaskId;
use crate::telemetry::{Encodable, ThreadLocalEncoder};
use dial9_core::handle::Dial9Handle;
use pin_project_lite::pin_project;
use smallvec::SmallVec;
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

/// Initial heap reservation for the instruction-pointer buffer on first capture.
const FRAME_BUF_INITIAL_CAPACITY: usize = 256;

struct WorkerSampler {
    key: (u64, u64),
    sampler: TaskDumpSampler,
    activation: Arc<AtomicU64>,
    published: bool,
}

#[derive(Default)]
struct WorkerSamplers {
    workers: Vec<WorkerSampler>,
    current: Option<usize>,
}

crate::primitives::thread_local! {
    // Switching between current-thread runtimes preserves each sampler. The
    // active index is installed by the worker hook, never searched per poll.
    static SAMPLERS: RefCell<WorkerSamplers> = const {
        RefCell::new(WorkerSamplers { workers: Vec::new(), current: None })
    };
}

/// Install the sampler when a runtime hook resolves this worker's identity.
pub(crate) fn set_worker_sampler(
    runtime_id: u64,
    worker_id: u64,
    config: Option<TaskDumpConfig>,
    activation: Option<Arc<AtomicU64>>,
) {
    SAMPLERS.with(|cell| {
        let mut state = cell.borrow_mut();
        state.current = config.map(|config| {
            let key = (runtime_id, worker_id);
            if let Some(index) = state.workers.iter().position(|w| w.key == key) {
                return index;
            }
            let sampler = TaskDumpSampler::new(
                config,
                worker_id,
                crate::telemetry::events::clock_monotonic_ns(),
            );
            let index = state.workers.len();
            state.workers.push(WorkerSampler {
                key,
                sampler,
                activation: activation.expect("configured worker has activation metadata"),
                published: false,
            });
            index
        });
    });
}

pub(crate) fn clear_worker_sampler() {
    SAMPLERS.with(|cell| *cell.borrow_mut() = WorkerSamplers::default());
}

fn observe_pending() -> Option<f64> {
    SAMPLERS.with(|cell| {
        let mut state = cell.borrow_mut();
        let index = state.current?;
        let worker = &mut state.workers[index];
        let selected = worker
            .sampler
            .observe_pending(crate::telemetry::recorder::poll_start_ts_monotonic());
        if !worker.published
            && let Some(timestamp) = worker.sampler.sampling_active_ns
        {
            worker.activation.store(timestamp, Ordering::Relaxed);
            worker.published = true;
        }
        selected
    })
}

// ─── TaskDumped future wrapper ──────────────────────────────────────────────

pin_project! {
    /// Future wrapper that captures async backtraces at yield points using
    /// a shared worker-local capture budget.
    pub(crate) struct TaskDumped<F> {
        #[pin]
        inner: F,
        handle: Dial9Handle,
        task_id: TaskId,
        frames: FrameBuf,
        // Skip the next capture, but not the normal poll, to break capture-wake loops.
        just_captured: bool,
    }
}

impl<F> TaskDumped<F> {
    pub(crate) fn new(inner: F, handle: Dial9Handle, task_id: TaskId) -> Self {
        Self {
            inner,
            handle,
            task_id,
            frames: FrameBuf::new(),
            just_captured: false,
        }
    }
}

impl<F: Future> Future for TaskDumped<F> {
    type Output = F::Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let mut this = self.project();
        let configured = SAMPLERS.with(|cell| cell.borrow().current.is_some());
        if !configured || !this.handle.is_enabled() {
            *this.just_captured = false;
            return this.inner.poll(cx);
        }
        let result = this.inner.as_mut().poll(cx);
        if result.is_ready() {
            return result;
        }
        if std::mem::take(this.just_captured) {
            return Poll::Pending;
        }
        let Some(probability) = observe_pending() else {
            return Poll::Pending;
        };
        let result = this.frames.capture(this.inner.as_mut(), cx);
        if result.is_ready() {
            // A completed capture re-poll has no following idle interval.
            this.frames.clear();
            return result;
        }
        *this.just_captured = true;
        // Read the actual capture time once for the entire callchain group.
        // PollStart can precede capture by substantial application work.
        let timestamp = crate::telemetry::events::clock_monotonic_ns();
        this.frames
            .emit(this.handle, *this.task_id, timestamp, probability);
        Poll::Pending
    }
}

/// Metadata for one captured callchain stored in [`FrameBuf`].
struct ChainMeta {
    /// Index into `FrameBuf::ips` where this chain's frames start.
    ip_start: usize,
    /// Address of the root function (upper trim boundary). `None` means trim
    /// to the end of the buffer.
    root_addr: Option<*const core::ffi::c_void>,
    /// Address of the leaf function (lower trim boundary). `None` means no
    /// leaf boundary was available; the chain will be skipped at emit time.
    leaf_addr: Option<*const core::ffi::c_void>,
}

// SAFETY: raw pointers are only used for address comparison, never dereferenced
// across threads.
unsafe impl Send for ChainMeta {}

/// Reusable storage for one or more callchains captured during a single
/// `trace_with` sub-poll. Frames are appended flat to `ips`; each new chain's
/// metadata is pushed onto `chains`.
struct FrameBuf {
    ips: Vec<u64>,
    chains: SmallVec<[ChainMeta; 4]>,
}

impl FrameBuf {
    fn new() -> Self {
        Self {
            ips: Vec::new(),
            chains: SmallVec::new(),
        }
    }

    fn clear(&mut self) {
        self.ips.clear();
        self.chains.clear();
    }

    /// Emit one `TaskDumpEvent` per recorded callchain, then clear.
    /// Trimming via `_Unwind_FindEnclosingFunction` happens here (emit path)
    /// rather than during capture, keeping the hot path lock-free.
    fn emit(
        &mut self,
        handle: &Dial9Handle,
        task_id: TaskId,
        capture_ts: u64,
        inclusion_probability: f64,
    ) {
        for (i, meta) in self.chains.iter().enumerate() {
            let ip_end = self
                .chains
                .get(i + 1)
                .map(|next| next.ip_start)
                .unwrap_or(self.ips.len());
            let raw = &self.ips[meta.ip_start..ip_end];
            let chain = match meta.leaf_addr {
                Some(leaf) => crate::unwind::trim_frames(raw, meta.root_addr, leaf),
                None => &[],
            };
            if !chain.is_empty() {
                handle.record_event_with(|| TaskDumpData {
                    timestamp_ns: capture_ts,
                    task_id,
                    callchain: chain,
                    inclusion_probability,
                });
            }
        }
        self.clear();
    }

    /// Capture backtraces at yield points by re-polling `inner` under the
    /// real waker inside `trace_with`, returning that re-poll's result.
    ///
    /// The re-poll can complete `inner`; that `Ready` is returned so the caller
    /// can adopt it.
    fn capture<F: Future>(&mut self, inner: Pin<&mut F>, cx: &mut Context<'_>) -> Poll<F::Output> {
        if self.ips.capacity() == 0 {
            self.ips.reserve(FRAME_BUF_INITIAL_CAPACITY);
        }
        self.clear();

        let ips = &mut self.ips;
        let chains = &mut self.chains;

        // `trace_with`'s outer closure is `FnOnce`; `Option::take` moves the
        // pinned reference in without requiring a `Copy` bound or unsafe.
        let mut result = Poll::Pending;
        tokio::runtime::dump::trace_with(
            || {
                result = inner.poll(cx);
            },
            |meta| {
                let ip_start = ips.len();
                // Hot path: collect raw IPs only — no _Unwind_FindEnclosingFunction,
                // no dl_iterate_phdr, no global locks. Trimming to root/leaf
                // boundaries happens later in emit().
                crate::unwind::collect_frames_raw(ips);
                // Stash the root/leaf addresses so we can trim at emit time.
                chains.push(ChainMeta {
                    ip_start,
                    root_addr: meta.root_addr,
                    leaf_addr: Some(meta.trace_leaf_addr),
                });
            },
        );
        result
    }
}

/// Borrowed-callchain view of a task-dump event that implements [`Encodable`]
/// by interning its ips into the batch's stack pool.
pub(crate) struct TaskDumpData<'a> {
    pub(crate) timestamp_ns: u64,
    pub(crate) task_id: TaskId,
    pub(crate) callchain: &'a [u64],
    pub(crate) inclusion_probability: f64,
}

impl Encodable for TaskDumpData<'_> {
    fn encode(&self, enc: &mut ThreadLocalEncoder<'_>) {
        let interned_callchain = enc.intern_stack_frames(self.callchain);
        enc.encode(&TaskDumpEvent {
            timestamp_ns: self.timestamp_ns,
            task_id: self.task_id,
            callchain: interned_callchain,
            inclusion_probability: self.inclusion_probability,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::analysis_events::Dial9Event;
    use crate::telemetry::encoder::encode_single;
    use crate::telemetry::format::decode_events;
    use crate::telemetry::task_metadata::TaskId;

    fn install_test_sampler(calibrated: bool) {
        clear_worker_sampler();
        let config = TaskDumpConfig::builder().rng_seed(42).build();
        set_worker_sampler(1, 0, Some(config), Some(Arc::new(AtomicU64::new(0))));
        if calibrated {
            SAMPLERS.with(|cell| {
                cell.borrow_mut().workers[0].sampler = TaskDumpSampler::new(
                    config,
                    0,
                    crate::telemetry::events::clock_monotonic_ns() - 1_000_000_000,
                );
            });
        }
    }

    #[test]
    fn non_selected_polls_never_repoll_or_reserve_frames() {
        use std::cell::Cell;
        use std::future::poll_fn;
        use std::task::Waker;

        let recorder =
            crate::telemetry::recorder(crate::telemetry::MemoryBuffer::new(1024 * 1024).unwrap())
                .build();
        install_test_sampler(false);
        let polls = Cell::new(0);
        let inner = poll_fn(|_| {
            polls.set(polls.get() + 1);
            Poll::<()>::Pending
        });
        let mut future = TaskDumped::new(inner, recorder.handle().clone(), TaskId::from_u32(1));
        let mut cx = Context::from_waker(Waker::noop());
        for _ in 0..100 {
            assert!(Pin::new(&mut future).poll(&mut cx).is_pending());
        }
        assert_eq!(polls.get(), 100);
        assert_eq!(future.frames.ips.capacity(), 0);

        // Exercise the calibrated geometric-skip path as well as warm-up.
        SAMPLERS.with(|cell| {
            let now = crate::telemetry::events::clock_monotonic_ns();
            let mut sampler = TaskDumpSampler::new(
                TaskDumpConfig::builder()
                    .captures_per_second_per_worker(1)
                    .rng_seed(42)
                    .build(),
                0,
                now - 1_000_000_000,
            );
            for i in 0..100_000 {
                assert_eq!(sampler.observe_pending(now - 1_000_000_000 + i), None);
            }
            cell.borrow_mut().workers[0].sampler = sampler;
        });
        for _ in 0..100 {
            assert!(Pin::new(&mut future).poll(&mut cx).is_pending());
        }
        assert_eq!(polls.get(), 200);
        assert_eq!(future.frames.ips.capacity(), 0);

        install_test_sampler(true);
        recorder.disable();
        assert!(Pin::new(&mut future).poll(&mut cx).is_pending());
        assert_eq!(polls.get(), 201);
        assert_eq!(future.frames.ips.capacity(), 0);
        clear_worker_sampler();
    }

    #[test]
    fn ready_during_selected_repoll_is_returned_without_emission() {
        use std::future::poll_fn;
        use std::task::Waker;

        let recorder =
            crate::telemetry::recorder(crate::telemetry::MemoryBuffer::new(1024 * 1024).unwrap())
                .build();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let _guard = runtime.enter();
        install_test_sampler(true);
        let mut polls = 0;
        let inner = poll_fn(|_| {
            polls += 1;
            match polls {
                1 => Poll::Pending,
                2 => Poll::Ready(17),
                _ => panic!("polled after completion"),
            }
        });
        let mut future = TaskDumped::new(inner, recorder.handle().clone(), TaskId::from_u32(1));
        assert_eq!(
            Pin::new(&mut future).poll(&mut Context::from_waker(Waker::noop())),
            Poll::Ready(17)
        );
        assert!(future.frames.ips.is_empty());
        assert!(future.frames.chains.is_empty());
        assert!(!future.just_captured);
        clear_worker_sampler();
    }

    #[test]
    fn task_dump_event_round_trips() {
        let dump = TaskDumpData {
            timestamp_ns: 42_000,
            task_id: TaskId::from_u32(17),
            callchain: &[0x1111_2222, 0x3333_4444, 0x5555_6666],
            inclusion_probability: 0.125,
        };
        let encoded = encode_single(&dump);
        let events = decode_events(&encoded).expect("decode");
        assert_eq!(events.len(), 1);
        let Dial9Event::TaskDumpEvent(ref e) = events[0] else {
            panic!("expected TaskDumpEvent, got {:?}", events[0]);
        };
        assert_eq!(e.timestamp_ns, 42_000);
        assert_eq!(e.task_id, 17);
        assert_eq!(e.inclusion_probability, 0.125);
        assert_eq!(e.callchain, vec![0x1111_2222, 0x3333_4444, 0x5555_6666]);
    }
}
