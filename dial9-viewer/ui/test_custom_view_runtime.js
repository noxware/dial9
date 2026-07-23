"use strict";

const { assert, test, summarize } = require("./test_harness.js");
const { ListView, MapView } = require("./script_engine.js");
const {
  compileBundle,
  eventView,
  traceEnvironment,
  resourceBundle,
  dinoBundle,
} = require("./custom_view_runtime.js");

function usage(timestamp, fields) {
  return {
    name: "ProcessResourceUsageEvent",
    timestamp,
    fields: {
      user_cpu_ns: 0,
      system_cpu_ns: 0,
      voluntary_context_switches: 0,
      involuntary_context_switches: 0,
      ...fields,
    },
  };
}

function trace(events, metadata) {
  return {
    customEvents: events,
    segmentMetadata: new Map(Object.entries(metadata || {})),
  };
}

function row(rows, index = 0) {
  assert.ok(rows[index] instanceof Map);
  return Object.fromEntries(rows[index]);
}

function compiledResource(viewport) {
  return compileBundle(resourceBundle(), {
    viewport: () => viewport.value,
  });
}

test("event views expose a normalized logical Map without copying fields", () => {
  const original = usage(123, { user_cpu_ns: "9007199254740993" });
  const view = eventView(original);
  assert.ok(view instanceof MapView);
  assert.strictEqual(view.get("kind"), "ProcessResourceUsageEvent");
  assert.strictEqual(view.get("time"), 123n);
  assert.strictEqual(view.get("user_cpu_ns"), 9007199254740993n);
  original.fields.user_cpu_ns = "9007199254740995";
  assert.strictEqual(view.get("user_cpu_ns"), 9007199254740995n);
});

test("the Dial9 adapter builds one shareable logical environment", () => {
  const environment = traceEnvironment(trace([
    { name: "Later", timestamp: 2, fields: {} },
    { name: "Earlier", timestamp: 1, fields: {} },
  ], { service: "demo" }));
  assert.ok(environment.events instanceof ListView);
  assert.ok(environment.metadata instanceof MapView);
  assert.strictEqual(environment.events.get(0).get("kind"), "Earlier");
  assert.strictEqual(environment.metadata.get("service"), "demo");
});

test("one ordered event stream supports multiple kinds and look-behind/look-ahead", () => {
  const s = (value) => ["string.const", value];
  const get = (name) => ["var.get", name];
  const set = (name, value) => ["var.set", name, value];
  const field = (event, name) => ["map.get", event, s(name)];
  const emitPair = (direction, neighbor) => [
    "dial9.output.emit", "pairs",
    ["map.new",
      s("direction"), s(direction),
      s("duration"), ["integer.subtract", field(get("event"), "time"), field(neighbor, "time")],
    ],
  ];
  const bundle = compileBundle({
    id: "event-navigation",
    outputs: { pairs: {} },
    computed_values: {},
    script: [
      set("events", "dial9.events"),
      [
        "for_each", "event", "index", get("events"),
        [
          [
            "case",
            ["cmp.eq", field(get("event"), "kind"), s("SpanStart")],
            [
              set("next_index", ["integer.add", get("index"), ["integer.const", "1"]]),
              [
                "case", ["cmp.lt", get("next_index"), ["list.length", get("events")]],
                [
                  set("neighbor", ["list.get", get("events"), get("next_index")]),
                  [
                    "case", ["cmp.eq", field(get("neighbor"), "kind"), s("SpanEnd")],
                    [
                      "dial9.output.emit", "pairs",
                      ["map.new",
                        s("direction"), s("forward"),
                        s("duration"), ["integer.subtract", field(get("neighbor"), "time"), field(get("event"), "time")],
                      ],
                    ],
                    "bool.true", "null",
                  ],
                ],
                "bool.true", "null",
              ],
            ],
            "bool.true", "null",
          ],
          [
            "case",
            ["cmp.eq", field(get("event"), "kind"), s("SpanEnd")],
            [
              set("previous_index", ["integer.subtract", get("index"), ["integer.const", "1"]]),
              set("neighbor", ["list.get", get("events"), get("previous_index")]),
              [
                "case", ["cmp.eq", field(get("neighbor"), "kind"), s("SpanStart")],
                emitPair("backward", get("neighbor")),
                "bool.true", "null",
              ],
            ],
            "bool.true", "null",
          ],
        ],
      ],
    ],
    panels: [],
  });
  bundle.loadTrace(trace([
    { name: "SpanEnd", timestamp: 20, fields: { span_id: "a" } },
    { name: "UnrelatedEvent", timestamp: 5, fields: {} },
    { name: "SpanStart", timestamp: 10, fields: { span_id: "a" } },
  ]));
  assert.deepStrictEqual(bundle.rows("pairs").map((value) => Object.fromEntries(value)), [
    { direction: "forward", duration: 10n },
    { direction: "backward", duration: 10n },
  ]);
});

