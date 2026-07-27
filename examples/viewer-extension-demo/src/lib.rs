use dial9_viewer_extension::{Column, Event, Extension, ExtensionError, OutputSink, TableId};
use std::mem;

const CPU_INTERVALS: TableId = TableId::new(0);
const SCALARS: TableId = TableId::new(1);
const CONTEXT_SWITCHES: TableId = TableId::new(2);
const DINO_BODY: TableId = TableId::new(3);
const DINO_FLAMES: TableId = TableId::new(4);
const BATCH_ROWS: usize = 1_024;

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
            { "name": "cores", "type": "f64", "nullable": true },
            { "name": "total_percent", "type": "f64", "nullable": true },
            { "name": "percent", "type": "f64", "nullable": true },
            { "name": "load", "type": "f64", "nullable": true }
          ]
        },
        {
          "name": "scalars",
          "columns": [
            { "name": "capacity", "type": "f64" }
          ]
        },
        {
          "name": "context_switches",
          "columns": [
            { "name": "time_ns", "type": "u64" },
            { "name": "voluntary_rate", "type": "f64", "nullable": true },
            { "name": "involuntary_rate", "type": "f64", "nullable": true }
          ]
        },
        {
          "name": "dino_body",
          "columns": [
            { "name": "time_ns", "type": "u64" },
            { "name": "value", "type": "f64" },
            { "name": "tooltip", "type": "utf8" }
          ]
        },
        {
          "name": "dino_flames",
          "columns": [
            { "name": "time_ns", "type": "u64" },
            { "name": "value", "type": "f64" },
            { "name": "tooltip", "type": "utf8" }
          ]
        }
      ],
      "panels": [
        {
          "title": "WASM · CPU Usage",
          "components": [
            {
              "name": "interval-area/v1",
              "table": "cpu_intervals",
              "start": "start_ns",
              "end": "end_ns",
              "y": "cores",
              "color": {
                "column": "load",
                "stops": [
                  { "value": 0, "color": "#4fc3f7" },
                  { "value": 1, "color": "#ff7361" }
                ]
              }
            },
            {
              "name": "interval-line/v1",
              "table": "cpu_intervals",
              "start": "start_ns",
              "end": "end_ns",
              "y": "cores",
              "color": {
                "column": "load",
                "stops": [
                  { "value": 0, "color": "#4fc3f7" },
                  { "value": 1, "color": "#ff7361" }
                ]
              }
            },
            {
              "name": "horizontal-rule/v1",
              "value": {
                "table": "scalars",
                "column": "capacity",
                "select": "first"
              },
              "color": "#ffcf99"
            },
            {
              "name": "swatch/v1",
              "label": "available parallelism",
              "color": "#ffcf99",
              "shape": "reference",
              "value": {
                "table": "scalars",
                "column": "capacity",
                "select": "first",
                "unit": "cores"
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
                { "label": "Cores", "column": "cores" },
                { "label": "Total CPU", "column": "total_percent", "unit": "%" }
              ]
            },
            {
              "name": "readout/v1",
              "table": "cpu_intervals",
              "items": [
                {
                  "label": "avg",
                  "column": "cores",
                  "reduce": {
                    "name": "time_weighted_mean",
                    "start": "start_ns",
                    "end": "end_ns"
                  },
                  "unit": "cores"
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
                  "unit": "cores"
                }
              ]
            }
          ]
        },
        {
          "title": "WASM · Context Switch Rate",
          "components": [
            {
              "name": "step-line/v1",
              "table": "context_switches",
              "x": "time_ns",
              "y": "voluntary_rate",
              "color": "#81c784"
            },
            {
              "name": "line/v1",
              "table": "context_switches",
              "x": "time_ns",
              "y": "involuntary_rate",
              "color": "#ffb74d"
            },
            {
              "name": "swatch/v1",
              "label": "Voluntary",
              "color": "#81c784",
              "shape": "line"
            },
            {
              "name": "swatch/v1",
              "label": "Involuntary",
              "color": "#ffb74d",
              "shape": "line"
            },
            {
              "name": "tooltip/v1",
              "table": "context_switches",
              "match": {
                "x": "time_ns",
                "y": "voluntary_rate"
              },
              "items": [
                { "label": "Voluntary", "column": "voluntary_rate", "unit": "switches/s" },
                { "label": "Time", "column": "time_ns", "unit": "ns" }
              ]
            },
            {
              "name": "tooltip/v1",
              "table": "context_switches",
              "match": {
                "x": "time_ns",
                "y": "involuntary_rate"
              },
              "items": [
                { "label": "Involuntary", "column": "involuntary_rate", "unit": "switches/s" },
                { "label": "Time", "column": "time_ns", "unit": "ns" }
              ]
            },
            {
              "name": "readout/v1",
              "table": "context_switches",
              "items": [
                { "label": "voluntary max", "column": "voluntary_rate", "reduce": "max", "unit": "switches/s" },
                { "label": "involuntary max", "column": "involuntary_rate", "reduce": "max", "unit": "switches/s" }
              ]
            }
          ]
        },
        {
          "title": "WASM · Extremely Scientific Dinosaur",
          "x_axis": { "kind": "time" },
          "y_scales": [
            { "name": "dino", "include_zero": true, "min": 0, "max": 10 }
          ],
          "components": [
            {
              "name": "background/v1",
              "color": "#0b2818"
            },
            {
              "name": "polyline/v1",
              "table": "dino_body",
              "x": "time_ns",
              "y": "value",
              "scale": "dino",
              "color": "#66d17a"
            },
            {
              "name": "polyline/v1",
              "table": "dino_flames",
              "x": "time_ns",
              "y": "value",
              "scale": "dino",
              "color": "#ff7043"
            },
            {
              "name": "swatch/v1",
              "label": "Dino",
              "color": "#66d17a",
              "shape": "line"
            },
            {
              "name": "swatch/v1",
              "label": "Flames",
              "color": "#ff7043",
              "shape": "line"
            },
            {
              "name": "tooltip/v1",
              "table": "dino_body",
              "match": {
                "x": "time_ns",
                "y": "value"
              },
              "items": [
                { "label": "Dino says", "column": "tooltip" }
              ]
            },
            {
              "name": "tooltip/v1",
              "table": "dino_flames",
              "match": {
                "x": "time_ns",
                "y": "value"
              },
              "items": [
                { "label": "Science", "column": "tooltip" }
              ]
            }
          ]
        }
      ]
    }
    "##
);

