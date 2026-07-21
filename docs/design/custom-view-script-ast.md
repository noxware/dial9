# Dial9 Script IR

## Características

- Todo es una expresión.
- Tipos dinámicos con semántica propia.
- S-expressions serializadas como JSON.
- Validado una vez y traducido a JavaScript especializado para performance cercana al JS manual.
- Sin acceso a JavaScript, globals, DOM, network o modules.
- Un algoritmo costoso puede bloquear la tab; no es responsabilidad del lenguaje impedirlo.

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
|Immediate function|Evalúa sus expresiones antes de invocar|
|Constant|Consume un atom sin evaluarlo|
|Variable operation|Consume un nombre y opcionalmente una expresión|
|Control flow|Decide cuándo y cuántas veces evaluar sus argumentos|
|Computed value|Evalúa su expresión dentro del entorno actual|

Los invokes sólo se resuelven contra operaciones registradas y computed values del bundle.
La representación es canónica: un invoke sin argumentos es un `Atom`; una lista con un
solo elemento, como `["do_something"]`, es inválida.

## Block

Un block no es un invoke. Es una posición interpretada como body por el bundle o por
una operación de control como `case` o `for_each`. Una expresión sola es un block de
una instrucción; varias expresiones se agrupan directamente:

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

|Function|Value lógico|
|---|---|
|`dial9.events`|ListView ordenada por `(time, ordinal)`|
|`dial9.metadata`|MapView global|
|`dial9.viewport`|MapView con el rango visible|
|`dial9.pointer`|MapView o `null`|
|`dial9.output.emit`|Agrega un valor a un output|

Un computed value hereda el scope de su invocación, incluido el binding `event` de un `for_each`.

## Interfaces virtuales

|Value lógico|Implementación posible|
|---|---|
|Event stream del host|Merge, índice, arrays o lectura lazy|
|Event del host|Vista virtual sobre cualquier representación física|
|Map del host|`MapView` read-only sobre cualquier representación física|
|List del host|`ListView` read-only sobre cualquier representación física|
|`map.new`|`Map` mutable de JavaScript|
|`list.new`|`Array` mutable de JavaScript|

## Runtime values

|Value|Backend inicial|
|---|---|
|Integer|`BigInt`|
|Float|`Number` finito|
|String|`String`|
|Bool|`Boolean`|
|Null|`null`|
|List|`Array` o `ListView`|
|Map|`Map` o `MapView`|
|Bytes|`Uint8Array`|

`MapView` y `ListView` son shapes internos que implementan las operaciones básicas
de Map y List sin exponer la representación física del valor.

## Lowering

```text
JSON S-expression
    -> validate operations and operand shapes
    -> resolve variables, constants, fields and invokes
    -> validated AST / internal IR
    -> specialized JavaScript
```

La ejecución sobre eventos no recorre el AST ni resuelve nombres de operaciones.

## Operaciones iniciales

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

Con argumentos, `map.new` exige pares `key, value`.

## Numeric operations

|Operación|Contrato|
|---|---|
|`integer.*`|Acepta integers y devuelve integer|
|`float.*`|Acepta floats y devuelve float|
|`integer.divide`|Trunca hacia cero|
|`integer.pow`|Exige un exponente integer no negativo|
|`*.divide`|División por cero es un error|
|`float.*`|Un resultado `NaN` o infinito es un error|

# Dial9 bundle

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

|Propiedad|Semántica|
|---|---|
|`dial9.output.emit(output, value)`|Agrega un valor al output declarado|
|Orden|Orden de emisión|
|Lifetime|Se materializa durante el script y queda inmutable al terminar|
|Representación|Colección lógica; el backend decide su almacenamiento físico|
|Rendering|El renderer consume valores semánticos y puede crear temporales por viewport|

# CPU usage

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
