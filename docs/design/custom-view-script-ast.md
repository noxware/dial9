# Dial9 Script AST

## Características

- Todo es una expresión.
- Tipos dinámicos con semántica propia.
- Sin coerciones implícitas, `undefined` ni truthiness.
- JavaScript es un backend, no el lenguaje público.
- Sin primitivas de queries: particiones y joins se construyen con estado.
- JSON con external tagging, `snake_case` y números exactos representados como strings.

## AST

```rust
struct Program {
    version: u32,
    outputs: BTreeMap<String, Output>,
    body: Expr,
}

struct Output {
    units: BTreeMap<String, String>,
}

enum Expr {
    Literal(Literal),
    Call(Call),
    Get(String),
    Set(String, Box<Expr>),
    Block(Vec<Expr>),
    Case {
        branches: Vec<Branch>,
        fallback: Option<Box<Expr>>,
    },
    ForEach {
        binding: String,
        index: Option<String>,
        iterable: Box<Expr>,
        body: Box<Expr>,
    },
    Break,
    Continue,
}

struct Branch {
    condition: Expr,
    result: Expr,
}

enum Literal {
    String(String),
    Integer(String),
    Float(String),
    Bool(bool),
    Null,
}

struct Call {
    name: String,
    args: Vec<Expr>,
}
```

## Program

```json
{
  "version": 1,
  "outputs": {
    "segments": { "units": { "start": "ns", "end": "ns" } }
  },
  "body": { "block": [] }
}
```

## Literals

```json
[
  { "literal": { "string": "hello" } },
  { "literal": { "integer": "123" } },
  { "literal": { "float": "1.0" } },
  { "literal": { "bool": true } },
  { "literal": "null" }
]
```

## Variables

```json
{ "get": "event" }
```

```json
{ "set": ["open", { "call": ["map.new"] }] }
```

## Calls

```json
{
  "call": [
    "map.get",
    { "get": "open" },
    { "literal": { "string": "key" } }
  ]
}
```

```json
{
  "set": [
    "cpu_time",
    { "call": ["add", { "get": "user_time" }, { "get": "system_time" }] }
  ]
}
```

## Blocks

```json
{
  "block": [
    { "set": ["a", { "literal": { "integer": "1" } }] },
    { "set": ["b", { "literal": { "integer": "2" } }] },
    { "call": ["add", { "get": "a" }, { "get": "b" }] }
  ]
}
```

## Conditionals

```json
{
  "case": {
    "branches": [
      {
        "condition": { "call": ["less", { "get": "current" }, { "get": "previous" }] },
        "result": { "call": ["diagnostic.warn", { "literal": { "string": "counter decreased" } }] }
      }
    ],
    "fallback": { "literal": "null" }
  }
}
```

## Iteration

```json
{
  "for_each": {
    "binding": "event",
    "index": "i",
    "iterable": { "get": "events" },
    "body": { "block": [] }
  }
}
```

```json
"continue"
```

```json
"break"
```

## Anteriores y siguientes

```json
{
  "call": [
    "list.get",
    { "get": "events" },
    { "call": ["subtract", { "get": "i" }, { "literal": { "integer": "1" } }] }
  ]
}
```

## Entorno

|Binding|Value|
|---|---|
|`events`|Lista inmutable ordenada por `(time, ordinal)`|
|`metadata`|Map global del trace|
|`viewport`|Map con el rango visible|
|`pointer`|Map interactivo o `null`|

## Event

```json
{
  "kind": "String",
  "time": "Integer",
  "ordinal": "Integer",
  "fields": "Map<String, Value>",
  "units": "Map<String, String>"
}
```

```json
{
  "call": [
    "map.get",
    { "call": ["map.get", { "get": "event" }, { "literal": { "string": "fields" } }] },
    { "literal": { "string": "span_id" } }
  ]
}
```

## Estado

```json
{
  "call": [
    "map.set",
    { "get": "open_spans" },
    { "get": "span_id" },
    { "get": "event" }
  ]
}
```

## Outputs

```json
{
  "call": [
    "output.emit",
    { "literal": { "string": "segments" } },
    { "get": "segment" }
  ]
}
```

## Tipos del runtime

|Value|Backend|
|---|---|
|Integer|`BigInt`|
|Float|`Number` finito|
|String|`String`|
|Bool|`Boolean`|
|Null|`null`|
|List|`Array`|
|Map|`Map`, nunca `Object`|
|Bytes|`Uint8Array`|

## Semántica

|Expression|Result|
|---|---|
|`set`|`null`|
|`set` de un nombre nuevo|Crea un binding del programa|
|`block`|Resultado de la última expresión o `null`|
|`case`|Resultado de la rama seleccionada o `null`|
|`for_each`|`null`|
|`get` sin binding|Error|
|`map.get` sin key|`null`; usar `map.has` para distinguirlo|
|`list.get` fuera de rango|`null`; índices negativos no recorren desde el final|
|`set` sobre un binding del entorno|Error|
|Condición no booleana|Error|
|Integer mezclado con Float|Error; conversión explícita|
|Argumentos de un call|Evaluados de izquierda a derecha|
|Branches de un case|Evaluados en orden; sólo se evalúa el resultado seleccionado|
|Binding e index de `for_each`|Locales al loop; los demás sets persisten|
|`output.emit`|Captura un snapshot inmutable del valor|

## Funciones

|Name|Description|
|---|---|
|`equal`, `not_equal`|Comparación escalar sin coerción|
|`less`, `less_equal`, `greater`, `greater_equal`|Comparación de valores compatibles|
|`and`, `or`, `not`|Lógica booleana eager; `case` provee short-circuit|
|`add`, `subtract`, `multiply`, `divide`, `remainder`, `negate`|Aritmética|
|`integer.to_float`, `float.truncate`, `float.floor`, `float.ceil`, `float.round`|Conversión y redondeo|
|`math.abs`, `math.sqrt`, `math.pow`, `math.log`|Matemática|
|`map.new`, `map.get`, `map.has`, `map.set`, `map.remove`, `map.entries`|Maps mutables con keys escalares|
|`list.new`, `list.get`, `list.set`, `list.push`, `list.length`, `list.slice`|Listas mutables|
|`list.min`, `list.max`, `list.sum`|Agregados sobre listas|
|`string.concat`, `string.format`, `string.starts_with`, `string.length`, `value.to_string`|Strings y textos arbitrarios|
|`output.emit`|Agrega un valor a un output nombrado|
|`diagnostic.warn`|Emite un warning asociado a la evaluación|

## Límites de ejecución

|Límite|Regla|
|---|---|
|Iterations|Presupuesto global por evaluación|
|Loops|Iteran sobre un snapshot finito|
|Collections|Máximo de elementos acumulados|
|Strings|Longitud máxima|
|Outputs|Máximo de valores emitidos|
|Capabilities|Sin globals, DOM, network, modules, prototypes ni dynamic code|
