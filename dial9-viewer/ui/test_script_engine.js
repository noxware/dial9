"use strict";

const { assert, test, summarize } = require("./test_harness.js");
const {
  compile,
  ListView,
  MapView,
  ScriptCompileError,
  ScriptRuntimeError,
} = require("./script_engine.js");

function int(value) {
  return ["integer.const", String(value)];
}

function str(value) {
  return ["string.const", value];
}

function get(name) {
  return ["var.get", name];
}

function set(name, value) {
  return ["var.set", name, value];
}

function mapGet(map, key) {
  return ["map.get", map, str(key)];
}

function throws(errorType, pattern, fn) {
  assert.throws(fn, (error) => error instanceof errorType && pattern.test(error.message));
}

test("compile returns a reusable zero-argument program", () => {
  const program = compile(["integer.add", int(2), int(3)]);
  assert.strictEqual(typeof program, "function");
  assert.strictEqual(program.length, 0);
  assert.strictEqual(program(), 5n);
  assert.strictEqual(program(), 5n);
});

test("large integers remain exact", () => {
  const program = compile([
    "integer.add",
    int("9007199254740993"),
    int("9007199254740995"),
  ]);
  assert.strictEqual(program(), 18014398509481988n);
});

test("integer arithmetic is typed", () => {
  assert.strictEqual(compile(["integer.subtract", int(-7), int(4)])(), -11n);
  assert.strictEqual(compile(["integer.multiply", int(-7), int(4)])(), -28n);
  throws(ScriptRuntimeError, /expected Integer/, () =>
    compile(["integer.add", ["float.const", "1"], int(2)])(),
  );
});

test("integer utility math preserves exact integer semantics", () => {
  assert.strictEqual(compile(["integer.negate", int(7)])(), -7n);
  assert.strictEqual(compile(["integer.abs", int(-7)])(), 7n);
  assert.strictEqual(compile(["integer.modulo", int(-7), int(3)])(), -1n);
  assert.strictEqual(compile(["integer.clamp", int(12), int(0), int(10)])(), 10n);
  throws(ScriptRuntimeError, /division by zero/, () =>
    compile(["integer.modulo", int(1), "integer.zero"])(),
  );
  throws(ScriptRuntimeError, /minimum exceeds maximum/, () =>
    compile(["integer.clamp", int(1), int(2), int(0)])(),
  );
});

test("integer division truncates toward zero", () => {
  assert.strictEqual(compile(["integer.divide", int(-7), int(3)])(), -2n);
  assert.strictEqual(compile(["integer.divide", int(7), int(-3)])(), -2n);
});

test("integer division rejects zero", () => {
  throws(ScriptRuntimeError, /division by zero/, () =>
    compile(["integer.divide", int(1), "integer.zero"])(),
  );
});

test("integer pow requires a non-negative integer exponent", () => {
  assert.strictEqual(compile(["integer.pow", int(3), int(4)])(), 81n);
  throws(ScriptRuntimeError, /non-negative exponent/, () =>
    compile(["integer.pow", int(3), int(-1)])(),
  );
});

test("typed min and max preserve numeric domains", () => {
  assert.strictEqual(compile(["integer.min", int(-2), int(3)])(), -2n);
  assert.strictEqual(compile(["integer.max", int(-2), int(3)])(), 3n);
  assert.strictEqual(compile(["float.min", ["float.const", "1.5"], ["float.const", "2.5"]])(), 1.5);
  assert.strictEqual(compile(["float.max", ["float.const", "1.5"], ["float.const", "2.5"]])(), 2.5);
});

test("float arithmetic rejects non-finite results", () => {
  assert.strictEqual(compile(["float.divide", ["float.const", "5"], ["float.const", "2"]])(), 2.5);
  throws(ScriptRuntimeError, /division by zero/, () =>
    compile(["float.divide", ["float.const", "1"], "float.zero"])(),
  );
  throws(ScriptRuntimeError, /non-finite/, () =>
    compile(["float.pow", ["float.const", "1e308"], ["float.const", "2"]])(),
  );
});