#[derive(Clone, Copy)]
struct ResourceSample {
    timestamp_ns: u64,
    user_cpu_ns: u64,
    system_cpu_ns: u64,
    voluntary_context_switches: u64,
    involuntary_context_switches: u64,
}

#[derive(Default)]
struct CpuBatch {
    start_ns: Vec<u64>,
    end_ns: Vec<u64>,
    wall_ns: Vec<u64>,
    cpu_ns: Vec<u64>,
    cores: Vec<f64>,
    cores_valid: Vec<bool>,
    total_percent: Vec<f64>,
    total_percent_valid: Vec<bool>,
    percent: Vec<f64>,
    percent_valid: Vec<bool>,
    load: Vec<f64>,
    load_valid: Vec<bool>,
}

impl CpuBatch {
    fn push(&mut self, previous: ResourceSample, current: ResourceSample, capacity: Option<f64>) {
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

        self.start_ns.push(previous.timestamp_ns);
        self.end_ns.push(current.timestamp_ns);
        self.wall_ns.push(wall_ns.unwrap_or(0));
        self.cpu_ns.push(cpu_ns.unwrap_or(0));
        push_nullable(&mut self.cores, &mut self.cores_valid, cores);
        push_nullable(
            &mut self.total_percent,
            &mut self.total_percent_valid,
            percent.map(|value| value.min(100.0)),
        );
        push_nullable(&mut self.percent, &mut self.percent_valid, percent);
        push_nullable(
            &mut self.load,
            &mut self.load_valid,
            cores.map(|cores| capacity.map_or(cores, |capacity| cores / capacity)),
        );
    }

    fn len(&self) -> usize {
        self.start_ns.len()
    }

