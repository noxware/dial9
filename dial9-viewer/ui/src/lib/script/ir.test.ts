import { describe, expect, it, vi } from "vitest";
import {
  ScriptRuntimeError,
  compile,
  createListView,
  createMapView,
  type CompileOptions,
  type SExpr,
  type ScriptBlock,
  type ScriptValue,
} from "./ir.js";

const bigintExpr = (value: number | string): SExpr => ["bigint.const", String(value)];
const numberExpr = (value: number | string): SExpr => ["number.const", String(value)];
const string = (value: string): SExpr => ["string.const", value];
const get = (name: string): SExpr => ["var.get", name];

function evaluate(expression: SExpr, options: CompileOptions = {}): ScriptValue {
  let result: ScriptValue | undefined;
  compile([["test.result", expression]], {
    functions: {
      ...options.functions,
      "test.result": (value) => {
        result = value;
        return null;
      },
    },
    onDiagnostic: options.onDiagnostic,
  })();
  if (result === undefined) throw new Error("test.result was not invoked");
  return result;
}

describe("compile", () => {
  it("returns a reusable native void function for a root block", () => {
    const captured: ScriptValue[] = [];
    const program = compile([["test.capture", ["bigint.add", bigintExpr(20), bigintExpr(22)]]], {
      functions: {
        "test.capture": (value) => {
          captured.push(value);
          return null;
        },
      },
    });

    expect(program).toBeTypeOf("function");
    expect(program()).toBeUndefined();
    expect(program()).toBeUndefined();
    expect(captured).toEqual([42n, 42n]);
    expect(compile([["bigint.add", bigintExpr(20), bigintExpr(22)]])()).toBeUndefined();
  });

  it("treats root programs as blocks, including blocks beginning with atoms", () => {
    expect(evaluate("bigint.zero")).toBe(0n);
    expect(evaluate("number.zero")).toBe(0);
    expect(evaluate("null.const")).toBeNull();
    expect(compile(["bigint.zero"])()).toBeUndefined();
  });

  it("does not interpolate literal payloads as JavaScript", () => {
    const payload = '"]; globalThis.__scriptIrEscaped = true; //';

    expect(evaluate(["string.const", payload])).toBe(payload);
    expect((globalThis as Record<string, unknown>).__scriptIrEscaped).toBeUndefined();
  });
});

describe("primitive operations", () => {
  it("implements typed bigint and number arithmetic", () => {
    expect(evaluate(["bigint.subtract", bigintExpr(9), bigintExpr(4)])).toBe(5n);
    expect(evaluate(["bigint.multiply", bigintExpr(6), bigintExpr(7)])).toBe(42n);
    expect(evaluate(["bigint.divide", bigintExpr(-7), bigintExpr(2)])).toBe(-3n);
    expect(evaluate(["bigint.pow", bigintExpr(3), bigintExpr(4)])).toBe(81n);
    expect(evaluate(["number.add", numberExpr(1.25), numberExpr(2.5)])).toBe(3.75);
    expect(evaluate(["number.subtract", numberExpr(9), numberExpr(1.5)])).toBe(7.5);
    expect(evaluate(["number.multiply", numberExpr(6), numberExpr(0.5)])).toBe(3);
    expect(evaluate(["number.divide", numberExpr(7), numberExpr(2)])).toBe(3.5);
    expect(evaluate(["number.pow", numberExpr(2), numberExpr(3)])).toBe(8);
  });

  it("returns null for recoverable numeric errors", () => {
    expect(evaluate(["bigint.add", bigintExpr(1), numberExpr(2)])).toBeNull();
    expect(evaluate(["bigint.divide", bigintExpr(1), "bigint.zero"])).toBeNull();
    expect(evaluate(["bigint.pow", bigintExpr(2), bigintExpr(-1)])).toBeNull();
    expect(evaluate(["number.divide", numberExpr(1), "number.zero"])).toBeNull();
    expect(evaluate(["number.pow", numberExpr(1e308), numberExpr(2)])).toBeNull();
  });

  it("converts primitive values without JS truthiness or non-finite values", () => {
    expect(evaluate(["bigint.from", numberExpr(-3.9)])).toBe(-3n);
    expect(evaluate(["bigint.from", string("123")])).toBe(123n);
    expect(evaluate(["bigint.from", string("")])).toBeNull();
    expect(evaluate(["number.from", bigintExpr(25)])).toBe(25);
    expect(evaluate(["number.from", string("1.25")])).toBe(1.25);
    expect(evaluate(["number.from", string("Infinity")])).toBeNull();
    expect(evaluate(["string.from", "bool.false"])).toBe("false");
    expect(evaluate(["string.from", "null.const"])).toBe("null");
    expect(evaluate(["string.from", "list.new"])).toBeNull();
  });

  it("constructs arbitrary text with strict string concatenation", () => {
    expect(evaluate(["string.concat", string("CPU: "), ["string.from", numberExpr(1.5)]])).toBe(
      "CPU: 1.5",
    );
    expect(evaluate(["string.concat", string("CPU: "), numberExpr(1.5)])).toBeNull();
  });

  it("checks logical types and reports their diagnostic names", () => {
    const cases: Array<[SExpr, string, string]> = [
      ["null.const", "null.is", "null"],
      ["bool.true", "bool.is", "bool"],
      [bigintExpr(1), "bigint.is", "bigint"],
      [numberExpr(1), "number.is", "number"],
      [string("x"), "string.is", "string"],
      ["list.new", "list.is", "list"],
      ["map.new", "map.is", "map"],
    ];

    for (const [expression, check, name] of cases) {
      expect(evaluate([check, expression])).toBe(true);
      expect(evaluate(["diagnostic.type_name", expression])).toBe(name);
    }
    expect(evaluate(["bigint.is", numberExpr(1)])).toBe(false);
  });

  it("uses strict equality and same-type ordered comparisons", () => {
    expect(evaluate(["cmp.eq", bigintExpr(1), numberExpr(1)])).toBe(false);
    expect(evaluate(["cmp.eq", string("a"), string("a")])).toBe(true);
    expect(evaluate(["cmp.lt", bigintExpr(1), bigintExpr(2)])).toBe(true);
    expect(evaluate(["cmp.lte", numberExpr(2), numberExpr(2)])).toBe(true);
    expect(evaluate(["cmp.gt", string("b"), string("a")])).toBe(true);
    expect(evaluate(["cmp.gte", bigintExpr(3), bigintExpr(4)])).toBe(false);
    expect(evaluate(["cmp.lt", bigintExpr(1), numberExpr(2)])).toBeNull();
  });
});