test("float utility math has explicit rounding semantics and remains Float", () => {
  const f = (value) => ["float.const", String(value)];
  assert.strictEqual(compile(["float.negate", f(1.5)])(), -1.5);
  assert.strictEqual(compile(["float.abs", f(-1.5)])(), 1.5);
  assert.strictEqual(compile(["float.floor", f(-1.2)])(), -2);
  assert.strictEqual(compile(["float.ceil", f(-1.2)])(), -1);
  assert.strictEqual(compile(["float.truncate", f(-1.8)])(), -1);
  assert.strictEqual(compile(["float.round", f(-1.5)])(), -2, "ties round away from zero");
  assert.strictEqual(compile(["float.sqrt", f(81)])(), 9);
  assert.strictEqual(compile(["float.clamp", f(-2), f(0), f(1)])(), 0);
  assert.strictEqual(compile(["type.of", ["float.floor", f(1.2)]])(), "float");
  throws(ScriptRuntimeError, /non-finite/, () => compile(["float.sqrt", f(-1)])());
  throws(ScriptRuntimeError, /minimum exceeds maximum/, () =>
    compile(["float.clamp", f(1), f(2), f(0)])(),
  );
});

test("numeric conversions are explicit", () => {
  assert.strictEqual(compile(["integer.from", str("42")])(), 42n);
  assert.strictEqual(compile(["float.from", int("9007199254740993")])(), 9007199254740992);
  throws(ScriptRuntimeError, /cannot convert/, () => compile(["integer.from", ["float.const", "1.5"]])());
});

test("type.of reports language types", () => {
  assert.strictEqual(compile(["type.of", int(1)])(), "integer");
  assert.strictEqual(compile(["type.of", "list.new"])(), "list");
  assert.strictEqual(compile(["type.of", "null"])(), "null");
});

test("zero-argument invokes use Atom form", () => {
  assert.strictEqual(compile("integer.zero")(), 0n);
  throws(ScriptCompileError, /Atom form/, () => compile(["integer.zero"]));
});

test("unknown and malformed operations fail during compile", () => {
  throws(ScriptCompileError, /unknown operation/, () => compile("does.not.exist"));
  throws(ScriptCompileError, /expects 2 argument/, () => compile(["integer.add", int(1)]));
  throws(ScriptCompileError, /invalid Integer/, () => compile(["integer.const", "1.2"]));
  throws(ScriptCompileError, /finite number/, () => compile(["float.const", "Infinity"]));
});

test("string constants cannot inject generated JavaScript", () => {
  const hostile = '");globalThis.__dial9Injected=true;//';
  delete globalThis.__dial9Injected;
  assert.strictEqual(compile(str(hostile))(), hostile);
  assert.strictEqual(globalThis.__dial9Injected, undefined);
});

test("blocks evaluate in order and return their final expression", () => {
  const program = compile([
    set("a", int(4)),
    set("b", ["integer.add", get("a"), int(3)]),
    ["integer.multiply", get("a"), get("b")],
  ]);
  assert.strictEqual(program(), 28n);
});

test("variables reject unknown and unassigned reads", () => {
  throws(ScriptCompileError, /unknown variable/, () => compile(get("missing")));
  const program = compile([
    "case",
    "bool.false",
    set("value", int(1)),
    "bool.true",
    get("value"),
  ]);
  throws(ScriptRuntimeError, /before assignment/, () => program());
});

test("program variables reset on every invocation", () => {
  const values = [];
  const program = compile([
    set("value", int(1)),
    ["capture", get("value")],
    set("value", ["integer.add", get("value"), int(1)]),
  ], { functions: { capture: (value) => values.push(value) } });
  program();
  program();
  assert.deepStrictEqual(values, [1n, 1n]);
});

test("case evaluates only the selected body", () => {
  const calls = [];
  const program = compile([
    "case",
    "bool.false",
    ["capture", str("wrong")],
    "bool.true",
    ["capture", str("right")],
  ], { functions: { capture: (value) => calls.push(value) } });
  program();
  assert.deepStrictEqual(calls, ["right"]);
});

