// Script IR execution overhead against equivalent native JavaScript.
//
// Run with:
//   npx vitest bench --run src/lib/script/ir.bench.ts
//
// Program construction and Script IR compilation happen at module load, outside
// the measured functions. Every measured execution allocates both the source
// list and the doubled result list.

import { bench, describe } from "vitest";
import { buildProcessCpuUsageSeries } from "../trace/analysis.js";
import {
  compile,
  createListView,
  createMapView,
  type MapView,
  type SExpr,
  type ScriptValue,
} from "./ir.js";

const ELEMENT_COUNT = 4_096;
const DOUBLE = ["number.const", "2"] as const;

let consumed: ScriptValue[] | null = null;

function consume(value: ScriptValue): null {
  if (!Array.isArray(value)) throw new TypeError("benchmark result must be a list");
  consumed = value;
  return null;
}

function nativeProgram(transform: string): () => void {
  const literal = Array.from({ length: ELEMENT_COUNT }, (_, index) => index).join(",");
  const factory = new Function(
    "consume",
    `"use strict";
return function benchmarkProgram() {
  const source = [${literal}];
  ${transform}
  consume(doubled);
};`,
  ) as (consumer: typeof consume) => () => void;
  return factory(consume);
}

const nativeFor = nativeProgram(`
  const doubled = [];
  for (let index = 0; index < source.length; index++) {
    doubled.push(source[index] * 2);
  }
`);

const nativeMap = nativeProgram("const doubled = source.map((value) => value * 2);");

const sourceValues: SExpr[] = Array.from(
  { length: ELEMENT_COUNT },
  (_, index) => ["number.const", String(index)],
);

const scriptProgram = compile(
  [
    ["var.let", "source", ["list.new", ...sourceValues]],
    ["var.let", "doubled", "list.new"],
    [
      "list.for_each",
      "element",
      "index",
      ["var.get", "source"],
      [
        [
          "list.push",
          ["var.get", "doubled"],
          ["number.multiply", ["var.get", "element"], DOUBLE],
        ],
      ],
    ],
    ["benchmark.consume", ["var.get", "doubled"]],
  ],
  { functions: { "benchmark.consume": consume } },
);

function verify(name: string, program: () => void): void {
  consumed = null;
  program();
  const result = consumed;
  if (
    result === null ||
    result.length !== ELEMENT_COUNT ||
    result[0] !== 0 ||
    result[ELEMENT_COUNT / 2] !== ELEMENT_COUNT ||
    result[ELEMENT_COUNT - 1] !== (ELEMENT_COUNT - 1) * 2
  ) {
    throw new Error(`${name} produced an invalid result`);
  }
}

verify("JavaScript for + push", nativeFor);
verify("JavaScript Array.map", nativeMap);
verify("Script IR", scriptProgram);

describe(`double a freshly-created ${ELEMENT_COUNT}-element list`, () => {
  bench("JavaScript for + push", nativeFor);
  bench("JavaScript Array.map", nativeMap);
  bench("Script IR (precompiled)", scriptProgram);
});

// A trace-like CPU derivation: the input already exists, as it does after the
// binary decoder finishes. One in four events is relevant, yielding 24,999
// materialized intervals per run. The Script IR sees only virtual views and
// emits script-owned maps through registered Dial9 capabilities.

const EVENT_COUNT = 100_000;
const RESOURCE_EVENT = "ProcessResourceUsageEvent";

interface CpuBenchmarkEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly fields: Readonly<Record<string, number>>;
  readonly units: null;
}

interface NativeCpuInterval {
  readonly start: number;
  readonly end: number;
  readonly wallDeltaNs: number;
  readonly cpuDeltaNs: number;
  readonly cores: number;
}

const cpuEvents: CpuBenchmarkEvent[] = Array.from({ length: EVENT_COUNT }, (_, index) => {
  if (index % 4 !== 0) {
    return { name: "UnrelatedEvent", timestamp: index * 1_000, fields: { noise: index }, units: null };
  }
  const sample = index / 4;
  return {
    name: RESOURCE_EVENT,
    timestamp: index * 1_000,
    fields: {
      user_cpu_ns: sample * 140,
      system_cpu_ns: sample * 60,
    },
    units: null,
  };
});

const cpuEventViews = cpuEvents.map((event) =>
  createMapView({
    has(key) {
      return (
        key === "kind" ||
        key === "time" ||
        key === "user_cpu_ns" ||
        key === "system_cpu_ns"
      );
    },
    get(key) {
      if (key === "kind") return event.name;
      if (key === "time") return event.timestamp;
      if (key === "user_cpu_ns") return event.fields.user_cpu_ns;
      if (key === "system_cpu_ns") return event.fields.system_cpu_ns;
      return null;
    },
  }),
);

const cpuEventList = createListView({
  length: cpuEventViews.length,
  get(index) {
    return cpuEventViews[index];
  },
});

