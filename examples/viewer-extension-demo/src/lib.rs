#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use dial9_viewer_extension::{Column, Event, Extension, OutputSink, Result, TableId};

const BATCH_ROWS: usize = 1_024;
const CPU_INTERVALS: TableId = TableId::new(0);
const SETTINGS: TableId = TableId::new(1);
const CONTEXT_INTERVALS: TableId = TableId::new(2);
const CONTEXT_SAMPLES: TableId = TableId::new(3);
const DINO_BODY: TableId = TableId::new(4);
const DINO_FLAMES: TableId = TableId::new(5);

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
            { "name": "window_ns", "type": "u64" },
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
            { "name": "window_ns", "type": "u64" },
            { "name": "voluntary_delta", "type": "u64", "nullable": true },
            { "name": "voluntary_rate", "type": "f64", "nullable": true },
            { "name": "involuntary_delta", "type": "u64", "nullable": true },
            { "name": "involuntary_rate", "type": "f64", "nullable": true },
            { "name": "voluntary_total", "type": "u64" },
            { "name": "involuntary_total", "type": "u64" }
          ]
        },
        {
          "name": "context_samples",
          "columns": [
            { "name": "time_ns", "type": "u64" },
            { "name": "voluntary_total", "type": "u64" },
            { "name": "involuntary_total", "type": "u64" }
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
            { "name": "y", "type": "f64" },
            { "name": "message", "type": "utf8" }
          ]
        }
      ],
      "panels": [
        {
          "title": "WASM · CPU Usage",
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
              }
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
              }
            },
            {
              "name": "horizontal-rule/v1",
              "y": { "table": "settings", "column": "capacity" },
              "scale": "usage",
              "color": "#ffcf99"
            },
            {
              "name": "swatch/v1",
              "label": "available parallelism",
              "color": "#ffcf99",
              "sample": "rule",
              "value": {
                "table": "settings",
                "column": "capacity",
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
                { "label": "Window", "column": "window_ns", "unit": "ns" },
                { "label": "CPU time", "column": "cpu_ns", "unit": "ns" },
                { "label": "Cores", "column": "cores" },
                { "label": "Total CPU", "column": "percent", "unit": "%" }
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
              "color": "#81c784"
            },
            {
              "name": "interval-area/v1",
              "table": "context_intervals",
              "start": "start_ns",
              "end": "end_ns",
              "y": "involuntary_rate",
              "scale": "rate",
              "color": "#ffb74d"
            },
            {
              "name": "interval-line/v1",
              "table": "context_intervals",
              "start": "start_ns",
              "end": "end_ns",
              "y": "voluntary_rate",
              "scale": "rate",
              "color": "#81c784"
            },
            {
              "name": "interval-line/v1",
              "table": "context_intervals",
              "start": "start_ns",
              "end": "end_ns",
              "y": "involuntary_rate",
              "scale": "rate",
              "color": "#ffb74d"
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
                { "label": "Window", "column": "window_ns", "unit": "ns" },
                { "label": "Voluntary", "column": "voluntary_delta", "unit": "switches" },
                { "label": "Rate", "column": "voluntary_rate", "unit": "switches/s" }
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
                { "label": "Window", "column": "window_ns", "unit": "ns" },
                { "label": "Involuntary", "column": "involuntary_delta", "unit": "switches" },
                { "label": "Rate", "column": "involuntary_rate", "unit": "switches/s" }
              ]
            },
            {
              "name": "readout/v1",
              "table": "context_intervals",
              "match": {
                "start": "start_ns",
                "end": "end_ns",
                "y": "voluntary_rate"
              },
              "items": [
                { "label": "Voluntary", "column": "voluntary_rate", "unit": "switches/s" },
                { "label": "Involuntary", "column": "involuntary_rate", "unit": "switches/s" }
              ]
            }
          ]
        },
        {
          "title": "WASM · Context Switches (Cumulative)",
          "scales": [
            {
              "name": "switches",
              "domain": { "mode": "visible", "include": [0] }
            }
          ],
          "components": [
            {
              "name": "line/v1",
              "table": "context_samples",
              "x": "time_ns",
              "y": "voluntary_total",
              "scale": "switches",
              "color": "#81c784"
            },
            {
              "name": "line/v1",
              "table": "context_samples",
              "x": "time_ns",
              "y": "involuntary_total",
              "scale": "switches",
              "color": "#ffb74d"
            },
            {
              "name": "swatch/v1",
              "label": "Voluntary",
              "color": "#81c784",
              "sample": "line"
            },
            {
              "name": "swatch/v1",
              "label": "Involuntary",
              "color": "#ffb74d",
              "sample": "line"
            },
            {
              "name": "tooltip/v1",
              "table": "context_samples",
              "match": { "x": "time_ns", "y": "voluntary_total" },
              "items": [
                { "label": "Voluntary", "column": "voluntary_total", "unit": "switches" }
              ]
            },
            {
              "name": "tooltip/v1",
              "table": "context_samples",
              "match": { "x": "time_ns", "y": "involuntary_total" },
              "items": [
                { "label": "Involuntary", "column": "involuntary_total", "unit": "switches" }
              ]
            },
            {
              "name": "readout/v1",
              "table": "context_samples",
              "match": { "x": "time_ns", "y": "voluntary_total" },
              "items": [
                { "label": "Voluntary", "column": "voluntary_total" },
                { "label": "Involuntary", "column": "involuntary_total" }
              ]
            }
          ]
        },
        {
          "title": "WASM · Extremely Scientific Dinosaur",
          "x_axis": { "type": "linear", "domain": [0, 100] },
          "scales": [
            {
              "name": "body",
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
              "scale": "body",
              "color": "#66d17a"
            },
            {
              "name": "polyline/v1",
              "table": "dino_flames",
              "x": "x",
              "y": "y",
              "scale": "body",
              "color": "#ff7043"
            },
            {
              "name": "swatch/v1",
              "label": "Dinosaur",
              "color": "#66d17a",
              "sample": "line"
            },
            {
              "name": "swatch/v1",
              "label": "Flames",
              "color": "#ff7043",
              "sample": "line"
            },
            {
              "name": "tooltip/v1",
              "table": "dino_body",
              "match": { "x": "x", "y": "y" },
              "items": [
                { "label": "Dino says", "column": "message" }
              ]
            },
            {
              "name": "tooltip/v1",
              "table": "dino_flames",
              "match": { "x": "x", "y": "y" },
              "items": [
                { "label": "Science", "column": "message" }
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

struct CpuBatch {
    start_ns: Vec<u64>,
    end_ns: Vec<u64>,
    window_ns: Vec<u64>,
    cpu_ns: Vec<u64>,
    cores: Vec<f64>,
    percent: Vec<f64>,
    percent_validity: Vec<u8>,
}

impl Default for CpuBatch {
    fn default() -> Self {
        Self {
            start_ns: Vec::with_capacity(BATCH_ROWS),
            end_ns: Vec::with_capacity(BATCH_ROWS),
            window_ns: Vec::with_capacity(BATCH_ROWS),
            cpu_ns: Vec::with_capacity(BATCH_ROWS),
            cores: Vec::with_capacity(BATCH_ROWS),
            percent: Vec::with_capacity(BATCH_ROWS),
            percent_validity: Vec::with_capacity(BATCH_ROWS.div_ceil(8)),
        }
    }
}

impl CpuBatch {
    fn push(&mut self, previous: ResourceSample, current: ResourceSample, capacity: Option<f64>) {
        let Some(window_ns) = current.timestamp_ns.checked_sub(previous.timestamp_ns) else {
            return;
        };
        if window_ns == 0 {
            return;
        }
        let Some(user_ns) = current.user_cpu_ns.checked_sub(previous.user_cpu_ns) else {
            return;
        };
        let Some(system_ns) = current.system_cpu_ns.checked_sub(previous.system_cpu_ns) else {
            return;
        };
        let Some(cpu_ns) = user_ns.checked_add(system_ns) else {
            return;
        };
        let cores = cpu_ns as f64 / window_ns as f64;
        if !cores.is_finite() {
            return;
        }

        self.start_ns.push(previous.timestamp_ns);
        self.end_ns.push(current.timestamp_ns);
        self.window_ns.push(window_ns);
        self.cpu_ns.push(cpu_ns);
        self.cores.push(cores);
        push_optional(
            &mut self.percent,
            &mut self.percent_validity,
            capacity.map(|value| ((cores / value) * 100.0).min(100.0)),
        );
    }

    fn flush(&mut self, output: &mut OutputSink) -> Result<()> {
        if self.start_ns.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(self);
        output.emit(
            CPU_INTERVALS,
            vec![
                Column::U64 {
                    values: batch.start_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.end_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.window_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.cpu_ns,
                    validity: None,
                },
                Column::F64 {
                    values: batch.cores,
                    validity: None,
                },
                Column::F64 {
                    values: batch.percent,
                    validity: Some(batch.percent_validity),
                },
            ],
        )
    }
}

struct ContextBatch {
    start_ns: Vec<u64>,
    end_ns: Vec<u64>,
    window_ns: Vec<u64>,
    voluntary_delta: Vec<u64>,
    voluntary_delta_validity: Vec<u8>,
    voluntary_rate: Vec<f64>,
    voluntary_rate_validity: Vec<u8>,
    involuntary_delta: Vec<u64>,
    involuntary_delta_validity: Vec<u8>,
    involuntary_rate: Vec<f64>,
    involuntary_rate_validity: Vec<u8>,
    voluntary_total: Vec<u64>,
    involuntary_total: Vec<u64>,
}

impl Default for ContextBatch {
    fn default() -> Self {
        Self {
            start_ns: Vec::with_capacity(BATCH_ROWS),
            end_ns: Vec::with_capacity(BATCH_ROWS),
            window_ns: Vec::with_capacity(BATCH_ROWS),
            voluntary_delta: Vec::with_capacity(BATCH_ROWS),
            voluntary_delta_validity: Vec::with_capacity(BATCH_ROWS.div_ceil(8)),
            voluntary_rate: Vec::with_capacity(BATCH_ROWS),
            voluntary_rate_validity: Vec::with_capacity(BATCH_ROWS.div_ceil(8)),
            involuntary_delta: Vec::with_capacity(BATCH_ROWS),
            involuntary_delta_validity: Vec::with_capacity(BATCH_ROWS.div_ceil(8)),
            involuntary_rate: Vec::with_capacity(BATCH_ROWS),
            involuntary_rate_validity: Vec::with_capacity(BATCH_ROWS.div_ceil(8)),
            voluntary_total: Vec::with_capacity(BATCH_ROWS),
            involuntary_total: Vec::with_capacity(BATCH_ROWS),
        }
    }
}

impl ContextBatch {
    fn push(&mut self, previous: ResourceSample, current: ResourceSample) {
        let Some(window_ns) = current.timestamp_ns.checked_sub(previous.timestamp_ns) else {
            return;
        };
        if window_ns == 0 {
            return;
        }
        let seconds = window_ns as f64 / 1_000_000_000.0;
        let voluntary = current
            .voluntary_context_switches
            .checked_sub(previous.voluntary_context_switches);
        let involuntary = current
            .involuntary_context_switches
            .checked_sub(previous.involuntary_context_switches);

        self.start_ns.push(previous.timestamp_ns);
        self.end_ns.push(current.timestamp_ns);
        self.window_ns.push(window_ns);
        push_optional(
            &mut self.voluntary_delta,
            &mut self.voluntary_delta_validity,
            voluntary,
        );
        push_optional(
            &mut self.voluntary_rate,
            &mut self.voluntary_rate_validity,
            voluntary.map(|value| value as f64 / seconds),
        );
        push_optional(
            &mut self.involuntary_delta,
            &mut self.involuntary_delta_validity,
            involuntary,
        );
        push_optional(
            &mut self.involuntary_rate,
            &mut self.involuntary_rate_validity,
            involuntary.map(|value| value as f64 / seconds),
        );
        self.voluntary_total
            .push(current.voluntary_context_switches);
        self.involuntary_total
            .push(current.involuntary_context_switches);
    }

    fn flush(&mut self, output: &mut OutputSink) -> Result<()> {
        if self.start_ns.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(self);
        output.emit(
            CONTEXT_INTERVALS,
            vec![
                Column::U64 {
                    values: batch.start_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.end_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.window_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.voluntary_delta,
                    validity: Some(batch.voluntary_delta_validity),
                },
                Column::F64 {
                    values: batch.voluntary_rate,
                    validity: Some(batch.voluntary_rate_validity),
                },
                Column::U64 {
                    values: batch.involuntary_delta,
                    validity: Some(batch.involuntary_delta_validity),
                },
                Column::F64 {
                    values: batch.involuntary_rate,
                    validity: Some(batch.involuntary_rate_validity),
                },
                Column::U64 {
                    values: batch.voluntary_total,
                    validity: None,
                },
                Column::U64 {
                    values: batch.involuntary_total,
                    validity: None,
                },
            ],
        )
    }
}

struct ContextSampleBatch {
    time_ns: Vec<u64>,
    voluntary_total: Vec<u64>,
    involuntary_total: Vec<u64>,
}

impl Default for ContextSampleBatch {
    fn default() -> Self {
        Self {
            time_ns: Vec::with_capacity(BATCH_ROWS),
            voluntary_total: Vec::with_capacity(BATCH_ROWS),
            involuntary_total: Vec::with_capacity(BATCH_ROWS),
        }
    }
}

impl ContextSampleBatch {
    fn push(&mut self, sample: ResourceSample) {
        self.time_ns.push(sample.timestamp_ns);
        self.voluntary_total.push(sample.voluntary_context_switches);
        self.involuntary_total
            .push(sample.involuntary_context_switches);
    }

    fn flush(&mut self, output: &mut OutputSink) -> Result<()> {
        if self.time_ns.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(self);
        output.emit(
            CONTEXT_SAMPLES,
            vec![
                Column::U64 {
                    values: batch.time_ns,
                    validity: None,
                },
                Column::U64 {
                    values: batch.voluntary_total,
                    validity: None,
                },
                Column::U64 {
                    values: batch.involuntary_total,
                    validity: None,
                },
            ],
        )
    }
}

#[derive(Default)]
struct DemoExtension {
    capacity: Option<f64>,
    previous: Option<ResourceSample>,
    cpu: CpuBatch,
    context: ContextBatch,
    context_samples: ContextSampleBatch,
}

impl Extension for DemoExtension {
    fn on_start(&mut self, output: &mut OutputSink) -> Result<()> {
        emit_dinosaur(output)
    }

    fn on_event(&mut self, event: Event<'_, '_>, output: &mut OutputSink) -> Result<()> {
        match event.name() {
            "SegmentMetadataEvent" => {
                if let Some(entries) = event
                    .field("entries")
                    .and_then(|value| value.as_string_map())
                {
                    for (key, value) in entries {
                        if key == "process.available_parallelism" {
                            self.capacity = value
                                .parse::<f64>()
                                .ok()
                                .filter(|capacity| capacity.is_finite() && *capacity > 0.0);
                        }
                    }
                }
            }
            "ProcessResourceUsageEvent" => {
                let Some(sample) = resource_sample(&event) else {
                    return Ok(());
                };
                self.context_samples.push(sample);
                if let Some(previous) = self.previous.replace(sample) {
                    self.cpu.push(previous, sample, self.capacity);
                    self.context.push(previous, sample);
                    if self.cpu.start_ns.len() >= BATCH_ROWS {
                        self.cpu.flush(output)?;
                    }
                    if self.context.start_ns.len() >= BATCH_ROWS {
                        self.context.flush(output)?;
                    }
                }
                if self.context_samples.time_ns.len() >= BATCH_ROWS {
                    self.context_samples.flush(output)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink) -> Result<()> {
        self.cpu.flush(output)?;
        self.context.flush(output)?;
        self.context_samples.flush(output)?;
        let mut values = Vec::with_capacity(1);
        let mut validity = Vec::with_capacity(1);
        push_optional(&mut values, &mut validity, self.capacity);
        output.emit(
            SETTINGS,
            vec![Column::F64 {
                values,
                validity: Some(validity),
            }],
        )
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

fn push_optional<T: Default>(values: &mut Vec<T>, validity: &mut Vec<u8>, value: Option<T>) {
    let row = values.len();
    if row.is_multiple_of(8) {
        validity.push(0);
    }
    if let Some(value) = value {
        validity[row / 8] |= 1 << (row % 8);
        values.push(value);
    } else {
        values.push(T::default());
    }
}

fn utf8_column(values: &[Option<&str>]) -> Column {
    let mut offsets = Vec::with_capacity(values.len() + 1);
    let mut bytes = Vec::new();
    let mut validity = Vec::with_capacity(values.len().div_ceil(8));
    offsets.push(0);
    for &value in values {
        push_optional_string(&mut bytes, &mut offsets, &mut validity, value);
    }
    Column::Utf8 {
        offsets,
        bytes,
        validity: values.iter().any(Option::is_none).then_some(validity),
    }
}

fn push_optional_string(
    bytes: &mut Vec<u8>,
    offsets: &mut Vec<u32>,
    validity: &mut Vec<u8>,
    value: Option<&str>,
) {
    let row = offsets.len() - 1;
    if row.is_multiple_of(8) {
        validity.push(0);
    }
    if let Some(value) = value {
        validity[row / 8] |= 1 << (row % 8);
        bytes.extend_from_slice(value.as_bytes());
    }
    offsets.push(bytes.len() as u32);
}

fn emit_dinosaur(output: &mut OutputSink) -> Result<()> {
    const BODY: &[(f64, f64, Option<&str>)] = &[
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
    const FLAMES: &[(f64, f64)] = &[
        (78.0, 7.6),
        (84.0, 8.5),
        (82.0, 7.5),
        (90.0, 7.8),
        (84.0, 6.8),
        (78.0, 7.2),
    ];

    output.emit(
        DINO_BODY,
        vec![
            Column::F64 {
                values: BODY.iter().map(|point| point.0).collect(),
                validity: None,
            },
            Column::F64 {
                values: BODY.iter().map(|point| point.1).collect(),
                validity: None,
            },
            utf8_column(&BODY.iter().map(|point| point.2).collect::<Vec<_>>()),
        ],
    )?;
    let messages = vec![Some("🔥"); FLAMES.len()];
    output.emit(
        DINO_FLAMES,
        vec![
            Column::F64 {
                values: FLAMES.iter().map(|point| point.0).collect(),
                validity: None,
            },
            Column::F64 {
                values: FLAMES.iter().map(|point| point.1).collect(),
                validity: None,
            },
            utf8_column(&messages),
        ],
    )
}

dial9_viewer_extension::export_extension!(DemoExtension);

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        timestamp_ns: u64,
        user_cpu_ns: u64,
        system_cpu_ns: u64,
        voluntary: u64,
        involuntary: u64,
    ) -> ResourceSample {
        ResourceSample {
            timestamp_ns,
            user_cpu_ns,
            system_cpu_ns,
            voluntary_context_switches: voluntary,
            involuntary_context_switches: involuntary,
        }
    }

    #[test]
    fn computes_cpu_and_context_deltas_from_adjacent_samples() {
        let previous = sample(10, 100, 50, 20, 4);
        let current = sample(20, 106, 54, 25, 5);
        let mut cpu = CpuBatch::default();
        let mut context = ContextBatch::default();

        cpu.push(previous, current, Some(2.0));
        context.push(previous, current);

        assert_eq!(cpu.start_ns, [10]);
        assert_eq!(cpu.cpu_ns, [10]);
        assert_eq!(cpu.cores, [1.0]);
        assert_eq!(cpu.percent, [50.0]);
        assert_eq!(cpu.percent_validity, [1]);
        assert_eq!(context.voluntary_delta, [5]);
        assert_eq!(context.involuntary_delta, [1]);
        assert_eq!(context.voluntary_rate, [500_000_000.0]);
    }

    #[test]
    fn counter_decreases_create_independent_context_gaps() {
        let previous = sample(10, 100, 50, 20, 4);
        let current = sample(20, 90, 60, 19, 7);
        let mut cpu = CpuBatch::default();
        let mut context = ContextBatch::default();

        cpu.push(previous, current, None);
        context.push(previous, current);

        assert!(cpu.start_ns.is_empty());
        assert_eq!(context.voluntary_delta_validity, [0]);
        assert_eq!(context.involuntary_delta_validity, [1]);
        assert_eq!(context.involuntary_delta, [3]);
    }

    #[test]
    fn backward_or_equal_timestamps_do_not_emit_rows() {
        let mut cpu = CpuBatch::default();
        let mut context = ContextBatch::default();
        let previous = sample(20, 100, 50, 2, 3);

        for timestamp in [20, 10] {
            let current = sample(timestamp, 110, 60, 4, 5);
            cpu.push(previous, current, Some(1.0));
            context.push(previous, current);
        }

        assert!(cpu.start_ns.is_empty());
        assert!(context.start_ns.is_empty());
    }
}
