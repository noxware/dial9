#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { runDemoPrograms } = require("./custom_view_demo.js");

const trace = {
  segmentMetadata: new Map([["process.available_parallelism", "4"]]),
  customEvents: [
    {
      name: "ProcessResourceUsageEvent",
      timestamp: 1_000,
      fields: {
        user_cpu_ns: "100",
        system_cpu_ns: "50",
        voluntary_context_switches: "10",
        involuntary_context_switches: "2",
      },
    },
    {
      name: "UnrelatedEvent",
      timestamp: 1_500,
      fields: { value: "ignored" },
    },
    {
      name: "ProcessResourceUsageEvent",
      timestamp: 2_000,
      fields: {
        user_cpu_ns: "500",
        system_cpu_ns: "150",
        voluntary_context_switches: "18",
        involuntary_context_switches: "3",
      },
    },
  ],
};

const state = runDemoPrograms(trace, { minTs: 1_000, maxTs: 2_000 });
assert.deepStrictEqual(state.diagnostics, []);
assert.strictEqual(state.capacity, 4);
assert.strictEqual(state.outputs.cpu_intervals.length, 1);
assert.strictEqual(state.outputs.context_switch_points.length, 2);
assert.strictEqual(state.outputs.dino_points.length, 23);
assert.strictEqual(state.outputs.dino_flames.length, 6);

const cpu = state.outputs.cpu_intervals[0];
assert.strictEqual(cpu.get("start"), 1_000n);
assert.strictEqual(cpu.get("end"), 2_000n);
assert.strictEqual(cpu.get("cpu_delta"), 500n);
assert.strictEqual(cpu.get("cores"), 0.5);

const context = state.outputs.context_switch_points[1];
assert.strictEqual(context.get("time"), 2_000n);
assert.strictEqual(context.get("voluntary"), 18);
assert.strictEqual(context.get("involuntary"), 3);

const head = state.outputs.dino_points.find((point) => point.get("part") === "head");
const tail = state.outputs.dino_points.find((point) => point.get("part") === "tail");
assert.strictEqual(head.get("tooltip"), "❤️");
assert.strictEqual(tail.get("tooltip"), "💩");
assert.match(state.programs.cpu.source, /function program/);

console.log("custom view demo tests passed");
