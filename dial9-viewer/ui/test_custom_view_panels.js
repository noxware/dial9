"use strict";

const { assert, test, summarize } = require("./test_harness.js");
const {
  formatValue,
  scalesFor,
  renderPanel,
  findHit,
  tooltipRows,
} = require("./custom_view_panels.js");

function fakeContext() {
  const calls = [];
  const ctx = { calls };
  for (const name of [
    "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "fill",
    "closePath", "setLineDash", "fillText",
  ]) {
    ctx[name] = (...args) => calls.push([name, ...args]);
  }
  return ctx;
}

function bundle(outputs) {
  return { rows: (name) => outputs[name] || [] };
}

function geometry() {
  return { canvasWidth: 500, canvasHeight: 100, left: 100, top: 8, width: 400, height: 82 };
}

test("presenter formats preserve exact integers and viewer units", () => {
  assert.strictEqual(formatValue(9007199254740993n, "integer"), "9007199254740993");
  assert.strictEqual(formatValue(1_500_000n, "duration"), "1.50ms");
  assert.strictEqual(formatValue(1.25, "cores"), "1.25 cores");
  assert.strictEqual(formatValue(12.5, "rate"), "12.50/s");
});

test("time scales align their draw range after the label gutter", () => {
  const panel = { x: { type: "time" }, y: { domain: [0, 10] }, layers: [] };
  const scales = scalesFor(panel, bundle({}), { start: 100, end: 200 }, geometry());
  assert.strictEqual(scales.x(100), 100);
  assert.strictEqual(scales.x(150), 300);
  assert.strictEqual(scales.x(200), 500);
});

test("automatic y domains include every stacked layer", () => {
  const panel = {
    x: { type: "time" }, y: { includeZero: true },
    layers: [
      { renderer: "line", data: "a", channels: { x: "x", y: "y" } },
      { renderer: "line", data: "b", channels: { x: "x", y: "y" } },
    ],
  };
  const source = bundle({
    a: [new Map([["x", 1n], ["y", 3]])],
    b: [new Map([["x", 1n], ["y", 8]])],
  });
  assert.deepStrictEqual(scalesFor(panel, source, { start: 0, end: 2 }, geometry()).yDomain, [0, 8]);
});

test("interval layers draw directly and retain only interactive hits", () => {
  const panel = {
    x: { type: "time" }, y: { includeZero: true },
    layers: [{
      renderer: "interval-area", data: "series",
      channels: { start: "start", end: "end", y: "value" },
      style: { color: "green", fillAlpha: 0.2 },
      tooltip: [{ label: "Value", field: "value" }],
    }],
  };
  const source = bundle({ series: [
    new Map([["start", 0n], ["end", 10n], ["value", 2]]),
    new Map([["start", 20n], ["end", 30n], ["value", 4]]),
  ] });
  const ctx = fakeContext();
  const result = renderPanel(ctx, panel, source, { start: 0, end: 15 }, geometry());
  assert.strictEqual(result.hits.length, 1, "off-screen interval should not produce a hit");
  assert.strictEqual(ctx.calls.filter(([name]) => name === "fillRect").length, 2, "background + one interval");
});

test("stacked series retain independent tooltip mappings", () => {
  const row = new Map([["x", 5n], ["low", 2], ["high", 8]]);
  const panel = {
    x: { type: "time" }, y: { domain: [0, 10] },
    layers: [
      {
        renderer: "line", data: "series", channels: { x: "x", y: "low" },
        style: { color: "green" }, tooltip: [{ label: "Low", field: "low" }],
      },
      {
        renderer: "line", data: "series", channels: { x: "x", y: "high" },
        style: { color: "orange" }, tooltip: [{ label: "High", field: "high" }],
      },
    ],
  };
  const result = renderPanel(fakeContext(), panel, bundle({ series: [row] }), { start: 0, end: 10 }, geometry());
  assert.strictEqual(result.hits.length, 2);
  const highY = result.scales.y(8);
  const hit = findHit(result.hits, result.scales.x(5), highY);
  assert.deepStrictEqual(tooltipRows(hit), [{ label: "High", value: "8" }]);
});

test("step and text renderers compose without dinosaur-specific behavior", () => {
  const points = [
    new Map([["x", 0], ["y", 1], ["tooltip", "💩"]]),
    new Map([["x", 1], ["y", 2], ["tooltip", ""]]),
  ];
  const labels = [new Map([["x", 2], ["y", 2], ["text", "🔥"], ["tooltip", "hot"]])];
  const panel = {
    x: { type: "linear", domain: [0, 3] }, y: { domain: [0, 3] },
    layers: [
      {
        renderer: "step-line", data: "points", channels: { x: "x", y: "y" },
        style: { color: "green" }, tooltip: [{ label: "", field: "tooltip", omitEmpty: true }],
      },
      {
        renderer: "text", data: "labels", channels: { x: "x", y: "y", text: "text" },
        style: { font: "12px sans-serif" }, tooltip: [{ label: "", field: "tooltip" }],
      },
    ],
  };
  const result = renderPanel(fakeContext(), panel, bundle({ points, labels }), { start: 0, end: 0 }, geometry());
  assert.strictEqual(result.hits.length, 3);
  assert.deepStrictEqual(tooltipRows(result.hits[0]), [{ label: "", value: "💩" }]);
  assert.deepStrictEqual(tooltipRows(result.hits[1]), []);
  assert.deepStrictEqual(tooltipRows(result.hits[2]), [{ label: "", value: "hot" }]);
});

summarize();