test("case rejects JavaScript truthiness", () => {
  throws(ScriptRuntimeError, /expected Bool/, () =>
    compile(["case", int(1), "null"])(),
  );
});

test("for_each accepts Array and exposes integer index", () => {
  const seen = [];
  const program = compile([
    "for_each",
    "value",
    "index",
    "values",
    ["capture", get("value"), get("index")],
  ], {
    functions: {
      values: () => ["a", "b", "c"],
      capture: (value, index) => seen.push([value, index]),
    },
  });
  program();
  assert.deepStrictEqual(seen, [["a", 0n], ["b", 1n], ["c", 2n]]);
});

test("for_each accepts a ListView without copying it", () => {
  const source = [10n, 20n, 30n];
  const view = new ListView(source.length, (index) => source[index]);
  const seen = [];
  compile([
    "for_each", "value", "index", "values",
    ["capture", get("value")],
  ], {
    functions: { values: () => view, capture: (value) => seen.push(value) },
  })();
  assert.deepStrictEqual(seen, source);
});

test("for_each restores shadowed loop bindings", () => {
  const seen = [];
  compile([
    set("item", str("outside")),
    ["for_each", "item", "index", ["list.new", str("inside")], "null"],
    ["capture", get("item")],
  ], { functions: { capture: (value) => seen.push(value) } })();
  assert.deepStrictEqual(seen, ["outside"]);
});

test("external functions receive resolved values eagerly", () => {
  const order = [];
  const program = compile(["outer", ["inner", int(7)]], {
    functions: {
      inner(value) { order.push("inner"); return value + 1n; },
      outer(value) { order.push("outer"); return value * 2n; },
    },
  });
  assert.strictEqual(program(), 16n);
  assert.deepStrictEqual(order, ["inner", "outer"]);
});

test("external zero-argument functions use Atom form", () => {
  assert.strictEqual(compile("host.now", { functions: { "host.now": () => 9n } })(), 9n);
});

test("host undefined never leaks into the language", () => {
  assert.strictEqual(compile("host.missing", { functions: { "host.missing": () => undefined } })(), null);
});

test("computed values run in the caller variable scope", () => {
  const event = new Map([["user", 7n], ["system", 5n]]);
  const program = compile([
    set("event", "current.event"),
    "computed.cpu",
  ], {
    functions: { "current.event": () => event },
    computed: {
      "computed.cpu": [
        "integer.add",
        mapGet(get("event"), "user"),
        mapGet(get("event"), "system"),
      ],
    },
  });
  assert.strictEqual(program(), 12n);
});

test("computed values cannot recurse", () => {
  throws(ScriptCompileError, /recursive computed value/, () =>
    compile("computed.a", { computed: { "computed.a": "computed.a" } }),
  );
});

test("map.new constructs and mutates an owned Map", () => {
  const program = compile([
    set("map", ["map.new", str("a"), int(1), str("a"), int(2)]),
    ["map.set", get("map"), str("b"), int(3)],
    ["map.remove", get("map"), str("a")],
    get("map"),
  ]);
  assert.deepStrictEqual([...program()], [["b", 3n]]);
});

