import { describe, expect, it, vi } from "vitest";
import {
  ScriptCompileError,
  ScriptRuntimeError,
  compile,
  createListView,
  createMapView,
  scriptValueReader,
  type CompileOptions,
  type SExpr,
  type ScriptBlock,
  type ScriptValue,
} from "./sub-js-ir.js";

const number = (input: number | string): SExpr => ["number.const", String(input)];
const bigint = (input: number | string): SExpr => ["bigint.const", String(input)];
const string = (input: string): SExpr => ["string.const", input];
const get = (name: string): SExpr => ["var.get", name];

function evaluate(expression: SExpr, options: CompileOptions = {}): ScriptValue {
  let called = false;
  let result: ScriptValue;
  compile([["test.capture", expression]], {
    functions: {
      ...options.functions,
      "test.capture": (value) => {
        called = true;
        result = value;
      },
    },
  })();
  if (!called) throw new Error("test.capture was not invoked");
  return result!;
}

describe("compile", () => {
  it("returns a reusable void function", () => {
    const captured: ScriptValue[] = [];
    const program = compile([["capture", ["op.add", number(20), number(22)]]], {
      functions: {
        capture(value) {
          captured.push(value);
        },
      },
    });

    expect(program()).toBeUndefined();
    expect(program()).toBeUndefined();
    expect(captured).toEqual([42, 42]);
    expect(compile([])()).toBeUndefined();
  });

  it("validates instruction structure, arity, bodies, and registered names", () => {
    expect(() => compile([[]])).toThrow(ScriptCompileError);
    expect(() => compile([["null.const"]])).toThrow(/atom form/);
    expect(() => compile([["op.add", number(1)]])).toThrow(/expects 2 operands/);
    expect(() => compile([["case", "bool.true", "null.const"]])).toThrow(/body must be a block/);
    expect(() => compile(["unknown.invoke"])).toThrow(/unknown instruction/);
    expect(() => compile(["loop.break"])).toThrow(/only valid in a loop/);
    expect(() =>
      compile([], {
        functions: {
          "op.add": () => undefined,
        },
      }),
    ).toThrow(/reserved name/);
  });

  it("parses complete numeric literals and emits canonical source", () => {
    expect(evaluate(["number.const", ".5"])).toBe(0.5);
    expect(evaluate(["number.const", "-0"])).toBe(-0);
    expect(evaluate(["number.const", "1.5e2"])).toBe(150);
    expect(() => compile([["bigint.const", "-0042"]])).toThrow(/not a bigint literal/);
    expect(() => compile([["number.const", "4.3garbage"]])).toThrow(/not a number literal/);
    expect(() => compile([["number.const", "1;globalThis.attack()"]])).toThrow(
      /not a number literal/,
    );
    expect(() => compile([["bigint.const", "1n;globalThis.attack()"]])).toThrow(
      /not a bigint literal/,
    );
  });
});

