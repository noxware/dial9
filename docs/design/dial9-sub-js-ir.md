# Dial9 Sub-JS IR

## Threat model

- Trace files are untrusted. An attacker may control the complete IR program and every name, literal, value, and structure contained in the trace.
- The viewer, compiler, runtime, registered external functions, view adapters, JavaScript realm, and its intrinsics are trusted.
- The IR confines trace-provided programs: they cannot access ambient authority or host objects except through capabilities explicitly registered by the viewer.
- Availability is not protected. A malicious program may consume excessive CPU or memory and freeze its own browser tab.

## Security

- Programs have no direct access to the DOM, network, filesystem, modules, JavaScript globals, `eval`, or `Function`.
- The compiler only accepts a fixed set of instructions considered safe and emits their predefined JavaScript translations. Trace-provided data may only enter generated code through instruction-specific encodings such as JavaScript string literals and canonical numeric literals; it is never emitted as an identifier or source fragment.
- Values visible to a program form a closed set: primitives, engine-owned wrappers, and read-only views. Every instruction must return another supported value or fail; functions, proxies, and raw host objects cannot appear as values.
- Guest-visible objects created by the engine have a null prototype.
- Every structured value is a wrapper whose backing value or capability is stored under an unforgeable, runtime-private `Symbol`.
- Instructions over structured values must access them through their corresponding private symbol. They must never use an unrestricted `value[key]` access.
- Consequently, applying `obj.get` to a string cannot reach `String.prototype`: the instruction first requires the private object symbol and fails when it is absent.
- The subset cannot traverse JavaScript prototypes, extract methods, or invoke arbitrary values. JavaScript gadgets such as `"".constructor.constructor("return globalThis")()` must therefore be impossible to express.
- Symbols and wrapper internals cannot be accessed, reflected on, or enumerated by programs.
- Foreign JavaScript objects, arrays, maps, proxies, and functions never enter a program directly.
- `MapView` and `ListView` provide read-only access to foreign structures. Values returned by a view are lazily normalized to primitives or further views, so nested host values cannot leak into the program.
- Only the trusted viewer can register external functions and views. Their return values are normalized to supported values before the program can observe them; raw structures become read-only views.
- Variable scopes are represented by a private chain of objects terminated by a null prototype, rather than by JavaScript variables. Each binding is an internal null-prototype `{ value }` cell, so `var.get` and `var.set` use direct property access through the scope chain without resolving names such as `window` or `globalThis` against JavaScript globals. One object and one cell per lexical binding are created per program execution; repeated scope entries reset cell values to `undefined` without changing object shapes.

## Structured values

Private symbols are unique `Symbol()` values held by the runtime, never global `Symbol.for()` values. A program can use the operations associated with a wrapper but cannot obtain its symbol or backing value.

```js
const object = Object.create(null);
object[OBJECT] = object;

const list = {
  __proto__: null,
  [LIST]: [],
};

const mapView = {
  __proto__: null,
  [MAP_VIEW_ADAPTER]: trustedMapAdapter,
  [MAP_VIEW_GET]: normalizingMapGetter,
  [MAP_VIEW_HAS]: mapViewHas,
};

const listView = {
  __proto__: null,
  [LIST_VIEW_ADAPTER]: trustedListAdapter,
  [LIST_VIEW_LENGTH]: listViewLength,
  [LIST_VIEW_GET]: normalizingListGetter,
};
```

Instructions lower directly through the symbol for their expected structure:

```js
// obj.get(object, key)
object[OBJECT][key]

// obj.set(object, key, value)
object[OBJECT][key] = value

// list.get(list, index)
list[LIST][+index]

// list.push(list, value)
list[LIST].push(value)

// map_view.get(view, key)
view[MAP_VIEW_GET](key)

// map_view.has(view, key)
view[MAP_VIEW_HAS](key)

// list_view.get(view, index)
view[LIST_VIEW_GET](+index)

// list_view.length(view)
view[LIST_VIEW_LENGTH]()
```

Using an instruction with the wrong structure encounters a missing private symbol and fails before applying a trace-controlled property key or JavaScript coercion. List indices are converted to numbers before touching their hidden native array, so strings such as `__proto__` cannot traverse `Array.prototype`. View getters expose logical foreign data, not properties of the wrapper, and recursively normalize nested results.

## Host boundary

Registered functions receive `ScriptValue` arguments. A sink such as `host.emit` may store an emitted wrapper by reference in an output list; it does not need to unwrap, clone, or serialize it. Trusted consumers inspect stored values through the runtime's host reader, which recognizes each wrapper and accesses its private symbol without exposing that capability to the program. Because outputs retain references, mutations performed by the program after an emit are visible to later consumers.

## Execution

- An invoke is either its zero-argument operation atom or a non-empty list containing an operation followed by its operands. A one-item list is rejected.
- Programs and control-flow bodies are blocks: lists of invokes, including when they contain only one invoke.
- `compile` returns a reusable function with no return value. Programs communicate with the host only through registered capabilities.

## Instructions

Numeric literal payloads are validated as complete literals, parsed, and emitted again in canonical form. `parseFloat` is not used, and trace-provided payloads are never copied directly into generated JavaScript.

