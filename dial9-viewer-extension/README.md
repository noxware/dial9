# dial9-viewer-extension

Rust SDK for sandboxed WebAssembly extensions that compute typed datasets for
the dial9 trace viewer.

An extension decodes the raw D9TF stream inside a dedicated Worker, emits
columnar record batches, and declares panels made from viewer-owned semantic
components. Extension code has no access to JavaScript, the DOM, the network,
WASI, or Canvas.

The current viewer loads `.wasm` files by drag and drop. Embedding the same
module bytes in D9TF is a future transport and will not change the SDK,
manifest, or ABI described here.

## Guest lifecycle

Implement `Extension`, embed one manifest, and export the implementation:

```rust
use dial9_viewer_extension::{
    Column, Event, Extension, OutputSink, Result, TableId,
};

#[derive(Default)]
struct CpuExtension {
    samples: Vec<f64>,
}

impl Extension for CpuExtension {
    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink,
    ) -> Result<()> {
        if event.name() == "MySample" {
            if let Some(value) = event.field("value").and_then(|v| v.as_f64()) {
                self.samples.push(value);
            }
        }

        if self.samples.len() == 1_024 {
            output.emit(
                TableId::new(0),
                vec![Column::F64 {
                    values: std::mem::take(&mut self.samples),
                    validity: None,
                }],
            )?;
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink) -> Result<()> {
        if !self.samples.is_empty() {
            output.emit(
                TableId::new(0),
                vec![Column::F64 {
                    values: self.samples,
                    validity: None,
                }],
            )?;
        }
        Ok(())
    }
}

dial9_viewer_extension::manifest!(r#"
{
  "version": 1,
  "tables": [
    {
      "name": "samples",
      "columns": [{ "name": "value", "type": "f64" }]
    }
  ],
  "panels": []
}
"#);

dial9_viewer_extension::export_extension!(CpuExtension);
```

`on_start` runs once before any event, including for an empty input.
`on_event` receives each decoded event in D9TF order, and `finish` consumes the
extension after the decoder has accepted the complete input. Returning an error
from any hook fails only this extension and discards all of its partial output.

`Event` and `Value` borrow decoder storage and are valid only during the
`on_event` call. They expose the event name and timestamp, named fields, field
units, primitive values, bytes, stack frames, string maps, lists, maps, and
pooled strings or stacks without materializing JavaScript event objects.

Build a core WebAssembly module without `wasm-bindgen`:

```bash
rustup target add wasm32-unknown-unknown
cargo build \
  --target wasm32-unknown-unknown \
  --profile viewer-extension
```

The module must have no imports. `export_extension!` exports the versioned ABI
and linear memory expected by the viewer.

## Manifest

`manifest!` removes JSON whitespace outside strings at compile time and writes
the result to the `dial9.viewer.manifest` WebAssembly custom section. It does
not add a JSON parser to the guest. The viewer requires exactly one such
section, valid UTF-8 and JSON, and `"version": 1`.

Tables are positional. `TableId::new(0)` names the first table, and every batch
must emit columns in that table's declared order. Table and column names are
used by components and never cross the output ABI.

```json
{
  "version": 1,
  "tables": [
    {
      "name": "intervals",
      "columns": [
        { "name": "start_ns", "type": "u64" },
        { "name": "end_ns", "type": "u64" },
        { "name": "value", "type": "f64", "nullable": true }
      ]
    }
  ],
  "panels": [
    {
      "title": "Intervals",
      "x_axis": { "type": "time" },
      "scales": [
        {
          "name": "values",
          "domain": { "mode": "visible", "include": [0] }
        }
      ],
      "components": [
        {
          "name": "interval-area/v1",
          "table": "intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "value",
          "scale": "values",
          "color": "#4fc3f7"
        },
        {
          "name": "tooltip/v1",
          "table": "intervals",
          "match": {
            "start": "start_ns",
            "end": "end_ns",
            "y": "value"
          },
          "items": [
            { "label": "Value", "column": "value" }
          ]
        }
      ]
    }
  ]
}
```

### Tables and scalar references

Supported column types are `f64`, `i64`, `u64`, `u32`, `u8`, and `utf8`.
`nullable` defaults to `false`.

A scalar reference has the shape `{"table":"settings","column":"limit"}`.
Its table must contain exactly one row. Numeric positions and scale limits
require a numeric column; a scalar background color requires `utf8`. Invalid
scalar cardinality or values produce a visible error in the affected panel.

### Axes, scales, and colors