describe("JavaScript lowering", () => {
  it("supports literals, predicates, and direct conversions", () => {
    expect(evaluate("undefined.const")).toBeUndefined();
    expect(evaluate("null.const")).toBeNull();
    expect(evaluate("bool.true")).toBe(true);
    expect(evaluate(["number.const", "4.3"])).toBe(4.3);
    expect(evaluate(["bigint.const", "42"])).toBe(42n);
    expect(evaluate(string("hello"))).toBe("hello");

    expect(evaluate(["undefined.is", "undefined.const"])).toBe(true);
    expect(evaluate(["null.is", "null.const"])).toBe(true);
    expect(evaluate(["bool.is", "bool.false"])).toBe(true);
    expect(evaluate(["number.is", number(1)])).toBe(true);
    expect(evaluate(["bigint.is", bigint(1)])).toBe(true);
    expect(evaluate(["string.is", string("x")])).toBe(true);
    expect(evaluate(["obj.is", "obj.new"])).toBe(true);
    expect(evaluate(["list.is", "list.new"])).toBe(true);

    expect(evaluate(["number.from", string("1.25")])).toBe(1.25);
    expect(evaluate(["bigint.from", string("42")])).toBe(42n);
    expect(evaluate(["string.from", number(1.25)])).toBe("1.25");
  });

  it("maps operators to JavaScript semantics", () => {
    expect(evaluate(["op.add", number(1.25), number(2.5)])).toBe(3.75);
    expect(evaluate(["op.add", string("CPU: "), number(1.5)])).toBe("CPU: 1.5");
    expect(evaluate(["op.add", bigint(20), bigint(22)])).toBe(42n);
    expect(evaluate(["op.subtract", number(9), number(4)])).toBe(5);
    expect(evaluate(["op.multiply", number(6), number(7)])).toBe(42);
    expect(evaluate(["op.divide", number(7), number(2)])).toBe(3.5);
    expect(evaluate(["op.remainder", number(7), number(4)])).toBe(3);
    expect(evaluate(["op.pow", number(3), number(4)])).toBe(81);
    expect(evaluate(["op.negate", number(3)])).toBe(-3);

    expect(evaluate(["op.eq", number(1), bigint(1)])).toBe(false);
    expect(evaluate(["op.neq", number(1), bigint(1)])).toBe(true);
    expect(evaluate(["op.lt", string("a"), string("b")])).toBe(true);
    expect(evaluate(["op.lte", number(2), number(2)])).toBe(true);
    expect(evaluate(["op.gt", number(3), number(2)])).toBe(true);
    expect(evaluate(["op.gte", number(3), number(3)])).toBe(true);
    expect(evaluate(["op.not", string("")])).toBe(true);
    expect(evaluate(["op.and", string("left"), string("right")])).toBe("right");
    expect(evaluate(["op.or", string(""), string("fallback")])).toBe("fallback");
    expect(() => evaluate(["op.add", number(1), bigint(1)])).toThrow(TypeError);
  });

  it("preserves short-circuit evaluation", () => {
    const called = vi.fn(() => "called");
    const options = { functions: { called } };

    expect(evaluate(["op.and", "bool.false", "called"], options)).toBe(false);
    expect(evaluate(["op.or", "bool.true", "called"], options)).toBe(true);
    expect(called).not.toHaveBeenCalled();

    expect(evaluate(["op.and", "bool.true", "called"], options)).toBe("called");
    expect(called).toHaveBeenCalledOnce();
  });

  it("maps Math, Number predicates, and string operations", () => {
    expect(evaluate(["math.abs", number(-4.5)])).toBe(4.5);
    expect(evaluate(["math.floor", number(4.9)])).toBe(4);
    expect(evaluate(["math.ceil", number(4.1)])).toBe(5);
    expect(evaluate(["math.round", number(4.5)])).toBe(5);
    expect(evaluate(["math.trunc", number(-4.9)])).toBe(-4);
    expect(evaluate(["math.min", number(3), number(2)])).toBe(2);
    expect(evaluate(["math.max", number(3), number(2)])).toBe(3);
    expect(evaluate(["number.is_finite", ["op.divide", number(1), number(0)]])).toBe(false);
    expect(evaluate(["number.is_nan", ["op.divide", number(0), number(0)]])).toBe(true);

    expect(evaluate(["string.length", string("trace")])).toBe(5);
    expect(evaluate(["string.includes", string("trace"), string("ace")])).toBe(true);
    expect(evaluate(["string.starts_with", string("trace"), string("tr")])).toBe(true);
    expect(evaluate(["string.ends_with", string("trace"), string("ce")])).toBe(true);
    expect(evaluate(["string.slice", string("trace"), number(1), number(4)])).toBe("rac");
  });
});

