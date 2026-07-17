# Computed Fields and Custom Views — Working Design Notes

- **Status:** exploratory; no public API or engine choice is final
- **Issue:** [#574](https://github.com/dial9-rs/dial9/issues/574)

## Goal

Allow Rust libraries and applications to bundle computed data and complete custom
views with a trace. Once the generic machinery exists, adding a view should not
require changing the viewer.

The design has three distinct responsibilities:

1. **Data and expression engine:** bind trace events and metadata, evaluate
   computations, and return typed result tables.
2. **Rendering:** turn result tables into layered, interactive visualizations.
3. **Rust API and trace transport:** define, validate, and embed versioned view
   bundles in self-contained trace segments.

The intended separation is:

```text
Rust ViewBundle
    -> versioned bundle event in each trace segment
    -> Dial9 adapter (event schemas + metadata -> typed tables)
    -> standalone data engine in a Worker
    -> named result tables + diagnostics
    -> renderer registry (plots, layers, legends, tooltips, guides)
```

## 1. Data and expression engine

### Boundary

The engine should not know about Dial9 event classes. It receives named typed
tables and scalar environments:

```ts
interface DataEngine {
  registerTable(name: string, table: ArrowTable): void;
  registerScalars(name: string, values: TypedRecord): void;
  compile(bundle: ViewBundle): CompiledBundle;
  query(
    relation: string,
    params: TypedRecord,
  ): AsyncIterable<RecordBatch>;
}
```

The Dial9 adapter binds an event schema to an alias such as `usage`, exposes
segment metadata, and preserves field types and annotations. Bindings should
include an expected schema fingerprint so that name collisions or incompatible
event versions fail explicitly.

There should not be a magical `previous` value. Previous relative to which
ordering and partition is ambiguous. A window expression makes both choices
explicit:

```sql
lag(cpu_time_ns) OVER (
  PARTITION BY process_id
  ORDER BY timestamp_ns
)
```

### Current preferred option: analytical SQL

The current preference is **DuckDB-Wasm with SQL**, subject to a memory and
performance spike before it becomes a permanent bundle contract.

Why it fits:

- Window functions (`lag`, `lead`), grouping, joins, filtering, recursive CTEs,
  lists, structs, and rich math already exist.
- Conditions and data-quality rules remain ordinary expressions instead of
  Dial9-specific concepts such as a `monotonic` operator.
- `UBIGINT` / `HUGEINT` preserve trace counters until an explicit floating-point
  conversion is needed.
- Arrow is available for ingestion and streaming results.
- It follows Perfetto's successful separation of SQL analysis from track
  rendering.

The main risk is memory. The current viewer already uses roughly 10x the raw
trace size at scale. Importing every existing object again into a database would
be unacceptable. A production integration must ingest only referenced event
types and columns, and should move toward a single columnar representation.

### CPU usage example

The current CPU panel can be expressed without domain-specific engine features:

```sql
WITH enriched AS (
  SELECT
    timestamp_ns AS end_ns,
    CAST(user_cpu_ns AS HUGEINT) AS user_ns,
    CAST(system_cpu_ns AS HUGEINT) AS system_ns,
    CAST(user_cpu_ns AS HUGEINT)
      + CAST(system_cpu_ns AS HUGEINT) AS cpu_time_ns
  FROM usage
),
samples AS (
  SELECT
    *,
    lag(end_ns) OVER w AS start_ns,
    lag(user_ns) OVER w AS previous_user_ns,
    lag(system_ns) OVER w AS previous_system_ns,
    lag(cpu_time_ns) OVER w AS previous_cpu_time_ns
  FROM enriched
  WINDOW w AS (ORDER BY end_ns)
),
intervals AS (
  SELECT
    *,
    CAST(end_ns AS HUGEINT) - CAST(start_ns AS HUGEINT) AS wall_ns,
    cpu_time_ns - previous_cpu_time_ns AS cpu_ns,
    end_ns > start_ns
      AND user_ns >= previous_user_ns
      AND system_ns >= previous_system_ns AS valid
  FROM samples
  WHERE start_ns IS NOT NULL
)
SELECT
  start_ns,
  end_ns,
  cpu_ns,
  CASE
    WHEN valid
    THEN CAST(cpu_ns AS DOUBLE) / CAST(wall_ns AS DOUBLE)
    ELSE NULL
  END AS cores,
  valid,
  CASE
    WHEN NOT valid
    THEN 'counter decreased or time did not advance'
  END AS warning
FROM intervals
ORDER BY start_ns;
```

This demonstrates the general policy:

- `NULL` can create a gap.
- A validity column can affect styling or hit testing.
- A warning can be shown in a tooltip or returned in a diagnostics relation.
- The query author can instead filter the row or escalate the diagnostic.
- The engine does not need to understand monotonic counters.

Viewport summaries should also be queries. For example, the current weighted
average and maximum can query `cpu_intervals` using `view_start` and `view_end`
parameters rather than being reimplemented by the renderer.

### Engine alternatives

| Option | Advantages | Costs / concerns | Current position |
| --- | --- | --- | --- |
| **DuckDB-Wasm + SQL** | Mature analytical language, windows/joins/recursion, unsigned and 128-bit integers, Arrow results | Wasm asset, ingestion cost, possible second data copy | Preferred, gated by a spike |
| **Arquero** | Native array/typed-array/Arrow dataframes, rich relational and window operations, good fit for current JS data | Less suitable as a stable public language contract; arbitrary `escape()` functions weaken safety and worker serialization | Benchmark fallback |
| **QuickJS-Wasm** | Real JavaScript with runtime heap, stack, and deadline limits | Data must be copied or bridged into another heap; interpreted execution and per-row host calls are costly | Possible future explicit escape hatch |
| **SES / native JS compartment** | No Wasm data copy; explicit ambient capabilities | Does not bound CPU or memory by itself; a Worker limits hangs but not all memory abuse | Not sufficient alone |
| **CEL** | Typed, side-effect-free scalar expressions | No relational/window/grouping engine; Dial9 would still need to build most of the pipeline | Not enough by itself |
| **Custom JSON AST/interpreter** | Complete control | Reimplements a small and permanently maintained subset of SQL/JS | Avoid |

The bundle envelope should identify its language, for example
`duckdb-sql/v1`. This leaves room for a future `quickjs/v1` without coupling
renderers or trace bindings to one evaluator.

### Safety and resource constraints

Trace bundles are untrusted input. The engine should:

- Run in a dedicated Worker.
- Accept query expressions wrapped as subqueries/CTEs, not arbitrary DDL.
- Disable external access, extension installation/loading, and remote files.
- Lock engine configuration after trusted initialization.
- Enforce source-size, execution-time, memory, output-row, and output-byte limits.
- Cancel a query or terminate its Worker without breaking the rest of the viewer.
- Expose only explicitly bound tables and scalars.

## 2. Rendering

### Boundary

Renderers consume typed result tables. They should not know how a value was
computed or contain trace-specific data rules.

Start with a small set of composable primitives:

- `interval-area` / `interval-bars`: `start`, `end`, `value`
- `line` / `step-line`: `time`, `value`
- `points`
- `rects`: spans, heatmaps, and flamegraph rectangles
- `rules` and `bands`: guides and thresholds
- potentially `text`

A panel is a container of plots and layers, not an assumption that one panel has
one series. Series, partitions, and facets come from mapped data columns.

```json
{
  "id": "process.cpu",
  "title": "CPU usage",
  "layers": [
    {
      "renderer": "interval-area/v1",
      "data": "cpu_intervals",
      "channels": {
        "start": "start_ns",
        "end": "end_ns",
        "y": "cores",
        "valid": "valid",
        "color": "color"
      }
    },
    {
      "renderer": "horizontal-rule/v1",
      "data": "cpu_guides",
      "channels": {
        "y": "value",
        "label": "label",
        "color": "color"
      }
    }
  ],
  "tooltip": [
    { "label": "CPU time", "field": "cpu_ns", "format": "duration" },
    { "label": "Cores", "field": "cores", "format": "decimal" },
    { "label": "Warning", "field": "warning" }
  ],
  "legend": { "data": "visible_cpu_summary" }
}
```

Presentation concerns map to data as follows:

- **Tooltips:** field mappings with named formats. A query can return a display
  string when a built-in format is insufficient.
- **Legends and header summaries:** separate result relations containing label,
  value, display value, and optional color.
- **Guides and thresholds:** ordinary `rules` or `bands` layers.
- **Conditional coloring:** a computed color/style column or a declarative
  scale mapping.
- **Gaps and invalid points:** `NULL` values or a mapped validity column.
- **Warnings/errors:** a generic diagnostics relation with severity, message,
  time/range, and optional source row.
- **Interaction:** renderers build only a visible hit index; tooltip contents
  still come from result fields.

Every draw path must remain pixel-bounded. Queries should be viewport-aware and
results should be streamed or reduced before millions of primitives are created.

### Rendering options

| Option | Advantages | Costs / concerns | Current position |
| --- | --- | --- | --- |
| **First-party canvas primitives** | Fits the existing timeline, viewport, hit testing, and styling; small and controllable | We must implement common marks, scales, layers, and interaction | Best initial foundation |
| **Vega as a rendering backend** | General marks, scales, axes, legends, signals, and transforms already exist | Additional runtime and dataflow; must disable external loaders and avoid duplicating computation/data | Worth revisiting after the data boundary exists |
| **One custom renderer per panel** | Easy for the first panel | Recreates the current coupling and requires viewer changes for every view | Avoid |

SQL can make the data side very general, but fixed renderers cannot promise every
possible visualization. Long-term freedom requires either a sufficiently general
marks/layers/scales grammar or additional versioned renderer implementations.
The result-table boundary supports either path.

## 3. Rust API and trace transport

### Rust API shape (not final)

Views can combine several event types and metadata, so they belong on the runtime
builder rather than on one event definition:

```rust
TracedRuntime::builder()
    .with_view_bundle(
        ViewBundle::builder("process.cpu")
            .bind_event::<ProcessResourceUsageEvent>("usage")
            .sql(include_str!("process_cpu.sql"))
            .panel(process_cpu_panel())
            .build()?,
    );
```

Points to decide before making this public:

- Whether the Rust API primarily exposes typed builders, an opaque versioned
  JSON bundle, or both.
- How reusable named relations and multiple panels are represented.
- Whether renderer IDs are strings/newtypes with typed helpers, so adding a
  renderer does not require a Rust enum release.
- How schema fingerprints and missing/ambiguous bindings are reported.

`TraceEvent::schema_entry()` already provides the event name, fields, timestamp
behavior, and annotations. `bind_event::<T>()` can use it as the source of truth
instead of duplicating a schema in the view definition.

### Trace representation

Do not add a new binary frame tag: old decoders must stop on unknown tags because
they cannot determine the frame length.

Prefer a normal self-describing event with no timestamp:

```text
Dial9ViewBundleEvent
  id
  format_version
  engine
  digest
  spec_json
```

Why:

- It uses the existing Schema and Event frames.
- The current viewer decodes and ignores unknown events without timestamps.
- It supports several independent bundles.
- It can be repeated in each segment prologue, keeping rotated segments
  self-contained.
- `id + digest` allows deduplication; the same ID with a different digest is a
  conflict and should disable that bundle with a diagnostic.

Do not hide bundles inside user segment metadata. Segment metadata is string-only
and its builder configuration is last-call-wins, including interaction with S3
configuration. Bundles need their own accumulating builder state and should be
written alongside metadata and clock sync in every segment prologue.

The payload should have per-bundle and aggregate size limits. Unknown bundle,
language, or renderer versions should fail locally while the rest of the trace
continues to load.

## Current viewer reference and constraints

The CPU panel currently spreads one view across four concerns:

```text
ProcessResourceUsageEvent
  -> unknown-event fallback in trace_parser.js
  -> buildProcessCpuUsageSeries() in trace_analysis.js
  -> visibleCpuStats() and renderProcessCpuPanel() in viewer.html
  -> panel-specific binary search and tooltip HTML
```

It is the first parity target because it exercises computed fields, `lag`, rate,
invalid monotonic samples, intervals, viewport summaries, guides, coloring, and
tooltips.

There is also a numeric correctness issue to avoid carrying forward: the trace
decoder preserves `u64` varints as strings, but the CPU analysis converts them to
JavaScript `Number`. Counters above `2^53` lose precision. The new engine should
retain integer types until an explicit ratio/cast.

The pending viewer migration plans a typed trace boundary, Workers, a renderer
registry, and pixel-bounded drawing. Those directions align with this design.
Its temporary frozen-core/Wasm decisions need to be revisited explicitly if the
SQL engine spike succeeds rather than bypassed implicitly.

## Proposed plan

1. **Hardcoded standalone spike**
   - Bind current CPU samples and metadata without changing the trace format.
   - Implement the same query in DuckDB-Wasm and Arquero.
   - Measure demo x1/x8 ingestion time, peak heap, query time, viewport updates,
     cancellation, and shipped asset size.
2. **Freeze the data boundary, not the public API**
   - Select the engine only after the measurements.
   - Define typed table/scalar inputs, relation results, diagnostics, and limits.
   - Keep the implementation independent of Dial9 and test it with in-memory
     fixtures.
3. **CPU rendering parity**
   - Implement basic interval-area and rule layers.
   - Reproduce gaps, warning data, visible average/max, guide, tooltip, and color.
   - Compare against the current `trace_analysis.js` tests and viewer behavior.
4. **Bundle format and Rust API**
   - Agree on public signatures and versioning before implementation.
   - Add the timestamp-less bundle event, segment repetition, deduplication, and
     conflict/error handling.
   - Add a round-trip Rust -> trace -> JS integration test.
5. **Generalize incrementally**
   - Add line, points, rect, band, series/facet, and legend contracts as required
     by additional existing views.
   - Move built-in views only when parity and performance are measurable.

## Open decisions

- Does DuckDB-Wasm stay within the existing heap budget when ingesting only bound
  columns, or is Arquero the better first engine?
- Should result relations be always viewport-parameterized and lazy, or can some
  trace-scoped relations be safely materialized and cached?
- How general should the first rendering grammar be: a few timeline primitives or
  a broader marks/scales grammar?
- Should Rust expose a raw versioned bundle escape hatch alongside typed builders?
- What are the initial per-bundle time, memory, source-size, and output limits?

## References

- [PerfettoSQL syntax](https://perfetto.dev/docs/analysis/perfetto-sql-syntax)
- [Perfetto query-backed tracks](https://perfetto.dev/docs/visualization/ui-automation)
- [Perfetto extension servers](https://perfetto.dev/docs/visualization/extension-servers)
- [DuckDB-Wasm overview](https://duckdb.org/docs/stable/clients/wasm/overview)
- [DuckDB-Wasm data ingestion](https://duckdb.org/docs/clients/wasm/data_ingestion)
- [Securing DuckDB](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)
- [Arquero](https://idl.uw.edu/arquero/)
- [QuickJS-Emscripten](https://github.com/justjake/quickjs-emscripten)
- [Vega expressions and transforms](https://vega.github.io/vega/docs/expressions)
