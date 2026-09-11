//! Configuration for task dump capture.
//!
//! Task dumps sample pending transitions before capturing async backtraces.
//! Pass [`TaskDumpConfig`] to
//! [`TokioAttachOptions`](crate::telemetry::TokioAttachOptions) when attaching a
//! runtime.
//!
//! Capture requires the `taskdump` crate feature, `--cfg tokio_unstable`, and a
//! supported Linux target. With the feature off, this module is still compiled
//! so the configuration API surface stays the same, but no dumps are captured.

use std::time::Duration;

/// Default expected capture budget: 10 captures/second/worker.
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
pub struct TaskDumpConfig {
    // Keep the field name for Bon's public IdleThreshold type-state API.
    // Its value is now the mean capture interval per worker.
    #[builder(default = DEFAULT_CAPTURE_INTERVAL, setters(vis = "", name = capture_interval))]
    idle_threshold: Duration,

    /// Optional fixed seed for deterministic sampling given the same worker
    /// identities and pending-transition timestamps. Each worker derives its
    /// own PRNG from this seed. By default, workers use a timestamp as seed.
    rng_seed: Option<u64>,
}

impl Default for TaskDumpConfig {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl TaskDumpConfig {
    /// Expected captures per second per runtime worker (default: 10).
    ///
    /// This is a long-run budget, not a strict cap. Workers calibrate for one
    /// second before capturing. Low-volume workers may capture every pending
    /// transition and still remain below the target.
    pub fn captures_per_second_per_worker(&self) -> f64 {
        1.0 / self.idle_threshold.as_secs_f64()
    }

    /// Mean wall-clock capture interval per worker.
    ///
    /// This no longer controls sampling by cumulative task idle time.
    #[deprecated(
        note = "use captures_per_second_per_worker; sampling now budgets captures per worker"
    )]
    pub fn idle_threshold(&self) -> Duration {
        self.idle_threshold
    }

    /// Optional fixed RNG seed for deterministic sampling.
    pub fn rng_seed(&self) -> Option<u64> {
        self.rng_seed
    }
}

impl<S: task_dump_config_builder::State> TaskDumpConfigBuilder<S> {
    /// Target a positive number of captures per second per worker. Defaults to 10.
    ///
    /// Panics if `rate` is zero. Omit the runtime's `task_dump_config` to disable
    /// capture. Rates above nanosecond resolution are rounded to a 1ns interval.
    pub fn captures_per_second_per_worker(
        self,
        rate: u32,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        assert!(rate > 0, "captures_per_second_per_worker must be positive");
        self.capture_interval(
            Duration::from_secs_f64(1.0 / f64::from(rate)).max(Duration::from_nanos(1)),
        )
    }

    /// Set the mean wall-clock capture interval per worker.
    ///
    /// This alias no longer samples by cumulative idle time. Zero retains the
    /// old capture-every-transition behavior, after the calibration epoch.
    #[deprecated(
        note = "use captures_per_second_per_worker; sampling now budgets captures per worker"
    )]
    pub fn idle_threshold(
        self,
        interval: Duration,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        self.capture_interval(interval.max(Duration::from_nanos(1)))
    }

    /// Optionally set the deprecated capture-interval alias.
    #[deprecated(note = "use captures_per_second_per_worker")]
    pub fn maybe_idle_threshold(
        self,
        interval: Option<Duration>,
    ) -> TaskDumpConfigBuilder<task_dump_config_builder::SetIdleThreshold<S>>
    where
        S::IdleThreshold: task_dump_config_builder::IsUnset,
    {
        self.capture_interval(
            interval
                .unwrap_or(DEFAULT_CAPTURE_INTERVAL)
                .max(Duration::from_nanos(1)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_explicit_rate() {
        assert_eq!(
            TaskDumpConfig::default().captures_per_second_per_worker(),
            10.0
        );
        let config = TaskDumpConfig::builder()
            .captures_per_second_per_worker(40)
            .rng_seed(7)
            .build();
        assert_eq!(config.captures_per_second_per_worker(), 40.0);
        assert_eq!(config.rng_seed(), Some(7));
    }

    #[test]
    #[should_panic(expected = "captures_per_second_per_worker must be positive")]
    fn zero_rate_is_rejected() {
        let _ = TaskDumpConfig::builder()
            .captures_per_second_per_worker(0)
            .build();
    }

    #[test]
    #[allow(deprecated)]
    fn legacy_aliases_share_the_capture_interval() {
        let interval = Duration::from_millis(250);
        let legacy = TaskDumpConfig::builder().idle_threshold(interval).build();
        let new = TaskDumpConfig::builder()
            .captures_per_second_per_worker(4)
            .build();
        assert_eq!(legacy.idle_threshold(), new.idle_threshold());
        assert_eq!(legacy.captures_per_second_per_worker(), 4.0);
        assert_eq!(
            TaskDumpConfig::builder()
                .maybe_idle_threshold(None)
                .build()
                .idle_threshold(),
            DEFAULT_CAPTURE_INTERVAL
        );
        assert_eq!(
            TaskDumpConfig::builder()
                .maybe_idle_threshold(Some(interval))
                .build()
                .idle_threshold(),
            interval
        );
        assert!(
            TaskDumpConfig::builder()
                .idle_threshold(Duration::ZERO)
                .build()
                .captures_per_second_per_worker()
                .is_finite()
        );
    }
}
