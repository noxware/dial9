use dial9_viewer_extension::{Event, Extension, ExtensionError, OutputSink};

const BATCH_ROWS: usize = 1_024;
const CONTEXT_WARNING: u64 = 8_000;
const CONTEXT_CRITICAL: u64 = 10_000;

dial9_viewer_extension::include_manifest!("viewer-extension.json");

#[derive(Clone, Copy)]
struct ResourceSample {
    timestamp_ns: u64,
    user_cpu_ns: u64,
    system_cpu_ns: u64,
    voluntary_context_switches: u64,
    involuntary_context_switches: u64,
}

#[derive(Default)]
pub struct DemoExtension {
    previous: Option<ResourceSample>,
    capacity: Option<f64>,
    cpu: tables::cpu_intervals::Batch,
    context: tables::context_switches::Batch,
    cumulative_context: tables::cumulative_context_switches::Batch,
}

impl DemoExtension {
    fn observe_resource_usage(
        &mut self,
        sample: ResourceSample,
        output: &mut OutputSink,
    ) -> Result<(), ExtensionError> {
        self.cumulative_context
            .push(cumulative_context_row(sample))?;
        if let Some(previous) = self.previous {
            self.cpu
                .push(cpu_interval_row(previous, sample, self.capacity))?;
            self.context.push(context_switch_row(previous, sample))?;
        }
        self.previous = Some(sample);

        if self.cpu.len() >= BATCH_ROWS {
            self.cpu.emit(output)?;
        }
        if self.context.len() >= BATCH_ROWS {
            self.context.emit(output)?;
        }
        if self.cumulative_context.len() >= BATCH_ROWS {
            self.cumulative_context.emit(output)?;
        }
        Ok(())
    }
}

