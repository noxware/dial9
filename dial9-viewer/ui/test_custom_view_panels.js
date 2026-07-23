"use strict";

const { assert, test, summarize } = require("./test_harness.js");
const {
  formatValue,
  scalesFor,
  renderPanel,
  findHit,
  legendEntries,
  tooltipRows,
  createPanelElement,
  compileBundles,
  renderers,
} = require("./custom_view_panels.js");

function fakeContext() {
  const calls = [];
  const ctx = { calls };
  for (const name of [
    "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "fill",
    "closePath", "setLineDash", "fillText", "arc",
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

function fakeDocument() {
  return {
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    createElement(tagName) {
      return {
        tagName,
        children: [],
        dataset: {},
        style: {},
        className: "",
        attributes: {},
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; },
      };
    },
  };
}

test("panel DOM is derived entirely from bundle and panel specs", () => {
  const bundleDefinition = { id: "example-bundle" };
  const spec = { id: "odd-panel", title: "An Unforeseen View", height: 137 };
  const { element, label, legend, summary, canvas } = createPanelElement(fakeDocument(), bundleDefinition, spec);
  assert.strictEqual(element.dataset.panelKey, "custom-view:example-bundle:odd-panel");
  assert.strictEqual(element.style.height, "137px");
  assert.strictEqual(label.children[0].textContent, "An Unforeseen View");
  assert.strictEqual(label.children[1], legend);
  assert.deepStrictEqual(element.children, [label, summary, canvas]);
});

test("one invalid bundle does not prevent unrelated bundles from compiling", () => {
  const seen = [];
  const valid = { id: "valid", computed_values: {}, outputs: {}, script: "null", panels: [] };
  const invalid = { id: "invalid", computed_values: {}, outputs: {}, script: "not.registered", panels: [] };
  const invalidRenderer = {
    id: "invalid-renderer", computed_values: {}, outputs: { data: {} }, script: "null",
    panels: [{
      id: "panel", title: "Bad", height: 10,
      x: { type: "time" }, y: {},
      layers: [{ renderer: "cpu-magic", data: "data", channels: {}, style: {} }],
    }],
  };
  const result = compileBundles([invalid, invalidRenderer, valid], {}, (diagnostic) => seen.push(diagnostic));
  assert.deepStrictEqual(result.bundles.map((bundle) => bundle.id), ["valid"]);
  assert.strictEqual(result.errors.length, 2);
  assert.strictEqual(result.errors[0].bundle, "invalid");
  assert.match(result.errors[0].message, /unknown operation/);
  assert.match(result.errors[1].message, /unknown custom view renderer/);
  assert.deepStrictEqual(seen, result.errors);
  assert.ok(renderers.includes("points"));
});

test("presenter formats preserve exact integers and viewer units", () => {
  assert.strictEqual(formatValue(9007199254740993n, "integer"), "9007199254740993");
  assert.strictEqual(formatValue(1_500_000n, "duration"), "1.50ms");
  assert.strictEqual(formatValue(1.25, "cores"), "1.25 cores");
  assert.strictEqual(formatValue(12.5, "rate"), "12.50/s");
});

test("legend entries can be emitted as arbitrary data", () => {
  const source = bundle({
    guide: [new Map([["text", "8 core capacity"], ["color", "orange"]])],
  });
  assert.deepStrictEqual(legendEntries([
    { label: "CPU", color: "blue" },
    { data: "guide", channels: { label: "text", color: "color" } },
  ], source), [
    { label: "CPU", color: "blue" },
    { label: "8 core capacity", color: "orange" },
  ]);
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
      hit: "x",
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
  assert.strictEqual(findHit(result.hits, 200, -100), result.hits[0], "x-only hit mode ignores vertical distance");
});

test("zoom clipping keeps crossing line segments and bounds interval geometry", () => {
  const crossing = {
    x: { type: "time" }, y: { domain: [0, 10] },
    layers: [{
      renderer: "line", data: "line", channels: { x: "x", y: "y" },
      style: { color: "green" }, tooltip: [{ field: "y" }],
    }],
  };
  const lineResult = renderPanel(fakeContext(), crossing, bundle({ line: [
    new Map([["x", -10n], ["y", 1]]),
    new Map([["x", 20n], ["y", 9]]),
  ] }), { start: 0, end: 10 }, geometry());
  assert.strictEqual(lineResult.hits.length, 2, "off-screen endpoints still define the visible segment");

  const interval = {
    x: { type: "time" }, y: { domain: [0, 10] },
    layers: [{
      renderer: "interval-area", data: "interval", channels: { start: "start", end: "end", y: "y" },
      style: { color: "green" }, tooltip: [{ field: "y" }],
    }],
  };
  const ctx = fakeContext();
  renderPanel(ctx, interval, bundle({ interval: [
    new Map([["start", -10n], ["end", 20n], ["y", 5]]),
  ] }), { start: 0, end: 10 }, geometry());
  const mark = ctx.calls.filter(([name]) => name === "fillRect")[1];
  assert.strictEqual(mark[1], 100);
  assert.strictEqual(mark[3], 400);
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

test("line and point layers consume per-row computed colors", () => {
  const rows = [
    new Map([["x", 0n], ["y", 1], ["color", "green"]]),
    new Map([["x", 1n], ["y", 2], ["color", "orange"]]),
    new Map([["x", 2n], ["y", 3], ["color", "red"]]),
  ];
  const panel = {
    x: { type: "time" }, y: { domain: [0, 4] },
    layers: [
      {
        renderer: "line", data: "series", channels: { x: "x", y: "y", color: "color" },
        style: { color: "black" }, tooltip: [{ field: "y" }],
      },
      {
        renderer: "points", data: "series", channels: { x: "x", y: "y", color: "color" },
        style: { radius: 4 }, tooltip: [{ field: "y" }],
      },
    ],
  };
  const ctx = fakeContext();
  const result = renderPanel(ctx, panel, bundle({ series: rows }), { start: 0, end: 2 }, geometry());
  assert.strictEqual(ctx.calls.filter(([name]) => name === "arc").length, 3);
  assert.strictEqual(ctx.calls.filter(([name]) => name === "stroke").length, 5, "three grid rules + two colored segments");
  assert.strictEqual(result.hits.length, 6);
  assert.strictEqual(ctx.fillStyle, "red");
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
