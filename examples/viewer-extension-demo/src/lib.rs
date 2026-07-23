use dial9_viewer_extension::{
    Component, DisplayField, Event, Extension, ExtensionError, LegendAtCursor, LegendStaticItem,
    Panel, Sampling, Scale, Table, TooltipStrategy, ViewBundle, XAxis,
};

const USAGE_EVENT: &str = "ProcessResourceUsageEvent";
const CPU_COLOR: &str = "#4fc3f7";
const VOLUNTARY_COLOR: &str = "#81c784";
const INVOLUNTARY_COLOR: &str = "#ff8a65";
const DINO_COLOR: &str = "#66bb6a";

#[derive(Clone, Copy)]
struct Usage {
    timestamp_ns: u64,
    user_cpu_ns: u64,
    system_cpu_ns: u64,
    voluntary: u64,
    involuntary: u64,
}

#[derive(Default)]
pub struct DemoExtension {
    usage: Vec<Usage>,
}

impl Extension for DemoExtension {
    fn on_event(&mut self, event: Event<'_, '_>) -> Result<(), ExtensionError> {
        if event.name() != USAGE_EVENT {
            return Ok(());
        }
        let Some(timestamp_ns) = event.timestamp_ns() else {
            return Ok(());
        };
        let Some(user_cpu_ns) = event.field("user_cpu_ns").and_then(|value| value.as_u64()) else {
            return Ok(());
        };
        let Some(system_cpu_ns) = event
            .field("system_cpu_ns")
            .and_then(|value| value.as_u64())
        else {
            return Ok(());
        };
        let Some(voluntary) = event
            .field("voluntary_context_switches")
            .and_then(|value| value.as_u64())
        else {
            return Ok(());
        };
        let Some(involuntary) = event
            .field("involuntary_context_switches")
            .and_then(|value| value.as_u64())
        else {
            return Ok(());
        };
        self.usage.push(Usage {
            timestamp_ns,
            user_cpu_ns,
            system_cpu_ns,
            voluntary,
            involuntary,
        });
        Ok(())
    }

    fn finish(&mut self) -> Result<ViewBundle, ExtensionError> {
        let mut usage = std::mem::take(&mut self.usage);
        usage.sort_unstable_by_key(|sample| sample.timestamp_ns);
        Ok(resource_views(&usage)
            .table(dino_points())
            .table(dino_hotspots())
            .table(dino_labels())
            .table(dino_background())
            .panel(dino_panel()))
    }
}

dial9_viewer_extension::export_extension!(DemoExtension);

fn resource_views(samples: &[Usage]) -> ViewBundle {
    let intervals = samples.len().saturating_sub(1);
    let mut starts = Vec::with_capacity(intervals);
    let mut ends = Vec::with_capacity(intervals);
    let mut wall_deltas = Vec::with_capacity(intervals);
    let mut cpu_deltas = Vec::with_capacity(intervals);
    let mut cores = Vec::with_capacity(intervals);

    let mut voluntary_starts = Vec::with_capacity(intervals);
    let mut voluntary_ends = Vec::with_capacity(intervals);
    let mut voluntary_deltas = Vec::with_capacity(intervals);
    let mut voluntary_rates = Vec::with_capacity(intervals);
    let mut voluntary_gaps = Vec::with_capacity(intervals);
    let mut involuntary_starts = Vec::with_capacity(intervals);
    let mut involuntary_ends = Vec::with_capacity(intervals);
    let mut involuntary_deltas = Vec::with_capacity(intervals);
    let mut involuntary_rates = Vec::with_capacity(intervals);
    let mut involuntary_gaps = Vec::with_capacity(intervals);
    let mut last_voluntary_end = None;
    let mut last_involuntary_end = None;

    for pair in samples.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        let Some(wall_delta) = current.timestamp_ns.checked_sub(previous.timestamp_ns) else {
            continue;
        };
        if wall_delta == 0 {
            continue;
        }

        let user_delta = current.user_cpu_ns.checked_sub(previous.user_cpu_ns);
        let system_delta = current.system_cpu_ns.checked_sub(previous.system_cpu_ns);
        if let (Some(user_delta), Some(system_delta)) = (user_delta, system_delta)
            && let Some(cpu_delta) = user_delta.checked_add(system_delta)
        {
            starts.push(previous.timestamp_ns as f64);
            ends.push(current.timestamp_ns as f64);
            wall_deltas.push(wall_delta);
            cpu_deltas.push(cpu_delta);
            cores.push(cpu_delta as f64 / wall_delta as f64);
        }

        let seconds = wall_delta as f64 / 1_000_000_000.0;
        if let Some(voluntary_delta) = current.voluntary.checked_sub(previous.voluntary) {
            voluntary_gaps.push(u8::from(
                last_voluntary_end.is_some_and(|end| end != previous.timestamp_ns),
            ));
            voluntary_starts.push(previous.timestamp_ns as f64);
            voluntary_ends.push(current.timestamp_ns as f64);
            voluntary_deltas.push(voluntary_delta);
            voluntary_rates.push(voluntary_delta as f64 / seconds);
            last_voluntary_end = Some(current.timestamp_ns);
        }
        if let Some(involuntary_delta) = current.involuntary.checked_sub(previous.involuntary) {
            involuntary_gaps.push(u8::from(
                last_involuntary_end.is_some_and(|end| end != previous.timestamp_ns),
            ));
            involuntary_starts.push(previous.timestamp_ns as f64);
            involuntary_ends.push(current.timestamp_ns as f64);
            involuntary_deltas.push(involuntary_delta);
            involuntary_rates.push(involuntary_delta as f64 / seconds);
            last_involuntary_end = Some(current.timestamp_ns);
        }
    }

    let cpu = Table::new("cpu_intervals")
        .f64("start_ns", starts)
        .f64("end_ns", ends)
        .u64("wall_delta_ns", wall_deltas)
        .u64("cpu_delta_ns", cpu_deltas)
        .f64("cores", cores);
    let voluntary = Table::new("voluntary_context_switches")
        .f64("start_ns", voluntary_starts)
        .f64("end_ns", voluntary_ends)
        .u64("delta", voluntary_deltas)
        .f64("rate", voluntary_rates)
        .u8("gap", voluntary_gaps);
    let involuntary = Table::new("involuntary_context_switches")
        .f64("start_ns", involuntary_starts)
        .f64("end_ns", involuntary_ends)
        .u64("delta", involuntary_deltas)
        .f64("rate", involuntary_rates)
        .u8("gap", involuntary_gaps);

    ViewBundle::new()
        .table(cpu)
        .table(voluntary)
        .table(involuntary)
        .panel(cpu_panel())
        .panel(context_steps_panel())
        .panel(context_lines_panel())
}

