//! Worker-local selection of eligible pending transitions before stack capture.

use crate::telemetry::TaskDumpConfig;
use dial9_core::sampling::SplitMix64;

const EPOCH_NS: u64 = 1_000_000_000;

/// One sampler per runtime worker, shared by all its eligible transitions.
/// Clock reads and publication of activation metadata belong to the caller.
#[derive(Debug)]
pub(crate) struct WorkerTaskDumpSampler {
    target_per_epoch: f64,
    epoch_start_ns: u64,
    eligible_count: u64,
    inclusion_probability: f64,
    skip: u64,
    rng: SplitMix64,
    sampling_active_ns: Option<u64>,
}

impl WorkerTaskDumpSampler {
    pub(crate) fn new(config: TaskDumpConfig, worker_id: u64, now_ns: u64) -> Self {
        let seed = config.rng_seed().unwrap_or(now_ns) ^ worker_id.wrapping_mul(0x9e3779b97f4a7c15);
        // Mix once more so worker IDs do not simply offset the SplitMix stream.
        let seed = SplitMix64::new(seed).next_u64();
        Self {
            target_per_epoch: EPOCH_NS as f64 / config.capture_interval().as_nanos() as f64,
            epoch_start_ns: now_ns,
            eligible_count: 0,
            inclusion_probability: 0.0,
            skip: 0,
            rng: SplitMix64::new(seed),
            sampling_active_ns: None,
        }
    }

    /// Observe one eligible pending transition at a monotonic timestamp.
    /// Returns the probability used if selected, or `None` otherwise.
    /// The first one-second epoch only measures the pending-transition rate.
    pub(crate) fn observe_pending(&mut self, now_ns: u64) -> Option<f64> {
        let elapsed_epochs = (now_ns - self.epoch_start_ns) / EPOCH_NS;
        if elapsed_epochs > 0 {
            // A skipped epoch had no observations. Do not reuse a busy epoch's
            // rate after the worker has spent a complete epoch idle.
            self.inclusion_probability = if elapsed_epochs > 1 || self.eligible_count == 0 {
                1.0
            } else {
                (self.target_per_epoch / self.eligible_count as f64).min(1.0)
            };
            self.epoch_start_ns += elapsed_epochs * EPOCH_NS;
            self.eligible_count = 0;
            self.skip = self.draw_skip();
            self.sampling_active_ns.get_or_insert(now_ns);
        }

        // The boundary transition belongs to the new epoch, so it cannot
        // influence its own selection probability.
        self.eligible_count += 1;
        self.sampling_active_ns?;
        if self.skip > 0 {
            self.skip -= 1;
            return None;
        }

        self.skip = self.draw_skip();
        Some(self.inclusion_probability)
    }

    pub(crate) fn sampling_active_ns(&self) -> Option<u64> {
        self.sampling_active_ns
    }

