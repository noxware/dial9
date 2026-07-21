# Custom View Script AST

## Program

```json
{
  "language": "dial9-script",
  "version": 1,
  "outputs": {
    "segments": { "units": { "start": "ns", "end": "ns" } }
  },
  "body": []
}
```

## Literals

```json
[
  { "literal": null },
  { "literal": true },
  { "literal": 1.5 },
  { "literal": "SpanEnter" },
  { "integer": "18446744073709551615" }
]
```

## Environment

```json
{ "env": "events" }
```

```json
{ "get": { "value": { "env": "metadata" }, "path": ["available_parallelism"] } }
```

```json
{ "get": { "value": { "env": "viewport" }, "path": ["start"] } }
```

## Variables

```json
{ "var": "event" }
```

```json
{ "let": "open", "value": { "call": "map.new", "args": [] } }
```

```json
{ "set": "previous", "value": { "var": "event" } }
```

## Field Access

```json
{ "get": { "value": { "var": "event" }, "path": ["kind"] } }
```

```json
{ "get": { "value": { "var": "event" }, "path": ["fields", "span_id"] } }
```

## Collections

```json
{ "list": [{ "literal": "SpanEnter" }, { "literal": "SpanExit" }] }
```

```json
{ "record": { "start": { "var": "start" }, "end": { "var": "end" } } }
```

```json
{ "call": "map.get", "args": [{ "var": "open" }, { "var": "span_id" }] }
```

```json
{ "do": { "call": "map.set", "args": [{ "var": "open" }, { "var": "span_id" }, { "var": "event" }] } }
```

## Expressions

```json
{ "binary": "+", "left": { "var": "user_time" }, "right": { "var": "system_time" } }
```

```json
{ "unary": "not", "value": { "var": "valid" } }
```

```json
{ "call": "string.starts_with", "args": [{ "var": "kind" }, { "literal": "SpanEnter" }] }
```

## Conditionals

```json
{
  "if": {
    "condition": { "binary": "<", "left": { "var": "current" }, "right": { "var": "previous" } },
    "then": [{ "warn": { "literal": "counter decreased" } }],
    "else": []
  }
}
```

## Iteration

```json
{
  "for": {
    "binding": "event",
    "iterable": { "env": "events" },
    "body": []
  }
}
```

```json
{ "control": "continue" }
```

```json
{ "control": "break" }
```

## Functions

```json
{
  "function": "cpu_time",
  "parameters": ["event"],
  "body": [{ "return": { "binary": "+", "left": { "var": "user_time" }, "right": { "var": "system_time" } } }]
}
```

```json
{ "call": "cpu_time", "args": [{ "var": "event" }] }
```

## Outputs

```json
{
  "emit": {
    "output": "segments",
    "value": { "record": { "start": { "var": "start" }, "end": { "var": "end" } } }
  }
}
```

## Diagnostics

```json
{ "warn": { "literal": "unmatched span exit" } }
```