fn cpu_panel() -> Panel {
    Panel::new("custom-cpu", "CPU Usage · WASM", 100)
        .component(Component::IntervalArea {
            id: "cpu-usage".into(),
            input: "cpu_intervals".into(),
            scale: "y".into(),
            start_column: "start_ns".into(),
            end_column: "end_ns".into(),
            value_column: "cores".into(),
            color: "rgba(79, 195, 247, 0.35)".into(),
            baseline: None,
        })
        .component(Component::Tooltip {
            id: "cpu-tooltip".into(),
            target: "cpu-usage".into(),
            strategy: TooltipStrategy::Interval,
            rows: vec![
                DisplayField::new("Window", "wall_delta_ns").unit("ns"),
                DisplayField::new("CPU time", "cpu_delta_ns").unit("ns"),
                DisplayField::new("Cores", "cores").unit("cores"),
            ],
        })
        .component(Component::Legend {
            id: "cpu-legend".into(),
            position: Default::default(),
            items: vec![],
            at_cursor: vec![
                LegendAtCursor::new("cpu_intervals", "end_ns", "cores", "CPU cores")
                    .color(CPU_COLOR)
                    .unit("cores"),
            ],
        })
}

fn context_steps_panel() -> Panel {
    Panel::new("context-switch-steps", "Context Switches · Steps", 100)
        .component(Component::IntervalArea {
            id: "voluntary-steps".into(),
            input: "voluntary_context_switches".into(),
            scale: "y".into(),
            start_column: "start_ns".into(),
            end_column: "end_ns".into(),
            value_column: "rate".into(),
            color: "rgba(129, 199, 132, 0.18)".into(),
            baseline: None,
        })
        .component(Component::IntervalLine {
            id: "involuntary-steps".into(),
            input: "involuntary_context_switches".into(),
            scale: "y".into(),
            start_column: "start_ns".into(),
            end_column: "end_ns".into(),
            value_column: "rate".into(),
            color: INVOLUNTARY_COLOR.into(),
            line_width: Some(1.75),
            dash: vec![],
        })
        .component(context_tooltip(
            "voluntary-steps-tooltip",
            "voluntary-steps",
            "delta",
            "rate",
            TooltipStrategy::Interval,
        ))
        .component(context_tooltip(
            "involuntary-steps-tooltip",
            "involuntary-steps",
            "delta",
            "rate",
            TooltipStrategy::Interval,
        ))
        .component(context_legend())
}

