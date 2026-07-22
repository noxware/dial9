# Script IR implementation decisions

Only decisions not fixed by `custom-view-script-ast.md` are listed here.

|Area|Current decision|
|---|---|
|Compiler API|`compile(sexpr, { functions, computedValues, onDiagnostic })` returns a reusable zero-argument function. A root value invoke returns its value; a root block or none-valued invoke returns JavaScript `undefined`, which is not a Script IR value.|
|Views|Hosts create virtual adapters with `createListView({ length, get })` and `createMapView({ has, get })`. Every value returned by `get` is normalized by the runtime.|
|Block ambiguity|A list beginning with an atom is always an invoke; a list beginning with a list is a block. Therefore a multi-invoke block containing only zero-argument atom invokes cannot currently be represented. No extra `block` invoke was added implicitly.|
|Computed values|Computed values are inlined at each invocation so they inherit lexical scope. Recursive cycles are rejected while compiling.|
|External functions|Names resolve to fixed numeric slots while compiling. Results must be logical values; JavaScript `undefined` is rejected rather than becoming a second null-like value. Standard and `computed.*` names cannot be overridden.|
|Conditions|Only `bool.true` selects a `case` branch. `false`, `null`, and other types do not match. A non-list `for_each` source performs no iterations.|
|Ordered comparisons|`cmp.lt/lte/gt/gte` accept same-type integer, float, or string operands. Other combinations return `null`.|
|List iteration|`for_each` snapshots the initial length and exposes its index as an Integer (`BigInt`). Values are still read per iteration, so mutation of an existing future entry is visible.|
|List mutation|`list.push` grows an owned list. `list.set` only replaces an existing index, avoiding sparse logical lists. Mutating operations are none-valued and invalid ownership/indexes are fatal runtime violations.|
|Stdlib scope|The compiler implements exactly the invokes in the specification's “Operaciones iniciales” table; it does not silently introduce additional convenience operations.|