test("resource program computes exact CPU and context-switch intervals", () => {
  const viewport = { value: { start: 0, end: 2_000_000_000 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(0, { user_cpu_ns: 0, system_cpu_ns: 0 }),
    usage(1_000_000_000, {
      user_cpu_ns: 500_000_000,
      system_cpu_ns: 100_000_000,
      voluntary_context_switches: 10,
      involuntary_context_switches: 2,
    }),
  ], { "process.available_parallelism": "4" }));

  assert.deepStrictEqual(row(bundle.rows("cpu_intervals")), {
    start: 0n,
    end: 1_000_000_000n,
    wall_delta: 1_000_000_000n,
    cpu_delta: 600_000_000n,
    cores: 0.6,
    utilization: 0.15,
    color: "#4fc3f7",
  });
  assert.deepStrictEqual(row(bundle.rows("context_intervals")), {
    start: 0n,
    end: 1_000_000_000n,
    voluntary_delta: 10n,
    involuntary_delta: 2n,
    voluntary_rate: 10,
    involuntary_rate: 2,
  });
  assert.deepStrictEqual(row(bundle.rows("cpu_guides")), {
    value: 4,
    label: "available parallelism",
    legend: "4 core capacity",
    color: "#ffcf99",
  });
});

test("event ordering is deterministic even when the source is out of order", () => {
  const viewport = { value: { start: 0, end: 3 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(2, { user_cpu_ns: 2, system_cpu_ns: 2, voluntary_context_switches: 2, involuntary_context_switches: 2 }),
    usage(0, {}),
    usage(1, { user_cpu_ns: 1, system_cpu_ns: 1, voluntary_context_switches: 1, involuntary_context_switches: 1 }),
  ]));
  assert.deepStrictEqual(bundle.rows("cpu_intervals").map((entry) => entry.get("start")), [0n, 1n]);
});

test("CPU resets create a CPU gap without dropping valid context data", () => {
  const viewport = { value: { start: 0, end: 3 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(0, { user_cpu_ns: 10, system_cpu_ns: 10, voluntary_context_switches: 0, involuntary_context_switches: 0 }),
    usage(1, { user_cpu_ns: 5, system_cpu_ns: 11, voluntary_context_switches: 2, involuntary_context_switches: 1 }),
  ]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 0);
  assert.strictEqual(bundle.rows("context_intervals").length, 1);
  assert.match(bundle.diagnostics[0].message, /CPU counter decreased/);
});

test("context resets create a context gap without dropping valid CPU data", () => {
  const viewport = { value: { start: 0, end: 3 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(0, { user_cpu_ns: 1, system_cpu_ns: 1, voluntary_context_switches: 10, involuntary_context_switches: 10 }),
    usage(1, { user_cpu_ns: 2, system_cpu_ns: 2, voluntary_context_switches: 5, involuntary_context_switches: 11 }),
  ]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 1);
  assert.strictEqual(bundle.rows("context_intervals").length, 0);
  assert.match(bundle.diagnostics[0].message, /context switch counter decreased/);
});

test("duplicate timestamps produce deterministic gaps and diagnostics", () => {
  const viewport = { value: { start: 0, end: 3 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(1, {}),
    usage(1, { user_cpu_ns: 1, system_cpu_ns: 1, voluntary_context_switches: 1, involuntary_context_switches: 1 }),
  ]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 0);
  assert.strictEqual(bundle.rows("context_intervals").length, 0);
  assert.strictEqual(bundle.diagnostics.length, 2);
});

test("visible CPU summary clips interval overlap to the viewport", () => {
  const viewport = { value: { start: 5, end: 15 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(0, {}),
    usage(10, { user_cpu_ns: 10, voluntary_context_switches: 1 }),
    usage(30, { user_cpu_ns: 70, voluntary_context_switches: 2 }),
  ]));
  bundle.runDynamic("cpu-visible-summary");
  assert.deepStrictEqual(row(bundle.rows("cpu_summary")), { avg: 2, max: 3, avg_utilization: null });

  viewport.value = { start: 0, end: 10 };
  bundle.runDynamic("cpu-visible-summary");
  assert.deepStrictEqual(row(bundle.rows("cpu_summary")), { avg: 1, max: 1, avg_utilization: null });
});