test("maps and loops express partitioned aggregation and indexed joins", () => {
  const input = [
    new Map([["group", "a"], ["value", 2n]]),
    new Map([["group", "b"], ["value", 5n]]),
    new Map([["group", "a"], ["value", 3n]]),
  ];
  const labels = [
    new Map([["group", "a"], ["label", "Alpha"]]),
    new Map([["group", "b"], ["label", "Beta"]]),
  ];
  const result = compile([
    set("totals", "map.new"),
    [
      "for_each", "row", "index", "input",
      [
        set("key", mapGet(get("row"), "group")),
        set("value", mapGet(get("row"), "value")),
        [
          "case", ["map.has", get("totals"), get("key")],
          ["map.set", get("totals"), get("key"), ["integer.add", ["map.get", get("totals"), get("key")], get("value")]],
          "bool.true", ["map.set", get("totals"), get("key"), get("value")],
        ],
      ],
    ],
    set("label_by_group", "map.new"),
    [
      "for_each", "row", "index", "labels",
      ["map.set", get("label_by_group"), mapGet(get("row"), "group"), mapGet(get("row"), "label")],
    ],
    set("joined", "list.new"),
    [
      "for_each", "row", "index", "input",
      [
        set("key", mapGet(get("row"), "group")),
        [
          "case", ["map.has", get("label_by_group"), get("key")],
          ["list.push", get("joined"), ["map.new",
            str("label"), ["map.get", get("label_by_group"), get("key")],
            str("total"), ["map.get", get("totals"), get("key")],
          ]],
          "bool.true", "null",
        ],
      ],
    ],
    get("joined"),
  ], { functions: { input: () => input, labels: () => labels } })();
  assert.deepStrictEqual(result.map((value) => Object.fromEntries(value)), [
    { label: "Alpha", total: 5n },
    { label: "Beta", total: 5n },
    { label: "Alpha", total: 5n },
  ]);
});

test("map.new rejects an odd number of arguments", () => {
  throws(ScriptCompileError, /key\/value pairs/, () => compile(["map.new", str("a")]));
});

test("MapView supports reads and rejects mutation", () => {
  const source = new Map([["answer", 42n]]);
  const view = new MapView((key) => source.get(key), (key) => source.has(key));
  assert.strictEqual(compile(["map.get", "view", str("answer")], {
    functions: { view: () => view },
  })(), 42n);
  assert.strictEqual(compile(["map.has", "view", str("answer")], {
    functions: { view: () => view },
  })(), true);
  assert.strictEqual(compile(["map.get", "view", str("missing")], {
    functions: { view: () => view },
  })(), null);
  throws(ScriptRuntimeError, /mutable Map/, () =>
    compile(["map.set", "view", str("answer"), int(0)], {
      functions: { view: () => view },
    })(),
  );
});

test("list operations distinguish owned Arrays from ListView", () => {
  const view = new ListView(2, (index) => [10n, 20n][index]);
  assert.strictEqual(compile(["list.length", "view"], { functions: { view: () => view } })(), 2n);
  assert.strictEqual(compile(["list.get", "view", int(1)], { functions: { view: () => view } })(), 20n);
  throws(ScriptRuntimeError, /mutable List/, () =>
    compile(["list.push", "view", int(30)], { functions: { view: () => view } })(),
  );
});

test("list bounds are explicit errors", () => {
  throws(ScriptRuntimeError, /out of bounds/, () =>
    compile(["list.get", ["list.new", int(1)], int(2)])(),
  );
  throws(ScriptRuntimeError, /out of range/, () =>
    compile(["list.get", ["list.new", int(1)], int(-1)])(),
  );
});

test("comparison does not coerce types", () => {
  assert.strictEqual(compile(["cmp.eq", int(1), ["float.const", "1"]])(), false);
  assert.strictEqual(compile(["cmp.lt", str("a"), str("b")])(), true);
  throws(ScriptRuntimeError, /same type/, () =>
    compile(["cmp.lt", int(1), ["float.const", "2"]])(),
  );
});

test("boolean operations require Bool", () => {
  assert.strictEqual(compile(["bool.and", "bool.true", "bool.false"])(), false);
  assert.strictEqual(compile(["bool.or", "bool.false", "bool.true"])(), true);
  assert.strictEqual(compile(["bool.not", "bool.false"])(), true);
  throws(ScriptRuntimeError, /expected Bool/, () => compile(["bool.not", "integer.zero"])());
});

test("string.concat forms arbitrary text", () => {
  assert.strictEqual(compile(["string.concat", str("CPU "), ["string.from", int(4)]])(), "CPU 4");
});

test("diagnostic.warn reports a structured warning", () => {
  const diagnostics = [];
  const result = compile(["diagnostic.warn", str("counter decreased")], {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })();
  assert.strictEqual(result, null);
  assert.deepStrictEqual(diagnostics, [{ severity: "warning", message: "counter decreased" }]);
});

summarize();
