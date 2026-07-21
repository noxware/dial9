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
    computed_values: BTreeMap<String, ComputedValue>,
    outputs: BTreeMap<String, Output>,
    script: Expr,
}

struct ComputedValue {
    parameters: Vec<String>,
    unit: Option<String>,
    expression: Expr,
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
  "computed_values": {},
  "outputs": {
    "segments": { "units": { "start": "ns", "end": "ns" } }
  },
  "script": { "block": [] }
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
|Call `computed.*`|Scope local, dependencias acíclicas y sin recursión|
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
|`map.new`, `map.of`, `map.get`, `map.has`, `map.set`, `map.remove`, `map.entries`|Maps mutables con keys escalares|
|`list.new`, `list.of`, `list.get`, `list.set`, `list.push`, `list.length`, `list.slice`|Listas mutables|
|`list.min`, `list.max`, `list.sum`|Agregados sobre listas|
|`string.concat`, `string.format`, `string.starts_with`, `string.length`, `value.to_string`|Strings y textos arbitrarios|
|`computed.<name>`|Evalúa un computed value del bundle|
|`output.emit`|Agrega un valor a un output nombrado|
|`diagnostic.warn`|Emite un warning con contexto opcional|

## Límites de ejecución

|Límite|Regla|
|---|---|
|Iterations|Presupuesto global por evaluación|
|Loops|Iteran sobre un snapshot finito|
|Collections|Máximo de elementos acumulados|
|Strings|Longitud máxima|
|Outputs|Máximo de valores emitidos|
|Capabilities|Sin globals, DOM, network, modules, prototypes ni dynamic code|

## Bundle completo: CPU usage

```json
{
  "version": 1,
  "computed_values": {
    "cpu_time": {
      "parameters": ["fields"],
      "unit": "ns",
      "expression": {
        "call": [
          "add",
          { "call": ["map.get", { "get": "fields" }, { "literal": { "string": "user_cpu_ns" } }] },
          { "call": ["map.get", { "get": "fields" }, { "literal": { "string": "system_cpu_ns" } }] }
        ]
      }
    },
    "cpu_cores": {
      "parameters": ["cpu_delta_ns", "wall_delta_ns"],
      "unit": "cores",
      "expression": {
        "call": [
          "divide",
          { "call": ["integer.to_float", { "get": "cpu_delta_ns" }] },
          { "call": ["integer.to_float", { "get": "wall_delta_ns" }] }
        ]
      }
    },
    "cpu_percent": {
      "parameters": ["cores", "capacity"],
      "unit": "percent",
      "expression": {
        "case": {
          "branches": [
            {
              "condition": { "call": ["equal", { "get": "capacity" }, { "literal": "null" }] },
              "result": { "literal": "null" }
            },
            {
              "condition": { "call": ["less_equal", { "get": "capacity" }, { "literal": { "float": "0.0" } }] },
              "result": { "literal": "null" }
            }
          ],
          "fallback": {
            "block": [
              {
                "set": [
                  "raw_percent",
                  {
                    "call": [
                      "divide",
                      { "call": ["multiply", { "get": "cores" }, { "literal": { "float": "100.0" } }] },
                      { "get": "capacity" }
                    ]
                  }
                ]
              },
              {
                "case": {
                  "branches": [
                    {
                      "condition": { "call": ["greater", { "get": "raw_percent" }, { "literal": { "float": "100.0" } }] },
                      "result": { "literal": { "float": "100.0" } }
                    }
                  ],
                  "fallback": { "get": "raw_percent" }
                }
              }
            ]
          }
        }
      }
    }
  },
  "outputs": {
    "cpu_intervals": {
      "units": {
        "start": "ns",
        "end": "ns",
        "wall_delta": "ns",
        "user_delta": "ns",
        "system_delta": "ns",
        "cpu_delta": "ns",
        "start_cpu_time": "ns",
        "end_cpu_time": "ns",
        "cores": "cores",
        "total_percent": "percent"
      }
    },
    "cpu_capacity": {
      "units": { "value": "cores" }
    },
    "cpu_summary": {
      "units": {
        "visible_start": "ns",
        "visible_end": "ns",
        "available_parallelism": "cores",
        "average_cores": "cores",
        "average_percent": "percent",
        "max_cores": "cores",
        "scale_max": "cores"
      }
    }
  },
  "script": {
    "block": [
      { "set": ["previous_sample", { "literal": "null" }] },
      { "set": ["interval_count", { "literal": { "integer": "0" } }] },
      { "set": ["visible_total_overlap", { "literal": { "integer": "0" } }] },
      { "set": ["visible_weighted_cores", { "literal": { "float": "0.0" } }] },
      { "set": ["visible_max_cores", { "literal": { "float": "0.0" } }] },
      {
        "set": [
          "capacity",
          {
            "call": [
              "map.get",
              { "get": "metadata" },
              { "literal": { "string": "process.available_parallelism" } }
            ]
          }
        ]
      },
      {
        "case": {
          "branches": [
            {
              "condition": { "call": ["equal", { "get": "capacity" }, { "literal": "null" }] },
              "result": { "literal": "null" }
            },
            {
              "condition": { "call": ["less_equal", { "get": "capacity" }, { "literal": { "integer": "0" } }] },
              "result": { "set": ["capacity", { "literal": "null" }] }
            }
          ],
          "fallback": { "literal": "null" }
        }
      },
      {
        "set": [
          "capacity_cores",
          {
            "case": {
              "branches": [
                {
                  "condition": { "call": ["equal", { "get": "capacity" }, { "literal": "null" }] },
                  "result": { "literal": "null" }
                }
              ],
              "fallback": { "call": ["integer.to_float", { "get": "capacity" }] }
            }
          }
        ]
      },
      {
        "for_each": {
          "binding": "event",
          "index": null,
          "iterable": { "get": "events" },
          "body": {
            "block": [
              {
                "case": {
                  "branches": [
                    {
                      "condition": {
                        "call": [
                          "not_equal",
                          { "call": ["map.get", { "get": "event" }, { "literal": { "string": "kind" } }] },
                          { "literal": { "string": "ProcessResourceUsageEvent" } }
                        ]
                      },
                      "result": "continue"
                    }
                  ],
                  "fallback": { "literal": "null" }
                }
              },
              { "set": ["time", { "call": ["map.get", { "get": "event" }, { "literal": { "string": "time" } }] }] },
              { "set": ["fields", { "call": ["map.get", { "get": "event" }, { "literal": { "string": "fields" } }] }] },
              { "set": ["user_cpu", { "call": ["map.get", { "get": "fields" }, { "literal": { "string": "user_cpu_ns" } }] }] },
              { "set": ["system_cpu", { "call": ["map.get", { "get": "fields" }, { "literal": { "string": "system_cpu_ns" } }] }] },
              {
                "case": {
                  "branches": [
                    {
                      "condition": { "call": ["equal", { "get": "time" }, { "literal": "null" }] },
                      "result": "continue"
                    },
                    {
                      "condition": { "call": ["equal", { "get": "user_cpu" }, { "literal": "null" }] },
                      "result": "continue"
                    },
                    {
                      "condition": { "call": ["equal", { "get": "system_cpu" }, { "literal": "null" }] },
                      "result": "continue"
                    },
                    {
                      "condition": { "call": ["less", { "get": "user_cpu" }, { "literal": { "integer": "0" } }] },
                      "result": "continue"
                    },
                    {
                      "condition": { "call": ["less", { "get": "system_cpu" }, { "literal": { "integer": "0" } }] },
                      "result": "continue"
                    }
                  ],
                  "fallback": { "literal": "null" }
                }
              },
              { "set": ["cpu_time", { "call": ["computed.cpu_time", { "get": "fields" }] }] },
              {
                "set": [
                  "current_sample",
                  {
                    "call": [
                      "map.of",
                      { "literal": { "string": "time" } }, { "get": "time" },
                      { "literal": { "string": "user_cpu" } }, { "get": "user_cpu" },
                      { "literal": { "string": "system_cpu" } }, { "get": "system_cpu" },
                      { "literal": { "string": "cpu_time" } }, { "get": "cpu_time" }
                    ]
                  }
                ]
              },
              {
                "case": {
                  "branches": [
                    {
                      "condition": { "call": ["equal", { "get": "previous_sample" }, { "literal": "null" }] },
                      "result": {
                        "block": [
                          { "set": ["previous_sample", { "get": "current_sample" }] },
                          "continue"
                        ]
                      }
                    }
                  ],
                  "fallback": { "literal": "null" }
                }
              },
              { "set": ["start", { "call": ["map.get", { "get": "previous_sample" }, { "literal": { "string": "time" } }] }] },
              { "set": ["wall_delta", { "call": ["subtract", { "get": "time" }, { "get": "start" }] }] },
              {
                "set": [
                  "user_delta",
                  {
                    "call": [
                      "subtract",
                      { "get": "user_cpu" },
                      { "call": ["map.get", { "get": "previous_sample" }, { "literal": { "string": "user_cpu" } }] }
                    ]
                  }
                ]
              },
              {
                "set": [
                  "system_delta",
                  {
                    "call": [
                      "subtract",
                      { "get": "system_cpu" },
                      { "call": ["map.get", { "get": "previous_sample" }, { "literal": { "string": "system_cpu" } }] }
                    ]
                  }
                ]
              },
              { "set": ["start_cpu_time", { "call": ["map.get", { "get": "previous_sample" }, { "literal": { "string": "cpu_time" } }] }] },
              { "set": ["previous_sample", { "get": "current_sample" }] },
              {
                "case": {
                  "branches": [
                    {
                      "condition": { "call": ["less_equal", { "get": "wall_delta" }, { "literal": { "integer": "0" } }] },
                      "result": "continue"
                    },
                    {
                      "condition": {
                        "call": [
                          "or",
                          { "call": ["less", { "get": "user_delta" }, { "literal": { "integer": "0" } }] },
                          { "call": ["less", { "get": "system_delta" }, { "literal": { "integer": "0" } }] }
                        ]
                      },
                      "result": {
                        "block": [
                          {
                            "call": [
                              "diagnostic.warn",
                              { "literal": { "string": "process CPU counter decreased" } },
                              {
                                "call": [
                                  "map.of",
                                  { "literal": { "string": "time" } }, { "get": "time" },
                                  { "literal": { "string": "user_delta" } }, { "get": "user_delta" },
                                  { "literal": { "string": "system_delta" } }, { "get": "system_delta" }
                                ]
                              }
                            ]
                          },
                          "continue"
                        ]
                      }
                    }
                  ],
                  "fallback": { "literal": "null" }
                }
              },
              { "set": ["cpu_delta", { "call": ["add", { "get": "user_delta" }, { "get": "system_delta" }] }] },
              { "set": ["cores", { "call": ["computed.cpu_cores", { "get": "cpu_delta" }, { "get": "wall_delta" }] }] },
              { "set": ["total_percent", { "call": ["computed.cpu_percent", { "get": "cores" }, { "get": "capacity_cores" }] }] },
              {
                "call": [
                  "output.emit",
                  { "literal": { "string": "cpu_intervals" } },
                  {
                    "call": [
                      "map.of",
                      { "literal": { "string": "start" } }, { "get": "start" },
                      { "literal": { "string": "end" } }, { "get": "time" },
                      { "literal": { "string": "wall_delta" } }, { "get": "wall_delta" },
                      { "literal": { "string": "user_delta" } }, { "get": "user_delta" },
                      { "literal": { "string": "system_delta" } }, { "get": "system_delta" },
                      { "literal": { "string": "cpu_delta" } }, { "get": "cpu_delta" },
                      { "literal": { "string": "start_cpu_time" } }, { "get": "start_cpu_time" },
                      { "literal": { "string": "end_cpu_time" } }, { "get": "cpu_time" },
                      { "literal": { "string": "cores" } }, { "get": "cores" },
                      { "literal": { "string": "total_percent" } }, { "get": "total_percent" }
                    ]
                  }
                ]
              },
              { "set": ["interval_count", { "call": ["add", { "get": "interval_count" }, { "literal": { "integer": "1" } }] }] },
              {
                "set": [
                  "overlap_start",
                  {
                    "call": [
                      "list.max",
                      {
                        "call": [
                          "list.of",
                          { "get": "start" },
                          { "call": ["map.get", { "get": "viewport" }, { "literal": { "string": "start" } }] }
                        ]
                      }
                    ]
                  }
                ]
              },
              {
                "set": [
                  "overlap_end",
                  {
                    "call": [
                      "list.min",
                      {
                        "call": [
                          "list.of",
                          { "get": "time" },
                          { "call": ["map.get", { "get": "viewport" }, { "literal": { "string": "end" } }] }
                        ]
                      }
                    ]
                  }
                ]
              },
              { "set": ["overlap", { "call": ["subtract", { "get": "overlap_end" }, { "get": "overlap_start" }] }] },
              {
                "case": {
                  "branches": [
                    {
                      "condition": { "call": ["greater", { "get": "overlap" }, { "literal": { "integer": "0" } }] },
                      "result": {
                        "block": [
                          { "set": ["visible_total_overlap", { "call": ["add", { "get": "visible_total_overlap" }, { "get": "overlap" }] }] },
                          {
                            "set": [
                              "visible_weighted_cores",
                              {
                                "call": [
                                  "add",
                                  { "get": "visible_weighted_cores" },
                                  {
                                    "call": [
                                      "multiply",
                                      { "get": "cores" },
                                      { "call": ["integer.to_float", { "get": "overlap" }] }
                                    ]
                                  }
                                ]
                              }
                            ]
                          },
                          {
                            "case": {
                              "branches": [
                                {
                                  "condition": { "call": ["greater", { "get": "cores" }, { "get": "visible_max_cores" }] },
                                  "result": { "set": ["visible_max_cores", { "get": "cores" }] }
                                }
                              ],
                              "fallback": { "literal": "null" }
                            }
                          }
                        ]
                      }
                    }
                  ],
                  "fallback": { "literal": "null" }
                }
              }
            ]
          }
        }
      },
      {
        "case": {
          "branches": [
            {
              "condition": { "call": ["not_equal", { "get": "capacity_cores" }, { "literal": "null" }] },
              "result": {
                "call": [
                  "output.emit",
                  { "literal": { "string": "cpu_capacity" } },
                  {
                    "call": [
                      "map.of",
                      { "literal": { "string": "value" } }, { "get": "capacity_cores" },
                      { "literal": { "string": "label" } },
                      {
                        "call": [
                          "string.format",
                          { "literal": { "string": "{0} core capacity" } },
                          { "get": "capacity_cores" }
                        ]
                      }
                    ]
                  }
                ]
              }
            }
          ],
          "fallback": { "literal": "null" }
        }
      },
      {
        "set": [
          "average_cores",
          {
            "case": {
              "branches": [
                {
                  "condition": { "call": ["greater", { "get": "visible_total_overlap" }, { "literal": { "integer": "0" } }] },
                  "result": {
                    "call": [
                      "divide",
                      { "get": "visible_weighted_cores" },
                      { "call": ["integer.to_float", { "get": "visible_total_overlap" }] }
                    ]
                  }
                }
              ],
              "fallback": { "literal": { "float": "0.0" } }
            }
          }
        ]
      },
      { "set": ["average_percent", { "call": ["computed.cpu_percent", { "get": "average_cores" }, { "get": "capacity_cores" }] }] },
      {
        "set": [
          "scale_capacity",
          {
            "case": {
              "branches": [
                {
                  "condition": { "call": ["equal", { "get": "capacity_cores" }, { "literal": "null" }] },
                  "result": { "literal": { "float": "0.0" } }
                }
              ],
              "fallback": { "get": "capacity_cores" }
            }
          }
        ]
      },
      {
        "set": [
          "scale_max",
          {
            "call": [
              "list.max",
              {
                "call": [
                  "list.of",
                  { "literal": { "float": "1.0" } },
                  { "get": "visible_max_cores" },
                  { "get": "scale_capacity" }
                ]
              }
            ]
          }
        ]
      },
      {
        "case": {
          "branches": [
            {
              "condition": { "call": ["greater", { "get": "interval_count" }, { "literal": { "integer": "0" } }] },
              "result": {
                "call": [
                  "output.emit",
                  { "literal": { "string": "cpu_summary" } },
                  {
                    "call": [
                      "map.of",
                      { "literal": { "string": "visible_start" } }, { "call": ["map.get", { "get": "viewport" }, { "literal": { "string": "start" } }] },
                      { "literal": { "string": "visible_end" } }, { "call": ["map.get", { "get": "viewport" }, { "literal": { "string": "end" } }] },
                      { "literal": { "string": "available_parallelism" } }, { "get": "capacity_cores" },
                      { "literal": { "string": "average_cores" } }, { "get": "average_cores" },
                      { "literal": { "string": "average_percent" } }, { "get": "average_percent" },
                      { "literal": { "string": "max_cores" } }, { "get": "visible_max_cores" },
                      { "literal": { "string": "scale_max" } }, { "get": "scale_max" }
                    ]
                  }
                ]
              }
            }
          ],
          "fallback": { "literal": "null" }
        }
      }
    ]
  }
}
```
