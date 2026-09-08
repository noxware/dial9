//! Configuration for task dump capture.
//!
//! Task dumps capture async backtraces at yield points. The capture interval
//! configures the expected wall-clock budget shared by tasks on each worker.
//! Pass [`TaskDumpConfig`] to
//! [`TokioAttachOptions`](crate::telemetry::TokioAttachOptions) when attaching a
//! runtime.
//!
//! Capture requires the `taskdump` crate feature, `--cfg tokio_unstable`, and a
//! supported Linux target. With the feature off, this module is still compiled
//! so the configuration API surface stays the same, but no dumps are captured.

use std::time::Duration;

/// Default budget: ten captures per second per worker.
const DEFAULT_CAPTURE_INTERVAL: Duration = Duration::from_millis(100);

/// Configuration for task dump capture.
///
/// <div class="warning">
///
/// This enables capture but does not instrument every task on the attached
/// runtime. Only futures spawned through a Dial9 spawner, such as
/// `dial9::spawn`, can produce task dumps. Futures spawned directly with
/// `tokio::spawn` remain valid, but do not produce task dumps.
///
/// </div>
#[derive(Debug, Clone, Copy, bon::Builder)]
#[builder(finish_fn(name = build_unchecked, vis = ""))]
pub struct TaskDumpConfig {
    /// Mean wall-clock interval between captures on one worker.
    // Preserve the published builder's IdleThreshold typestate names.
    #[builder(
        name = idle_threshold,
        default = DEFAULT_CAPTURE_INTERVAL,
        setters(name = capture_interval_internal, vis = "")
    )]
    capture_interval: Duration,

    /// Optional fixed seed for deterministic sampling. Each worker derives its
    /// own PRNG stream from this seed and its worker ID. When `None` (default),
    /// the sampler uses its initialization timestamp as the seed.
    rng_seed: Option<u64>,
}

impl Default for TaskDumpConfig {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl TaskDumpConfig {
    /// Mean wall-clock interval between captures on one worker.
    pub fn capture_interval(&self) -> Duration {
        self.capture_interval
    }

    /// Deprecated alias for [`Self::capture_interval`].
    ///
    /// This interval now configures a per-worker wall-clock capture budget,
    /// rather than cumulative per-task idle time between emitted dumps.
    #[deprecated(note = "use capture_interval; this now represents a per-worker capture budget")]
    pub fn idle_threshold(&self) -> Duration {
        self.capture_interval()
    }

    /// Optional fixed RNG seed for deterministic sampling.
    pub fn rng_seed(&self) -> Option<u64> {
        self.rng_seed
    }
}

impl<S: task_dump_config_builder::State> TaskDumpConfigBuilder<S> {
    /// Target captures per second per worker. Defaults to 10.
    ///
    /// This is an expected rate, not a strict per-second cap. The reciprocal
    /// interval is rounded to the nearest nanosecond. `build()` rejects zero
    /// rates and rates whose interval rounds to zero. Disable task dumps by
    /// omitting the runtime's `task_dump_config` instead.
    ///
    /// The rate and legacy interval setters share one builder member:
    ///
    /// ```compile_fail
    /// use dial9_tokio_telemetry::telemetry::TaskDumpConfig;
    /// use std::time::Duration;
    ///
    /// TaskDumpConfig::builder()
    ///     .captures_per_second_per_worker(10)
    ///     .idle_threshold(Duration::from_millis(20))
    ///     .build();
    /// ```
    pub fn captures_per_second_per_worker(
        self,
        rate: u64,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        // Keep invalid input until build(), where all interval validation lives.
        let interval = if rate == 0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(1.0 / rate as f64)
        };
        self.capture_interval_internal(interval)
    }

    /// Set the capture interval using the legacy configuration name.
    ///
    /// This sets the same interval as `captures_per_second_per_worker`, so the
    /// two setters cannot be combined. The interval now represents a per-worker
    /// wall-clock budget, rather than cumulative per-task idle time.
    #[deprecated(
        note = "use captures_per_second_per_worker; idle_threshold now sets the capture interval"
    )]
    pub fn idle_threshold(
        self,
        interval: Duration,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        self.capture_interval_internal(interval)
    }

    /// Optional legacy capture interval. `None` uses the default of 100ms.
    #[deprecated(
        note = "use captures_per_second_per_worker; idle_threshold now sets the capture interval"
    )]
    pub fn maybe_idle_threshold(
        self,
        interval: Option<Duration>,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        self.maybe_capture_interval_internal(interval)
    }

    /// Build the task-dump configuration.
    ///
    /// # Panics
    ///
    /// Panics if the configured capture interval is zero, including a zero
    /// capture rate or a rate too high to represent as a nonzero `Duration`.
    #[track_caller]
    pub fn build(self) -> TaskDumpConfig
    where
        S: task_dump_config_builder::IsComplete,
    {
        let config = self.build_unchecked();
        assert!(
            !config.capture_interval.is_zero(),
            "task-dump capture interval must be nonzero; captures_per_second_per_worker must be positive and representable in nanoseconds",
        );
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_ten_captures_per_second() {
        assert_eq!(
            TaskDumpConfig::default().capture_interval(),
            Duration::from_millis(100)
        );
        assert_eq!(TaskDumpConfig::default().rng_seed(), None);
    }

    #[test]
    fn rate_sets_the_capture_interval() {
        let config = TaskDumpConfig::builder()
            .captures_per_second_per_worker(25)
            .rng_seed(42)
            .build();
        assert_eq!(config.capture_interval(), Duration::from_millis(40));
        assert_eq!(config.rng_seed(), Some(42));
    }

    #[test]
    #[allow(deprecated)]
    fn legacy_setters_and_accessor_use_the_same_interval() {
        let interval = Duration::from_millis(40);
        for config in [
            TaskDumpConfig::builder().idle_threshold(interval).build(),
            TaskDumpConfig::builder()
                .maybe_idle_threshold(Some(interval))
                .build(),
            TaskDumpConfig::builder()
                .captures_per_second_per_worker(25)
                .build(),
        ] {
            assert_eq!(config.capture_interval(), interval);
            assert_eq!(config.idle_threshold(), interval);
        }
        assert_eq!(
            TaskDumpConfig::builder()
                .maybe_idle_threshold(None)
                .build()
                .capture_interval(),
            TaskDumpConfig::default().capture_interval(),
        );
    }

    #[test]
    fn zero_rate_is_rejected_at_build_time() {
        let builder = TaskDumpConfig::builder().captures_per_second_per_worker(0);
        assert!(std::panic::catch_unwind(|| builder.build()).is_err());
    }

    #[test]
    fn rate_conversion_rounds_to_nanoseconds_and_rejects_unrepresentable_intervals() {
        let config = TaskDumpConfig::builder()
            .captures_per_second_per_worker(3)
            .build();
        assert_eq!(config.capture_interval(), Duration::from_nanos(333_333_333));
        let config = TaskDumpConfig::builder()
            .captures_per_second_per_worker(1_000_000_000)
            .build();
        assert_eq!(config.capture_interval(), Duration::from_nanos(1));
        let builder = TaskDumpConfig::builder().captures_per_second_per_worker(u64::MAX);
        assert!(std::panic::catch_unwind(|| builder.build()).is_err());
    }

    #[test]
    #[allow(deprecated)]
    fn zero_interval_is_rejected_at_build_time() {
        let builder = TaskDumpConfig::builder().idle_threshold(Duration::ZERO);
        assert!(std::panic::catch_unwind(|| builder.build()).is_err());
    }
}