let nativeCpuIntervals: NativeCpuInterval[] = [];

function nativeCpuProgram(): void {
  const intervals: NativeCpuInterval[] = [];
  let previousTime: number | null = null;
  let previousCpuTime: number | null = null;

  for (const event of cpuEvents) {
    if (event.name !== RESOURCE_EVENT) continue;
    const currentTime = event.timestamp;
    const currentCpuTime = event.fields.user_cpu_ns! + event.fields.system_cpu_ns!;
    if (previousTime !== null && previousCpuTime !== null) {
      const wallDeltaNs = currentTime - previousTime;
      const cpuDeltaNs = currentCpuTime - previousCpuTime;
      if (wallDeltaNs > 0 && cpuDeltaNs >= 0) {
        intervals.push({
          start: previousTime,
          end: currentTime,
          wallDeltaNs,
          cpuDeltaNs,
          cores: cpuDeltaNs / wallDeltaNs,
        });
      }
    }
    previousTime = currentTime;
    previousCpuTime = currentCpuTime;
  }

  nativeCpuIntervals = intervals;
}

let nativeViewCpuIntervals: NativeCpuInterval[] = [];

function nativeViewCpuProgram(): void {
  const intervals: NativeCpuInterval[] = [];
  let previousTime: number | null = null;
  let previousCpuTime: number | null = null;

  for (let index = 0; index < cpuEventList.length; index++) {
    const event = cpuEventList.get(index) as MapView;
    if (event.get("kind") !== RESOURCE_EVENT) continue;
    const currentTime = event.get("time") as number;
    const currentCpuTime =
      (event.get("user_cpu_ns") as number) + (event.get("system_cpu_ns") as number);
    if (previousTime !== null && previousCpuTime !== null) {
      const wallDeltaNs = currentTime - previousTime;
      const cpuDeltaNs = currentCpuTime - previousCpuTime;
      if (wallDeltaNs > 0 && cpuDeltaNs >= 0) {
        intervals.push({
          start: previousTime,
          end: currentTime,
          wallDeltaNs,
          cpuDeltaNs,
          cores: cpuDeltaNs / wallDeltaNs,
        });
      }
    }
    previousTime = currentTime;
    previousCpuTime = currentCpuTime;
  }

  nativeViewCpuIntervals = intervals;
}

let currentViewerCpuResult: ReturnType<typeof buildProcessCpuUsageSeries> | null = null;

function currentViewerCpuProgram(): void {
  currentViewerCpuResult = buildProcessCpuUsageSeries(cpuEvents, null);
}

const get = (name: string): SExpr => ["var.get", name];
const string = (value: string): SExpr => ["string.const", value];
const field = (name: string): SExpr => ["map.get", get("event"), string(name)];
const cores = (): SExpr => ["number.divide", get("cpu_delta"), get("wall_delta")];
const intervalMap = (): SExpr => [
  "map.new",
  string("start"),
  get("previous_time"),
  string("end"),
  get("current_time"),
  string("wallDeltaNs"),
  get("wall_delta"),
  string("cpuDeltaNs"),
  get("cpu_delta"),
  string("cores"),
  cores(),
];

