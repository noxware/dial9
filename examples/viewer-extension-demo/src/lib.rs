use dial9_viewer_extension::{Column, Event, Extension, OutputSink, Result, TableId};

const CPU_INTERVALS: TableId = TableId::new(0);
const SETTINGS: TableId = TableId::new(1);
const CONTEXT_INTERVALS: TableId = TableId::new(2);
const DINO_BODY: TableId = TableId::new(3);
const DINO_FLAMES: TableId = TableId::new(4);

const RESOURCE_USAGE_EVENT: &str = "ProcessResourceUsageEvent";
const SEGMENT_METADATA_EVENT: &str = "SegmentMetadataEvent";
const AVAILABLE_PARALLELISM: &str = "process.available_parallelism";

dial9_viewer_extension::manifest!(
    r##"
{
  "version": 1,
  "tables": [
    {
      "name": "cpu_intervals",
      "columns": [
        { "name": "start_ns", "type": "u64" },
        { "name": "end_ns", "type": "u64" },
        { "name": "wall_ns", "type": "u64" },
        { "name": "cpu_ns", "type": "u64" },
        { "name": "cores", "type": "f64" },
        { "name": "percent", "type": "f64", "nullable": true }
      ]
    },
    {
      "name": "settings",
      "columns": [
        { "name": "capacity", "type": "f64", "nullable": true }
      ]
    },
    {
      "name": "context_intervals",
      "columns": [
        { "name": "start_ns", "type": "u64" },
        { "name": "end_ns", "type": "u64" },
        { "name": "wall_ns", "type": "u64" },
        { "name": "voluntary_delta", "type": "u64", "nullable": true },
        { "name": "voluntary_rate", "type": "f64", "nullable": true },
        { "name": "involuntary_delta", "type": "u64", "nullable": true },
        { "name": "involuntary_rate", "type": "f64", "nullable": true }
      ]
    },
    {
      "name": "dino_body",
      "columns": [
        { "name": "x", "type": "f64" },
        { "name": "y", "type": "f64" },
        { "name": "message", "type": "utf8", "nullable": true }
      ]
    },
    {
      "name": "dino_flames",
      "columns": [
        { "name": "x", "type": "f64" },
        { "name": "y", "type": "f64" }
      ]
    }
  ],
  "panels": [
    {
      "title": "CPU Usage · WASM",
      "height": 92,
      "x_axis": { "type": "time" },
      "scales": [
        {
          "name": "usage",
          "domain": {
            "mode": "visible",
            "include": [
              0,
              1,
              { "table": "settings", "column": "capacity" }
            ]
          }
        }
      ],
      "components": [
        {
          "name": "interval-area/v1",
          "table": "cpu_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "cores",
          "scale": "usage",
          "color": {
            "column": "percent",
            "stops": [
              { "at": 0, "color": "#4fc3f7" },
              { "at": 100, "color": "#ff7361" }
            ]
          },
          "opacity": 0.42
        },
        {
          "name": "interval-line/v1",
          "table": "cpu_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "cores",
          "scale": "usage",
          "color": {
            "column": "percent",
            "stops": [
              { "at": 0, "color": "#4fc3f7" },
              { "at": 100, "color": "#ff7361" }
            ]
          },
          "opacity": 0.9
        },
        {
          "name": "horizontal-rule/v1",
          "y": { "table": "settings", "column": "capacity" },
          "scale": "usage",
          "color": "#ffcf99",
          "opacity": 0.65,
          "dash": [4, 3]
        },
        {
          "name": "swatch/v1",
          "label": "available parallelism",
          "color": "#ffcf99",
          "sample": "rule",
          "dash": [4, 3],
          "value": {
            "table": "settings",
            "column": "capacity",
            "unit": "cores",
            "max_fraction_digits": 0
          }
        },
        {
          "name": "tooltip/v1",
          "table": "cpu_intervals",
          "match": {
            "start": "start_ns",
            "end": "end_ns",
            "y": "cores"
          },
          "items": [
            { "label": "Window", "column": "wall_ns", "unit": "ns" },
            { "label": "CPU time", "column": "cpu_ns", "unit": "ns" },
            {
              "label": "Cores",
              "column": "cores",
              "max_fraction_digits": 2
            },
            { "label": "Total CPU", "column": "percent", "unit": "%" }
          ]
        },
        {
          "name": "readout/v1",
          "table": "cpu_intervals",
          "match": {
            "start": "start_ns",
            "end": "end_ns",
            "y": "cores"
          },
          "items": [
            {
              "label": "avg",
              "column": "cores",
              "reduce": {
                "name": "time_weighted_mean",
                "start": "start_ns",
                "end": "end_ns"
              },
              "unit": "cores",
              "max_fraction_digits": 2
            },
            {
              "label": "avg",
              "column": "percent",
              "reduce": {
                "name": "time_weighted_mean",
                "start": "start_ns",
                "end": "end_ns"
              },
              "unit": "%"
            },
            {
              "label": "max",
              "column": "cores",
              "reduce": "max",
              "unit": "cores",
              "max_fraction_digits": 2
            }
          ]
        }
      ]
    },
    {
      "title": "Context Switch Rate · Steps",
      "height": 104,
      "x_axis": { "type": "time" },
      "scales": [
        {
          "name": "rate",
          "domain": { "mode": "visible", "include": [0] }
        }
      ],
      "components": [
        {
          "name": "interval-area/v1",
          "table": "context_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "voluntary_rate",
          "scale": "rate",
          "color": "#81c784",
          "opacity": 0.16
        },
        {
          "name": "interval-line/v1",
          "table": "context_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "voluntary_rate",
          "scale": "rate",
          "color": "#81c784",
          "line_width": 1.5
        },
        {
          "name": "interval-area/v1",
          "table": "context_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "involuntary_rate",
          "scale": "rate",
          "color": "#ffb74d",
          "opacity": 0.12
        },
        {
          "name": "interval-line/v1",
          "table": "context_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "involuntary_rate",
          "scale": "rate",
          "color": "#ffb74d",
          "line_width": 1.5
        },
        {
          "name": "swatch/v1",
          "label": "Voluntary",
          "color": "#81c784",
          "sample": "area"
        },
        {
          "name": "swatch/v1",
          "label": "Involuntary",
          "color": "#ffb74d",
          "sample": "area"
        },
        {
          "name": "tooltip/v1",
          "table": "context_intervals",
          "match": {
            "start": "start_ns",
            "end": "end_ns",
            "y": "voluntary_rate"
          },
          "items": [
            { "label": "Window", "column": "wall_ns", "unit": "ns" },
            { "label": "Voluntary", "column": "voluntary_delta" },
            {
              "label": "Rate",
              "column": "voluntary_rate",
              "unit": "switches/s",
              "max_fraction_digits": 2
            }
          ]
        },
        {
          "name": "tooltip/v1",
          "table": "context_intervals",
          "match": {
            "start": "start_ns",
            "end": "end_ns",
            "y": "involuntary_rate"
          },
          "items": [
            { "label": "Window", "column": "wall_ns", "unit": "ns" },
            { "label": "Involuntary", "column": "involuntary_delta" },
            {
              "label": "Rate",
              "column": "involuntary_rate",
              "unit": "switches/s",
              "max_fraction_digits": 2
            }
          ]
        }
      ]
    },
    {
      "title": "Context Switch Rate · Lines",
      "height": 104,
      "x_axis": { "type": "time" },
      "scales": [
        {
          "name": "rate",
          "domain": { "mode": "visible", "include": [0] }
        }
      ],
      "components": [
        {
          "name": "line/v1",
          "table": "context_intervals",
          "x": "end_ns",
          "y": "voluntary_rate",
          "scale": "rate",
          "color": "#81c784",
          "line_width": 1.75
        },
        {
          "name": "line/v1",
          "table": "context_intervals",
          "x": "end_ns",
          "y": "involuntary_rate",
          "scale": "rate",
          "color": "#ffb74d",
          "line_width": 1.75
        },
        {
          "name": "swatch/v1",
          "label": "Voluntary",
          "color": "#81c784",
          "sample": "line",
          "line_width": 1.75
        },
        {
          "name": "swatch/v1",
          "label": "Involuntary",
          "color": "#ffb74d",
          "sample": "line",
          "line_width": 1.75
        },
        {
          "name": "tooltip/v1",
          "table": "context_intervals",
          "match": { "x": "end_ns", "y": "voluntary_rate" },
          "items": [
            { "label": "Voluntary", "column": "voluntary_delta" },
            {
              "label": "Rate",
              "column": "voluntary_rate",
              "unit": "switches/s",
              "max_fraction_digits": 2
            }
          ]
        },
        {
          "name": "tooltip/v1",
          "table": "context_intervals",
          "match": { "x": "end_ns", "y": "involuntary_rate" },
          "items": [
            { "label": "Involuntary", "column": "involuntary_delta" },
            {
              "label": "Rate",
              "column": "involuntary_rate",
              "unit": "switches/s",
              "max_fraction_digits": 2
            }
          ]
        }
      ]
    },
    {
      "title": "A Completely Reasonable Dinosaur",
      "height": 148,
      "x_axis": { "type": "linear", "domain": [0, 100] },
      "scales": [
        {
          "name": "dino",
          "domain": { "mode": "fixed", "min": 0, "max": 10 }
        }
      ],
      "components": [
        { "name": "background/v1", "color": "#102219" },
        {
          "name": "polyline/v1",
          "table": "dino_body",
          "x": "x",
          "y": "y",
          "scale": "dino",
          "color": "#193c24",
          "line_width": 9
        },
        {
          "name": "polyline/v1",
          "table": "dino_body",
          "x": "x",
          "y": "y",
          "scale": "dino",
          "color": "#66d17a",
          "line_width": 5
        },
        {
          "name": "polyline/v1",
          "table": "dino_flames",
          "x": "x",
          "y": "y",
          "scale": "dino",
          "color": "#8f2d20",
          "line_width": 8
        },
        {
          "name": "polyline/v1",
          "table": "dino_flames",
          "x": "x",
          "y": "y",
          "scale": "dino",
          "color": "#ff7043",
          "line_width": 4
        },
        {
          "name": "swatch/v1",
          "label": "Dinosaur",
          "color": "#66d17a",
          "sample": "line",
          "line_width": 5
        },
        {
          "name": "swatch/v1",
          "label": "Fire",
          "color": "#ff7043",
          "sample": "line",
          "line_width": 4
        },
        {
          "name": "tooltip/v1",
          "table": "dino_body",
          "match": { "x": "x", "y": "y" },
          "items": [
            { "label": "Dino says", "column": "message" }
          ]
        }
      ]
    }
  ]
}
"##
);

