# Trace-bundled viewer extensions

## Goal

Rust libraries and applications can attach computations and complete custom
views to a trace. Once the generic machinery exists, a new view does not
require a viewer change.

The contract separates:

- ordinary Rust computation in sandboxed core WebAssembly;
- immutable typed tables produced by that computation;
- versioned, reusable viewer components declared in a static manifest.

The design follows Perfetto's separation between data producers and reusable
track renderers rather than exposing Canvas or viewer internals to extensions.

## Topology

```text
decompressed D9TF ─┬─→ normal viewer parser
                   ├─→ Worker 1 → Wasm extension 1 → columnar batches
                   ├─→ Worker 2 → Wasm extension 2 → columnar batches
                   └─→ Worker N → Wasm extension N → columnar batches
                                                        │
                                             instance-scoped stores
                                                        │
                                           stackable panel components
```

- Every module has one dedicated Worker and one WebAssembly instance.
- Main posts each decompressed chunk to every Worker and immediately continues
  parsing. v1 has no credits or backpressure; Worker message queues may grow.
- Until the first attachment preamble closes, main retains that small input
  prefix. It starts discovered Workers, replays the prefix to them, then fans
  out later chunks directly. The normal parser does not wait for this scan.
- A Worker processes messages in order. After each guest call it drains and
  acknowledges all available output before handling its next message.
- Input crosses into each guest once, as raw D9TF bytes. There is no host call
  per event and no JavaScript event-object graph for extension computation.
- The viewer stores output by extension instance. Identical table names in
  different modules never collide.

## Trust boundary

The browser and dial9 viewer are trusted. Trace bytes, embedded modules,
manifests, descriptors, and output buffers are untrusted.

- Modules are core WebAssembly built for `wasm32-unknown-unknown`.
- Modules must declare zero imports. They receive no WASI, DOM, network,
  storage, clock, JavaScript object, or host callback capability.
- Compilation, instantiation, and execution happen in a disposable Worker.
- All guest pointers, lengths, descriptors, schemas, and manifests are
  validated before data reaches renderers.
- A trap or invalid output removes only that extension instance.
- Guest strings are inserted as text, never HTML.
- v1 provides capability isolation, not availability quotas. Memory, execution,
  module-count, and output limits are deliberately deferred until supported by
  representative measurements.

Core WebAssembly has no ambient host access; environment interaction exists
only through imports. The host therefore rejects any module for which
`WebAssembly.Module.imports(module)` is non-empty.

## Trace attachment

D9TF frame `0x07` is a generic embedded file:

```text
tag:u8 = 0x07
name_len:u16-le
data_len:u32-le
name:name_len bytes of UTF-8
data:data_len opaque bytes
```

Embedded files form one contiguous preamble immediately after every D9TF
header. A file after any other frame is invalid.

`SegmentWriter` repeats registered files at the start of every physical
segment, before metadata and clock sync, so each segment remains independently
openable. Rust registration is:

```rust
EmbeddedFile::borrowed(name, &'static [u8])
EmbeddedFile::owned(name, Vec<u8>)
RecorderBuilder::embedded_file(file)
```

Names are opaque labels, not global identities. The viewer automatically loads
`.wasm` files from only the first D9TF header of a logical trace load. Repeated
preambles, thread-local headers, and later appended trace segments are decoded
but do not create duplicate instances in v1.

## Rust SDK

The `dial9-viewer-extension` crate exposes:

```rust
pub trait Extension: Default {
    fn on_start(&mut self, output: &mut OutputSink) -> Result<()> {
        Ok(())
    }

    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink,
    ) -> Result<()> {
        Ok(())
    }

    fn finish(self, output: &mut OutputSink) -> Result<()> {
        Ok(())
    }
}
```

`Event` and `Value` borrow the incremental D9TF decoder. They expose event
names, timestamps, schema-order fields, units, integers, floats, booleans,
strings, bytes, inline and pooled stacks, lists, maps, and pooled strings.
Values cannot outlive `on_event`.

The guest may keep arbitrary Rust state, including maps for joins, partitions,
or start/end matching. It emits typed tables at any lifecycle point:

```rust
output.emit(
    TableId::new(0),
    vec![
        Column::U64 { values: start_ns, validity: None },
        Column::U64 { values: end_ns, validity: None },
        Column::F64 { values: cores, validity: Some(cores_validity) },
        Column::F64 { values: percent, validity: Some(percent_validity) },
    ],
)?;
```

`TableId` is the zero-based table position in the manifest. Columns are in
manifest order; names do not cross the ABI.

The SDK validates:

