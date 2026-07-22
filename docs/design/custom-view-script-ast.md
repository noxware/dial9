# Introducción

Este documento define tres componentes para crear vistas dinámicas en el viewer de Dial9:

- Dial9 Script IR: un lenguaje de scripting imperativo, dinámico y minimalista, representado como S-expressions JSON y diseñado para compilarse en runtime a JavaScript especializado para su ejecución en el browser. Sólo permite las APIs registradas explícitamente y no expone I/O por defecto. El lenguaje es independiente de Dial9.
- Stackable/composable rendering components: primitivas visuales predefinidas que consumen los outputs de los scripts para producir gráficos, tooltips, legends y otros elementos de un panel.
- Bundle: un conjunto de computed values y custom views expresados mediante el lenguaje de scripting y los rendering components stackeables.

# Dial9 Script IR

## Características

- Toda forma ejecutable es un invoke; un block sólo agrupa invokes.
- Tipos dinámicos con semántica propia.
- S-expressions serializadas como JSON.
- Validado una vez y traducido a JavaScript especializado para performance cercana al JS manual.
- Sin acceso a JavaScript, globals, DOM, network o modules.
- Un algoritmo costoso puede bloquear la tab; no es responsabilidad del lenguaje impedirlo.

## Seguridad

El engine ofrece capability confinement, no aislamiento del browser: el JavaScript
generado se ejecuta en el mismo realm que el viewer, pero el script sólo puede alcanzar
los invokes y valores expuestos explícitamente por el host.

### Valores foreign y ownership

- Sólo `map.new` y `list.new` crean containers mutables propiedad del script.
- Arrays, Maps y objects provenientes del host se exponen recursivamente como `ListView`
  o `MapView` read-only. Si un valor nested también es un container, se devuelve como view.
- Las views sólo exponen entries lógicas definidas por su adapter, nunca prototypes,
  methods ni properties internas del object subyacente.
- `map.set`, `list.set` y otras operaciones mutables sólo aceptan containers propiedad
  del script; intentar aplicarlas a una view es un error.
- Los valores devueltos por funciones registradas cruzan el mismo boundary: los
  primitivos se aceptan, los containers se convierten en views y las funciones u otros
  valores no soportados se rechazan.

### Funciones registradas

Una función registrada es una capability confiada al host. Puede mutar estado de
JavaScript, realizar I/O o retener valores si su implementación lo permite. Registrar
una función con efectos concede esa capability explícitamente; el engine no intenta
hacer segura una implementación del host.

Para permitir mutaciones controladas, el host puede registrar una función que valide un
valor del script y lo escriba en su propio estado. Esa mutación queda fuera de las
garantías del engine y es responsabilidad de la integración.

### Recursos

No hay límites de memoria, iteraciones ni tiempo de ejecución. Un script puede bloquear
la tab o agotar memoria mediante un algoritmo costoso, pero eso no le concede nuevas
capabilities. Más adelante podrían añadirse contadores de operaciones, iteraciones y
allocations sin cambiar el IR público.

## Errores

- Recoverable errors provienen de datos inválidos o ausentes, como una conversión
  fallida, tipos incompatibles, división por cero o un resultado no finito. Devuelven
  `null`, que puede propagarse o manejarse explícitamente con `null.is`.
- Fatal errors indican un programa inválido o una violación del runtime, como un invoke
  desconocido, arity incorrecta o un intento de mutar una view. Abortan la ejecución
  actual y producen un diagnóstico.

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
["var.let", "value", ["float.from", ["var.get", "integer_value"]]]
```

## Invoke

```text
invoke = "zero_argument_operation"
       | ["operation", argument...]