#[derive(Clone, Copy, Debug, PartialEq)]
struct Usage {
    timestamp_ns: u64,
    user_cpu_ns: u64,
    system_cpu_ns: u64,
    voluntary: Option<u64>,
    involuntary: Option<u64>,
}

#[derive(Debug)]
struct Nullable<T> {
    values: Vec<T>,
    validity: Vec<u8>,
    rows: usize,
}

impl<T> Default for Nullable<T> {
    fn default() -> Self {
        Self {
            values: Vec::new(),
            validity: Vec::new(),
            rows: 0,
        }
    }
}

impl<T: Default> Nullable<T> {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            values: Vec::with_capacity(capacity),
            validity: Vec::with_capacity(capacity.div_ceil(8)),
            rows: 0,
        }
    }

    fn push(&mut self, value: Option<T>) {
        if self.rows.is_multiple_of(8) {
            self.validity.push(0);
        }
        match value {
            Some(value) => {
                self.values.push(value);
                *self.validity.last_mut().expect("validity byte exists") |= 1 << (self.rows & 7);
            }
            None => self.values.push(T::default()),
        }
        self.rows += 1;
    }
}

#[derive(Debug, Default)]
struct CpuColumns {
    start_ns: Vec<u64>,
    end_ns: Vec<u64>,
    wall_ns: Vec<u64>,
    cpu_ns: Vec<u64>,
    cores: Vec<f64>,
    percent: Nullable<f64>,
}