- at least one column;
- equal row counts;
- `u32` ABI lengths;
- one LSB-first validity bit per row (`1` valid, `0` null);
- UTF-8 offsets beginning at zero, monotonically covering the byte buffer, with
  each row containing valid UTF-8.

The host additionally validates the table ID, column count, type, and
nullability against the manifest.

## Manifest

Exactly one `dial9.viewer.manifest` WebAssembly custom section contains UTF-8
JSON. The host parses and validates it before instantiation.

```rust
dial9_viewer_extension::manifest!(r#"
{
  "version": 1,
  "tables": [],
  "panels": []
}
"#);
```

`manifest!` is declarative and dependency-free. At compile time it removes only
JSON whitespace outside strings and preserves string bytes and escapes.

### Tables

```json
{
  "name": "cpu_intervals",
  "columns": [
    { "name": "start_ns", "type": "u64" },
    { "name": "end_ns", "type": "u64" },
    { "name": "cores", "type": "f64", "nullable": true },
    { "name": "percent", "type": "f64", "nullable": true }
  ]
}
```

- Table and column names are unique and non-empty within the manifest.
- Initial types are `f64`, `i64`, `u64`, `u32`, `u8`, and `utf8`.
- `nullable` defaults to `false`.
- Multiple emitted batches append rows to the same logical table.
- Tables become visible to panels only after the extension finishes
  successfully. Failure discards acknowledged and queued partial output.

### Panels and scales

```json
{
  "title": "CPU Usage",
  "height": 96,
  "x_axis": { "type": "time" },
  "scales": [
    {
      "name": "usage",
      "domain": { "mode": "visible", "include": [0] }
    }
  ],
  "components": []
}
```

- `height` is optional and expressed in CSS pixels.
- `x_axis.type` is `time` or `linear`; linear axes may declare a fixed
  `[min, max]` domain.
- Every graphical Y channel selects a named linear scale.
- A scale domain is either
  `{ "mode": "fixed", "min": value, "max": value }` or
  `{ "mode": "visible", "include": [value, ...] }`. A value is a finite
  number or a scalar reference. All graphical components using a visible scale
  participate in its derived domain.
- Panels and components are identified internally by array position. Public
  IDs are unnecessary.
- Component array order is drawing Z-order.

### Component references

A component table reference is a manifest table name. A column reference is a
column name in that table. A scalar reference selects row zero:

```json
{ "table": "settings", "column": "capacity" }
```

Colors are either CSS color literals or numeric ramps:

```json
{
  "column": "percent",
  "stops": [
    { "at": 0, "color": "#38bdf8" },
    { "at": 100, "color": "#ef4444" }
  ]
}
```

The ramp column belongs to the component's table. Stops must be finite and
strictly increasing.

All component objects use a versioned `name`. Unknown names or versions disable
only their panel. Its shell remains visible with an error naming the missing
component.

## Drawing components

Initial drawing components are:

| Name | Required channels |
| --- | --- |
| `background/v1` | literal color or scalar color reference |
| `interval-area/v1` | table, start, end, y, scale, color |
| `interval-line/v1` | table, start, end, y, scale, color |
| `line/v1` | table, x, y, scale, color |
| `step-line/v1` | table, x, y, scale, color |
| `polyline/v1` | table, x, y, scale, color |
| `horizontal-rule/v1` | literal/scalar y, scale, color |

Common optional styling is line width, dash pattern, and opacity in `[0, 1]`.

- Time X columns are nanosecond `u64` values; linear X and all Y channels are
  numeric.
- `interval-area/v1` accepts an optional numeric or scalar `baseline`; it
  defaults to zero.
- Intervals are `[start, end)`.
- Null in a required geometric channel omits that interval or breaks that path,
  creating a gap.
- `line/v1` connects successive valid points directly.
- `step-line/v1` holds the prior Y until the next X.
- `line/v1` and `step-line/v1` require nondecreasing X values. The host builds
  an index over valid X rows and rejects the panel if that invariant is broken.
- `polyline/v1` follows every row in source order without sorting or
  coalescing. Repeated and decreasing X values are intentional.
- Dense ordered interval, line, and step-line inputs retain their first, last,
  minimum, and maximum rows per horizontal pixel in source order. Null runs
  remain path gaps. `polyline/v1` is never sampled.
- Renderers index time columns and draw only rows intersecting the viewport.
- Hit testing searches the original indexed rows around the pointer, not the
  sampled drawing representatives, so tooltips still resolve exact data.

Hit testing visits graphical components in reverse drawing order. Each
renderer defines containment or nearest-distance behavior. A hit carries the
extension instance, panel, table, row, and component channel mappings.

