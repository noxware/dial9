import { describe, expect, it, vi } from "vitest";
import {
  ScriptCompileError,
  ScriptRuntimeError,
  compile,
  createListView,
  createMapView,
  type SExpr,
  type ScriptValue,
} from "./ir.js";

const integer = (value: number | string): SExpr => ["integer.const", String(value)];
const float = (value: number | string): SExpr => ["float.const", String(value)];
const string = (value: string): SExpr => ["string.const", value];
const get = (name: string): SExpr => ["var.get", name];

describe("compile", () => {
  it("returns a reusable native function for a value invoke", () => {
    const program = compile(["integer.add", integer(20), integer(22)]);

    expect(program).toBeTypeOf("function");
    expect(program()).toBe(42n);
    expect(program()).toBe(42n);
  });

  it("supports canonical zero-argument atoms and rejects bracketed forms", () => {
    expect(compile("integer.zero")()).toBe(0n);
    expect(compile("float.zero")()).toBe(0);
    expect(compile("null.const")()).toBeNull();
    expect(() => compile(["integer.zero"])).toThrow(ScriptCompileError);
  });

  it("does not interpolate literal payloads as JavaScript", () => {
    const payload = '"]; globalThis.__scriptIrEscaped = true; //';

    expect(compile(["string.const", payload])()).toBe(payload);
    expect((globalThis as Record<string, unknown>).__scriptIrEscaped).toBeUndefined();
  });
});

describe("primitive operations", () => {
  it("implements typed integer and float arithmetic", () => {
    expect(compile(["integer.subtract", integer(9), integer(4)])()).toBe(5n);
    expect(compile(["integer.multiply", integer(6), integer(7)])()).toBe(42n);
    expect(compile(["integer.divide", integer(-7), integer(2)])()).toBe(-3n);
    expect(compile(["integer.pow", integer(3), integer(4)])()).toBe(81n);
    expect(compile(["float.add", float(1.25), float(2.5)])()).toBe(3.75);
    expect(compile(["float.subtract", float(9), float(1.5)])()).toBe(7.5);
    expect(compile(["float.multiply", float(6), float(0.5)])()).toBe(3);
    expect(compile(["float.divide", float(7), float(2)])()).toBe(3.5);
    expect(compile(["float.pow", float(2), float(3)])()).toBe(8);
  });

  it("returns null for recoverable numeric errors", () => {
    expect(compile(["integer.add", integer(1), float(2)])()).toBeNull();
    expect(compile(["integer.divide", integer(1), "integer.zero"])()).toBeNull();
    expect(compile(["integer.pow", integer(2), integer(-1)])()).toBeNull();
    expect(compile(["float.divide", float(1), "float.zero"])()).toBeNull();
    expect(compile(["float.pow", float(1e308), float(2)])()).toBeNull();
  });

  it("converts primitive values without JS truthiness or non-finite values", () => {
    expect(compile(["integer.from", float(-3.9)])()).toBe(-3n);
    expect(compile(["integer.from", string("123")])()).toBe(123n);
    expect(compile(["integer.from", string("")])()).toBeNull();
    expect(compile(["float.from", integer(25)])()).toBe(25);
    expect(compile(["float.from", string("1.25")])()).toBe(1.25);
    expect(compile(["float.from", string("Infinity")])()).toBeNull();
    expect(compile(["string.from", "bool.false"])()).toBe("false");
    expect(compile(["string.from", "null.const"])()).toBe("null");
    expect(compile(["string.from", "list.new"])()).toBeNull();
  });

  it("constructs arbitrary text with strict string concatenation", () => {
    expect(compile(["string.concat", string("CPU: "), ["string.from", float(1.5)]])()).toBe(
      "CPU: 1.5",
    );
    expect(compile(["string.concat", string("CPU: "), float(1.5)])()).toBeNull();
  });

  it("checks logical types and reports their diagnostic names", () => {
    const cases: Array<[SExpr, string, string]> = [
      ["null.const", "null.is", "null"],
      ["bool.true", "bool.is", "bool"],
      [integer(1), "integer.is", "integer"],
      [float(1), "float.is", "float"],
      [string("x"), "string.is", "string"],
      ["list.new", "list.is", "list"],
      ["map.new", "map.is", "map"],
    ];

    for (const [expression, check, name] of cases) {
      expect(compile([check, expression])()).toBe(true);
      expect(compile(["diagnostic.type_name", expression])()).toBe(name);
    }
    expect(compile(["integer.is", float(1)])()).toBe(false);
  });

  it("uses strict equality and same-type ordered comparisons", () => {
    expect(compile(["cmp.eq", integer(1), float(1)])()).toBe(false);
    expect(compile(["cmp.eq", string("a"), string("a")])()).toBe(true);
    expect(compile(["cmp.lt", integer(1), integer(2)])()).toBe(true);
    expect(compile(["cmp.lte", float(2), float(2)])()).toBe(true);
    expect(compile(["cmp.gt", string("b"), string("a")])()).toBe(true);
    expect(compile(["cmp.gte", integer(3), integer(4)])()).toBe(false);
    expect(compile(["cmp.lt", integer(1), float(2)])()).toBeNull();
  });
});

