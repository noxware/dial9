# Viewer extensions

Viewer extensions are Rust programs compiled to core WebAssembly. They consume
the same decompressed D9TF byte stream as the viewer and emit immutable typed
tables. A static manifest composes semantic components over those tables.

```text
D9TF ─┬─→ viewer parser
      └─→ dedicated Worker → extension WASM → column batches → panels
```

Version 1 loads `.wasm` files by drag and drop in the legacy viewer. A module
may be dropped before a trace or after one is loaded. Embedding the same module
bytes in D9TF is deferred; it does not change the SDK, ABI, manifest, or
component contracts documented here.

## Rust extension

An extension crate needs a `cdylib`:

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
dial9-viewer-extension = "0.5.0-rc0"
```

```rust
use dial9_viewer_extension::{
    Column, Event, Extension, ExtensionError, OutputSink, TableId,
};

const POINTS: TableId = TableId::new(0);

dial9_viewer_extension::manifest!(r#"
{
  "version": 1,
  "tables": [{
    "name": "points",
    "columns": [
      { "name": "time_ns", "type": "u64" },
      { "name": "value", "type": "f64", "nullable": true }
    ]
  }],
  "panels": [{
    "title": "My panel",
    "components": [{
      "name": "line/v1",
      "table": "points",
      "x": "time_ns",
      "y": "value"
    }]
  }]
}
"#);

#[derive(Default)]
struct MyExtension {
    time_ns: Vec<u64>,
    values: Vec<f64>,
}

impl Extension for MyExtension {
    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink<'_>,
    ) -> Result<(), ExtensionError> {
        if event.name() != "MyEvent" {
            return Ok(());
        }
        let Some((time_ns, value)) =
            event.timestamp_ns().zip(event.field("value").and_then(|v| v.as_f64()))
        else {
            return Ok(());
        };
        self.time_ns.push(time_ns);
        self.values.push(value);
        if self.time_ns.len() == 1024 {
            output.emit(
                POINTS,
                vec![
                    Column::U64 {
                        values: std::mem::take(&mut self.time_ns),
                        validity: None,
                    },
                    Column::F64 {
                        values: std::mem::take(&mut self.values),
                        validity: None,
                    },
                ],
            )?;
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        if !self.time_ns.is_empty() {
            output.emit(
                POINTS,
                vec![
                    Column::U64 { values: self.time_ns, validity: None },
                    Column::F64 { values: self.values, validity: None },
                ],
            )?;
        }
        Ok(())
    }
}

dial9_viewer_extension::export_extension!(MyExtension);
```

Build it without WASI or `wasm-bindgen`:

```sh
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
```

`on_start`, `on_event`, and `finish` run in input order. Any hook may emit
batches. `finish` only flushes end-of-input state; it does not return a bundle.
A hook error is fatal to that extension instance but does not stop the normal
viewer or other extensions.

`Event` is an allocation-free view over the on-wire event. It provides the
schema name, optional timestamp, named or schema-order fields, and field units.
`Value` exposes checked conversions for integers, floats, booleans, strings,
bytes, stacks, lists, maps, and string maps. Borrowed values are valid only
during the current `on_event` call.

## Tables and batches

The manifest's `tables` array is the schema and source of table IDs.
`TableId::new(n)` addresses position `n`; column vectors use manifest order, so
names are never sent across the ABI.

| Manifest type | Rust column | Host storage |
| --- | --- | --- |
| `f64` | `Column::F64` | `Float64Array` |
| `i64` | `Column::I64` | `BigInt64Array` |
| `u64` | `Column::U64` | `BigUint64Array` |
| `u32` | `Column::U32` | `Uint32Array` |
| `u8` | `Column::U8` | `Uint8Array` |
| `utf8` | `Column::Utf8` | offsets plus UTF-8 bytes |

Every column in one `emit` must contain the same row count. A nullable column
uses an optional LSB-first validity bitmap: bit `i` is set when row `i` is
present. UTF-8 uses `rows + 1` monotonic `u32` offsets into one byte vector.

`emit` takes ownership of the vectors. The guest retains them until the host
copies and validates the batch and calls the output acknowledgement; the SDK
does not make a second guest-side copy. The viewer stores received typed
columns as chunks and decodes individual UTF-8 cells lazily.

Null in a required geometric channel creates a gap: a point is omitted, an
interval is discarded, and adjacent line runs are not connected.

## Manifest

Exactly one UTF-8 custom section named `dial9.viewer.manifest` must contain a
version-1 JSON object:

```json
{
  "version": 1,
  "tables": [],
  "panels": []
}
```

`manifest!` removes JSON whitespace outside strings at compile time and writes
that custom section. The viewer validates the complete manifest before
instantiating the module.

Panels have these fields:

| Field | Meaning |
| --- | --- |
| `title` | Text shown at the left of the panel |
| `x_axis` | Optional `{ "kind": "time" }` (default) or `{ "kind": "linear" }` |
| `y_scales` | Optional named scales; defaults to one zero-inclusive scale |
| `components` | Stackable components in drawing order |

A Y scale has `name`, optional `include_zero`, and optional `min`/`max`.
Bounds are a finite number or a scalar reference:

```json
{ "table": "limits", "column": "capacity", "select": "first" }
```

Scalar references select `first` or `last`, or reduce with `min`, `max`, `sum`,
`count`, or `mean`. `select` and `reduce` are mutually exclusive.

## Components

The viewer owns physical layout, dimensions, typography, stroke widths,
opacity, grid, hit tolerance, DPR, and theme. A manifest describes data and
meaning; it cannot issue Canvas commands or set pixel-level appearance.

| Component | Required data |
| --- | --- |
| `background/v1` | `color`: literal or UTF-8 scalar reference |
| `interval-area/v1` | `table`, `start`, `end`, `y` |
| `interval-line/v1` | `table`, `start`, `end`, `y` |
| `line/v1` | `table`, `x`, `y` |
| `step-line/v1` | `table`, `x`, `y` |
| `polyline/v1` | `table`, `x`, `y` |
| `horizontal-rule/v1` | `value`: number or scalar reference |
| `tooltip/v1` | `table`, `items` |
| `swatch/v1` | `label`, `color`, `shape` |
| `readout/v1` | `table`, `items` |

Graph components accept an optional named `scale` and `color`. A graph color is
a literal or a numeric ramp:

```json
{
  "column": "load",
  "stops": [
    { "value": 0, "color": "#4fc3f7" },
    { "value": 1, "color": "#ff7361" }
  ]
}
```

`polyline/v1` alone preserves exact row order, including repeated or decreasing
X coordinates. `line/v1` and `step-line/v1` index rows by X so the viewer can
draw only the visible range. Interval components index overlap against the
visible range.

Tooltip items contain `label`, `column`, and an optional `unit`. An optional
`match` maps geometric channels (`x`, `start`, `end`, `y`) to columns, allowing
overlaid graphs from one table to have independent tooltips. Graph hit testing
runs in reverse drawing order.

A swatch's `shape` is `line`, `area`, or `reference`. It may show a formatted
scalar `value`. Multiple swatches compose beside the title; reference labels
stay outside the canvas so guides cannot overlap text.

Readout items use either:

- `sample: "hit"` or `sample: "cursor"`;
- `reduce: "min" | "max" | "sum" | "count" | "mean"` over visible rows; or
- a time-weighted visible reducer:

```json
{
  "name": "time_weighted_mean",
  "start": "start_ns",
  "end": "end_ns"
}
```

Readout values compose at the right with `·`. Reducers are cached for the
current viewport rather than recomputed for every pointer event.

Known units such as `ns` and `%` use viewer formatters. Unknown units are plain
suffixes. Omitting `unit` applies ordinary number formatting without adding a
suffix. Titles, labels, values, and errors are inserted as text, never HTML.

An unknown component name or version leaves its panel shell visible with an
error naming the missing component. Other panels and extensions continue.

The reference extension in
`examples/viewer-extension-demo` demonstrates CPU intervals, overlaid context
switch series, viewport readouts, independent tooltips, guides, swatches, and a
multi-layer dinosaur. The queue-depth composition fixture is
`dial9-viewer/ui/src/lib/viewer-extensions/fixtures/queue-depth-manifest.json`.

## Guest ABI

All integers are little-endian `u32`. ABI version 1 requires exported memory
and these functions:

| Export | Contract |
| --- | --- |
| `dial9_abi_version() -> u32` | Returns `1` |
| `dial9_input_alloc(len) -> ptr` | Reserves the next input destination |
| `dial9_push(len) -> status` | Processes those input bytes |
| `dial9_finish() -> status` | Finishes the D9TF stream |
| `dial9_output_next() -> ptr` | Returns the next descriptor, or zero |
| `dial9_output_descriptor_len() -> u32` | Current descriptor length |
| `dial9_output_ack() -> status` | Releases the current batch |
| `dial9_error_ptr/len()` | Current UTF-8 error |

The host drains and acknowledges all available batches after every `push` and
after `finish`.

A batch descriptor begins with
`table_id, rows, column_count, reserved`. Each column then contributes eight
words:

```text
type, flags,
values_ptr, values_len,
offsets_ptr, offsets_len,
validity_ptr, validity_len
```

Type tags follow the table above (`f64 = 1` through `utf8 = 6`). Flag bit zero
means validity is present; all other bits are reserved. Numeric columns do not
use offsets. The host validates the descriptor, schema, lengths, pointers,
UTF-8, and validity before acknowledging guest memory.

## Isolation and lifecycle

The trace file and extension are untrusted; the browser and viewer are trusted.

- Each module runs in its own dedicated Worker.
- The module must have zero imports and is instantiated with `{}`.
- It receives no DOM, JavaScript object, network, storage, clock, WASI, or other
  browser capability.
- Input crosses only as D9TF bytes; output crosses only through validated
  numeric descriptors and copied typed buffers.
- A trap, invalid output, or hook error removes only that instance.
- Partial output is not published. Panels appear only after successful
  `finish`.
- Extension table names are scoped by instance, so modules cannot overwrite
  one another.

Version 1 intentionally has no CPU, memory, output, or message-queue quotas. A
module can consume excessive resources or loop forever in its Worker, but it
cannot acquire browser capabilities through this ABI. Resource policy remains
separate from the versioned data and component contracts.

The main thread sends each decompressed input chunk to every extension Worker
and immediately continues its own parser. Worker queues preserve order; there
is no v1 backpressure. Loading a module after a trace replays the viewer's
retained decompressed buffer. Replacing or cancelling a logical trace disposes
its extension instances.