impl CpuColumns {
    fn into_columns(self) -> Vec<Column> {
        vec![
            Column::U64 {
                values: self.start_ns,
                validity: None,
            },
            Column::U64 {
                values: self.end_ns,
                validity: None,
            },
            Column::U64 {
                values: self.wall_ns,
                validity: None,
            },
            Column::U64 {
                values: self.cpu_ns,
                validity: None,
            },
            Column::F64 {
                values: self.cores,
                validity: None,
            },
            Column::F64 {
                values: self.percent.values,
                validity: Some(self.percent.validity),
            },
        ]
    }
}

#[derive(Debug, Default)]
struct ContextColumns {
    start_ns: Vec<u64>,
    end_ns: Vec<u64>,
    wall_ns: Vec<u64>,
    voluntary_delta: Nullable<u64>,
    voluntary_rate: Nullable<f64>,
    involuntary_delta: Nullable<u64>,
    involuntary_rate: Nullable<f64>,
}

impl ContextColumns {
    fn into_columns(self) -> Vec<Column> {
        vec![
            Column::U64 {
                values: self.start_ns,
                validity: None,
            },
            Column::U64 {
                values: self.end_ns,
                validity: None,
            },
            Column::U64 {
                values: self.wall_ns,
                validity: None,
            },
            Column::U64 {
                values: self.voluntary_delta.values,
                validity: Some(self.voluntary_delta.validity),
            },
            Column::F64 {
                values: self.voluntary_rate.values,
                validity: Some(self.voluntary_rate.validity),
            },
            Column::U64 {
                values: self.involuntary_delta.values,
                validity: Some(self.involuntary_delta.validity),
            },
            Column::F64 {
                values: self.involuntary_rate.values,
                validity: Some(self.involuntary_rate.validity),
            },
        ]
    }
}

