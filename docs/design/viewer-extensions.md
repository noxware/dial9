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
    Event, Extension, ExtensionError, OutputSink,
};

dial9_viewer_extension::include_manifest!("viewer-extension.json");

#[derive(Default)]
struct MyExtension {
    points: tables::points::Batch,
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
        self.points.push(tables::points::Row {
            time_ns,
            value: Some(value),
        })?;
        if self.points.len() == 1024 {
            self.points.emit(output)?;
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        self.points.emit(output)?;
        Ok(())
    }
}

dial9_viewer_extension::export_extension!(MyExtension);
```

`viewer-extension.json` contains both the output schemas and their panels:

```json
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

`include_manifest!` resolves its path relative to `CARGO_MANIFEST_DIR`, parses
the `tables` array at compile time, embeds the compact manifest, and generates:

```text
tables::<table name>::ID
tables::<table name>::Row
tables::<table name>::Batch
```

Table and column names must be valid Rust identifiers; keywords use Rust's raw
identifier syntax in generated code. Nullable columns become `Option<T>` row
fields. UTF-8 fields borrow `&str` while `Batch::push` copies them into offsets
and bytes. `Batch::emit` drains the generated typed columns into the ordinary
output ABI; an empty batch emits nothing.

The raw `TableId`, `Column`, and `OutputSink::emit` API remains available.
Generated batches delegate to it rather than defining another transport.
`TableId::new(n)` addresses position `n`; column vectors use manifest order, so
names are never sent across the ABI.

| Manifest type | Generated row | Raw column | Host storage |
| --- | --- | --- | --- |
| `f64` | `f64` | `Column::F64` | `Float64Array` |
| `i64` | `i64` | `Column::I64` | `BigInt64Array` |
| `u64` | `u64` | `Column::U64` | `BigUint64Array` |
| `u32` | `u32` | `Column::U32` | `Uint32Array` |
| `u8` | `u8` | `Column::U8` | `Uint8Array` |
| `utf8` | `&str` | `Column::Utf8` | offsets plus UTF-8 bytes |

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

`include_manifest!` removes JSON whitespace outside strings at compile time and
writes that custom section. The lower-level `manifest!` embeds an inline JSON
expression without generating table bindings. The viewer validates the
complete manifest before instantiating the module.

Panels have these fields:

| Field | Meaning |
| --- | --- |
| `title` | Text shown at the left of the panel |
| `x_axis` | Optional `{ "kind": "time" }` (default) or a linear axis with optional `min`/`max` |
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
| `line/v1` | `table`, `y`, and either `x` or `start`/`end` |
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
X coordinates. Point-based `line/v1` and `step-line/v1` index rows by X.
Interval-based `line/v1` linearly joins values at contiguous interval
boundaries and covers the final interval through its end. Interval components
index overlap against the visible range.

Tooltip items contain `label`, `column`, and an optional `unit`. An optional
`match` maps geometric channels (`x`, `start`, `end`, `y`) to columns, allowing
overlaid graphs from one table to have independent tooltips. Graph hit testing
runs in reverse drawing order.

A swatch's `shape` is `line`, `area`, or `reference`. A scalar `value` is
formatted as `label (value)`. Multiple swatches compose beside the title;
reference labels stay outside the canvas so guides cannot overlap text.

Like tooltips, a readout may use `match` to select one channel mapping when a
table drives multiple overlaid graphs. Readout items use either:

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

Known units such as `ns` and `%` use viewer formatters. Tooltip unit `timestamp`
uses the viewer's current relative or wall-clock time mode. Unknown units are
plain suffixes. Omitting `unit` applies ordinary number formatting without
adding a suffix. Titles, labels, values, and errors are inserted as text, never
HTML.

An unknown component name or version leaves its panel shell visible with an
error naming the missing component. Other panels and extensions continue.

### Interactive field views

The legacy viewer can graph a numeric field directly from a selected custom
event. `Interpret as` offers three semantic presets:

- `Gauge` maps each raw observation to its timestamp and renders the points as
  a line.
- `Counter rate` emits one rate interval between consecutive observations.
  Counter decreases are gaps.
- `Up/down counter rate` emits the same intervals and permits negative rates.

The viewer scans events in timestamp order without sorting or constructing row
objects, materializes only the matching schema name into host-native typed
columns, and feeds them to the same table store and semantic components used by
extensions. Missing or non-numeric operands are encoded through the validity
bitmap and create gaps. Nanosecond counters are normalized to seconds per
second and presented as a duration per second, such as `494.5ms/s`.

The generated panel composes the corresponding graph, tooltip, and visible
`avg`/`min`/`max` readout. Closing it drops the renderer, table store, and all
references to its typed buffers; replacing the trace closes every interactive
view. This path does not instantiate WASM or encode the guest ABI.

Local typed columns are produced and consumed on the same JavaScript host, so
the guest ABI's little-endian transport requirement does not apply to them.

The reference extension in
`examples/viewer-extension-demo` demonstrates CPU intervals, overlaid context
switch series, viewport readouts, independent tooltips, guides, swatches, and a
multi-layer dinosaur. The queue-depth composition fixture is
`dial9-viewer/ui/src/lib/viewer-extensions/fixtures/queue-depth-manifest.json`.

## Guest ABI

Descriptor words and numeric column values are little-endian. The host maps
copied column buffers directly into JavaScript typed arrays for efficiency, so
viewer extensions require a platform whose typed arrays are little-endian. On
an unsupported big-endian platform, loading an extension fails without
disabling the rest of the viewer.

ABI version 1 requires exported memory and these functions:

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

## Performance check

Generate the deterministic 250,000-event fixture and run all equivalent paths:

```sh
cargo build -p viewer-extension-demo --target wasm32-unknown-unknown \
  --profile viewer-extension
cargo run -p viewer-extension-demo --features trace-fixture \
  --bin make_trace -- /tmp/viewer-extension-bench.bin 250000
DIAL9_EXTENSION_WASM=../../target/wasm32-unknown-unknown/viewer-extension/viewer_extension_demo.wasm \
DIAL9_EXTENSION_TRACE=/tmp/viewer-extension-bench.bin \
  npm --prefix dial9-viewer/ui run bench:viewer-extension
```

The benchmark checks result equivalence before timing. It excludes Wasm
compilation and the one-time reference parse, but includes instantiation,
streaming D9TF decode, computation, guest-to-host validation/copy, simulated
transferable transport, and chunk-store insertion where named.

One local Node/V8 baseline:

| Path | Mean |
| --- | ---: |
| JS `for`, parsed events | 38.1 ms |
| JS `filter`/`map`, parsed events | 59.9 ms |
| JS D9TF parse + `for` | 256.9 ms |
| Wasm, precompiled + validated batches | 65.2 ms |
| Wasm + transferable transport + host store | 84.9 ms |

That run used a 10.53 MiB trace, produced 492 batches and 21.16 MiB of host
columns, and ended with 4.31 MiB of guest linear memory. The stripped reference
module was 91.1 KiB. The benchmark fails if a batch exceeds the extension's
1,024-row bound or, for a large fixture, guest memory grows to the size of the
complete trace.