### Literals

```json
"undefined.const"
"null.const"
"bool.true"
"bool.false"
["number.const", "4.3"]
["bigint.const", "42"]
["string.const", "hello"]
"obj.new"
"list.new"
["obj.new", ["string.const", "x"], ["number.const", "4.3"]]
["list.new", ["number.const", "1"], ["number.const", "2"]]
```

### Type predicates

```json
["undefined.is", ["var.get", "value"]]
["null.is", ["var.get", "value"]]
["bool.is", ["var.get", "value"]]
["number.is", ["var.get", "value"]]
["bigint.is", ["var.get", "value"]]
["string.is", ["var.get", "value"]]
["obj.is", ["var.get", "value"]]
["list.is", ["var.get", "value"]]
["map_view.is", ["var.get", "value"]]
["list_view.is", ["var.get", "value"]]
```

### Conversions

```json
["number.from", ["var.get", "value"]]
["bigint.from", ["var.get", "value"]]
["string.from", ["var.get", "value"]]
```

### Operators

`op.eq` and `op.neq` map to JavaScript strict equality (`===` and `!==`). The IR does not expose coercive equality.

```json
["op.add", ["var.get", "left"], ["var.get", "right"]]
["op.subtract", ["var.get", "left"], ["var.get", "right"]]
["op.multiply", ["var.get", "left"], ["var.get", "right"]]
["op.divide", ["var.get", "left"], ["var.get", "right"]]
["op.remainder", ["var.get", "left"], ["var.get", "right"]]
["op.pow", ["var.get", "base"], ["var.get", "exponent"]]
["op.negate", ["var.get", "value"]]
["op.eq", ["var.get", "left"], ["var.get", "right"]]
["op.neq", ["var.get", "left"], ["var.get", "right"]]
["op.lt", ["var.get", "left"], ["var.get", "right"]]
["op.lte", ["var.get", "left"], ["var.get", "right"]]
["op.gt", ["var.get", "left"], ["var.get", "right"]]
["op.gte", ["var.get", "left"], ["var.get", "right"]]
["op.not", ["var.get", "value"]]
["op.and", ["var.get", "left"], ["var.get", "right"]]
["op.or", ["var.get", "left"], ["var.get", "right"]]
```

### Math

```json
["math.abs", ["var.get", "value"]]
["math.floor", ["var.get", "value"]]
["math.ceil", ["var.get", "value"]]
["math.round", ["var.get", "value"]]
["math.trunc", ["var.get", "value"]]
["math.min", ["var.get", "left"], ["var.get", "right"]]
["math.max", ["var.get", "left"], ["var.get", "right"]]
["number.is_finite", ["var.get", "value"]]
["number.is_nan", ["var.get", "value"]]
```

### String

```json
["string.length", ["var.get", "value"]]
["string.includes", ["var.get", "value"], ["var.get", "search"]]
["string.starts_with", ["var.get", "value"], ["var.get", "prefix"]]
["string.ends_with", ["var.get", "value"], ["var.get", "suffix"]]
["string.slice", ["var.get", "value"], ["var.get", "start"], ["var.get", "end"]]
```

### Variables

```json
["var.let", "value", ["number.const", "1"]]
["var.get", "value"]
["var.set", "value", ["number.const", "2"]]
```

### Control flow

```json
[
  "case",
  ["op.gt", ["var.get", "value"], ["number.const", "0"]],
  [
    ["var.set", "result", ["string.const", "positive"]]
  ],
  "bool.true",
  [
    ["var.set", "result", ["string.const", "not positive"]]
  ]
]

[
  "loop.for_each",
  "item",
  "index",
  ["var.get", "values"],
  [
    ["consume", ["var.get", "item"], ["var.get", "index"]]
  ]
]

"loop.break"
"loop.continue"
```

### Object

```json
["obj.get", ["var.get", "object"], ["string.const", "key"]]
["obj.set", ["var.get", "object"], ["string.const", "key"], ["var.get", "value"]]
["obj.has", ["var.get", "object"], ["string.const", "key"]]
["obj.delete", ["var.get", "object"], ["string.const", "key"]]
["obj.keys", ["var.get", "object"]]
```

### List

```json
["list.get", ["var.get", "list"], ["number.const", "0"]]
["list.set", ["var.get", "list"], ["number.const", "0"], ["var.get", "value"]]
["list.push", ["var.get", "list"], ["var.get", "value"]]
["list.pop", ["var.get", "list"]]
["list.length", ["var.get", "list"]]
```

### Read-only views

```json
["map_view.get", ["var.get", "view"], ["string.const", "key"]]
["map_view.has", ["var.get", "view"], ["string.const", "key"]]
["list_view.get", ["var.get", "view"], ["number.const", "0"]]
["list_view.length", ["var.get", "view"]]
```

### Registered capabilities

```json
"host.events"
["host.emit", ["string.const", "output"], ["var.get", "value"]]
```

## Performance

The IR is a safe subset of JavaScript compiled to straightforward JavaScript code. Instructions lower as directly as possible to native operations, with small symbol indirections and other targeted protections only where required to preserve the security boundary.