describe("variables and control flow", () => {
  it("uses private null-terminated scope chains with shadowing and nearest set", () => {
    const seen: ScriptValue[] = [];
    const program: ScriptBlock = [
      ["var.let", "value", number(1)],
      [
        "case",
        "bool.true",
        [
          ["var.let", "value", number(2)],
          ["var.set", "value", number(3)],
          ["capture", get("value")],
        ],
      ],
      ["capture", get("value")],
      [
        "case",
        "bool.true",
        [
          ["var.set", "value", number(4)],
        ],
      ],
      ["capture", get("value")],
    ];

    compile(program, {
      functions: {
        capture(value) {
          seen.push(value);
        },
      },
    })();

    expect(seen).toEqual([3, 1, 4]);
    expect(evaluate(["var.get", "missing"])).toBeUndefined();
    expect(() => compile([["var.set", "missing", number(1)]])()).toThrow(TypeError);
  });

  it("executes the first truthy case", () => {
    const seen: ScriptValue[] = [];
    compile(
      [
        [
          "case",
          "null.const",
          [["capture", number(1)]],
          string("truthy"),
          [["capture", number(2)]],
          "bool.true",
          [["capture", number(3)]],
        ],
      ],
      {
        functions: {
          capture(value) {
            seen.push(value);
          },
        },
      },
    )();
    expect(seen).toEqual([2]);
  });

  it("iterates owned lists and views with break and continue", () => {
    const owned: Array<[ScriptValue, ScriptValue]> = [];
    const program: ScriptBlock = [
      [
        "loop.for_each",
        "item",
        "index",
        ["list.new", number(10), number(20), number(30), number(40)],
        [
          [
            "case",
            ["op.eq", get("index"), number(1)],
            ["loop.continue"],
          ],
          [
            "case",
            ["op.eq", get("index"), number(3)],
            ["loop.break"],
          ],
          ["capture", get("item"), get("index")],
        ],
      ],
    ];
    compile(program, {
      functions: {
        capture(item, index) {
          owned.push([item, index]);
        },
      },
    })();
    expect(owned).toEqual([
      [10, 0],
      [30, 2],
    ]);

    const view = createListView({
      length: 2,
      get(index) {
        return { index };
      },
    });
    const seenViews: ScriptValue[] = [];
    compile(
      [
        [
          "loop.for_each",
          "item",
          "index",
          "host.view",
          [
            ["capture", get("item")],
          ],
        ],
      ],
      {
        functions: {
          "host.view": () => view,
          capture(item) {
            seenViews.push(item);
          },
        },
      },
    )();
    expect(seenViews.every(scriptValueReader.isMapView)).toBe(true);
  });

  it("resets lexical bindings between loop iterations", () => {
    const seen: ScriptValue[] = [];
    compile(
      [
        [
          "loop.for_each",
          "item",
          "index",
          ["list.new", number(1), number(2)],
          [
            ["capture", ["var.get", "local"]],
            ["var.let", "local", ["var.get", "item"]],
          ],
        ],
      ],
      {
        functions: {
          capture(value) {
            seen.push(value);
          },
        },
      },
    )();
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("owned structures and host outputs", () => {
  it("supports object and list operations", () => {
    let objectKeys: ScriptValue | undefined;
    let list: ScriptValue | undefined;
    const program: ScriptBlock = [
      ["var.let", "object", ["obj.new", string("a"), number(1)]],
      ["obj.set", get("object"), string("b"), number(2)],
      ["capture", ["obj.get", get("object"), string("a")]],
      ["capture", ["obj.has", get("object"), string("b")]],
      ["captureKeys", ["obj.keys", get("object")]],
      ["obj.delete", get("object"), string("a")],
      ["capture", ["obj.has", get("object"), string("a")]],
      ["var.let", "list", ["list.new", number(1), number(2)]],
      ["list.set", get("list"), number(0), number(3)],
      ["list.push", get("list"), number(4)],
      ["capture", ["list.pop", get("list")]],
      ["capture", ["list.get", get("list"), number(0)]],
      ["capture", ["list.length", get("list")]],
      ["captureList", get("list")],
    ];
    const values: ScriptValue[] = [];
    compile(program, {
      functions: {
        capture(value) {
          values.push(value);
        },
        captureKeys(value) {
          objectKeys = value;
        },
        captureList(value) {
          list = value;
        },
      },
    })();

    expect(values).toEqual([1, true, false, 4, 3, 2]);
    if (!scriptValueReader.isList(objectKeys)) throw new Error("expected obj.keys to return a list");
    expect(scriptValueReader.listLength(objectKeys)).toBe(2);
    expect(scriptValueReader.listGet(objectKeys, 0)).toBe("a");
    if (!scriptValueReader.isList(list)) throw new Error("expected an owned list");
    expect(scriptValueReader.listGet(list, 0)).toBe(3);
  });

  it("stores emitted wrappers by reference and exposes them through the host reader", () => {
    const output: ScriptValue[] = [];
    compile(
      [
        ["var.let", "row", ["obj.new", string("value"), number(1)]],
        ["dial9.emit", string("cpu"), get("row")],
        ["obj.set", get("row"), string("value"), number(2)],
      ],
      {
        functions: {
          "dial9.emit": (_name, value) => {
            output.push(value);
          },
        },
      },
    )();

    expect(output).toHaveLength(1);
    const row = output[0];
    if (!scriptValueReader.isObject(row)) throw new Error("expected an owned object");
    expect(scriptValueReader.objectGet(row, "value")).toBe(2);
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(Object.keys(row)).toEqual(["value"]);
  });
});

describe("trace confinement", () => {
  it("does not interpolate trace strings or instruction names as source", () => {
    const marker = "__dial9SubJsEscaped";
    delete (globalThis as Record<string, unknown>)[marker];
    const payload = `"]; globalThis.${marker} = true; //`;

    expect(evaluate(string(payload))).toBe(payload);
    expect(evaluate(string("line\u2028separator\u2029end"))).toBe("line\u2028separator\u2029end");
    expect(() => compile([[`globalThis.${marker}=true`]])).toThrow();
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("encodes variable, object-key, and external names as data", () => {
    const marker = "__dial9SubJsNameEscaped";
    const hostileName = `x\"]; globalThis.${marker} = true; //`;
    delete (globalThis as Record<string, unknown>)[marker];

    let variable: ScriptValue;
    let objectValue: ScriptValue;
    let externalCalled = false;
    compile(
      [
        ["var.let", hostileName, number(7)],
        ["captureVariable", ["var.get", hostileName]],
        [
          "captureObject",
          ["obj.get", ["obj.new", string(hostileName), number(8)], string(hostileName)],
        ],
        hostileName,
      ],
      {
        functions: {
          captureVariable(value) {
            variable = value;
          },
          captureObject(value) {
            objectValue = value;
          },
          [hostileName]: () => {
            externalCalled = true;
          },
        },
      },
    )();

    expect(variable!).toBe(7);
    expect(objectValue!).toBe(8);
    expect(externalCalled).toBe(true);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("never resolves variable names against JavaScript globals", () => {
    expect(evaluate(["var.get", "globalThis"])).toBeUndefined();
    expect(evaluate(["var.get", "window"])).toBeUndefined();
    let protoBinding: ScriptValue;
    compile(
      [
        ["var.let", "__proto__", number(42)],
        ["capture", ["var.get", "__proto__"]],
      ],
      {
        functions: {
          capture(value) {
            protoBinding = value;
          },
        },
      },
    )();
    expect(protoBinding!).toBe(42);
    expect(() => compile([["var.set", "globalThis", number(1)]])()).toThrow(TypeError);
  });

  it("blocks prototype traversal through object and list instructions", () => {
    expect(() => evaluate(["obj.get", string(""), string("constructor")])).toThrow(TypeError);
    expect(evaluate(["list.get", "list.new", string("__proto__")])).toBeUndefined();
    expect(evaluate(["list.get", "list.new", string("constructor")])).toBeUndefined();
    expect(
      evaluate([
        "obj.get",
        ["obj.new", string("__proto__"), string("ordinary value")],
        string("__proto__"),
      ]),
    ).toBe("ordinary value");
  });

  it("keeps views read-only and wrapper internals inaccessible", () => {
    const host = { value: 1 };
    const view = createMapView({
      has(key) {
        return typeof key === "string" && Object.hasOwn(host, key);
      },
      get(key) {
        return typeof key === "string" && Object.hasOwn(host, key)
          ? host[key as keyof typeof host]
          : undefined;
      },
    });

    expect(Object.getPrototypeOf(view)).toBeNull();
    expect(() =>
      evaluate(["obj.set", "host.view", string("value"), number(2)], {
        functions: { "host.view": () => view },
      }),
    ).toThrow(TypeError);
    expect(host.value).toBe(1);
    expect(
      evaluate(["map_view.get", "host.view", string("__proto__")], {
        functions: { "host.view": () => view },
      }),
    ).toBeUndefined();
    expect(scriptValueReader.mapViewHas(view, "value")).toBe(true);
    expect(scriptValueReader.mapViewHas(view, "missing")).toBe(false);
  });

  it("normalizes foreign values lazily and rejects leaked functions", () => {
    const foreign = {
      nested: { answer: 42 },
      items: [{ value: 1 }],
      callable: () => "escaped",
    };
    const options = { functions: { "host.data": () => foreign } };

    expect(evaluate(["map_view.is", "host.data"], options)).toBe(true);
    expect(
      evaluate(
        ["map_view.is", ["map_view.get", "host.data", string("nested")]],
        options,
      ),
    ).toBe(true);
    expect(
      evaluate(
        ["list_view.is", ["map_view.get", "host.data", string("items")]],
        options,
      ),
    ).toBe(true);
    expect(evaluate(["map_view.get", "host.data", string("__proto__")], options)).toBeUndefined();
    expect(() =>
      evaluate(["map_view.get", "host.data", string("callable")], options),
    ).toThrow(ScriptRuntimeError);
    expect(() =>
      evaluate("host.symbol", { functions: { "host.symbol": () => Symbol("escaped") } }),
    ).toThrow(ScriptRuntimeError);
  });

  it("does not expose an array prototype through a foreign list view index", () => {
    const options = { functions: { "host.list": () => [] } };
    expect(
      evaluate(["list_view.get", "host.list", string("__proto__")], options),
    ).toBeUndefined();
    expect(
      evaluate(["list_view.get", "host.list", string("constructor")], options),
    ).toBeUndefined();
  });
});
