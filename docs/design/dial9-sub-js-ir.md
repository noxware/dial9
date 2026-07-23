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
- Native JavaScript objects, arrays, maps, proxies, and functions never enter a program directly.
- `MapView` and `ListView` provide read-only access to foreign structures. Values returned by a view are lazily normalized to primitives or further views, so nested host values cannot leak into the program.
- Only the trusted viewer can register external functions and views. Their return values are normalized to supported primitives or read-only views before the program can observe them.
- Variable scopes are represented by a private chain of objects terminated by a null prototype, rather than by JavaScript variables. `var.get` and `var.set` only traverse this chain, so names such as `window` or `globalThis` cannot resolve to JavaScript globals.

## Structured values

Private symbols are unique `Symbol()` values held by the runtime, never global `Symbol.for()` values. A program can use the operations associated with a wrapper but cannot obtain its symbol or backing value.

```js
const object = {
  __proto__: null,
  [OBJECT]: { __proto__: null },
};

const list = {
  __proto__: null,
  [LIST]: [],
};

const mapView = {
  __proto__: null,
  [MAP_VIEW_GET]: trustedMapGetter,
};

const listView = {
  __proto__: null,
  [LIST_VIEW_LENGTH]: trustedLengthGetter,
  [LIST_VIEW_GET]: trustedListGetter,
};
```

Instructions lower directly through the symbol for their expected structure:

```js
// obj.get(object, key)
object[OBJECT][key]

// obj.set(object, key, value)
object[OBJECT][key] = value

// list.get(list, index)
list[LIST][index]

// list.push(list, value)
list[LIST].push(value)

// map_view.get(view, key)
normalizeForeign(view[MAP_VIEW_GET](key))

// list_view.get(view, index)
normalizeForeign(view[LIST_VIEW_GET](index))
```

Using an instruction with the wrong structure encounters a missing private symbol and fails before applying a trace-controlled property key or JavaScript coercion. View getters expose logical foreign data, not properties of the wrapper, and recursively normalize nested results.

## Performance

The IR is a safe subset of JavaScript compiled to straightforward JavaScript code. Instructions lower as directly as possible to native operations, with small symbol indirections and other targeted protections only where required to preserve the security boundary.