fn resource_columns(samples: &mut [Usage], capacity: Option<f64>) -> (CpuColumns, ContextColumns) {
    samples.sort_by_key(|sample| sample.timestamp_ns);
    let interval_capacity = samples.len().saturating_sub(1);
    let mut cpu = CpuColumns {
        start_ns: Vec::with_capacity(interval_capacity),
        end_ns: Vec::with_capacity(interval_capacity),
        wall_ns: Vec::with_capacity(interval_capacity),
        cpu_ns: Vec::with_capacity(interval_capacity),
        cores: Vec::with_capacity(interval_capacity),
        percent: Nullable::with_capacity(interval_capacity),
    };
    let mut context = ContextColumns {
        start_ns: Vec::with_capacity(interval_capacity),
        end_ns: Vec::with_capacity(interval_capacity),
        wall_ns: Vec::with_capacity(interval_capacity),
        voluntary_delta: Nullable::with_capacity(interval_capacity),
        voluntary_rate: Nullable::with_capacity(interval_capacity),
        involuntary_delta: Nullable::with_capacity(interval_capacity),
        involuntary_rate: Nullable::with_capacity(interval_capacity),
    };

    for pair in samples.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        let Some(wall_ns) = current.timestamp_ns.checked_sub(previous.timestamp_ns) else {
            continue;
        };
        if wall_ns == 0 {
            continue;
        }

        let user_ns = current.user_cpu_ns.checked_sub(previous.user_cpu_ns);
        let system_ns = current.system_cpu_ns.checked_sub(previous.system_cpu_ns);
        if let (Some(user_ns), Some(system_ns)) = (user_ns, system_ns)
            && let Some(cpu_ns) = user_ns.checked_add(system_ns)
        {
            let cores = cpu_ns as f64 / wall_ns as f64;
            if cores.is_finite() {
                cpu.start_ns.push(previous.timestamp_ns);
                cpu.end_ns.push(current.timestamp_ns);
                cpu.wall_ns.push(wall_ns);
                cpu.cpu_ns.push(cpu_ns);
                cpu.cores.push(cores);
                cpu.percent
                    .push(capacity.map(|capacity| (cores / capacity * 100.0).min(100.0)));
            }
        }

        context.start_ns.push(previous.timestamp_ns);
        context.end_ns.push(current.timestamp_ns);
        context.wall_ns.push(wall_ns);
        let seconds = wall_ns as f64 / 1_000_000_000.0;
        let voluntary = previous
            .voluntary
            .zip(current.voluntary)
            .and_then(|(previous, current)| current.checked_sub(previous));
        let involuntary = previous
            .involuntary
            .zip(current.involuntary)
            .and_then(|(previous, current)| current.checked_sub(previous));
        context.voluntary_delta.push(voluntary);
        context
            .voluntary_rate
            .push(voluntary.map(|delta| delta as f64 / seconds));
        context.involuntary_delta.push(involuntary);
        context
            .involuntary_rate
            .push(involuntary.map(|delta| delta as f64 / seconds));
    }

    (cpu, context)
}