describe("boolean evaluation", () => {
  it("is strict about boolean operands", () => {
    expect(compile(["bool.not", "bool.false"])()).toBe(true);
    expect(compile(["bool.not", "null.const"])()).toBeNull();
    expect(compile(["bool.and", "bool.true", "bool.false"])()).toBe(false);
    expect(compile(["bool.or", "bool.false", "bool.true"])()).toBe(true);
    expect(compile(["bool.and", string("truthy"), "bool.true"])()).toBeNull();
  });

  it("short-circuits the right operand", () => {
    const called = vi.fn(() => true);
    const options = { functions: { "test.called": called } };

    expect(compile(["bool.and", "bool.false", "test.called"], options)()).toBe(false);
    expect(compile(["bool.or", "bool.true", "test.called"], options)()).toBe(true);
    expect(called).not.toHaveBeenCalled();

    expect(compile(["bool.and", "bool.true", "test.called"], options)()).toBe(true);
    expect(called).toHaveBeenCalledOnce();
  });
});

describe("variables and scopes", () => {
  it("supports root mutation, branch shadowing, and nearest-binding lookup", () => {
    const seen: ScriptValue[] = [];
    const program: SExpr = [
      ["var.let", "value", integer(1)],
      [
        "case",
        "bool.true",
        [
          ["var.let", "value", integer(2)],
          ["test.capture", get("value")],
        ],
      ],
      ["test.capture", get("value")],
      [
        "case",
        "bool.true",
        ["var.set", "value", integer(3)],
      ],
      ["test.capture", get("value")],
    ];

    expect(
      compile(program, {
        functions: {
          "test.capture": (entry) => {
            seen.push(entry);
            return null;
          },
        },
      })(),
    ).toBeUndefined();
    expect(seen).toEqual([2n, 1n, 3n]);
  });

  it("rejects missing bindings and same-scope redeclarations", () => {
    expect(() => compile(["var.get", "missing"])).toThrow(/unknown variable/);
    expect(() =>
      compile([
        ["var.let", "same", integer(1)],
        ["var.let", "same", integer(2)],
      ]),
    ).toThrow(/already declared/);
  });
});

describe("control flow", () => {
  it("executes the first true case body and treats non-bools as non-matches", () => {
    const seen: ScriptValue[] = [];
    const program: SExpr = [
      "case",
      "null.const",
      ["test.capture", integer(1)],
      "bool.true",
      ["test.capture", integer(2)],
      "bool.true",
      ["test.capture", integer(3)],
    ];

    compile(program, {
      functions: {
        "test.capture": (entry) => {
          seen.push(entry);
          return null;
        },
      },
    })();
    expect(seen).toEqual([2n]);
  });

  it("iterates lists with fresh item/index bindings and supports continue/break", () => {
    const seen: Array<[ScriptValue, ScriptValue]> = [];
    const program: SExpr = [
      "for_each",
      "item",
      "index",
      ["list.new", integer(10), integer(20), integer(30), integer(40)],
      [
        [
          "case",
          ["cmp.eq", get("index"), integer(1)],
          "loop.continue",
        ],
        [
          "case",
          ["cmp.eq", get("index"), integer(3)],
          "loop.break",
        ],
        ["test.capture", get("item"), get("index")],
      ],
    ];

    compile(program, {
      functions: {
        "test.capture": (item, index) => {
          seen.push([item!, index!]);
          return null;
        },
      },
    })();
    expect(seen).toEqual([
      [10n, 0n],
      [30n, 2n],
    ]);
  });

  it("rejects loop control outside a loop", () => {
    expect(() => compile("loop.break")).toThrow(/only valid in a loop/);
    expect(() => compile("loop.continue")).toThrow(/only valid in a loop/);
  });
});