- `x_axis` defaults to `{"type":"time"}` and follows the viewer viewport.
  `{"type":"linear","domain":[min,max]}` uses a fixed domain; omitting its
  domain derives one from the panel's graphical data.
- Each Y scale has a unique name. A `visible` domain is derived from geometry
  intersecting the current viewport plus optional `include` literals or scalar
  references. A `fixed` domain takes finite `min` and `max` literals or scalar
  references and requires `min < max`.
- A series color is either a literal CSS color or
  `{"column":"load","stops":[{"at":0,"color":"#4fc3f7"}, ...]}`. Stops are
  finite and strictly increasing; values outside the range use the endpoint
  color.
- A ramp may normalize its column through
  `"domain":{"min":...,"max":...}` before applying its stops. Bounds accept
  finite numbers or one-row numeric scalar references. An optional
  `fallback_scale` uses that named Y scale's current domain when either bound
  is unavailable; without it, an unavailable domain is a visible panel error.
  Resolved bounds must satisfy `min < max`.
- A null or non-finite required geometric value creates a gap. Invalid or
  non-positive intervals are not drawn.

The first Y scale is labeled on the left. Additional scales are labeled on the
right. Their physical layout, along with panel dimensions, padding, grids,
typography, line widths, opacity, hit tolerance, DPR, and theme adaptation,
belongs to the viewer and cannot be specified by a manifest.

### Component catalog

Components are drawn in manifest order. Hit testing walks graphical components
in reverse order, so the topmost valid hit wins. A hit records its instance,
panel, component, table, row, and channel mappings. Presentation components
select hits by table and optional `match` mappings; public component IDs are
not needed.

| Component | Contract |
|---|---|
| `background/v1` | Fills the chart region with a literal color or one-row UTF-8 scalar. Its position in the component array controls its Z order. |
| `interval-area/v1` | Area from `baseline` (default `0`) to `y` over `[start,end)`. `start` rows must be nondecreasing. |
| `interval-line/v1` | Horizontal `y` over `[start,end)`, with vertical connectors only between adjacent, contiguous valid rows. `start` must be nondecreasing. |
| `line/v1` | Straight segments through `x`,`y`; `x` must be nondecreasing. |
| `step-line/v1` | Left-held horizontal steps followed by vertical transitions; `x` must be nondecreasing. |
| `polyline/v1` | Straight segments in source row order. Repeated and decreasing X values are preserved. |
| `horizontal-rule/v1` | Non-interactive horizontal reference at a literal or scalar `y` on a named scale. Put its label in a swatch rather than over the canvas. |
| `tooltip/v1` | Displays configured `items` from the topmost hit row and omits null items. |
| `swatch/v1` | Adds a `line`, `area`, or `rule` sample and label beside the panel title. An optional one-row scalar value follows the label. |
| `readout/v1` | Adds right-aligned items separated by `·`. Items either sample the matched hit/cursor row or reduce the visible viewport. |

`line/v1`, `step-line/v1`, and interval components reject unsorted inputs.
Use `polyline/v1` when source order itself defines the path. Nulls separate
runs rather than connecting across missing data. Dense sorted series are
coalesced per horizontal pixel while retaining endpoints, geometric and color
extrema, transitions between ramp bands, and gaps. Deliberately oscillating
colors remain dense rather than losing their semantics; `polyline/v1` is not
reordered or coalesced.

Tooltip and readout items have `label`, `column`, and an optional `unit`.
A readout item also accepts:

- `min`, `max`, `sum`, `count`, or `mean`;
- `{"name":"time_weighted_mean","start":"start_ns","end":"end_ns"}`.

Reducers ignore null cells and operate on the current viewport. The weighted
mean clips each interval's duration to that viewport. An optional
`"clamp":{"min":...,"max":...}` applies finite bounds to the aggregate after
reduction. Simple reducers derive viewport membership from the graphical
component selected by `table` and `match`; the panel reports an error if none
matches. `time_weighted_mean` can stand alone because its own `start` and `end`
columns define viewport overlap. A readout without `reduce` follows the
topmost matching hit when available, then the matching series at the cursor.

Known units are `ns`, `us`, `ms`, `s`, `bytes`, and `%`. Unknown units are
rendered as suffixes. Omitting `unit` preserves the raw value with no numeric
formatting or suffix.

An unknown versioned component leaves its panel shell visible with an error
naming the missing component. Other panels and extension instances continue
to work.

## Columnar output

`OutputSink::emit` takes owned `Vec` buffers:

```rust
output.emit(
    TableId::new(0),
    vec![
        Column::U64 { values: starts, validity: None },
        Column::U64 { values: ends, validity: None },
        Column::F64 {
            values,
            validity: Some(validity),
        },
    ],
)?;
```

The first column determines the row count. Every column must have that many
rows, and at least one column is required. A validity bitmap has
`ceil(rows / 8)` bytes, one bit per row, least-significant bit first; `1` is
valid and `0` is null. Nullable columns still carry one value slot per row.

`Column::Utf8` uses one byte buffer and `rows + 1` monotonically increasing
`u32` offsets. The first offset is zero, the last equals the byte length, and
every slice must be valid UTF-8. A null string still has an offset entry.

Validation is intentionally split:

- the SDK checks rectangularity, bitmap length, UTF-8 offsets/content, and
  sizes representable by the ABI;
- the Worker checks table IDs, manifest column count/order/type/nullability,
  descriptor layout, pointer ranges, alignment, and UTF-8 before publishing a
  batch.

The viewer stores transferred batches as chunks and decodes UTF-8 cells lazily.
It does not concatenate each table into a second monolithic allocation.

## Numeric ABI v1

The module exports `memory` and these functions:

| Export | Contract |
|---|---|
| `dial9_abi_version() -> i32` | Returns `1`. |
| `dial9_input_reserve(len) -> i32` | Reserves `len` input bytes and returns their pointer. |
| `dial9_push(len) -> i32` | Decodes the bytes written into the reserved range; `0` succeeds. |
| `dial9_finish() -> i32` | Finishes decoding and runs `Extension::finish`; `0` succeeds. |
| `dial9_output_next() -> i32` | Stages the next batch: `1` available, `0` empty, `-1` failed. |
| `dial9_output_descriptor_ptr/len() -> i32` | Returns the staged descriptor range; length is in bytes. |
| `dial9_output_ack() -> i32` | Releases the staged guest batch after the host copies it; `0` succeeds. |
| `dial9_error_ptr/len() -> i32` | Returns the current UTF-8 error range. |

Pointers and lengths are unsigned 32-bit values represented by WebAssembly
`i32`. A zero-length buffer uses pointer zero. Descriptor words are
little-endian `u32`.

The descriptor header is:

```text
[descriptor_version=1, table_id, rows, column_count]
```

Each following column contributes eight words:

```text
[kind, flags, primary_ptr, primary_len,
 auxiliary_ptr, auxiliary_len, validity_ptr, validity_len]
```

Kinds are `1=f64`, `2=i64`, `3=u64`, `4=u32`, `5=u8`, and `6=utf8`.
Numeric data occupies the primary range and has no auxiliary range. UTF-8
bytes occupy the primary range and its `u32` offsets the auxiliary range.
Flag bit zero indicates a validity range; all other bits are reserved.

The guest retains every `Vec` referenced by a staged descriptor. The Worker
copies its buffers into transferable `ArrayBuffer`s, calls
`dial9_output_ack`, and then transfers those buffers to the main thread.
Acknowledgement drops the guest-owned batch; callers must not keep references
to emitted buffers.

## Browser lifecycle and isolation

Each dropped module creates a distinct instance with its own Worker, WASM
memory, tables, and panels. Identical table names in different instances do not
collide.

- Before a trace: the module waits and receives the next logical trace.
- During a trace load: the module is associated with that load and replays the
  retained decompressed stream once the load finishes.
- After a trace: the module immediately replays that retained stream in bounded
  chunks.
- Replacing or resetting the trace terminates its Workers and removes their
  panels. A module is not implicitly carried into a later trace.

The main thread sends decompressed D9TF chunks to all active Workers without
awaiting them. Each Worker processes its message queue in order, drains and
acknowledges all output after each push, and transfers batches back to the main
thread. There is no v1 credit protocol or backpressure.

Panels become visible only after an extension finishes successfully. Invalid
manifests, ABI output, traps, or extension errors discard that instance's
partial store and produce a visible error; other instances continue.

The host rejects every module import and instantiates with an empty import
object. Consequently guest code has no host capability: no DOM, network,
JavaScript objects, browser storage, clocks, randomness, or WASI. The Worker
also validates all guest-controlled memory ranges before reading them.

This is capability isolation, not resource isolation. Version 1 has no CPU,
memory, output-size, module-count, or queue quotas. A malicious or erroneous
module can consume its Worker's resources or fail to terminate, but it cannot
acquire browser capabilities through this ABI.

See
[`examples/viewer-extension-demo`](../examples/viewer-extension-demo/src/lib.rs)
for CPU, context-switch, and arbitrary-order dinosaur panels.