impl Extension for DemoExtension {
    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink,
    ) -> Result<(), ExtensionError> {
        match event.name() {
            "SegmentMetadataEvent" => {
                if let Some(entries) = event
                    .field("entries")
                    .and_then(|value| value.as_string_map())
                {
                    for (key, value) in entries {
                        if key == "process.available_parallelism" {
                            self.capacity =
                                value.parse().ok().filter(|capacity: &f64| *capacity > 0.0);
                        }
                    }
                }
            }
            "ProcessResourceUsageEvent" => {
                let Some(sample) = resource_sample(&event) else {
                    return Ok(());
                };
                self.observe_resource_usage(sample, output)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink) -> Result<(), ExtensionError> {
        self.cpu.emit(output)?;
        self.context.emit(output)?;
        self.cumulative_context.emit(output)?;

        if let Some(capacity) = self.capacity {
            let mut scalars = tables::scalars::Batch::new();
            scalars.push(tables::scalars::Row { capacity })?;
            scalars.emit(output)?;
        }

        let mut limits = tables::context_limits::Batch::new();
        limits.push(tables::context_limits::Row {
            warning: CONTEXT_WARNING,
            critical: CONTEXT_CRITICAL,
        })?;
        limits.emit(output)?;

        emit_dinosaur(output)?;
        Ok(())
    }
}

fn cpu_interval_row(
    previous: ResourceSample,
    current: ResourceSample,
    capacity: Option<f64>,
) -> tables::cpu_intervals::Row {
    let wall_ns = current.timestamp_ns.checked_sub(previous.timestamp_ns);
    let user_ns = current.user_cpu_ns.checked_sub(previous.user_cpu_ns);
    let system_ns = current.system_cpu_ns.checked_sub(previous.system_cpu_ns);
    let cpu_ns = user_ns.and_then(|user| system_ns.and_then(|system| user.checked_add(system)));
    let cores = wall_ns
        .zip(cpu_ns)
        .filter(|(wall, _)| *wall > 0)
        .map(|(wall, cpu)| cpu as f64 / wall as f64)
        .filter(|value| value.is_finite());
    let percent = cores
        .zip(capacity)
        .map(|(cores, capacity)| (cores / capacity) * 100.0);

    tables::cpu_intervals::Row {
        start_ns: previous.timestamp_ns,
        end_ns: current.timestamp_ns,
        wall_ns: wall_ns.unwrap_or(0),
        cpu_ns: cpu_ns.unwrap_or(0),
        cores,
        total_percent: percent.map(|value| value.min(100.0)),
        percent,
        load: cores.map(|cores| capacity.map_or(cores, |capacity| cores / capacity)),
    }
}

fn context_switch_row(
    previous: ResourceSample,
    current: ResourceSample,
) -> tables::context_switches::Row {
    let chronological = current.timestamp_ns > previous.timestamp_ns;
    let voluntary_delta = chronological
        .then(|| {
            current
                .voluntary_context_switches
                .checked_sub(previous.voluntary_context_switches)
        })
        .flatten();
    let involuntary_delta = chronological
        .then(|| {
            current
                .involuntary_context_switches
                .checked_sub(previous.involuntary_context_switches)
        })
        .flatten();

    tables::context_switches::Row {
        start_ns: previous.timestamp_ns,
        end_ns: current.timestamp_ns,
        voluntary_delta,
        involuntary_delta,
    }
}

fn cumulative_context_row(sample: ResourceSample) -> tables::cumulative_context_switches::Row {
    tables::cumulative_context_switches::Row {
        timestamp_ns: sample.timestamp_ns,
        voluntary: sample.voluntary_context_switches,
        involuntary: sample.involuntary_context_switches,
    }
}

fn resource_sample(event: &Event<'_, '_>) -> Option<ResourceSample> {
    Some(ResourceSample {
        timestamp_ns: event.timestamp_ns()?,
        user_cpu_ns: event.field("user_cpu_ns")?.as_u64()?,
        system_cpu_ns: event.field("system_cpu_ns")?.as_u64()?,
        voluntary_context_switches: event.field("voluntary_context_switches")?.as_u64()?,
        involuntary_context_switches: event.field("involuntary_context_switches")?.as_u64()?,
    })
}

const DINO_BODY_POINTS: &[(u8, f64, &str)] = &[
    (10, 3.0, "💩"),
    (18, 4.0, "💩"),
    (28, 5.8, ""),
    (40, 7.0, ""),
    (52, 6.8, ""),
    (59, 7.8, "❤️"),
    (66, 8.4, "❤️"),
    (76, 8.2, "❤️"),
    (78, 7.0, "❤️"),
    (69, 6.7, "❤️"),
    (63, 5.4, ""),
    (68, 4.8, ""),
    (62, 5.1, ""),
    (56, 3.8, ""),
    (56, 1.2, ""),
    (50, 1.2, ""),
    (48, 3.5, ""),
    (38, 3.6, ""),
    (38, 1.1, ""),
    (32, 1.1, ""),
    (34, 4.1, ""),
    (25, 4.4, "💩"),
    (10, 3.0, "💩"),
];

const DINO_FLAME_POINTS: &[(u8, f64, &str)] = &[
    (78, 7.6, "🔥"),
    (84, 8.5, "🔥"),
    (82, 7.5, "🔥"),
    (90, 7.8, "🔥"),
    (84, 6.8, "🔥"),
    (78, 7.2, "🔥"),
];

fn emit_dinosaur(output: &mut OutputSink) -> Result<(), ExtensionError> {
    let mut body = tables::dino_body::Batch::with_capacity(DINO_BODY_POINTS.len());
    for &(x, value, tooltip) in DINO_BODY_POINTS {
        body.push(tables::dino_body::Row { x, value, tooltip })?;
    }
    body.emit(output)?;

    let mut flames = tables::dino_flames::Batch::with_capacity(DINO_FLAME_POINTS.len());
    for &(x, value, tooltip) in DINO_FLAME_POINTS {
        flames.push(tables::dino_flames::Row { x, value, tooltip })?;
    }
    flames.emit(output)?;
    Ok(())
}

dial9_viewer_extension::export_extension!(DemoExtension);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_invalid_deltas_become_gaps() {
        let previous = ResourceSample {
            timestamp_ns: 100,
            user_cpu_ns: 40,
            system_cpu_ns: 20,
            voluntary_context_switches: 4,
            involuntary_context_switches: 2,
        };
        let current = ResourceSample {
            timestamp_ns: 200,
            user_cpu_ns: 30,
            system_cpu_ns: 25,
            voluntary_context_switches: 5,
            involuntary_context_switches: 3,
        };
        let row = cpu_interval_row(previous, current, Some(4.0));
        assert_eq!(row.cores, None);
        assert_eq!(row.total_percent, None);
    }

    #[test]
    fn cpu_values_match_the_legacy_formula() {
        let previous = ResourceSample {
            timestamp_ns: 1_000,
            user_cpu_ns: 100,
            system_cpu_ns: 50,
            voluntary_context_switches: 0,
            involuntary_context_switches: 0,
        };
        let current = ResourceSample {
            timestamp_ns: 1_100,
            user_cpu_ns: 150,
            system_cpu_ns: 80,
            voluntary_context_switches: 0,
            involuntary_context_switches: 0,
        };
        let row = cpu_interval_row(previous, current, Some(4.0));
        assert_eq!(row.wall_ns, 100);
        assert_eq!(row.cpu_ns, 80);
        assert_eq!(row.cores, Some(0.8));
        assert_eq!(row.total_percent, Some(20.0));
        assert_eq!(row.load, Some(0.2));
    }

    #[test]
    fn context_switch_delta_covers_the_sample_interval() {
        let previous = ResourceSample {
            timestamp_ns: 1_000,
            user_cpu_ns: 0,
            system_cpu_ns: 0,
            voluntary_context_switches: 10,
            involuntary_context_switches: 4,
        };
        let current = ResourceSample {
            timestamp_ns: 2_000_001_000,
            user_cpu_ns: 0,
            system_cpu_ns: 0,
            voluntary_context_switches: 298,
            involuntary_context_switches: 9,
        };
        let row = context_switch_row(previous, current);
        assert_eq!(row.start_ns, 1_000);
        assert_eq!(row.end_ns, 2_000_001_000);
        assert_eq!(row.voluntary_delta, Some(288));
        assert_eq!(row.involuntary_delta, Some(5));
    }

    #[test]
    fn cumulative_context_switches_preserve_every_sample() {
        let rows = [
            ResourceSample {
                timestamp_ns: 1_000,
                user_cpu_ns: 0,
                system_cpu_ns: 0,
                voluntary_context_switches: 10,
                involuntary_context_switches: 4,
            },
            ResourceSample {
                timestamp_ns: 2_000,
                user_cpu_ns: 0,
                system_cpu_ns: 0,
                voluntary_context_switches: 298,
                involuntary_context_switches: 9,
            },
        ]
        .map(cumulative_context_row);
        assert_eq!(rows[0].timestamp_ns, 1_000);
        assert_eq!(rows[1].timestamp_ns, 2_000);
        assert_eq!(rows[0].voluntary, 10);
        assert_eq!(rows[1].voluntary, 298);
        assert_eq!(rows[0].involuntary, 4);
        assert_eq!(rows[1].involuntary, 9);
    }

    #[test]
    fn dinosaur_preserves_repeated_and_backward_coordinates() {
        let percentages: Vec<_> = DINO_BODY_POINTS
            .iter()
            .map(|(percent, _, _)| *percent)
            .collect();
        assert!(percentages.windows(2).any(|pair| pair[0] == pair[1]));
        assert!(percentages.windows(2).any(|pair| pair[0] > pair[1]));
        assert!(DINO_BODY_POINTS.iter().any(|point| point.2 == "💩"));
        assert!(DINO_BODY_POINTS.iter().any(|point| point.2 == "❤️"));
        assert!(DINO_FLAME_POINTS.iter().all(|point| point.2 == "🔥"));
    }
}
