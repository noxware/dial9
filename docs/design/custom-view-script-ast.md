# Dial9 Script IR

## Characteristics

- Everything is an expression.
- Dynamic types with language-defined semantics.
- S-expressions serialized as JSON.
- Validated once and lowered to specialized JavaScript for performance close to handwritten JavaScript.
- No access to JavaScript, globals, the DOM, the network, or modules.
- An expensive algorithm may block the tab; preventing that is not the language's responsibility.

## S-expression

```rust
enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}
```

```json
"integer.zero"
```

```json
["float.const", "1.3"]
```

```json
["integer.add", ["var.get", "a"], ["var.get", "b"]]
```

```json
["var.set", "value", ["float.from", ["var.get", "integer_value"]]]
```

## Invoke

```text
expression = "zero_argument_operation"
           | ["operation", argument...]
```

|Operation kind|Arguments|
|---|---|
|Immediate function|Evaluates its expressions before invocation|
|Constant|Consumes an atom without evaluating it|
|Variable operation|Consumes a name and, optionally, an expression|
|Control flow|Decides when and how many times to evaluate its arguments|
|Computed value|Evaluates its expression within the current scope|

Invokes are resolved only against registered operations and computed values from the bundle.
The representation is canonical: a zero-argument invoke is an `Atom`; a single-element
list such as `["do_something"]` is invalid.

## Block

A block is not an invoke. It is a position interpreted as a body by the bundle or by
a control-flow operation such as `case` or `for_each`. A single expression is a
one-instruction block; multiple expressions are grouped directly:

```json
[
  ["var.set", "a", ["integer.const", "1"]],
  ["var.set", "b", ["var.get", "a"]],
  ["integer.add", ["var.get", "a"], ["var.get", "b"]]
]
```

## Case

```json
[
  "case",
  ["cmp.gte", ["var.get", "number"], "integer.zero"],
  "do_something",
  "bool.true",
  "fallback"
]
```

## For Each

```json
[
  "for_each",
  "event",
  "index",
  "dial9.events",
  [
    ["var.set", "copy", ["var.get", "event"]],
    ["var.set", "position", ["var.get", "index"]]
  ]
]
```

## Dial9 functions

|Function|Logical value|
|---|---|
|`dial9.events`|ListView ordered by `(time, ordinal)`|
|`dial9.metadata`|Global MapView|
|`dial9.viewport`|MapView containing the visible range|
|`dial9.pointer`|MapView or `null`|
|`dial9.output.emit`|Appends a value to an output|

A computed value inherits its invocation scope, including the `event` binding from a `for_each`.

## Virtual interfaces

|Logical value|Possible implementation|
|---|---|
|Host event stream|Merge, index, arrays, or lazy reads|
|Host event|Virtual view over any physical representation|
|Host Map|Read-only `MapView` over any physical representation|
|Host List|Read-only `ListView` over any physical representation|
|`map.new`|Mutable JavaScript `Map`|
|`list.new`|Mutable JavaScript `Array`|

## Runtime values

|Value|Initial backend|
|---|---|
|Integer|`BigInt`|
|Float|Finite `Number`|
|String|`String`|
|Bool|`Boolean`|
|Null|`null`|
|List|`Array` or `ListView`|
|Map|`Map` or `MapView`|
|Bytes|`Uint8Array`|

`MapView` and `ListView` are internal shapes that implement the basic Map and List
operations without exposing a value's physical representation.

## Lowering

```text
JSON S-expression
    -> validate operations and operand shapes
    -> resolve variables, constants, fields and invokes
    -> validated AST / internal IR
    -> specialized JavaScript
```

Execution over events does not walk the AST or resolve operation names.

## Initial operations

|Namespace|Examples|
|---|---|
|Constants|`null`, `bool.true`, `bool.false`, `integer.zero`, `integer.const`, `float.zero`, `float.const`, `string.const`|
|Variables|`var.get`, `var.set`|
|Control flow|`case`, `for_each`|
|Conversion|`integer.from`, `float.from`, `string.from`, `type.of`|
|Integer math|`integer.add`, `integer.subtract`, `integer.multiply`, `integer.divide`, `integer.pow`|
|Float math|`float.add`, `float.subtract`, `float.multiply`, `float.divide`, `float.pow`|
|Comparison|`cmp.eq`, `cmp.lt`, `cmp.lte`, `cmp.gt`, `cmp.gte`|
|Boolean|`bool.not`, `bool.and`, `bool.or`|
|Map|`map.new`, `map.get`, `map.has`, `map.set`, `map.remove`|
|List|`list.new`, `list.get`, `list.set`, `list.push`, `list.length`|
|Effects|`diagnostic.warn`|