    /// Number of failures before a Bernoulli success, including zero.
    fn draw_skip(&mut self) -> u64 {
        if self.inclusion_probability == 1.0 {
            return 0;
        }
        // Uniform in (0, 1]: neither ln(0) nor a clamped point mass at zero.
        let u = ((self.rng.next_u64() >> 11) + 1) as f64 / (1_u64 << 53) as f64;
        // ln_1p retains precision when the inclusion probability is tiny.
        (u.ln() / (-self.inclusion_probability).ln_1p()).floor() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::WorkerTaskDumpSampler;
    use crate::telemetry::TaskDumpConfig;

    const SECOND: u64 = 1_000_000_000;

    fn sampler(rate: u64, worker: u64) -> WorkerTaskDumpSampler {
        WorkerTaskDumpSampler::new(
            TaskDumpConfig::builder()
                .captures_per_second_per_worker(rate)
                .rng_seed(42)
                .build(),
            worker,
            0,
        )
    }

    #[test]
    fn first_epoch_only_calibrates_and_activation_is_published_once() {
        let mut sampler = sampler(10, 0);
        for i in 0..10 {
            assert_eq!(sampler.observe_pending(i * SECOND / 10), None);
            assert_eq!(sampler.sampling_active_ns(), None);
        }
        assert_eq!(sampler.observe_pending(SECOND), Some(1.0));
        assert_eq!(sampler.sampling_active_ns(), Some(SECOND));
        assert_eq!(sampler.observe_pending(2 * SECOND), Some(1.0));
        assert_eq!(sampler.sampling_active_ns(), Some(SECOND));
    }

    #[test]
    fn calibration_starts_at_initialization_even_without_pending_polls() {
        let start = 7 * SECOND;
        let mut sampler = WorkerTaskDumpSampler::new(TaskDumpConfig::default(), 0, start);
        assert_eq!(sampler.sampling_active_ns(), None);
        assert_eq!(sampler.observe_pending(start + SECOND), Some(1.0));
        assert_eq!(sampler.sampling_active_ns(), Some(start + SECOND));
    }

    #[test]
    fn probability_uses_the_previous_epoch_and_excludes_the_boundary_poll() {
        let mut sampler = sampler(10, 0);
        for i in 0..100 {
            assert_eq!(sampler.observe_pending(i * SECOND / 100), None);
        }
        let selected: Vec<_> = (0..1000)
            .filter_map(|i| sampler.observe_pending(SECOND + i * SECOND / 1000))
            .collect();
        assert!(!selected.is_empty());
        assert!(selected.iter().all(|&p| p == 0.1));
        let selected: Vec<_> = (0..1000)
            .filter_map(|i| sampler.observe_pending(2 * SECOND + i * SECOND / 1000))
            .collect();
        assert!(!selected.is_empty());
        assert!(selected.iter().all(|&p| p == 0.01));
    }

    #[test]
    fn quiet_workers_capture_every_transition_and_reset_the_skip() {
        let mut sampler = sampler(10, 0);
        for i in 0..1000 {
            sampler.observe_pending(i * SECOND / 1000);
        }
        sampler.observe_pending(SECOND);
        // The preceding complete epoch is empty, regardless of older traffic.
        assert_eq!(sampler.observe_pending(4 * SECOND), Some(1.0));
        assert_eq!(sampler.observe_pending(4 * SECOND + 1), Some(1.0));
    }

    #[test]
    fn epochs_keep_fixed_boundaries_when_a_worker_is_polled_late() {
        let mut sampler = sampler(10, 0);
        for i in 0..100 {
            sampler.observe_pending(i * SECOND / 100);
        }
        // The first observation in epoch 1 arrives halfway through it.
        sampler.observe_pending(SECOND + SECOND / 2);
        assert_eq!(sampler.sampling_active_ns(), Some(SECOND + SECOND / 2));
        // Epoch 1 had just one transition: p must change at 2s, not 2.5s.
        assert_eq!(sampler.observe_pending(2 * SECOND), Some(1.0));
    }

    fn selections(sampler: &mut WorkerTaskDumpSampler) -> Vec<(u64, f64)> {
        (0..10_000)
            .filter_map(|i| {
                let timestamp = i * SECOND / 1000;
                sampler.observe_pending(timestamp).map(|p| (timestamp, p))
            })
            .collect()
    }

    #[test]
    fn fixed_seed_repeats_but_different_workers_have_independent_streams() {
        let first = selections(&mut sampler(10, 0));
        assert!(!first.is_empty());
        assert_eq!(first, selections(&mut sampler(10, 0)));
        assert_ne!(first, selections(&mut sampler(10, 1)));
    }

    #[test]
    fn another_workers_traffic_does_not_change_selection() {
        let mut first = sampler(10, 0);
        let mut busy = sampler(10, 1);
        let mut selected = Vec::new();
        for i in 0..10_000 {
            let timestamp = i * SECOND / 1000;
            for _ in 0..10 {
                busy.observe_pending(timestamp);
            }
            if let Some(p) = first.observe_pending(timestamp) {
                selected.push((timestamp, p));
            }
        }
        assert_eq!(selected, selections(&mut sampler(10, 0)));
    }

    #[test]
    fn capture_rate_converges_across_pending_poll_rates() {
        for pending_per_second in [1, 5, 10, 100, 1000, 10_000] {
            let mut sampler = sampler(10, 0);
            let mut captured = 0;
            for epoch in 0..201 {
                for i in 0..pending_per_second {
                    if sampler
                        .observe_pending(epoch * SECOND + i * SECOND / pending_per_second)
                        .is_some()
                    {
                        captured += 1;
                    }
                }
            }
            let expected = 200 * pending_per_second.min(10);
            assert!(
                (captured as f64 - expected as f64).abs() <= expected as f64 * 0.08,
                "{pending_per_second} pending/s: {captured} captures, expected about {expected}",
            );
        }
    }

    #[test]
    fn inverse_probability_weights_recover_wait_time_as_traffic_changes() {
        let mut sampler = sampler(10, 0);
        let mut actual = 0.0;
        let mut estimated = 0.0;
        for epoch in 0..401 {
            let pending_per_second = if epoch % 2 == 0 { 100 } else { 1000 };
            for i in 0..pending_per_second {
                let probability =
                    sampler.observe_pending(epoch * SECOND + i * SECOND / pending_per_second);
                let wait_ns = (1 + i % 7) as f64 * 1000.0;
                if epoch > 0 {
                    actual += wait_ns;
                    if let Some(p) = probability {
                        estimated += wait_ns / p;
                    }
                }
            }
        }
        assert!(
            (estimated - actual).abs() < actual * 0.08,
            "estimated wait {estimated}, actual wait {actual}",
        );
    }
}
