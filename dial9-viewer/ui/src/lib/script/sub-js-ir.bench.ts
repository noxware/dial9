// Run with:
//   npx vitest bench --run src/lib/script/sub-js-ir.bench.ts

import { bench, describe } from "vitest";
import {
  compile,
  createListView,
  createMapView,
  scriptValueReader,
  type SExpr,
  type ScriptValue,
} from "./sub-js-ir.js";

const EVENT_COUNT = 100_000;
const RESOURCE_EVENT = "ProcessResourceUsageEvent";

interface Event {
  readonly kind: string;
  readonly time: number;
  readonly user: number;
  readonly system: number;
}

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

const events: Event[] = Array.from({ length: EVENT_COUNT }, (_, index) => {
  if (index % 4 !== 0) {
    return { kind: "UnrelatedEvent", time: index * 1_000, user: 0, system: 0 };
  }
  const sample = index / 4;
  return {
    kind: RESOURCE_EVENT,
    time: index * 1_000,
    user: sample * 140,
    system: sample * 60,
  };
});

const eventViews = events.map((event) =>
  createMapView({
    has: (key) => typeof key === "string" && Object.hasOwn(event, key),
    get: (key) =>
      typeof key === "string" && Object.hasOwn(event, key)
        ? event[key as keyof Event]
        : undefined,
  }),
);

const eventList = createListView({
  length: eventViews.length,
  get: (index) => eventViews[index],
});

let nativeOutput: Interval[] = [];

function nativeProgram(): void {
  const output: Interval[] = [];
  let hasPrevious = false;
  let previousTime = 0;
  let previousCpu = 0;

  for (const event of events) {
    if (event.kind !== RESOURCE_EVENT) continue;
    const currentCpu = event.user + event.system;
    if (hasPrevious) {
      const wallDelta = event.time - previousTime;
      const cpuDelta = currentCpu - previousCpu;
      if (wallDelta > 0 && cpuDelta >= 0) {
        output.push({
          start: previousTime,
          end: event.time,
          value: cpuDelta / wallDelta,
        });
      }
    }
    hasPrevious = true;
    previousTime = event.time;
    previousCpu = currentCpu;
  }

  nativeOutput = output;
}

const get = (name: string): SExpr => ["var.get", name];
const string = (value: string): SExpr => ["string.const", value];
const number = (value: number): SExpr => ["number.const", String(value)];
const field = (name: keyof Event): SExpr => ["map_view.get", get("event"), string(name)];

const scriptOutput: ScriptValue[] = [];
const functions = {
  "dial9.events": () => eventList,
  "dial9.emit": (value: ScriptValue) => {
    scriptOutput.push(value);
  },
  noop: () => undefined,
};

function compileLoop(body: readonly SExpr[]): () => void {
  return compile([["loop.for_each", "event", "index", "dial9.events", body]], { functions });
}

const loopOnly = compileLoop(["noop"]);
const filterOnly = compileLoop([
  ["case", ["op.eq", field("kind"), string(RESOURCE_EVENT)], ["noop"]],
]);
const cpuMathOnly = compileLoop([
  [
    "case",
    ["op.eq", field("kind"), string(RESOURCE_EVENT)],
    [
      ["noop", ["op.add", field("user"), field("system")]],
    ],
  ],
]);
const scalarEmit = compileLoop([
  [
    "case",
    ["op.eq", field("kind"), string(RESOURCE_EVENT)],
    [
      ["dial9.emit", ["op.add", field("user"), field("system")]],
    ],
  ],
]);
const objectEmit = compileLoop([
  [
    "case",
    ["op.eq", field("kind"), string(RESOURCE_EVENT)],
    [
      [
        "dial9.emit",
        [
          "obj.new",
          string("time"),
          field("time"),
          string("cpu"),
          ["op.add", field("user"), field("system")],
        ],
      ],
    ],
  ],
]);

const scriptProgram = compile(
  [
    ["var.let", "has_previous", "bool.false"],
    ["var.let", "previous_time", number(0)],
    ["var.let", "previous_cpu", number(0)],
    [
      "loop.for_each",
      "event",
      "index",
      "dial9.events",
      [
        [
          "case",
          ["op.eq", field("kind"), string(RESOURCE_EVENT)],
          [
            ["var.let", "current_time", field("time")],
            ["var.let", "current_cpu", ["op.add", field("user"), field("system")]],
            [
              "case",
              get("has_previous"),
              [
                [
                  "var.let",
                  "wall_delta",
                  ["op.subtract", get("current_time"), get("previous_time")],
                ],
                [
                  "var.let",
                  "cpu_delta",
                  ["op.subtract", get("current_cpu"), get("previous_cpu")],
                ],
                [
                  "case",
                  [
                    "op.and",
                    ["op.gt", get("wall_delta"), number(0)],
                    ["op.gte", get("cpu_delta"), number(0)],
                  ],
                  [
                    [
                      "dial9.emit",
                      [
                        "obj.new",
                        string("start"),
                        get("previous_time"),
                        string("end"),
                        get("current_time"),
                        string("value"),
                        ["op.divide", get("cpu_delta"), get("wall_delta")],
                      ],
                    ],
                  ],
                ],
              ],
            ],
            ["var.set", "has_previous", "bool.true"],
            ["var.set", "previous_time", get("current_time")],
            ["var.set", "previous_cpu", get("current_cpu")],
          ],
        ],
      ],
    ],
  ],
  { functions },
);

function runScript(): void {
  scriptOutput.length = 0;
  scriptProgram();
}

nativeProgram();
runScript();
if (nativeOutput.length !== 24_999 || scriptOutput.length !== nativeOutput.length) {
  throw new Error("CPU benchmark produced invalid output");
}
const firstScriptInterval = scriptOutput[0];
const firstNativeInterval = nativeOutput[0]!;
if (
  !scriptValueReader.isObject(firstScriptInterval) ||
  scriptValueReader.objectGet(firstScriptInterval, "start") !== firstNativeInterval.start ||
  scriptValueReader.objectGet(firstScriptInterval, "end") !== firstNativeInterval.end ||
  scriptValueReader.objectGet(firstScriptInterval, "value") !== firstNativeInterval.value
) {
  throw new Error("CPU benchmark produced incorrect interval values");
}

describe("derive 24,999 CPU intervals from 100,000 events", () => {
  bench("JavaScript", nativeProgram);
  bench("Sub-JS loop only", loopOnly);
  bench("Sub-JS filter only", filterOnly);
  bench("Sub-JS CPU math only", cpuMathOnly);
  bench("Sub-JS scalar emit", () => {
    scriptOutput.length = 0;
    scalarEmit();
  });
  bench("Sub-JS object emit", () => {
    scriptOutput.length = 0;
    objectEmit();
  });
  bench("Sub-JS IR (precompiled)", runScript);
});