```text
map.new = "map.new" | ["map.new", key, value, ...]
```

With arguments, `map.new` requires `key, value` pairs.

## Numeric operations

|Operation|Contract|
|---|---|
|`integer.*`|Accepts integers and returns an integer|
|`float.*`|Accepts floats and returns a float|
|`integer.divide`|Truncates toward zero|
|`integer.pow`|Requires a non-negative integer exponent|
|`*.divide`|Division by zero is an error|
|`float.*`|A `NaN` or infinite result is an error|

# Dial9 Bundle

```rust
struct Bundle {
    version: u32,
    computed_values: BTreeMap<String, ComputedValue>,
    outputs: BTreeMap<String, Output>,
    script: SExpr,
}

struct ComputedValue {
    unit: Option<String>,
    expression: SExpr,
}

struct Output {
    units: BTreeMap<String, String>,
}
```

## Outputs

|Property|Semantics|
|---|---|
|`dial9.output.emit(output, value)`|Appends a value to the declared output|
|Order|Emission order|
|Lifetime|Materialized while the script runs and immutable afterward|
|Representation|Logical collection; the backend chooses its physical storage|
|Rendering|The renderer consumes semantic values and may create viewport-local temporary data|

# CPU Usage

```json
{
  "version": 1,
  "computed_values": {
    "cpu_time": {
      "unit": "ns",
      "expression": [
        "integer.add",
        ["map.get", ["var.get", "event"], ["string.const", "user_cpu_ns"]],
        ["map.get", ["var.get", "event"], ["string.const", "system_cpu_ns"]]
      ]
    }
  },
  "outputs": {
    "cpu_intervals": {
      "units": {
        "start": "ns",
        "end": "ns",
        "wall_delta": "ns",
        "cpu_delta": "ns",
        "cores": "cores"
      }
    }
  },
  "script": [
    ["var.set", "has_previous", "bool.false"],
    [
      "for_each",
      "event",
      "index",
      "dial9.events",
      [
        "case",
        ["cmp.eq", ["map.get", ["var.get", "event"], ["string.const", "kind"]], ["string.const", "ProcessResourceUsageEvent"]],
        [
          ["var.set", "current_time", ["map.get", ["var.get", "event"], ["string.const", "time"]]],
          ["var.set", "current_cpu_time", "computed.cpu_time"],
          [
            "case",
            ["var.get", "has_previous"],
            [
              ["var.set", "wall_delta", ["integer.subtract", ["var.get", "current_time"], ["var.get", "previous_time"]]],
              ["var.set", "cpu_delta", ["integer.subtract", ["var.get", "current_cpu_time"], ["var.get", "previous_cpu_time"]]],
              [
                "case",
                ["cmp.lte", ["var.get", "wall_delta"], "integer.zero"],
                "null",
                ["cmp.lt", ["var.get", "cpu_delta"], "integer.zero"],
                ["diagnostic.warn", ["string.const", "CPU counter decreased"]],
                "bool.true",
                [
                  "dial9.output.emit",
                  "cpu_intervals",
                  [
                    "map.new",
                    ["string.const", "start"], ["var.get", "previous_time"],
                    ["string.const", "end"], ["var.get", "current_time"],
                    ["string.const", "wall_delta"], ["var.get", "wall_delta"],
                    ["string.const", "cpu_delta"], ["var.get", "cpu_delta"],
                    ["string.const", "cores"],
                    [
                      "float.divide",
                      ["float.from", ["var.get", "cpu_delta"]],
                      ["float.from", ["var.get", "wall_delta"]]
                    ]
                  ]
                ]
              ]
            ],
            "bool.true",
            "null"
          ],
          ["var.set", "previous_time", ["var.get", "current_time"]],
          ["var.set", "previous_cpu_time", ["var.get", "current_cpu_time"]],
          ["var.set", "has_previous", "bool.true"]
        ],
        "bool.true",
        "null"
      ]
    ]
  ]
}
```