describe("CPU usage specification example", () => {
  it("derives intervals through registered Dial9 invokes without engine coupling", () => {
    const field = (name: string): SExpr => ["map.get", get("event"), string(name)];
    const script: SExpr = [
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
          ["cmp.eq", field("kind"), string("ProcessResourceUsageEvent")],
          [
            ["var.let", "current_time", field("time")],
            [
              "var.let",
              "current_cpu_time",
              ["integer.add", field("user_cpu_ns"), field("system_cpu_ns")],
            ],
            [
              "case",
              get("has_previous"),
              [
                [
                  "var.let",
                  "wall_delta",
                  ["integer.subtract", get("current_time"), get("previous_time")],
                ],
                [
                  "var.let",
                  "cpu_delta",
                  ["integer.subtract", get("current_cpu_time"), get("previous_cpu_time")],
                ],
                [
                  "case",
                  ["cmp.lte", get("wall_delta"), "integer.zero"],
                  "null.const",
                  ["cmp.lt", get("cpu_delta"), "integer.zero"],
                  ["diagnostic.warn", string("CPU counter decreased")],
                  "bool.true",
                  [
                    "dial9.output.emit",
                    "cpu_intervals",
                    [
                      "map.new",
                      string("start"),
                      get("previous_time"),
                      string("end"),
                      get("current_time"),
                      string("cpu_delta"),
                      get("cpu_delta"),
                      string("cores"),
                      [
                        "float.divide",
                        ["float.from", get("cpu_delta")],
                        ["float.from", get("wall_delta")],
                      ],
                    ],
                  ],
                ],
              ],
              "bool.true",
              "null.const",
            ],
            ["var.set", "previous_time", get("current_time")],
            ["var.set", "previous_cpu_time", get("current_cpu_time")],
            ["var.set", "has_previous", "bool.true"],
          ],
          "bool.true",
          "null.const",
        ],
      ],
    ];
    const events = [
      { kind: "OtherEvent", time: 50n },
      { kind: "ProcessResourceUsageEvent", time: 100n, user_cpu_ns: 10n, system_cpu_ns: 5n },
      { kind: "ProcessResourceUsageEvent", time: 200n, user_cpu_ns: 40n, system_cpu_ns: 25n },
      { kind: "ProcessResourceUsageEvent", time: 300n, user_cpu_ns: 1n, system_cpu_ns: 1n },
      { kind: "ProcessResourceUsageEvent", time: 400n, user_cpu_ns: 21n, system_cpu_ns: 1n },
    ];
    const emitted: Map<ScriptValue, ScriptValue>[] = [];
    const diagnostics: string[] = [];
    const program = compile(script, {
      functions: {
        "dial9.events": () => events,
        cpu_intervals: () => "cpu_intervals",
        "dial9.output.emit": (output, interval) => {
          expect(output).toBe("cpu_intervals");
          expect(interval).toBeInstanceOf(Map);
          emitted.push(interval as Map<ScriptValue, ScriptValue>);
          return null;
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    expect(program()).toBeUndefined();
    expect(emitted).toHaveLength(2);
    expect(Object.fromEntries(emitted[0]!)).toEqual({
      start: 100n,
      end: 200n,
      cpu_delta: 50n,
      cores: 0.5,
    });
    expect(Object.fromEntries(emitted[1]!)).toEqual({
      start: 300n,
      end: 400n,
      cpu_delta: 20n,
      cores: 0.2,
    });
    expect(diagnostics).toEqual(["CPU counter decreased"]);
  });
});

describe("owned maps and lists", () => {
  it("constructs, reads, and mutates script-owned maps", () => {
    const seen: ScriptValue[] = [];
    const program: SExpr = [
      ["var.let", "map", ["map.new", string("a"), integer(1)]],
      ["test.capture", ["map.has", get("map"), string("a")]],
      ["map.set", get("map"), string("b"), integer(2)],
      ["test.capture", ["map.get", get("map"), string("b")]],
      ["test.capture", ["map.remove", get("map"), string("a")]],
      ["test.capture", ["map.get", get("map"), string("a")]],
    ];

    compile(program, {
      functions: {
        "test.capture": (entry) => {
          seen.push(entry);
          return null;
        },
      },
    })();
    expect(seen).toEqual([true, 2n, true, null]);
  });

  it("constructs, reads, and mutates script-owned lists", () => {
    const seen: ScriptValue[] = [];
    const program: SExpr = [
      ["var.let", "list", ["list.new", integer(1)]],
      ["list.push", get("list"), integer(2)],
      ["list.set", get("list"), integer(0), integer(3)],
      ["test.capture", ["list.length", get("list")]],
      ["test.capture", ["list.get", get("list"), integer(0)]],
      ["test.capture", ["list.get", get("list"), integer(1)]],
      ["test.capture", ["list.get", get("list"), integer(99)]],
    ];

    compile(program, {
      functions: {
        "test.capture": (entry) => {
          seen.push(entry);
          return null;
        },
      },
    })();
    expect(seen).toEqual([2n, 3n, 2n, null]);
  });

  it("uses list.push for growth and rejects out-of-range list.set", () => {
    const program: SExpr = [
      ["var.let", "list", "list.new"],
      ["list.set", get("list"), "integer.zero", integer(1)],
    ];

    expect(() => compile(program)()).toThrow(/existing integer index/);
  });

  it("compares containers by reference", () => {
    const same: SExpr = [
      ["var.let", "map", "map.new"],
      ["test.capture", ["cmp.eq", get("map"), get("map")]],
      ["test.capture", ["cmp.eq", get("map"), "map.new"]],
    ];
    const seen: ScriptValue[] = [];

    compile(same, {
      functions: {
        "test.capture": (entry) => {
          seen.push(entry);
          return null;
        },
      },
    })();
    expect(seen).toEqual([true, false]);
  });
});

describe("external functions and views", () => {
  it("eagerly evaluates arguments and normalizes nested host data", () => {
    const host = { event: { values: [10n, 20n] } };
    const source = vi.fn(() => host);
    const program: SExpr = [
      "list.get",
      ["map.get", ["map.get", "host.source", string("event")], string("values")],
      integer(1),
    ];

    expect(compile(program, { functions: { "host.source": source } })()).toBe(20n);
    expect(source).toHaveBeenCalledOnce();
  });

  it("supports fully virtual views with no exposed backing object", () => {
    const map = createMapView({
      has(key) {
        return key === "answer";
      },
      get(key) {
        return key === "answer" ? 42n : null;
      },
    });
    const list = createListView({
      length: 3,
      get(index) {
        return createMapView({
          has: (key) => key === "answer",
          get: (key) => (key === "answer" ? BigInt(index) : null),
        });
      },
    });

    expect(
      compile(["map.get", "host.map", string("answer")], {
        functions: { "host.map": () => map },
      })(),
    ).toBe(42n);
    expect(
      compile(["map.get", ["list.get", "host.list", integer(2)], string("answer")], {
        functions: { "host.list": () => list },
      })(),
    ).toBe(2n);
  });

  it("passes already evaluated logical values to external functions", () => {
    const fn = vi.fn((left: ScriptValue, right: ScriptValue) =>
      typeof left === "bigint" && typeof right === "bigint" ? left + right : null,
    );

    expect(
      compile(["host.add", ["integer.add", integer(1), integer(2)], integer(4)], {
        functions: { "host.add": fn },
      })(),
    ).toBe(7n);
    expect(fn).toHaveBeenCalledWith(3n, 4n);
  });

  it("allows diagnostics to be handled by the host", () => {
    const onDiagnostic = vi.fn();

    expect(
      compile(["diagnostic.warn", string("counter decreased")], { onDiagnostic })(),
    ).toBeNull();
    expect(onDiagnostic).toHaveBeenCalledWith({
      level: "warning",
      message: "counter decreased",
    });
  });
});

describe("security boundary", () => {
  it("wraps host arrays, maps, and objects as read-only views", () => {
    const values = [1n];
    const mapping = new Map<ScriptValue, unknown>([["key", 2n]]);
    const object = { key: 3n };
    const functions = {
      "host.array": () => values,
      "host.map": () => mapping,
      "host.object": () => object,
    };

    expect(() =>
      compile(["list.push", "host.array", integer(2)], { functions })(),
    ).toThrow(/cannot mutate a ListView/);
    expect(() =>
      compile(["map.set", "host.map", string("x"), integer(2)], { functions })(),
    ).toThrow(/cannot mutate a MapView/);
    expect(() =>
      compile(["map.set", "host.object", string("x"), integer(2)], { functions })(),
    ).toThrow(/cannot mutate a MapView/);
    expect(values).toEqual([1n]);
    expect(mapping.has("x")).toBe(false);
    expect(object).toEqual({ key: 3n });
  });

  it("never exposes inherited object properties", () => {
    const inherited = { secret: "no" };
    const host = Object.assign(Object.create(inherited) as Record<string, unknown>, {
      visible: "yes",
    });
    const functions = { "host.object": () => host };

    expect(compile(["map.get", "host.object", string("visible")], { functions })()).toBe("yes");
    expect(compile(["map.get", "host.object", string("secret")], { functions })()).toBeNull();
    expect(compile(["map.get", "host.object", string("toString")], { functions })()).toBeNull();
  });

  it("normalizes every view read and rejects unsupported leaked values", () => {
    const nested = { safe: 1n };
    const wrapsNested = createMapView({
      has: () => true,
      get: () => nested,
    });
    const leaksFunction = createMapView({
      has: () => true,
      get: () => () => "host code",
    });

    expect(
      compile(["map.is", ["map.get", "host.nested", string("x")]], {
        functions: { "host.nested": () => wrapsNested },
      })(),
    ).toBe(true);
    expect(() =>
      compile(["map.get", "host.leak", string("x")], {
        functions: { "host.leak": () => leaksFunction },
      })(),
    ).toThrow(ScriptRuntimeError);
  });

  it("validates view control metadata at the runtime boundary", () => {
    const invalidLength = createListView({ length: -1, get: () => null });
    const invalidHas = createMapView({
      has: (() => "yes") as unknown as () => boolean,
      get: () => null,
    });

    expect(() =>
      compile(["list.length", "host.list"], {
        functions: { "host.list": () => invalidLength },
      })(),
    ).toThrow(/non-negative safe integer/);
    expect(() =>
      compile(["map.has", "host.map", string("key")], {
        functions: { "host.map": () => invalidHas },
      })(),
    ).toThrow(/must return a boolean/);
  });

  it("rejects unsupported and non-finite external results", () => {
    expect(() => compile("host.undefined", { functions: { "host.undefined": () => undefined } })()).toThrow(
      /unsupported undefined/,
    );
    expect(() => compile("host.function", { functions: { "host.function": () => () => null } })()).toThrow(
      /unsupported function/,
    );
    expect(() => compile("host.nan", { functions: { "host.nan": () => Number.NaN } })()).toThrow(
      /non-finite/,
    );
  });

  it("dispatches hostile external names by fixed index rather than generated source", () => {
    const name = 'host\"]; globalThis.__scriptIrExternalEscaped = true; //';
    const program = compile(name, { functions: { [name]: () => 7n } });

    expect(program()).toBe(7n);
    expect((globalThis as Record<string, unknown>).__scriptIrExternalEscaped).toBeUndefined();
  });
});

describe("validation", () => {
  it("rejects unknown invokes, invalid arity, and value-less operands", () => {
    expect(() => compile("does.not.exist")).toThrow(/unknown invoke/);
    expect(() => compile(["integer.add", integer(1)])).toThrow(/expects 2 operands/);
    expect(() => compile(["integer.add", ["var.let", "x", integer(1)], integer(2)])).toThrow(
      /does not produce a value/,
    );
  });

  it("rejects reserved external names", () => {
    expect(() => compile("integer.zero", { functions: { "integer.add": () => 1n } })).toThrow(
      /reserved name/,
    );
  });
});