const BODY_POINTS: &[(f64, f64, Option<&str>)] = &[
    (10.0, 3.0, Some("💩")),
    (18.0, 4.0, Some("💩")),
    (28.0, 5.8, None),
    (40.0, 7.0, None),
    (52.0, 6.8, None),
    (59.0, 7.8, Some("❤️")),
    (66.0, 8.4, Some("❤️")),
    (76.0, 8.2, Some("❤️")),
    (78.0, 7.0, Some("❤️")),
    (69.0, 6.7, Some("❤️")),
    (63.0, 5.4, None),
    (68.0, 4.8, None),
    (62.0, 5.1, None),
    (56.0, 3.8, None),
    (56.0, 1.2, None),
    (50.0, 1.2, None),
    (48.0, 3.5, None),
    (38.0, 3.6, None),
    (38.0, 1.1, None),
    (32.0, 1.1, None),
    (34.0, 4.1, None),
    (25.0, 4.4, Some("💩")),
    (10.0, 3.0, Some("💩")),
];

const FLAME_POINTS: &[(f64, f64)] = &[
    (78.0, 7.6),
    (84.0, 8.5),
    (82.0, 7.5),
    (90.0, 7.8),
    (84.0, 6.8),
    (78.0, 7.2),
];

fn nullable_utf8(values: impl IntoIterator<Item = Option<&'static str>>) -> Column {
    let values = values.into_iter();
    let mut offsets = Vec::with_capacity(values.size_hint().0 + 1);
    let mut bytes = Vec::new();
    let mut validity = Vec::new();
    offsets.push(0);
    for (row, value) in values.enumerate() {
        if row.is_multiple_of(8) {
            validity.push(0);
        }
        if let Some(value) = value {
            bytes.extend_from_slice(value.as_bytes());
            *validity.last_mut().expect("validity byte exists") |= 1 << (row & 7);
        }
        offsets.push(u32::try_from(bytes.len()).expect("fixture strings fit in u32"));
    }
    Column::Utf8 {
        offsets,
        bytes,
        validity: Some(validity),
    }
}

fn dino_body_columns() -> Vec<Column> {
    vec![
        Column::F64 {
            values: BODY_POINTS.iter().map(|point| point.0).collect(),
            validity: None,
        },
        Column::F64 {
            values: BODY_POINTS.iter().map(|point| point.1).collect(),
            validity: None,
        },
        nullable_utf8(BODY_POINTS.iter().map(|point| point.2)),
    ]
}

fn dino_flame_columns() -> Vec<Column> {
    vec![
        Column::F64 {
            values: FLAME_POINTS.iter().map(|point| point.0).collect(),
            validity: None,
        },
        Column::F64 {
            values: FLAME_POINTS.iter().map(|point| point.1).collect(),
            validity: None,
        },
    ]
}

#[derive(Default)]
pub struct DemoExtension {
    usage: Vec<Usage>,
    capacity: Option<f64>,
}