test("CPU expressions drive threshold color, legend text, and visible utilization", () => {
  const viewport = { value: { start: 0, end: 10 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([
    usage(0, {}),
    usage(10, { user_cpu_ns: 30 }),
  ], { "process.available_parallelism": "2" }));
  bundle.runDynamic("cpu-visible-summary");
  assert.deepStrictEqual(row(bundle.rows("cpu_intervals")), {
    start: 0n, end: 10n, wall_delta: 10n, cpu_delta: 30n,
    cores: 3, utilization: 1, color: "#ef5350",
  });
  assert.deepStrictEqual(row(bundle.rows("cpu_guides")), {
    value: 2, label: "available parallelism", legend: "2 core capacity", color: "#ffcf99",
  });
  assert.deepStrictEqual(row(bundle.rows("cpu_summary")), { avg: 3, max: 3, avg_utilization: 1 });
});

test("loading another trace clears every materialized output", () => {
  const viewport = { value: { start: 0, end: 10 } };
  const bundle = compiledResource(viewport);
  bundle.loadTrace(trace([usage(0, {}), usage(1, { user_cpu_ns: 1 })]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 1);
  bundle.loadTrace(trace([]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 0);
  assert.strictEqual(bundle.rows("context_intervals").length, 0);
});

test("a runtime error disables only that bundle and clears partial outputs", () => {
  const viewport = { value: { start: 0, end: 10 } };
  const bundle = compiledResource(viewport);
  const loaded = bundle.loadTrace(trace([
    usage(0, {}),
    usage(1, { user_cpu_ns: 1 }),
    usage(2, { user_cpu_ns: "not-an-integer" }),
  ]));
  assert.strictEqual(loaded, false);
  assert.strictEqual(bundle.rows("cpu_intervals").length, 0, "partial output must not render");
  assert.strictEqual(bundle.rows("context_intervals").length, 0);
  assert.deepStrictEqual(bundle.diagnostics.map(({ severity }) => severity), ["error"]);
  assert.match(bundle.diagnostics[0].message, /not an exact integer/);

  const dino = compileBundle(dinoBundle());
  assert.strictEqual(dino.loadTrace(trace([])), true);
  assert.ok(dino.rows("dino_points").length > 0, "an unrelated bundle still runs");
});

test("a failing dynamic program is cleared and diagnosed only once", () => {
  const bundle = compileBundle({
    id: "bad-dynamic",
    outputs: { summary: {} },
    computed_values: {},
    script: "null",
    dynamic: [{
      id: "summary",
      outputs: ["summary"],
      script: [
        "dial9.output.emit", "summary",
        ["map.get", "dial9.viewport", ["string.const", "start"]],
      ],
    }],
    panels: [],
  }, { viewport: () => ({ start: 1.5, end: 2 }) });
  assert.strictEqual(bundle.loadTrace(trace([])), true);
  assert.strictEqual(bundle.runDynamic("summary"), false);
  assert.strictEqual(bundle.rows("summary").length, 0);
  assert.strictEqual(bundle.diagnostics.length, 1);
  assert.strictEqual(bundle.runDynamic("summary"), false);
  assert.strictEqual(bundle.diagnostics.length, 1);
});

test("older resource events without context counters still produce CPU", () => {
  const viewport = { value: { start: 0, end: 10 } };
  const bundle = compiledResource(viewport);
  const old = (timestamp, user) => ({
    name: "ProcessResourceUsageEvent",
    timestamp,
    fields: { user_cpu_ns: user, system_cpu_ns: 0 },
  });
  bundle.loadTrace(trace([old(0, 0), old(1, 1)]));
  assert.strictEqual(bundle.rows("cpu_intervals").length, 1);
  assert.strictEqual(bundle.rows("context_intervals").length, 0);
  assert.strictEqual(bundle.diagnostics.length, 0);
});

test("resource panels reuse one data output with independent renderers", () => {
  const definition = resourceBundle();
  const panels = definition.panels;
  const steps = panels.find((panel) => panel.id === "context-switch-steps");
  const spikes = panels.find((panel) => panel.id === "context-switch-spikes");
  assert.deepStrictEqual(steps.layers.map((layer) => layer.renderer), ["interval-area", "interval-line"]);
  assert.deepStrictEqual(spikes.layers.map((layer) => layer.renderer), ["line", "line"]);
  assert.ok([...steps.layers, ...spikes.layers].every((layer) => layer.data === "context_intervals"));
  assert.notStrictEqual(steps.layers[0].tooltip[0].field, steps.layers[1].tooltip[0].field);
  assert.strictEqual(definition.computed_values.cpu_time.unit, "ns");
  assert.strictEqual(definition.outputs.cpu_intervals.units.cores, "cores");
  assert.strictEqual(definition.outputs.context_intervals.units.voluntary_rate, "switches/s");
});

test("dinosaur is ordinary emitted geometry with semantic hit fields", () => {
  const bundle = compileBundle(dinoBundle());
  bundle.loadTrace(trace([]));
  const points = bundle.rows("dino_points").map((entry) => Object.fromEntries(entry));
  assert.ok(points.length > 20);
  assert.ok(points.some((point) => point.part === "tail" && point.tooltip === "💩"));
  assert.ok(points.some((point) => point.part === "head" && point.tooltip === "❤️"));
  assert.ok(new Set(points.map((point) => point.x)).size < points.length, "expected repeated x coordinates");
  assert.strictEqual(row(bundle.rows("dino_labels")).text, "🔥🔥🔥");

  const tail = bundle.rows("dino_points").find((point) => point.get("tooltip") === "💩");
  bundle.setPointer(new Map([["datum", tail]]));
  assert.strictEqual(bundle.runDynamic("dino-hover"), true);
  assert.deepStrictEqual(row(bundle.rows("dino_hover")), { text: "💩" });
  bundle.setPointer(null);
  bundle.runDynamic("dino-hover");
  assert.deepStrictEqual(row(bundle.rows("dino_hover")), { text: "" });
});

summarize();