fn context_lines_panel() -> Panel {
    Panel::new("context-switch-lines", "Context Switches · Lines", 100)
        .component(Component::Line {
            id: "voluntary-lines".into(),
            input: "voluntary_context_switches".into(),
            scale: "y".into(),
            x_column: "end_ns".into(),
            value_column: "rate".into(),
            color: VOLUNTARY_COLOR.into(),
            line_width: Some(1.75),
            dash: vec![],
            gap_column: Some("gap".into()),
            sampling: Sampling::Pixel,
        })
        .component(Component::Line {
            id: "involuntary-lines".into(),
            input: "involuntary_context_switches".into(),
            scale: "y".into(),
            x_column: "end_ns".into(),
            value_column: "rate".into(),
            color: INVOLUNTARY_COLOR.into(),
            line_width: Some(1.75),
            dash: vec![],
            gap_column: Some("gap".into()),
            sampling: Sampling::Pixel,
        })
        .component(context_tooltip(
            "voluntary-lines-tooltip",
            "voluntary-lines",
            "delta",
            "rate",
            TooltipStrategy::NearestPoint { radius: Some(14.0) },
        ))
        .component(context_tooltip(
            "involuntary-lines-tooltip",
            "involuntary-lines",
            "delta",
            "rate",
            TooltipStrategy::NearestPoint { radius: Some(14.0) },
        ))
        .component(context_legend())
}

fn context_tooltip(
    id: &str,
    target: &str,
    delta: &str,
    rate: &str,
    strategy: TooltipStrategy,
) -> Component {
    Component::Tooltip {
        id: id.into(),
        target: target.into(),
        strategy,
        rows: vec![
            DisplayField::new("Switches", delta).unit("integer"),
            DisplayField::new("Rate", rate).unit("per-second"),
        ],
    }
}

fn context_legend() -> Component {
    Component::Legend {
        id: "context-legend".into(),
        position: Default::default(),
        items: vec![],
        at_cursor: vec![
            LegendAtCursor::new(
                "voluntary_context_switches",
                "end_ns",
                "rate",
                "Voluntary/s",
            )
            .color(VOLUNTARY_COLOR)
            .unit("per-second"),
            LegendAtCursor::new(
                "involuntary_context_switches",
                "end_ns",
                "rate",
                "Involuntary/s",
            )
            .color(INVOLUNTARY_COLOR)
            .unit("per-second"),
        ],
    }
}

fn dino_panel() -> Panel {
    Panel::new("green-dinosaur", "A Completely Reasonable Dinosaur", 160)
        .x_axis(XAxis::Linear {
            min: 0.0,
            max: 100.0,
        })
        .scale(Scale::new("dino").domain(0.0, 100.0))
        .component(Component::Background {
            id: "dino-background".into(),
            input: "dino_background".into(),
            color_column: "color".into(),
        })
        .component(Component::Polyline {
            id: "dino-outline".into(),
            input: "dino_points".into(),
            scale: "dino".into(),
            x_column: "x".into(),
            value_column: "y".into(),
            color: DINO_COLOR.into(),
            line_width: Some(8.0),
            dash: vec![],
            gap_column: None,
        })
        .component(Component::Text {
            id: "dino-flames".into(),
            input: "dino_labels".into(),
            scale: "dino".into(),
            x_column: "x".into(),
            value_column: "y".into(),
            text_column: "text".into(),
            color: None,
            color_column: None,
            font: Some("20px sans-serif".into()),
            align: None,
        })
        .component(Component::Text {
            id: "dino-hotspots".into(),
            input: "dino_hotspots".into(),
            scale: "dino".into(),
            x_column: "x".into(),
            value_column: "y".into(),
            text_column: "text".into(),
            color: Some("transparent".into()),
            color_column: None,
            font: Some("1px sans-serif".into()),
            align: None,
        })
        .component(Component::Tooltip {
            id: "dino-hotspot-tooltip".into(),
            target: "dino-hotspots".into(),
            strategy: TooltipStrategy::NearestPoint { radius: Some(18.0) },
            rows: vec![DisplayField::new("", "tooltip")],
        })
        .component(Component::Tooltip {
            id: "dino-flame-tooltip".into(),
            target: "dino-flames".into(),
            strategy: TooltipStrategy::NearestPoint { radius: Some(24.0) },
            rows: vec![DisplayField::new("", "tooltip")],
        })
        .component(Component::Legend {
            id: "dino-legend".into(),
            position: Default::default(),
            items: vec![LegendStaticItem::new("Definitely production data").color(DINO_COLOR)],
            at_cursor: vec![],
        })
}

