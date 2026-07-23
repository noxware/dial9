# Trace-bundled viewer extensions

## Goal

Rust libraries can bundle arbitrary trace computations and custom panels without
changing the viewer. Rust is the computation language; WebAssembly is the
sandbox; a small columnar format and stackable components are the UI contract.

## Data flow

```text
trace source ── fetch + gunzip once ── extension worker
                                           │
                      ┌────────────────────┴───────────────────┐
                      │ copy one reusable chunk into each WASM │
                      │ transfer the raw chunk to main         │
                      ▼                                        ▼
               Rust StreamingDecoder                    viewer parser
                      │                                        │
                 extension state                         ParsedTrace
                      │
               D9VO tables + recipes
                      └──────── validate ──────── custom panel tracks
```

- There is one source stream, not two fetches or decompressions.
- Each guest receives raw D9TF chunks, not one host call per event.
- The unavoidable boundary cost is one chunk copy into each guest's reusable
  linear-memory input. The raw chunk is transferred to the main parser.
- A guest retains only its decoder and user-defined state unless its Rust code
  deliberately stores events. It never receives the viewer's `ParsedTrace`.
- Every source segment may repeat the extension preamble. The worker verifies
  identical repeats, instantiates once, and removes repeats from the event
  stream. The retained logical trace keeps one preamble for range reparsing.

Parsing D9TF once in the viewer and once in each guest costs CPU, but avoids a
general decoded-event ABI, per-event crossings, and a second object graph.
Prefer one extension module that emits several tables and panels.

## Rust extension

```rust
#[derive(Default)]
struct Views {
    state: MyState,
}

impl dial9_viewer_extension::Extension for Views {
    fn on_event(&mut self, event: Event<'_, '_>) -> Result<(), ExtensionError> {
        // Filter, join, group, aggregate, or retain whatever state is needed.
        Ok(())
    }

    fn finish(&mut self) -> Result<ViewBundle, ExtensionError> {
        Ok(ViewBundle::new()
            .table(/* columnar output */)
            .panel(/* component recipe */))
    }
}

dial9_viewer_extension::export_extension!(Views);
```

`Event` exposes the timestamp, event name, schema-order field iteration, and
allocation-free views over every D9TF value family, including nested values,
bytes, pooled strings, and stack frames. Computation is ordinary Rust, so
state machines, maps, joins, sorting, grouping, and invariants need no viewer
language feature.

Build a self-contained module with a bounded memory:

```toml
# Cargo.toml
[lib]
crate-type = ["cdylib"]

# .cargo/config.toml in the extension project
[target.wasm32-unknown-unknown]
rustflags = ["-C", "link-arg=--max-memory=67108864"]
```

```sh
cargo build --target wasm32-unknown-unknown --release
```

Create and register the extension with `ViewerExtension::new(name, wasm)?` and
`RecorderBuilder::viewer_extension(extension)?`. Names must be non-empty,
unique, and at most 4096 bytes. A trace supports up to eight extensions, each
with at most 2 MiB of Wasm. Recorder rotation writes the extension preamble
into every segment.

## Transport contracts

### D9TF

Frame `0x07` stores `name_len:u16`, `wasm_len:u32`, UTF-8 name, and raw module
bytes. Extension frames must be contiguous immediately after each D9TF header.

### Guest ABI

| Export | Meaning |
| --- | --- |
| `dial9_abi_version() -> i32` | ABI negotiation |
| `dial9_input_alloc(len) -> i32` | reusable input destination |
| `dial9_push(len) -> i32` | decode and process one chunk |
| `dial9_finish() -> i32` | finish decoding and materialize output |
| `dial9_output_ptr/len() -> i32` | D9VO result |
| `dial9_error_ptr/len() -> i32` | bounded UTF-8 error |

### D9VO

D9VO contains a small JSON recipe manifest followed by named columnar tables.
Numeric columns are consumed as typed-array views; UTF-8 columns are decoded
once. Tooltips and legends read the same materialized rows as drawings, so
pointer movement never calls untrusted code.

The 32 MiB host output limit is a ceiling, not a promise that every bundle of
that size fits beside arbitrary extension state in the guest's 64 MiB memory.

## Components

Components share one ordered panel recipe. Canvas drawings use recipe order as
z-order; tooltip and legend entries are DOM presenters over those drawings.

| Component | Input |
| --- | --- |
| `background` | color column |
| `interval-area` | start, end, value |
| `interval-line` | start, end, value |
| `line` | x, value, optional gaps |
| `step-line` | x, value, optional gaps |
| `polyline` | x, value, optional gaps; exact source order |
| `horizontal-rule` | values |
| `text` | x, y, text, optional color |
| `tooltip` | target drawing, hit strategy, display fields and units |
| `legend` | static items and/or fields sampled at the cursor |

Named y-scales can derive their visible domain or declare bounds. Panels use
the viewer time axis by default and may instead declare a fixed linear axis.

The demo extension exercises:

- CPU time deltas and CPU usage intervals;
- voluntary and involuntary context switches as overlaid interval/step and
  point-line panels with independent tooltips;
- a green dinosaur with backward/repeated x coordinates, background, flames, and
  different tail/head tooltip values.

## Measured cost

The checked-in benchmark uses a generated, output-dense D9TF stream with
250,000 resource-usage events and validates the module with the production
policy. Compilation and fixture parsing happen outside each timed sample.

| Path | Mean |
| --- | ---: |
| JS `for`, viewer objects already parsed | 46.11 ms |
| JS `filter`/`map`, viewer objects already parsed | 68.34 ms |
| JS parse D9TF + `for` | 270.94 ms |
| WASM instantiate + decode D9TF + encode D9VO | 66.03 ms |
| WASM plus output copy and validation | 96.03 ms |

The 10.65 MiB trace produces 749,997 plotted intervals in a 25.28 MiB D9VO
buffer. The 122.7 KiB module reaches 62.50 MiB of its 64 MiB linear-memory
maximum. This is an intentionally output-heavy case: nearly every input sample
produces rows in three output tables.

Trusted JS over the viewer's existing objects is the fastest computation path,
but couples extensions to the host representation and is not a sandbox.
WASM pays for its own decoder and boundary copy; it is about 2.8× faster than
building a second JS object graph in this fixture and runs concurrently with
the viewer parser. These numbers measure extension computation, not total
viewer load time or Canvas painting.

## Security boundary

The browser and viewer are trusted; trace bytes, recipes, and modules are not.

- Raw modules are validated before compilation: no imports, start function,
  shared memory, memory64, unexpected exports, or unbounded memory/table.
- The module has no ambient DOM, network, storage, clock, or host-object access.
- Compilation and guest calls run in a disposable worker. Host-side deadlines
  terminate non-returning code.
- Per-module and aggregate memory, module, output, table, row, component,
  canvas, and rendering-work limits bound availability attacks.
- D9VO is structurally and semantically validated before use, including
  references, finite values, sorted x columns where required, interval ordering,
  and sizes.
- Renderer failures disable only the offending custom panel. Guest strings are
  rendered as text, never HTML.
- Invalid or trapping modules are isolated from one another. If the worker
  itself must be terminated, the base trace is fetched again and parsed with
  fresh sinks, without extension output.

These guarantees rely on the browser's WebAssembly sandbox, as all browser
execution does; the extension receives no capability with which to escape it.

## Lifecycle

An extension runs once while its trace is loaded and emits immutable tables.
Zoom, pan, tooltips, and cursor legends query those tables synchronously.
Reactive guest callbacks are intentionally absent; a future ABI can add them
without changing the materialized-table or component contracts.
