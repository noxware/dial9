# View Data Language

Status: working public-contract draft. Backend and transport are not fixed.

Companion to [Computed Fields and Custom Views](computed-fields-and-custom-views.md);
this document covers only the data language contract.

## Goal

Allow Rust libraries and applications to bundle computed data and complete custom
views with a trace. Once the generic machinery exists, adding a view must not
require changing the viewer's data engine.

The language describes dataflow, not visualization policy. It produces named
tables; predefined renderer layers consume those tables.

## Core decisions

- The persisted contract is a versioned JSON AST owned by Dial9.
- Programs are declarative, deterministic, and side-effect free.
- Tables and scalar parameters are named inputs; their physical JS shape is hidden.
- Relations are immutable and form an acyclic dependency graph.
- Ordering, partitioning, windows, joins, intervals, gaps, and diagnostics are explicit.
- One bounded `scan` primitive covers arbitrary ordered state machines; domain
  operations such as `rate` are not language primitives.
- Values do not carry hidden temporal support. Time is represented by ordinary columns.
- Missing values are `null`; there are no implicit numeric defaults.
- No operation has metric-specific policy. In particular, counter resets are program logic.
- Backend choice, caching, sync/async execution, and storage are implementation details.

## Execution flow

```text
trace schemas + metadata
        |
        v
Dial9 bindings -> named logical tables and scalar parameters
        |
        v
validate and type-check versioned JSON AST
        |
        v
evaluate named relation DAG
        |
        +-> computed event fields
        +-> plot datasets
        +-> tooltip / legend datasets
        +-> guides / thresholds / diagnostics datasets
        |
        v
ordered predefined renderer layers
```

The host may supply parameters such as metadata and the current viewport. Static
relations can be cached; parameter-dependent relations can be reevaluated. This
does not affect the public language.

## From hidden configuration to explicit dataflow

| Previous concept | Language expression |
| --- | --- |
| `window.on_decrease` | Compare current and lagged values; use `case`, `filter`, and a diagnostics output. |
| `hold_until_next` | Add `lead(timestamp)` in an explicitly ordered window. |
| `partition_by` setting | `partition_by` on the relevant window or `group_by` on an aggregate. |
| implicit point/interval support | Explicit `time`, or `start` and `end`, output columns. |
| invalid-point/gap policy | Emit `null`, filter the row, or split the output relation. |
| thresholds and guides | Ordinary one-row relations consumed by rule/band layers. |
| threshold coloring | A computed `color`/`class` column. |
| summary and legend configuration | Aggregate or constant output relations. |
| `metric.kind` changing evaluation | Optional descriptive metadata only; never evaluator behavior. |

## Value model

| Type | Semantics |
| --- | --- |
| `null` | Missing or invalid value. |
| `bool` | `true` or `false`; no truthy/falsy coercion. |
| `int` | Exact signed integer. Trace `i64`/`u64` values enter without precision loss. |
| `float` | IEEE-754 binary64; non-finite results become `null`. |
| `string` | Unicode string. |
| `bytes` | Opaque byte sequence. |
| `list<T>` | Ordered homogeneous values. |
| `map<K, V>` | Dynamic keyed state with structural equality; keys are scalar. |
| `record` | String-keyed values accessed only through safe field/get operations. |

Integer-to-float conversion is explicit. Integer literals are decimal strings in
JSON so they are not rounded by the JSON parser.

General rules:

- Scalar functions are pure and normally propagate `null`.
- `case`, `coalesce`, and null predicates are the explicit exceptions.
- Division by zero and invalid casts return `null`.
- An unknown logical field is a validation error. A declared nullable or
  schema-evolution-missing value is `null`; inherited JS properties are never visible.
- A relation has no defined order unless an `order` node establishes one.
- Window nodes require explicit ordering. Ties retain stable input order; bindings
  should expose a stable row/sequence column when tie order matters.

## Program envelope

```json
{
  "language": "dial9-data",
  "version": 1,
  "inputs": ["usage"],
  "computed_fields": [
    {
      "source": "usage",
      "name": "cpu_time_ns",
      "expr": {
        "kind": "call",
        "fn": "add",
        "args": [
          { "kind": "field", "name": "user_cpu_ns" },
          { "kind": "field", "name": "system_cpu_ns" }
        ]
      }
    }
  ],
  "relations": [
    { "name": "cpu_intervals", "query": { "kind": "relation_ref", "name": "..." } }
  ],
  "outputs": {
    "cpu_intervals": { "relation": "cpu_intervals" }
  }
}
```

`computed_fields` is event-local sugar for deriving columns on one input table.
Names must not collide with input fields. Named relations may use raw or computed
columns.

## Contract evolution

- Existing node and function meanings never change within a language version.
- Unknown node kinds, functions, or versions reject that view with a diagnostic;
  they never fall back to a similar operation.
- An incompatible semantic change requires a new version. Executor and trace
  storage changes do not.

## Stable expression AST

Every node has a `kind`; user-controlled strings are data, never executable source.

