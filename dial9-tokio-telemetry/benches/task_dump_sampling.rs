//! Measure the sampling decision independently of stack capture, then the full
//! runtime poll path when built with `--features taskdump` (Linux only).
//! cargo bench -p dial9-tokio-telemetry --bench task_dump_sampling
//! cargo bench -p dial9-tokio-telemetry --features taskdump --bench task_dump_sampling -- runtime

use criterion::{BenchmarkId, Criterion};
use dial9_core::primitives;
use dial9_tokio_telemetry::telemetry;
use std::hint::black_box;
use std::sync::{Arc, Barrier, atomic::AtomicU64};
use std::time::{Duration, Instant};

// Benchmark the actual private implementation without adding a public API.
#[path = "../src/task_dump_sampler.rs"]
#[allow(dead_code, unused_imports)]
mod sampler;
use sampler::{TaskDumpSampler, WorkerTaskDumpSampler};

const EPOCH: u64 = 1_000_000_000;

fn config() -> telemetry::TaskDumpConfig {
    telemetry::TaskDumpConfig::builder().rng_seed(42).build()
}

fn calibrated_worker(id: u64) -> WorkerTaskDumpSampler {
    let worker = WorkerTaskDumpSampler::new(config(), id, 0, Arc::new(AtomicU64::new(0)));
    for i in 0..100_000 {
        black_box(worker.observe_pending(|| i));
    }
    worker
}

fn decisions(c: &mut Criterion) {
    let mut group = c.benchmark_group("sampling_decision");
    let mut local = TaskDumpSampler::new(config(), 0, 0);
    for i in 0..100_000 {
        black_box(local.observe_pending(i));
    }
    group.bench_function("local_reference", |b| {
        b.iter(|| black_box(local.observe_pending(black_box(EPOCH))));
    });
    let worker = calibrated_worker(0);
    group.bench_function("shared_worker", |b| {
        b.iter(|| black_box(worker.observe_pending(|| black_box(EPOCH))));
    });
    let worker = calibrated_worker(0);
    group.bench_function("shared_worker_with_clock", |b| {
        b.iter(|| {
            black_box(worker.observe_pending(|| {
                // Isolate the clock read with the same probability as shared_worker.
                // runtime_polls exercises real epoch changes.
                black_box(dial9_core::clock::clock_monotonic_ns());
                black_box(EPOCH)
            }))
        });
    });
    for threads in [2, 8] {
        for shared in [false, true] {
            let name = if shared {
                "contended_worker"
            } else {
                "independent_workers"
            };
            group.bench_with_input(BenchmarkId::new(name, threads), &threads, |b, &threads| {
                let workers: Vec<_> = (0..if shared { 1 } else { threads })
                    .map(|id| Arc::new(calibrated_worker(id)))
                    .collect();
                b.iter_custom(|iterations| {
                    let barrier = Barrier::new(threads as usize);
                    let start = Instant::now();
                    std::thread::scope(|scope| {
                        for id in 0..threads {
                            let worker = &workers[if shared { 0 } else { id as usize }];
                            let barrier = &barrier;
                            scope.spawn(move || {
                                barrier.wait();
                                for _ in 0..iterations {
                                    black_box(worker.observe_pending(|| black_box(EPOCH)));
                                }
                            });
                        }
                    });
                    // Aggregate elapsed time per transition, including join costs.
                    start.elapsed() / threads as u32
                });
            });
        }
    }
    group.finish();
}

#[cfg(feature = "taskdump")]
fn runtime_polls(c: &mut Criterion) {
    use telemetry::{Dial9HandleTokioExt, Dial9TokioHandle, MemoryBuffer, TokioAttachOptions};
    const POLLS: u64 = 10_000;
    let mut group = c.benchmark_group("runtime_pending_poll");
    for enabled in [false, true] {
        let recorder = telemetry::recorder(MemoryBuffer::new(16 * 1024 * 1024).unwrap()).build();
        let mut builder = tokio::runtime::Builder::new_current_thread();
        builder.enable_all();
        let rt = recorder
            .handle()
            .attach_tokio_runtime(
                builder,
                TokioAttachOptions::builder()
                    .maybe_task_dump_config(enabled.then(config))
                    .build(),
            )
            .unwrap();
        let handle = Dial9TokioHandle::current();
        let run_batch = || {
            rt.block_on(async {
                handle
                    .spawn(async {
                        for _ in 0..POLLS {
                            tokio::task::yield_now().await;
                        }
                    })
                    .await
                    .unwrap();
            });
        };
        // Calibrate at the benchmark's poll rate before measuring active sampling.
        let warmup = Instant::now();
        while warmup.elapsed() < Duration::from_secs(2) {
            run_batch();
        }
        group.bench_function(if enabled { "sampling_10hz" } else { "disabled" }, |b| {
            b.iter_custom(|iterations| {
                let batches = iterations.div_ceil(POLLS);
                let start = Instant::now();
                for _ in 0..batches {
                    run_batch();
                }
                // Criterion's iteration unit is one poll, not one batch.
                start
                    .elapsed()
                    .mul_f64(iterations as f64 / (batches * POLLS) as f64)
            });
        });
        drop(rt);
        recorder.graceful_shutdown(Duration::from_secs(1));
    }
    group.finish();
}

fn main() {
    let mut c = Criterion::default()
        .sample_size(20)
        .warm_up_time(Duration::from_millis(500))
        .measurement_time(Duration::from_secs(1))
        .configure_from_args();
    decisions(&mut c);
    #[cfg(feature = "taskdump")]
    runtime_polls(&mut c);
    c.final_summary();
}