fn dino_points() -> Table {
    const POINTS: &[(f64, f64, &str, &str)] = &[
        (4.0, 28.0, "tail", "💩"),
        (10.0, 34.0, "tail", "💩"),
        (16.0, 40.0, "tail", "💩"),
        (22.0, 40.0, "body", ""),
        (22.0, 62.0, "body", ""),
        (32.0, 62.0, "body", ""),
        (32.0, 72.0, "body", ""),
        (48.0, 72.0, "body", ""),
        (48.0, 64.0, "body", ""),
        (58.0, 64.0, "neck", ""),
        (58.0, 76.0, "head", "❤️"),
        (72.0, 76.0, "head", "❤️"),
        (72.0, 64.0, "head", "❤️"),
        (64.0, 64.0, "head", "❤️"),
        (64.0, 48.0, "body", ""),
        (54.0, 48.0, "body", ""),
        (54.0, 30.0, "leg", ""),
        (46.0, 30.0, "leg", ""),
        (46.0, 48.0, "body", ""),
        (32.0, 48.0, "body", ""),
        (32.0, 28.0, "leg", ""),
        (24.0, 28.0, "leg", ""),
        (24.0, 48.0, "body", ""),
        (16.0, 40.0, "tail", "💩"),
    ];
    Table::new("dino_points")
        .f64("x", POINTS.iter().map(|point| point.0).collect())
        .f64("y", POINTS.iter().map(|point| point.1).collect())
        .string("part", POINTS.iter().map(|point| point.2))
        .string("tooltip", POINTS.iter().map(|point| point.3))
}

fn dino_hotspots() -> Table {
    Table::new("dino_hotspots")
        .f64("x", vec![4.0, 72.0])
        .f64("y", vec![28.0, 76.0])
        .string("text", ["", ""])
        .string("tooltip", ["💩", "❤️"])
}

fn dino_labels() -> Table {
    Table::new("dino_labels")
        .f64("x", vec![78.0])
        .f64("y", vec![72.0])
        .string("text", ["🔥🔥🔥"])
        .string("tooltip", ["hot breath"])
}

fn dino_background() -> Table {
    Table::new("dino_background").string("color", ["#102b1c"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decreasing_counters_create_independent_gaps() {
        let samples = [
            Usage {
                timestamp_ns: 0,
                user_cpu_ns: 10,
                system_cpu_ns: 10,
                voluntary: 0,
                involuntary: 0,
            },
            Usage {
                timestamp_ns: 1_000_000_000,
                user_cpu_ns: 5,
                system_cpu_ns: 11,
                voluntary: 2,
                involuntary: 1,
            },
        ];
        let bundle = resource_views(&samples);
        assert_eq!(
            bundle
                .tables()
                .iter()
                .find(|table| table.name() == "cpu_intervals")
                .unwrap()
                .rows(),
            0
        );
        assert_eq!(
            bundle
                .tables()
                .iter()
                .find(|table| table.name() == "voluntary_context_switches")
                .unwrap()
                .rows(),
            1
        );
        assert_eq!(
            bundle
                .tables()
                .iter()
                .find(|table| table.name() == "involuntary_context_switches")
                .unwrap()
                .rows(),
            1
        );
    }

    #[test]
    fn context_counter_resets_create_independent_gaps() {
        let samples = [
            Usage {
                timestamp_ns: 0,
                user_cpu_ns: 0,
                system_cpu_ns: 0,
                voluntary: 10,
                involuntary: 10,
            },
            Usage {
                timestamp_ns: 1_000_000_000,
                user_cpu_ns: 0,
                system_cpu_ns: 0,
                voluntary: 2,
                involuntary: 12,
            },
        ];
        let bundle = resource_views(&samples);
        let rows = |name: &str| {
            bundle
                .tables()
                .iter()
                .find(|table| table.name() == name)
                .unwrap()
                .rows()
        };
        assert_eq!(rows("voluntary_context_switches"), 0);
        assert_eq!(rows("involuntary_context_switches"), 1);
    }

    #[test]
    fn bundle_covers_all_satisfaction_panels() {
        let bundle = resource_views(&[])
            .table(dino_points())
            .table(dino_hotspots())
            .table(dino_labels())
            .table(dino_background())
            .panel(dino_panel());
        let ids: Vec<_> = bundle
            .panels()
            .iter()
            .map(|panel| panel.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "custom-cpu",
                "context-switch-steps",
                "context-switch-lines",
                "green-dinosaur"
            ]
        );
        let tooltip = |panel_id: &str, tooltip_id: &str| {
            bundle
                .panels()
                .iter()
                .find(|panel| panel.id == panel_id)
                .and_then(|panel| {
                    panel.components.iter().find_map(|component| {
                        if let Component::Tooltip { id, strategy, .. } = component
                            && id == tooltip_id
                        {
                            return Some(strategy);
                        }
                        None
                    })
                })
                .unwrap()
        };
        assert!(matches!(
            tooltip("context-switch-steps", "voluntary-steps-tooltip"),
            TooltipStrategy::Interval
        ));
        assert!(matches!(
            tooltip("context-switch-lines", "voluntary-lines-tooltip"),
            TooltipStrategy::NearestPoint { .. }
        ));
        assert!(dino_points().rows() > 20);
    }
}