function cpuDerivationProgram(
  validIntervalBody: readonly SExpr[],
  before: readonly SExpr[] = [],
  after: readonly SExpr[] = [],
): SExpr[] {
  return [
    ...before,
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
          ["cmp.eq", field("kind"), string(RESOURCE_EVENT)],
          [
            ["var.let", "current_time", field("time")],
            [
              "var.let",
              "current_cpu_time",
              ["number.add", field("user_cpu_ns"), field("system_cpu_ns")],
            ],
            [
              "case",
              get("has_previous"),
              [
                [
                  "var.let",
                  "wall_delta",
                  ["number.subtract", get("current_time"), get("previous_time")],
                ],
                [
                  "var.let",
                  "cpu_delta",
                  ["number.subtract", get("current_cpu_time"), get("previous_cpu_time")],
                ],
                [
                  "case",
                  [
                    "bool.and",
                    ["cmp.gt", get("wall_delta"), "number.zero"],
                    ["cmp.gte", get("cpu_delta"), "number.zero"],
                  ],
                  validIntervalBody,
                  "bool.true",
                  ["null.const"],
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
    ...after,
  ];
}

const dial9Events = { "dial9.events": () => cpuEventList };

let probeValue: ScriptValue = null;
const consumeProbe = (value: ScriptValue): null => {
  probeValue = value;
  return null;
};

const filterOnlyProgram = compile(
  [
    ["var.let", "matched", "number.zero"],
    [
      "list.for_each",
      "event",
      "index",
      "dial9.events",
      [
        [
          "case",
          ["cmp.eq", field("kind"), string(RESOURCE_EVENT)],
          [
            [
              "var.set",
              "matched",
              ["number.add", get("matched"), ["number.const", "1"]],
            ],
          ],
          "bool.true",
          ["null.const"],
        ],
      ],
    ],
    ["benchmark.consume", get("matched")],
  ],
  { functions: { ...dial9Events, "benchmark.consume": consumeProbe } },
);

const computeOnlyProgram = compile(
  cpuDerivationProgram(
    [["var.set", "checksum", ["number.add", get("checksum"), cores()]]],
    [["var.let", "checksum", "number.zero"]],
    [["benchmark.consume", get("checksum")]],
  ),
  { functions: { ...dial9Events, "benchmark.consume": consumeProbe } },
);

let scalarCpuIntervals: ScriptValue[] = [];
const emitScalarProgram = compile(
  cpuDerivationProgram([["dial9.output.emit", "cpu_values", cores()]]),
  {
    functions: {
      ...dial9Events,
      cpu_values: () => "cpu_values",
      "dial9.output.emit": (output, value) => {
        if (output !== "cpu_values") throw new TypeError("invalid scalar output");
        scalarCpuIntervals.push(value);
        return null;
      },
    },
  },
);

function runEmitScalarProgram(): void {
  scalarCpuIntervals = [];
  emitScalarProgram();
}

const collectScalarsProgram = compile(
  cpuDerivationProgram(
    [["list.push", get("collected"), cores()]],
    [["var.let", "collected", "list.new"]],
    [["benchmark.consume", get("collected")]],
  ),
  { functions: { ...dial9Events, "benchmark.consume": consumeProbe } },
);

const collectMapsProgram = compile(
  cpuDerivationProgram(
    [["list.push", get("collected"), intervalMap()]],
    [["var.let", "collected", "list.new"]],
    [["benchmark.consume", get("collected")]],
  ),
  { functions: { ...dial9Events, "benchmark.consume": consumeProbe } },
);

let scriptCpuIntervals: Map<ScriptValue, ScriptValue>[] = [];

const scriptCpuProgram = compile(
  cpuDerivationProgram([["dial9.output.emit", "cpu_intervals", intervalMap()]]),
  {
    functions: {
      ...dial9Events,
      cpu_intervals: () => "cpu_intervals",
      "dial9.output.emit": (output, interval) => {
        if (output !== "cpu_intervals" || !(interval instanceof Map)) {
          throw new TypeError("invalid CPU benchmark emission");
        }
        scriptCpuIntervals.push(interval);
        return null;
      },
    },
  },
);

function runScriptCpuProgram(): void {
  scriptCpuIntervals = [];
  scriptCpuProgram();
}

nativeCpuProgram();
nativeViewCpuProgram();
currentViewerCpuProgram();
filterOnlyProgram();
const filterCount = probeValue;
computeOnlyProgram();
const computeChecksum = probeValue;
runEmitScalarProgram();
collectScalarsProgram();
const collectedScalars = probeValue;
collectMapsProgram();
const collectedMaps = probeValue;
runScriptCpuProgram();

const expectedIntervals = EVENT_COUNT / 4 - 1;
if (
  nativeCpuIntervals.length !== expectedIntervals ||
  nativeViewCpuIntervals.length !== expectedIntervals ||
  currentViewerCpuResult?.intervals.length !== expectedIntervals ||
  filterCount !== EVENT_COUNT / 4 ||
  typeof computeChecksum !== "number" ||
  Math.abs(computeChecksum - expectedIntervals * 0.05) > 1e-9 ||
  scalarCpuIntervals.length !== expectedIntervals ||
  scalarCpuIntervals.at(-1) !== 0.05 ||
  !Array.isArray(collectedScalars) ||
  collectedScalars.length !== expectedIntervals ||
  collectedScalars.at(-1) !== 0.05 ||
  !Array.isArray(collectedMaps) ||
  collectedMaps.length !== expectedIntervals ||
  !(collectedMaps.at(-1) instanceof Map) ||
  scriptCpuIntervals.length !== expectedIntervals ||
  scriptCpuIntervals.at(-1)?.get("cores") !== 0.05
) {
  throw new Error("CPU benchmark programs produced different results");
}

describe(`CPU bottlenecks over ${EVENT_COUNT.toLocaleString()} mixed events`, () => {
  const options = { time: 1_000 };
  bench("01 JS direct objects + object outputs", nativeCpuProgram, options);
  bench("02 JS direct views + object outputs", nativeViewCpuProgram, options);
  bench("03 current viewer CPU implementation", currentViewerCpuProgram, options);
  bench("04 IR views + filter only", filterOnlyProgram, options);
  bench("05 IR views + CPU math, no outputs", computeOnlyProgram, options);
  bench("06 IR CPU math + scalars collected once", collectScalarsProgram, options);
  bench("07 IR CPU math + scalar emit", runEmitScalarProgram, options);
  bench("08 IR CPU math + maps collected once", collectMapsProgram, options);
  bench("09 IR CPU math + map emit", runScriptCpuProgram, options);
});