## Presentation components

Presentation components consume the same tables and hit records as drawings:

| Name | Purpose |
| --- | --- |
| `tooltip/v1` | fields from the winning hit row |
| `swatch/v1` | left-side title label with line/area/reference sample |
| `readout/v1` | right-side cursor samples and viewport reductions |

`tooltip/v1` and `readout/v1` may match a table and optionally channel mappings.
This distinguishes overlaid series from the same table without component IDs.
Null values are omitted.

Channel mappings use an optional `match` object containing any of `x`, `start`,
`end`, and `y`, each naming a column in the presentation component's table.
Tooltip uses the winning graphical hit. A readout item without `reduce` samples
the matching graphical series at the cursor.

Display items contain `label`, `column`, and optional `unit` and
`max_fraction_digits`. Known units such as `ns` and `%` use viewer formatters.
Unknown units are appended as suffixes. With no unit, the raw value is
displayed without an added suffix; `max_fraction_digits` can limit a numeric
value independently. Labels and units are independent, so
`{ "label": "Cores", "column": "cores", "max_fraction_digits": 2 }` does not
render `Cores: … cores`.

`readout/v1` joins items with `·` and supports:

- sampling the current hit/cursor row;
- `min`, `max`, `sum`, `count`, and `mean` over visible rows;
- `time_weighted_mean` with explicit start and end columns.

`swatch/v1` declares `label`, `color`, and `sample` (`line`, `area`, or `rule`),
plus optional line styling and an optional scalar `value` reference with a
unit. Swatches compose independently beside the title without divider dots.
Guide and threshold labels belong in swatches; `horizontal-rule/v1` draws only
their lines, avoiding canvas-label overlap.

## Columnar guest ABI

`export_extension!` exports:

| Export | Contract |
| --- | --- |
| `dial9_abi_version() -> u32` | ABI negotiation; v1 returns `1` |
| `dial9_input_reserve(len) -> u32` | resize reusable input and return pointer |
| `dial9_push(len) -> i32` | process one complete host chunk |
| `dial9_finish() -> i32` | finish decode and extension lifecycle |
| `dial9_output_next() -> i32` | `1` ready, `0` empty, `-1` failed |
| `dial9_output_descriptor_ptr() -> u32` | staged descriptor pointer |
| `dial9_output_descriptor_len() -> u32` | descriptor byte length |
| `dial9_output_ack() -> i32` | release staged guest buffers |
| `dial9_error_ptr/len() -> u32` | UTF-8 terminal error |

Status `0` from `push`, `finish`, and `ack` means success.
JavaScript interprets the bit pattern of pointer and length `i32` results as
unsigned `u32`; addresses at or above 2 GiB are not mistaken for negative
status values.

The output descriptor is little-endian `u32` words:

```text
header:
  [descriptor_version, table_id, rows, column_count]

per column:
  [kind, flags,
   primary_ptr, primary_len_bytes,
   auxiliary_ptr, auxiliary_len_bytes,
   validity_ptr, validity_len_bytes]
```

Column kinds are:

| Kind | Value | Primary | Auxiliary |
| --- | ---: | --- | --- |
| `f64` | 1 | packed values | empty |
| `i64` | 2 | packed values | empty |
| `u64` | 3 | packed values | empty |
| `u32` | 4 | packed values | empty |
| `u8` | 5 | packed values | empty |
| `utf8` | 6 | UTF-8 bytes | `u32` offsets |

Flag bit `0` means a validity bitmap is present. Empty buffers use pointer and
length zero.

A validity buffer is accepted only for a nullable manifest column and has
exactly `ceil(rows / 8)` bytes. Omitting it means every row is valid, including
for a nullable column.

`emit` moves the user's original `Vec`s into the runtime queue. The descriptor
points directly at them; no monolithic guest payload is built. Worker JS:

1. validates the descriptor and every range against current linear memory;
2. copies each column to a dedicated host `ArrayBuffer`;
3. posts transferable buffers to main;
4. calls `ack`, which drops the original guest `Vec`s.

UTF-8 bytes and offsets stay columnar in main and strings are decoded on
demand.

## Host lifecycle

1. Scan and copy first-header embedded files while streaming the normal parser,
   retaining input only until that preamble closes.
2. For each `.wasm`, create a dedicated Worker and replay the retained prefix.
3. Compile the module; require exactly one manifest and zero imports.
4. Parse and semantically validate manifest tables, components, references,
   scales, reducers, units, and styles.
