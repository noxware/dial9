# Dial9 Sub-JS IR

## Security

- Programs have no direct access to the DOM, network, filesystem, modules, JavaScript globals, `eval`, or `Function`.
- The compiler only accepts a fixed set of instructions considered safe and emits their predefined JavaScript translations. Program data is never interpolated as JavaScript source.
- Guest-visible objects created by the engine have a null prototype.
- Every structured value is a wrapper whose backing value or capability is stored under an unforgeable, runtime-private `Symbol`.
- Instructions over structured values must access them through their corresponding private symbol. They must never use an unrestricted `value[key]` access.
- Consequently, applying `obj.get` to a string cannot reach `String.prototype`: the instruction first requires the private object symbol and fails when it is absent.
- The subset cannot traverse JavaScript prototypes, extract methods, or invoke arbitrary values. JavaScript gadgets such as `"".constructor.constructor("return globalThis")()` must therefore be impossible to express.
- Symbols and wrapper internals cannot be accessed, reflected on, or enumerated by programs.
- Native JavaScript objects, arrays, maps, proxies, and functions never enter a program directly.
- `MapView` and `ListView` provide read-only access to foreign structures. Values returned by a view are lazily normalized to primitives or further views, so nested host values cannot leak into the program.
- External functions may receive and return only supported primitives, engine-owned structures, or read-only views. Exposing any broader host capability explicitly leaves this security boundary.
- Variable scopes are represented by a private chain of objects terminated by a null prototype, rather than by JavaScript variables. `var.get` and `var.set` only traverse this chain, so names such as `window` or `globalThis` cannot resolve to JavaScript globals.

## Performance

The IR is a safe subset of JavaScript compiled to straightforward JavaScript code. Instructions lower as directly as possible to native operations, with small symbol indirections and other targeted protections only where required to preserve the security boundary.