impl Extension for DemoExtension {
    fn on_event(&mut self, event: Event<'_, '_>, _output: &mut OutputSink) -> Result<()> {
        match event.name() {
            RESOURCE_USAGE_EVENT => {
                let Some(timestamp_ns) = event.timestamp_ns() else {
                    return Ok(());
                };
                let Some(user_cpu_ns) = event.field("user_cpu_ns").and_then(|value| value.as_u64())
                else {
                    return Ok(());
                };
                let Some(system_cpu_ns) = event
                    .field("system_cpu_ns")
                    .and_then(|value| value.as_u64())
                else {
                    return Ok(());
                };
                let voluntary = event
                    .field("voluntary_context_switches")
                    .and_then(|value| value.as_u64());
                let involuntary = event
                    .field("involuntary_context_switches")
                    .and_then(|value| value.as_u64());
                self.usage.push(Usage {
                    timestamp_ns,
                    user_cpu_ns,
                    system_cpu_ns,
                    voluntary,
                    involuntary,
                });
            }
            SEGMENT_METADATA_EVENT => {
                let Some(entries) = event
                    .field("entries")
                    .and_then(|value| value.as_string_map())
                else {
                    return Ok(());
                };
                for (key, value) in entries {
                    if key == AVAILABLE_PARALLELISM {
                        self.capacity = value
                            .parse::<f64>()
                            .ok()
                            .filter(|value| value.is_finite() && *value > 0.0);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink) -> Result<()> {
        let (cpu, context) = resource_columns(&mut self.usage, self.capacity);
        output.emit(CPU_INTERVALS, cpu.into_columns())?;

        let mut capacity = Nullable::with_capacity(1);
        capacity.push(self.capacity);
        output.emit(
            SETTINGS,
            vec![Column::F64 {
                values: capacity.values,
                validity: Some(capacity.validity),
            }],
        )?;

        output.emit(CONTEXT_INTERVALS, context.into_columns())?;
        output.emit(DINO_BODY, dino_body_columns())?;
        output.emit(DINO_FLAMES, dino_flame_columns())
    }
}

dial9_viewer_extension::export_extension!(DemoExtension);

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(
        timestamp_ns: u64,
        user_cpu_ns: u64,
        system_cpu_ns: u64,
        voluntary: u64,
        involuntary: u64,
    ) -> Usage {
        Usage {
            timestamp_ns,
            user_cpu_ns,
            system_cpu_ns,
            voluntary: Some(voluntary),
            involuntary: Some(involuntary),
        }
    }

    #[test]
    fn cpu_matches_adjacent_samples_and_preserves_reset_gaps() {
        let mut samples = vec![
            usage(3_000_000_000, 15, 25, 5, 5),
            usage(0, 10, 10, 0, 0),
            usage(1_000_000_000, 20, 15, 2, 1),
            usage(2_000_000_000, 5, 20, 3, 3),
        ];
        let (cpu, _) = resource_columns(&mut samples, Some(4.0));

        assert_eq!(cpu.start_ns, [0, 2_000_000_000]);
        assert_eq!(cpu.end_ns, [1_000_000_000, 3_000_000_000]);
        assert_eq!(cpu.cpu_ns, [15, 15]);
        assert_eq!(cpu.cores, [15e-9, 15e-9]);
        assert!(
            cpu.percent
                .values
                .iter()
                .all(|value| (value - 3.75e-7).abs() < f64::EPSILON)
        );
        assert_eq!(cpu.percent.validity, [0b11]);
    }

    #[test]
    fn context_counter_resets_create_independent_nulls() {
        let mut samples = vec![
            usage(0, 0, 0, 10, 10),
            usage(1_000_000_000, 0, 0, 2, 12),
            usage(2_000_000_000, 0, 0, 5, 1),
        ];
        let (_, context) = resource_columns(&mut samples, None);

        assert_eq!(context.voluntary_delta.values, [0, 3]);
        assert_eq!(context.voluntary_delta.validity, [0b10]);
        assert_eq!(context.involuntary_delta.values, [2, 0]);
        assert_eq!(context.involuntary_delta.validity, [0b01]);
        assert_eq!(context.voluntary_rate.validity, [0b10]);
        assert_eq!(context.involuntary_rate.validity, [0b01]);
    }

    #[test]
    fn missing_context_fields_do_not_discard_cpu_samples() {
        let mut samples = vec![
            Usage {
                timestamp_ns: 0,
                user_cpu_ns: 0,
                system_cpu_ns: 0,
                voluntary: None,
                involuntary: None,
            },
            Usage {
                timestamp_ns: 1_000_000_000,
                user_cpu_ns: 1,
                system_cpu_ns: 1,
                voluntary: None,
                involuntary: None,
            },
        ];
        let (cpu, context) = resource_columns(&mut samples, None);

        assert_eq!(cpu.start_ns, [0]);
        assert_eq!(context.voluntary_rate.validity, [0]);
        assert_eq!(context.involuntary_rate.validity, [0]);
    }

    #[test]
    fn dinosaur_keeps_repeated_and_backward_points_with_tooltip_messages() {
        assert_eq!(BODY_POINTS.first().map(|point| point.2), Some(Some("💩")));
        assert!(BODY_POINTS.windows(2).any(|pair| pair[1].0 < pair[0].0));
        assert_eq!(BODY_POINTS.first(), BODY_POINTS.last());
        assert!(BODY_POINTS.iter().any(|point| point.2 == Some("❤️")));
        assert_eq!(FLAME_POINTS.len(), 6);
    }
}