5. Instantiate with `{}` and verify memory plus the v1 ABI exports.
6. Feed every decompressed D9TF chunk in order.
7. Drain batches after every `push`; retain them in a private instance store.
8. On end of trace, call `finish`, drain final batches, then atomically publish
   panels.
9. On failure, terminate the Worker and discard that instance's store and
   panels.

A dropped `.wasm` creates a local instance:

- before a trace, it remains pending for the next logical load;
- after a trace, it receives the retained decompressed D9TF bytes;
- loading a replacement trace removes all instances for the prior load.

Multiple modules may be loaded. An instance identity prevents one module's
tables or lifecycle from affecting another's.

## Viewer integration

The legacy viewer is the first supported UI. Its existing parser and panels
remain unchanged for side-by-side validation. A thin TypeScript adapter owns
extension lifecycle, stores, custom panel layout, viewport mapping, rendering,
hit testing, tooltips, and the hook from `renderAll()`.

The new viewer receives a separate adapter later; neither the Rust SDK,
manifest, nor output ABI depends on legacy global arrays or DOM shape.

## Acceptance fixtures

### CPU — required

The extension must match the existing CPU panel's sample selection and order,
counter deltas, invalid-counter gaps, intervals, cores, percentages, capacity
guide, scale, ramp, area, upper border, viewport readout, and tooltip.

Expected tooltip fields are `Window`, `CPU time`, `Cores`, and `Total CPU`.
Expected readout is `avg … cores · avg …% · max … cores`.

### Dragon — recommended flexibility validation

The fixture uses the coordinates from
`574-computed-fields-and-views-p5`. Separate components draw its background,
green body, outline, and fire. The path includes repeated and decreasing X
coordinates. Tail and head hits show 💩 and ❤️ only in the tooltip.

### Additional coverage

- line and step-line overlays with independent hits and tooltips;
- queue-depth manifest layout, swatches, rules, cursor values, and viewport
  reducers without replacing the built-in panel;
- multiple modules and duplicate table names;
- invalid imports, traps, pointers, UTF-8, descriptors, schemas, and manifests;
- attachments and input split at every byte boundary;
- multiple batches, gaps, nullability, and lazy UTF-8;
- a reproducible 250k-event and generated-large-trace benchmark covering
  decode, computation, transfer, and guest/host memory;
- Rust, Vitest, Vite build, and browser integration suites, plus visual
  side-by-side review against the unchanged legacy panels.

### Executable fixture

`examples/viewer-extension-demo` is a real extension, not a host-side mock. It
uses fixed manifest-order `TableId`s and raw `Vec<Column>` batches to provide:

- CPU intervals and presentation matching the built-in panel;
- independent nullable voluntary/involuntary context-switch rates;
- the source-order dinosaur and graphical flame paths from the acceptance
  fixture.

Its optional `make_trace` binary embeds the compiled module in a synthetic
D9TF trace. From `dial9-viewer/ui`, `npm run test:viewer-extension-demo`
compiles the guest, generates that trace, feeds it through the production ABI
at arbitrary chunk boundaries, and verifies its tables and presentation
components. `npm run test:viewer-extension-browser` additionally loads the
trace through the legacy page in Chromium, checks that built-in panels remain,
compares CPU readout values, verifies every custom canvas, and exercises the
dinosaur tail/head hit regions. It also loads the same module before and after
the trace, verifying pending replay, immediate replay, and instance-scoped
duplicate table names.

### Performance fixture

From `dial9-viewer/ui`, `npm run bench:viewer-extension` generates 250,000
resource-usage events and reports one machine-readable
`VIEWER_EXTENSION_BENCHMARK` record. It measures module compilation,
manifest validation and instantiation separately from D9TF decoding,
computation, guest-to-host column copies, transferable ownership handoff, and
store append. It also reports exact trace/module/output byte counts and initial
and peak WebAssembly linear-memory sizes.

`DIAL9_VIEWER_EXTENSION_BENCH_SAMPLES` selects a larger generated workload.
Build and fixture generation are outside measured phases. The check validates
all resulting row counts but deliberately has no performance threshold.

## Versioning and deferred work

- ABI and manifest top-level versions are independent numeric contracts.
- Component names include their version (`name/v1`), allowing additive
  implementations without silently changing old rendering.
- Unknown top-level versions reject the extension; unknown component versions
  produce a visible panel-local error.

Deferred:

- adapter for the new viewer;
- reactive WebAssembly callbacks;
- resource quotas and static policy limits;
- generated table builders, domain structs, proc macros, and serializers;
- alternative activation policies for later appended trace attachments;
- CLI/server hosts;
- specialized heatmap, slices, spans, and flamegraph components;
- replacement of the built-in queue-depth panel.