    fn flush(&mut self, output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        if self.start_ns.is_empty() {
            return Ok(());
        }
        output.emit(
            CPU_INTERVALS,
            vec![
                Column::U64 {
                    values: mem::take(&mut self.start_ns),
                    validity: None,
                },
                Column::U64 {
                    values: mem::take(&mut self.end_ns),
                    validity: None,
                },
                Column::U64 {
                    values: mem::take(&mut self.wall_ns),
                    validity: None,
                },
                Column::U64 {
                    values: mem::take(&mut self.cpu_ns),
                    validity: None,
                },
                nullable_f64(&mut self.cores, &mut self.cores_valid),
                nullable_f64(&mut self.total_percent, &mut self.total_percent_valid),
                nullable_f64(&mut self.percent, &mut self.percent_valid),
                nullable_f64(&mut self.load, &mut self.load_valid),
            ],
        )?;
        Ok(())
    }
}

#[derive(Default)]
struct ContextBatch {
    time_ns: Vec<u64>,
    voluntary_rate: Vec<f64>,
    voluntary_valid: Vec<bool>,
    involuntary_rate: Vec<f64>,
    involuntary_valid: Vec<bool>,
}

impl ContextBatch {
    fn push(&mut self, previous: Option<ResourceSample>, current: ResourceSample) {
        let wall_ns = previous.and_then(|previous| {
            current
                .timestamp_ns
                .checked_sub(previous.timestamp_ns)
                .filter(|wall| *wall > 0)
                .map(|wall| (previous, wall))
        });
        let voluntary = wall_ns.and_then(|(previous, wall)| {
            current
                .voluntary_context_switches
                .checked_sub(previous.voluntary_context_switches)
                .map(|delta| delta as f64 * 1_000_000_000.0 / wall as f64)
        });
        let involuntary = wall_ns.and_then(|(previous, wall)| {
            current
                .involuntary_context_switches
                .checked_sub(previous.involuntary_context_switches)
                .map(|delta| delta as f64 * 1_000_000_000.0 / wall as f64)
        });

        self.time_ns.push(current.timestamp_ns);
        push_nullable(
            &mut self.voluntary_rate,
            &mut self.voluntary_valid,
            voluntary,
        );
        push_nullable(
            &mut self.involuntary_rate,
            &mut self.involuntary_valid,
            involuntary,
        );
    }

    fn len(&self) -> usize {
        self.time_ns.len()
    }

    fn flush(&mut self, output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        if self.time_ns.is_empty() {
            return Ok(());
        }
        output.emit(
            CONTEXT_SWITCHES,
            vec![
                Column::U64 {
                    values: mem::take(&mut self.time_ns),
                    validity: None,
                },
                nullable_f64(&mut self.voluntary_rate, &mut self.voluntary_valid),
                nullable_f64(&mut self.involuntary_rate, &mut self.involuntary_valid),
            ],
        )?;
        Ok(())
    }
}

#[derive(Default)]
pub struct DemoExtension {
    previous: Option<ResourceSample>,
    capacity: Option<f64>,
    min_timestamp_ns: Option<u64>,
    max_timestamp_ns: Option<u64>,
    cpu: CpuBatch,
    context: ContextBatch,
}

impl DemoExtension {
    fn observe_timestamp(&mut self, timestamp_ns: u64) {
        self.min_timestamp_ns = Some(
            self.min_timestamp_ns
                .map_or(timestamp_ns, |value| value.min(timestamp_ns)),
        );
        self.max_timestamp_ns = Some(
            self.max_timestamp_ns
                .map_or(timestamp_ns, |value| value.max(timestamp_ns)),
        );
    }

    fn observe_resource_usage(
        &mut self,
        sample: ResourceSample,
        output: &mut OutputSink<'_>,
    ) -> Result<(), ExtensionError> {
        self.context.push(self.previous, sample);
        if let Some(previous) = self.previous {
            self.cpu.push(previous, sample, self.capacity);
        }
        self.previous = Some(sample);

        if self.cpu.len() >= BATCH_ROWS {
            self.cpu.flush(output)?;
        }
        if self.context.len() >= BATCH_ROWS {
            self.context.flush(output)?;
        }
        Ok(())
    }
}