describe("boolean evaluation", () => {
  it("is strict about boolean operands", () => {
    expect(evaluate(["bool.not", "bool.false"])).toBe(true);
    expect(evaluate(["bool.not", "null.const"])).toBeNull();
    expect(evaluate(["bool.and", "bool.true", "bool.false"])).toBe(false);
    expect(evaluate(["bool.or", "bool.false", "bool.true"])).toBe(true);
    expect(evaluate(["bool.and", string("truthy"), "bool.true"])).toBeNull();
  });

  it("short-circuits the right operand", () => {
    const called = vi.fn(() => true);
    const options = { functions: { "test.called": called } };

    expect(evaluate(["bool.and", "bool.false", "test.called"], options)).toBe(false);
    expect(evaluate(["bool.or", "bool.true", "test.called"], options)).toBe(true);
    expect(called).not.toHaveBeenCalled();

    expect(evaluate(["bool.and", "bool.true", "test.called"], options)).toBe(true);
    expect(called).toHaveBeenCalledOnce();
  });
});

describe("variables and scopes", () => {
  it("supports root mutation, branch shadowing, and nearest-binding lookup", () => {
    const seen: ScriptValue[] = [];
    const program: ScriptBlock = [
      ["var.let", "value", bigintExpr(1)],
      [
        "case",
        "bool.true",
        [
          ["var.let", "value", bigintExpr(2)],
          ["test.capture", get("value")],
        ],
      ],
      ["test.capture", get("value")],
      [
        "case",
        "bool.true",
        [["var.set", "value", bigintExpr(3)]],
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
    expect(() => compile([["var.get", "missing"]])).toThrow(/unknown variable/);
    expect(() =>
      compile([
        ["var.let", "same", bigintExpr(1)],
        ["var.let", "same", bigintExpr(2)],
      ]),
    ).toThrow(/already declared/);
  });
});

describe("control flow", () => {
  it("executes the first true case body and treats non-bools as non-matches", () => {
    const seen: ScriptValue[] = [];
    const program: ScriptBlock = [
      [
        "case",
        "null.const",
        [["test.capture", bigintExpr(1)]],
        "bool.true",
        [["test.capture", bigintExpr(2)]],
        "bool.true",
        [["test.capture", bigintExpr(3)]],
      ],
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
    const program: ScriptBlock = [
      [
        "list.for_each",
        "item",
        "index",
        ["list.new", bigintExpr(10), bigintExpr(20), bigintExpr(30), bigintExpr(40)],
        [
          [
            "case",
            ["cmp.eq", get("index"), numberExpr(1)],
            ["loop.continue"],
          ],
          [
            "case",
            ["cmp.eq", get("index"), numberExpr(3)],
            ["loop.break"],
          ],
          ["test.capture", get("item"), get("index")],
        ],
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
      [10n, 0],
      [30n, 2],
    ]);
  });

  it("rejects loop control outside a loop", () => {
    expect(() => compile(["loop.break"])).toThrow(/only valid in a loop/);
    expect(() => compile(["loop.continue"])).toThrow(/only valid in a loop/);
  });
});

describe("CPU usage specification example", () => {
  it("derives intervals through registered Dial9 invokes without engine coupling", () => {
    const field = (name: string): SExpr => ["map.get", get("event"), string(name)];
    const script: ScriptBlock = [
      ["var.let", "has_previous", "bool.false"],
      ["var.let", "previous_time", "null.const"],
      ["var.let", "previous_cpu_time", "null.const"],
      [
        "list.for_each",
        "event",
        "index",
        "dial9.events",
        [
          [
            "case",
            ["cmp.eq", field("kind"), string("ProcessResourceUsageEvent")],
            [
              ["var.let", "current_time", field("time")],
              [
                "var.let",
                "current_cpu_time",
                ["bigint.add", field("user_cpu_ns"), field("system_cpu_ns")],
              ],
              [
                "case",
                get("has_previous"),
                [
                  [
                    "var.let",
                    "wall_delta",
                    ["bigint.subtract", get("current_time"), get("previous_time")],
                  ],
                  [
                    "var.let",
                    "cpu_delta",
                    ["bigint.subtract", get("current_cpu_time"), get("previous_cpu_time")],
                  ],
                  [
                    "case",
                    ["cmp.lte", get("wall_delta"), "bigint.zero"],
                    ["null.const"],
                    ["cmp.lt", get("cpu_delta"), "bigint.zero"],
                    [["diagnostic.warn", string("CPU counter decreased")]],
                    "bool.true",
                    [
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
                            "number.divide",
                            ["number.from", get("cpu_delta")],
                            ["number.from", get("wall_delta")],
                          ],
                        ],
                      ],
                    ],
                  ],
                ],
                "bool.true",
                ["null.const"],
              ],
              ["var.set", "previous_time", get("current_time")],
              ["var.set", "previous_cpu_time", get("current_cpu_time")],
              ["var.set", "has_previous", "bool.true"],
            ],
            "bool.true",
            ["null.const"],
          ],
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
    const program: ScriptBlock = [
      ["var.let", "map", ["map.new", string("a"), bigintExpr(1)]],
      ["test.capture", ["map.has", get("map"), string("a")]],
      ["map.set", get("map"), string("b"), bigintExpr(2)],
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
    const program: ScriptBlock = [
      ["var.let", "list", ["list.new", bigintExpr(1)]],
      ["list.push", get("list"), bigintExpr(2)],
      ["list.set", get("list"), numberExpr(0), bigintExpr(3)],
      ["test.capture", ["list.length", get("list")]],
      ["test.capture", ["list.get", get("list"), numberExpr(0)]],
      ["test.capture", ["list.get", get("list"), numberExpr(1)]],
      ["test.capture", ["list.get", get("list"), numberExpr(99)]],
    ];

    compile(program, {
      functions: {
        "test.capture": (entry) => {
          seen.push(entry);
          return null;
        },
      },
    })();
    expect(seen).toEqual([2, 3n, 2n, null]);
  });

  it("uses list.push for growth and rejects out-of-range list.set", () => {
    const program: ScriptBlock = [
      ["var.let", "list", "list.new"],
      ["list.set", get("list"), "number.zero", bigintExpr(1)],
    ];

    expect(() => compile(program)()).toThrow(/existing non-negative safe-integer number index/);
  });

  it("compares containers by reference", () => {
    const same: ScriptBlock = [
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
    const expression: SExpr = [
      "list.get",
      ["map.get", ["map.get", "host.source", string("event")], string("values")],
      numberExpr(1),
    ];

    expect(evaluate(expression, { functions: { "host.source": source } })).toBe(20n);
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
      evaluate(["map.get", "host.map", string("answer")], {
        functions: { "host.map": () => map },
      }),
    ).toBe(42n);
    expect(
      evaluate(["map.get", ["list.get", "host.list", numberExpr(2)], string("answer")], {
        functions: { "host.list": () => list },
      }),
    ).toBe(2n);
  });

  it("passes already evaluated logical values to external functions", () => {
    const fn = vi.fn((left: ScriptValue, right: ScriptValue) =>
      typeof left === "bigint" && typeof right === "bigint" ? left + right : null,
    );

    expect(
      evaluate(["host.add", ["bigint.add", bigintExpr(1), bigintExpr(2)], bigintExpr(4)], {
        functions: { "host.add": fn },
      }),
    ).toBe(7n);
    expect(fn).toHaveBeenCalledWith(3n, 4n);
  });

  it("allows diagnostics to be handled by the host", () => {
    const onDiagnostic = vi.fn();

    expect(
      evaluate(["diagnostic.warn", string("counter decreased")], { onDiagnostic }),
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
      compile([["list.push", "host.array", bigintExpr(2)]], { functions })(),
    ).toThrow(/cannot mutate a ListView/);
    expect(() =>
      compile([["map.set", "host.map", string("x"), bigintExpr(2)]], { functions })(),
    ).toThrow(/cannot mutate a MapView/);
    expect(() =>
      compile([["map.set", "host.object", string("x"), bigintExpr(2)]], { functions })(),
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

    expect(evaluate(["map.get", "host.object", string("visible")], { functions })).toBe("yes");
    expect(evaluate(["map.get", "host.object", string("secret")], { functions })).toBeNull();
    expect(evaluate(["map.get", "host.object", string("toString")], { functions })).toBeNull();
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
      evaluate(["map.is", ["map.get", "host.nested", string("x")]], {
        functions: { "host.nested": () => wrapsNested },
      }),
    ).toBe(true);
    expect(() =>
      evaluate(["map.get", "host.leak", string("x")], {
        functions: { "host.leak": () => leaksFunction },
      }),
    ).toThrow(ScriptRuntimeError);
  });

  it("validates view control metadata at the runtime boundary", () => {
    const invalidLength = createListView({ length: -1, get: () => null });
    const invalidHas = createMapView({
      has: (() => "yes") as unknown as () => boolean,
      get: () => null,
    });

    expect(() =>
      evaluate(["list.length", "host.list"], {
        functions: { "host.list": () => invalidLength },
      }),
    ).toThrow(/non-negative safe integer/);
    expect(() =>
      evaluate(["map.has", "host.map", string("key")], {
        functions: { "host.map": () => invalidHas },
      }),
    ).toThrow(/must return a boolean/);
  });

  it("rejects unsupported and non-finite external results", () => {
    expect(() => compile(["host.undefined"], { functions: { "host.undefined": () => undefined } })()).toThrow(
      /unsupported undefined/,
    );
    expect(() => compile(["host.function"], { functions: { "host.function": () => () => null } })()).toThrow(
      /unsupported function/,
    );
    expect(() => compile(["host.nan"], { functions: { "host.nan": () => Number.NaN } })()).toThrow(
      /non-finite/,
    );
  });

  it("dispatches hostile external names by fixed index rather than generated source", () => {
    const name = 'host\"]; globalThis.__scriptIrExternalEscaped = true; //';
    const external = vi.fn(() => 7n);
    const program = compile([name], { functions: { [name]: external } });

    expect(program()).toBeUndefined();
    expect(external).toHaveBeenCalledOnce();
    expect((globalThis as Record<string, unknown>).__scriptIrExternalEscaped).toBeUndefined();
  });
});

describe("validation", () => {
  it("rejects unknown invokes, invalid arity, and value-less operands", () => {
    expect(() => compile(["does.not.exist"])).toThrow(/unknown invoke/);
    expect(() => compile([["bigint.add", bigintExpr(1)]])).toThrow(/expects 2 operands/);
    expect(() => compile([["bigint.add", ["var.let", "x", bigintExpr(1)], bigintExpr(2)]])).toThrow(
      /does not produce a value/,
    );
  });

  it("requires a root block and a block for every control-flow body", () => {
    expect(() => compile("bigint.zero" as unknown as ScriptBlock)).toThrow(/program must be a block/);
    expect(() => compile([["bigint.zero"]])).toThrow(/zero-argument invokes must use their atom form/);
    expect(() => compile([["case", "bool.true", "null.const"]])).toThrow(/body must be a block/);
  });

  it("rejects reserved external names", () => {
    expect(() => compile(["bigint.zero"], { functions: { "bigint.add": () => 1n } })).toThrow(
      /reserved name/,
    );
  });
});