```

|Operation kind|Arguments|Result|
|---|---|---|
|Immediate function|Evalúa sus operands antes de invocar|Value|
|Primitive literal|Consume atoms de payload sin evaluarlos|Value|
|Variable operation|Consume un nombre; `var.let` y `var.set` también consumen un value invoke|Value para `var.get`; none para `var.let` y `var.set`|
|Control flow|Decide cuándo y cuántas veces evaluar sus operands|None|
|Computed value|Evalúa su expresión dentro del scope actual|Value|

Los invokes sólo se resuelven contra operaciones registradas y computed values del bundle.
La representación es canónica: un invoke sin argumentos es un `Atom`; una lista con un
solo elemento, como `["do_something"]`, es inválida.

## Convenciones

La gramática es intencionalmente pequeña. La mayor parte del diseño del lenguaje recae
en definir invokes consistentes: sus nombres, operandos, tipos y reglas de evaluación.
Estas convenciones forman parte del contrato público del lenguaje.

### Nombres de invokes

Un invoke puede ser una función, cuyos argumentos se evalúan antes de invocarla, o una
construcción especial, que controla cómo evalúa los operandos o blocks que recibe.

Las operaciones suelen pertenecer al namespace de su tipo, siguiendo una convención
similar a las funciones de módulos de Elixir. Por ejemplo, `float.add` sólo acepta
floats; los integers utilizan `integer.add`.

### Literales

Los literales primitivos parametrizados utilizan normalmente `<type>.const`, por ejemplo
`["string.const", "hello"]`. `null.const` sigue la misma convención sin recibir
argumentos. `bool.true` y `bool.false` son excepciones porque son los dos únicos valores
booleanos; no existe `bool.const`. `integer.zero` y `float.zero` son formas de
conveniencia sin argumentos.

Las estructuras no primitivas se construyen con `<type>.new`, por ejemplo `list.new`.

### Conversiones

Las conversiones siguen la convención de Rust `<target-type>.from`:

```json
["float.from", ["var.get", "integer_value"]]
```

### Tipos

Las comprobaciones de tipo siguen la convención `<type>.is`. Aceptan cualquier valor,
nunca fallan y devuelven un bool:

```json
["float.is", ["var.get", "value"]]
```

Para debugging, `diagnostic.type_name` devuelve el nombre del tipo lógico:

```json
["diagnostic.type_name", ["var.get", "value"]]
```

La representación física no afecta estos resultados: `Array` y `ListView` son list;
`Map` y `MapView` son map.

### Booleanos

`bool.not`, `bool.and` y `bool.or` sólo aceptan bools; cualquier otro valor, incluido
`null`, produce `null` como recoverable type error. `bool.and` y `bool.or` hacen
short-circuit y no evalúan el segundo operando cuando el primero determina el resultado.

## Block

Un block no es un invoke y no produce un value. Es un body contextual que contiene uno
o más invokes. Un block de un solo invoke no necesita wrapper; varios invokes se
agrupan directamente:

```json
[
  ["var.let", "a", ["integer.const", "1"]],
  ["var.let", "b", ["var.get", "a"]],
  ["integer.add", ["var.get", "a"], ["var.get", "b"]]
]
```

## Variable scopes

|Operation|Semantics|
|---|---|
|`var.let`|Declara un binding en el scope actual; puede shadow uno exterior, pero no redeclararse en el mismo scope|
|`var.get`|Lee el binding visible más cercano|
|`var.set`|Actualiza el binding visible más cercano; falla si no existe|

Cada body introduce un scope aunque contenga un solo invoke. El script usa el root scope;
cada branch de `case` usa un child scope y cada iteración de `for_each` crea uno nuevo.
El scope se descarta al terminar el body, incluidos `loop.continue` y `loop.break`. Los
bindings item/index pertenecen al scope de su iteración.

## Case

`case` ejecuta el body de la primera condición `bool.true` y no produce un value.

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

`for_each` ejecuta su body para cada elemento y no produce un value.

```json
[
  "for_each",
  "event",
  "index",
  "dial9.events",
  [
    ["var.let", "copy", ["var.get", "event"]],
    ["var.let", "position", ["var.get", "index"]]
  ]
]
```

## Loop control

`loop.break` y `loop.continue` no reciben argumentos ni producen un value. Sólo son
válidos dentro de un loop.

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
    -> resolve variables, literal payloads, fields and invokes
    -> validated AST / internal IR
    -> specialized JavaScript
```

La ejecución sobre eventos no recorre el AST ni resuelve nombres de operaciones.

## Operaciones iniciales

|Namespace|Examples|
|---|---|
|Primitive literals|`null.const`, `bool.true`, `bool.false`, `integer.zero`, `integer.const`, `float.zero`, `float.const`, `string.const`|
|Variables|`var.let`, `var.get`, `var.set`|
|Control flow|`case`, `for_each`, `loop.break`, `loop.continue`|
|Conversion|`integer.from`, `float.from`, `string.from`|
|Type checks|`null.is`, `bool.is`, `integer.is`, `float.is`, `string.is`, `list.is`, `map.is`, `bytes.is`|
|Integer math|`integer.add`, `integer.subtract`, `integer.multiply`, `integer.divide`, `integer.pow`|
|Float math|`float.add`, `float.subtract`, `float.multiply`, `float.divide`, `float.pow`|
|Comparison|`cmp.eq`, `cmp.lt`, `cmp.lte`, `cmp.gt`, `cmp.gte`|
|Boolean|`bool.not`, `bool.and`, `bool.or`|
|Map|`map.new`, `map.get`, `map.has`, `map.set`, `map.remove`|
|List|`list.new`, `list.get`, `list.set`, `list.push`, `list.length`|
|Diagnostics|`diagnostic.warn`, `diagnostic.type_name`|

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
    ["var.let", "has_previous", "bool.false"],
    ["var.let", "previous_time", "null.const"],
    ["var.let", "previous_cpu_time", "null.const"],
    [
      "for_each",
      "event",
      "index",
      "dial9.events",
      [
        "case",
        ["cmp.eq", ["map.get", ["var.get", "event"], ["string.const", "kind"]], ["string.const", "ProcessResourceUsageEvent"]],
        [
          ["var.let", "current_time", ["map.get", ["var.get", "event"], ["string.const", "time"]]],
          ["var.let", "current_cpu_time", "computed.cpu_time"],
          [
            "case",
            ["var.get", "has_previous"],
            [
              ["var.let", "wall_delta", ["integer.subtract", ["var.get", "current_time"], ["var.get", "previous_time"]]],
              ["var.let", "cpu_delta", ["integer.subtract", ["var.get", "current_cpu_time"], ["var.get", "previous_cpu_time"]]],
              [
                "case",
                ["cmp.lte", ["var.get", "wall_delta"], "integer.zero"],
                "null.const",
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
            "null.const"
          ],
          ["var.set", "previous_time", ["var.get", "current_time"]],
          ["var.set", "previous_cpu_time", ["var.get", "current_cpu_time"]],
          ["var.set", "has_previous", "bool.true"]
        ],
        "bool.true",
        "null.const"
      ]
    ]
  ]
}
```