impl Extension for DemoExtension {
    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink<'_>,
    ) -> Result<(), ExtensionError> {
        if let Some(timestamp_ns) = event.timestamp_ns() {
            self.observe_timestamp(timestamp_ns);
        }

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

    fn finish(mut self, output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        self.cpu.flush(output)?;
        self.context.flush(output)?;
        if let Some(capacity) = self.capacity {
            output.emit(
                SCALARS,
                vec![Column::F64 {
                    values: vec![capacity],
                    validity: None,
                }],
            )?;
        }
        if let (Some(start), Some(end)) = (self.min_timestamp_ns, self.max_timestamp_ns) {
            emit_dinosaur(output, start, end.max(start.saturating_add(1)))?;
        }
        Ok(())
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

fn push_nullable(values: &mut Vec<f64>, valid: &mut Vec<bool>, value: Option<f64>) {
    values.push(value.unwrap_or(0.0));
    valid.push(value.is_some());
}

fn nullable_f64(values: &mut Vec<f64>, valid: &mut Vec<bool>) -> Column {
    let validity = validity_bitmap(valid);
    valid.clear();
    Column::F64 {
        values: mem::take(values),
        validity: Some(validity),
    }
}

fn validity_bitmap(valid: &[bool]) -> Vec<u8> {
    let mut bitmap = vec![0; valid.len().div_ceil(8)];
    for (index, present) in valid.iter().copied().enumerate() {
        if present {
            bitmap[index / 8] |= 1 << (index % 8);
        }
    }
    bitmap
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

fn emit_dinosaur(
    output: &mut OutputSink<'_>,
    start_ns: u64,
    end_ns: u64,
) -> Result<(), ExtensionError> {
    emit_points(output, DINO_BODY, start_ns, end_ns, DINO_BODY_POINTS)?;
    emit_points(output, DINO_FLAMES, start_ns, end_ns, DINO_FLAME_POINTS)
}

fn emit_points(
    output: &mut OutputSink<'_>,
    table: TableId,
    start_ns: u64,
    end_ns: u64,
    points: &[(u8, f64, &str)],
) -> Result<(), ExtensionError> {
    let span = end_ns - start_ns;
    let time_ns = points
        .iter()
        .map(|(percent, _, _)| start_ns + ((u128::from(span) * u128::from(*percent)) / 100) as u64)
        .collect();
    let values = points.iter().map(|(_, value, _)| *value).collect();
    let (offsets, data) = utf8_column(points.iter().map(|(_, _, tooltip)| *tooltip))?;
    output.emit(
        table,
        vec![
            Column::U64 {
                values: time_ns,
                validity: None,
            },
            Column::F64 {
                values,
                validity: None,
            },
            Column::Utf8 {
                offsets,
                data,
                validity: None,
            },
        ],
    )?;
    Ok(())
}

fn utf8_column<'a>(
    values: impl IntoIterator<Item = &'a str>,
) -> Result<(Vec<u32>, Vec<u8>), ExtensionError> {
    let values = values.into_iter();
    let (lower, _) = values.size_hint();
    let mut offsets = Vec::with_capacity(lower + 1);
    let mut data = Vec::new();
    offsets.push(0);
    for value in values {
        data.extend_from_slice(value.as_bytes());
        offsets.push(
            data.len()
                .try_into()
                .map_err(|_| ExtensionError::new("dinosaur text exceeds u32::MAX bytes"))?,
        );
    }
    Ok((offsets, data))
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
        let mut batch = CpuBatch::default();
        batch.push(previous, current, Some(4.0));
        assert_eq!(batch.cores_valid, [false]);
        assert_eq!(batch.total_percent_valid, [false]);
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
        let mut batch = CpuBatch::default();
        batch.push(previous, current, Some(4.0));
        assert_eq!(batch.wall_ns, [100]);
        assert_eq!(batch.cpu_ns, [80]);
        assert_eq!(batch.cores, [0.8]);
        assert_eq!(batch.total_percent, [20.0]);
        assert_eq!(batch.load, [0.2]);
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