| `kind` | Required fields | Meaning |
| --- | --- | --- |
| `literal` | `type`, `value` | Typed constant. `int.value` is a decimal string. |
| `field` | `name`, optional `scope` | Logical row field; `scope` disambiguates join inputs. |
| `param` | `name` | Host scalar such as metadata or viewport bounds. |
| `call` | `fn`, `args` | Whitelisted scalar standard-library call. |
| `case` | `branches`, optional `else` | Ordered conditional expression. |
| `list` | `items` | List construction. |
| `map` | `entries` | Dynamic map construction from key/value expressions. |
| `record` | `fields` | Record construction. |

Example condition:

```json
{
  "kind": "case",
  "branches": [
    {
      "when": {
        "kind": "call",
        "fn": "gte",
        "args": [
          { "kind": "field", "name": "user_delta" },
          { "kind": "literal", "type": "int", "value": "0" }
        ]
      },
      "then": { "kind": "field", "name": "cores" }
    }
  ],
  "else": { "kind": "literal", "type": "null", "value": null }
}
```

## Stable relation AST

| `kind` | Main fields | Result |
| --- | --- | --- |
| `source` | `name` | Bound input table. |
| `relation_ref` | `name` | Named relation in the same program; cycles are invalid. |
| `values` | `rows` | Inline rows; cells may reference scalar parameters. |
| `derive` | `input`, `columns` | Input rows plus named scalar expressions. |
| `project` | `input`, `columns` | Only the named output expressions. |
| `filter` | `input`, `predicate` | Rows whose predicate is exactly `true`. |
| `order` | `input`, `by` | Stable ordered rows. |
| `distinct` | `input`, `by` | First row for each key tuple. |
| `union` | `inputs`, `all` | Name/type-aligned union. |
| `join` | `left`, `right`, `type`, `on` | `inner`, `left`, `right`, or `full` join. |
| `aggregate` | `input`, `group_by`, `measures` | One row per key tuple. |
| `window` | `input`, `partition_by`, `order_by`, `columns` | Input rows plus window results. |
| `scan` | `input`, `partition_by`, `order_by`, `initial`, `step`, optional `finish` | Ordered state transition with emitted rows. |
| `unnest` | `input`, `value`, `as`, optional `index` | One row per list item. |
| `limit` | `input`, `count`, optional `offset` | Bounded slice of an ordered relation. |

Join fields use `scope: "left"` or `scope: "right"`; a following `project`
chooses names and prevents backend-specific collision behavior.

Aggregate measure:

```json
{ "fn": "sum", "value": { "kind": "field", "name": "weight" } }
```

Window column:

```json
{
  "fn": "lag",
  "value": { "kind": "field", "name": "user_cpu_ns" },
  "offset": 1,
  "default": { "kind": "literal", "type": "null", "value": null }
}
```

Aggregate windows accept an explicit row frame, for example
`{"start":"unbounded_preceding","end":"current_row"}` for a cumulative sum.

### Bounded sequential state

Windows cover fixed relative-row and frame calculations. They cannot express a
general state machine such as pairing interleaved opens/closes or tracking many
currently open IDs. `scan` is the single escape hatch for those cases.

For each partition, `scan` initializes state once and evaluates `step(row,
state)` exactly once per ordered input row. The step returns the next state and
zero or more output records. Optional `finish(state)` runs once at the end of a
partition. `row` and `state` are explicit field scopes; state updates are pure
map/list operations. There is no user-controlled loop, recursion, or shared
state between partitions.

## Standard library v1

### Scalar functions

| Category | Functions |
| --- | --- |
| exact arithmetic | `add`, `sub`, `mul`, `idiv`, `mod`, `neg`, `abs` |
| bitwise integer | `bit_and`, `bit_or`, `bit_xor`, `bit_not`, `shift_left`, `shift_right` |
| floating arithmetic | `div`, `pow`, `sqrt`, `cbrt`, `hypot`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10` |
| trigonometry | `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2` |
| numeric | `min`, `max`, `clamp`, `sign`, `floor`, `ceil`, `round`, `trunc` |
| comparison | `eq`, `ne`, `lt`, `lte`, `gt`, `gte` |
| boolean | `and`, `or`, `not` |
| null | `is_null`, `is_not_null`, `coalesce`, `null_if` |
| conversion | `to_int`, `to_float`, `to_string`, `to_bool` |
| string | `concat`, `length`, `lower`, `upper`, `trim`, `contains`, `starts_with`, `ends_with`, `index_of`, `slice`, `split`, `replace` |
| collection | `get`, `has`, `length`, `contains`, `index_of`, `slice`, `append`, `concat`, `reverse`, `entries`, `keys`, `values`, `put`, `remove` |
| bucketing | `bucket(value, width, origin)` |

There is deliberately no counter-aware `rate`. A rate is ordinary lagged
arithmetic, and negative/reset handling is an explicit condition in the program.

### Aggregates

| Function | Result |
| --- | --- |
| `count`, `count_distinct` | Exact integer count. |
| `sum`, `min`, `max`, `mean` | Numeric reduction ignoring `null`. |
| `first`, `last` | First/last non-null value in established order. |
| `any`, `all` | Boolean reduction. |
| `collect` | Ordered list of non-null values. |
| `quantile` | Requested numeric quantile. |

### Window functions

| Function | Meaning |
| --- | --- |
| `lag`, `lead` | Value at a relative ordered row. |
| `row_number`, `rank`, `dense_rank` | Ordered row position/rank. |
| `first`, `last` | Value at a window-frame boundary. |
| `count`, `sum`, `min`, `max`, `mean` | Aggregate over an explicit frame. |

## CPU usage without policy settings

The CPU view is a query, not a special function:

1. Order `usage` by recording/process identity, timestamp, and stable sequence.
2. In a partitioned window derive `previous_timestamp`, `previous_user`, and
   `previous_system` with `lag`.
3. Derive `wall_delta`, `user_delta`, and `system_delta`.
4. Derive `valid = wall_delta > 0 && user_delta >= 0 && system_delta >= 0`.
5. Derive `cores = case(valid, to_float(user_delta + system_delta) /
   to_float(wall_delta), null)`.
6. Derive a warning string with a second `case`.
7. Project `start`, `end`, `cores`, raw deltas, `valid`, and `warning` into
   `cpu_intervals`.
8. Filter invalid rows into `cpu_diagnostics` if the view wants warnings.

A different author may retain negative derivatives, drop invalid rows, emit a
different diagnostic, or recover using different logic without any engine change.

Snapshot intervals similarly use `lead(timestamp)`. An invalid snapshot remains a
row and therefore still terminates the preceding interval; its rendered value can
be `null`, creating an explicit gap.

## Renderer boundary

Layers consume named relations and map columns to fixed channels:

```json
{
  "renderer": "interval-area/v1",
  "data": "cpu_intervals",
  "channels": {
    "start": "start",
    "end": "end",
    "y": "cores",
    "color": "color",
    "valid": "valid"
  }
}
```

Lines, areas, points, rules, bands, legends, and tooltips do not evaluate data
policies. Guides, thresholds, summaries, legends, and diagnostics are named
relations like any other data.

## Validation corpus

| Case | Required language capability |
| --- | --- |
| CPU usage | exact counters, partitioned lag, conditions, intervals, null gaps, diagnostics |
| socket accept queues | partitioned lead, invalid snapshots, multiple rendered partitions |
| context-switch views | multiple outputs, cumulative and derivative series, multi-line panels |
| queue depth / active tasks | union, ordering, cumulative window sum |
| spans / polls | ordered `scan`, keyed joins, interval intersection, diagnostics |
| heatmaps | numeric bucketing, grouping, aggregation |
| flamegraph input | list unnesting, grouping, weighted aggregation |
| guides / thresholds / legends | scalar parameters and ordinary output relations |

Geometry tests from `574-generalize-series-and-fields` remain renderer tests:
half-open intervals, gap preservation, clipping, downsampling, aligned timelines,
hit testing, and multi-series legends.

## Backend direction

The AST must not expose backend syntax or semantics. Use one Dial9 executor;
that executor may delegate relational storage and verbs to a library.

| Candidate | Benefit | Main risk |
| --- | --- | --- |
| Arquero relational kernel | Fastest way to exercise columnar transforms, grouping, windows, joins, and reshaping over JS-owned data. | Its null, ordering, integer, and expression-compilation semantics may not match this contract. |
| Custom JS relational executor | Direct access to current arrays and complete semantic control. | Reimplementing and maintaining grouping, joins, windows, and reshaping is the larger project. |
| Both as public/parallel backends | None needed for the goal. | Semantic drift and a doubled test surface. |

Arquero should therefore be a time-boxed compatibility spike, not a public
commitment. The spike must cover exact integer deltas, nulls, stable ordering,
partitioned windows, joins, unnesting, logical column adapters, and `scan` input
and output. Arquero currently also relies on generated JavaScript for normal
expressions and has a known gap around some BigInt aggregates, so Dial9 cannot
simply inherit its behavior.

If the spike passes, the Dial9 executor can own validation, types, bindings, and
`scan` while using Arquero for the relational kernel. If it fails, the same AST
targets a custom JS executor. Do not add backend-specific settings to compensate
for missing semantics. A trace can never invoke Arquero `escape()`, register a
function, or supply a raw Arquero expression; only the trusted lowerer can call
the backend API.

References: [Arquero API](https://idl.uw.edu/arquero/api/),
[CSP / generated-code issue](https://github.com/uwdata/arquero/issues/361), and
[BigInt aggregate issue](https://github.com/uwdata/arquero/issues/364).

## Explicit non-goals for v1

- Textual syntax, user-defined functions, loops, recursion, mutation, or I/O.
- Exposing raw JS event objects or executable JavaScript from a trace.
- Hard CPU/heap accounting beyond structural AST validation.
- Public commitments about Workers, async evaluation, streaming, OPFS, or storage.
- Renderer-specific geometry or Canvas APIs in the data language.
