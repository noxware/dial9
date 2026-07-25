import { describe, expect, it } from "vitest";
import { ExtensionStore, type ColumnarBatch } from "./columnar.js";
import { parseExtensionManifestJson } from "./manifest.js";
import { ExtensionPanel, type PanelViewport } from "./panel.js";

class FakeContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  lineWidth = 1;
  globalAlpha = 1;
  font = "";
  textAlign: CanvasTextAlign = "start";
  readonly fills: readonly unknown[][] = [];
  readonly strokes: readonly unknown[][] = [];
  readonly texts: string[] = [];
  #path: unknown[][] = [];

  clearRect(): void {}
  fillRect(...args: unknown[]): void {
    (this.fills as unknown[][]).push([this.fillStyle, this.globalAlpha, ...args]);
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
  beginPath(): void {
    this.#path = [];
  }
  moveTo(x: number, y: number): void {
    this.#path.push(["move", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.#path.push(["line", x, y]);
  }
  stroke(): void {
    (this.strokes as unknown[][]).push([
      this.strokeStyle,
      this.lineWidth,
      ...this.#path,
    ]);
  }
  setLineDash(): void {}
  save(): void {}
  rect(): void {}
  clip(): void {}
  restore(): void {}
}

const VIEWPORT: PanelViewport = {
  start: 0,
  end: 30,
  width: 500,
  height: 92,
  labelWidth: 100,
};

function utf8(values: readonly string[]): {
  readonly offsets: ArrayBuffer;
  readonly bytes: ArrayBuffer;
} {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const offsets = new Uint32Array(values.length + 1);
  let length = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    length += encoded[index]!.length;
    offsets[index + 1] = length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const value of encoded) {
    bytes.set(value, at);
    at += value.length;
  }
  return { offsets: offsets.buffer, bytes: bytes.buffer };
}

function cpuFixture() {
  const manifest = parseExtensionManifestJson(
    JSON.stringify({
      version: 1,
      tables: [
        {
          name: "cpu",
          columns: [
            { name: "start", type: "u64" },
            { name: "end", type: "u64" },
            { name: "wall", type: "u64" },
            { name: "cpu_time", type: "u64" },
            { name: "cores", type: "f64", nullable: true },
            { name: "percent", type: "f64", nullable: true },
          ],
        },
        {
          name: "settings",
          columns: [{ name: "capacity", type: "u32" }],
        },
      ],
      panels: [
        {
          title: "CPU Usage",
          height: 92,
          scales: [
            {
              name: "usage",
              domain: {
                mode: "visible",
                include: [0, { table: "settings", column: "capacity" }],
              },
            },
          ],
          components: [
            {
              name: "interval-area/v1",
              table: "cpu",
              start: "start",
              end: "end",
              y: "cores",
              scale: "usage",
              color: {
                column: "percent",
                stops: [
                  { at: 0, color: "#4fc3f7" },
                  { at: 100, color: "#ef4444" },
                ],
              },
            },
            {
              name: "interval-line/v1",
              table: "cpu",
              start: "start",
              end: "end",
              y: "cores",
              scale: "usage",
              color: "#4fc3f7",
            },
            {
              name: "horizontal-rule/v1",
              y: { table: "settings", column: "capacity" },
              scale: "usage",
              color: "#ffcf99",
              dash: [4, 3],
            },
            {
              name: "swatch/v1",
              label: "available parallelism",
              color: "#ffcf99",
              sample: "rule",
              value: { table: "settings", column: "capacity" },
            },
            {
              name: "tooltip/v1",
              table: "cpu",
              match: { start: "start", end: "end", y: "cores" },
              items: [
                { label: "Window", column: "wall", unit: "ns" },
                { label: "CPU time", column: "cpu_time", unit: "ns" },
                { label: "Cores", column: "cores" },
                { label: "Total CPU", column: "percent", unit: "%" },
              ],
            },
            {
              name: "readout/v1",
              table: "cpu",
              items: [
                {
                  label: "avg",
                  column: "cores",
                  reduce: {
                    name: "time_weighted_mean",
                    start: "start",
                    end: "end",
                  },
                },
                { label: "max", column: "cores", reduce: "max" },
              ],
            },
          ],
        },
      ],
    }),
  );
  const store = new ExtensionStore(manifest);
  const batch: ColumnarBatch = {
    table_id: 0,
    rows: 3,
    columns: [
      { type: "u64", values: new BigUint64Array([0n, 10n, 20n]).buffer },
      { type: "u64", values: new BigUint64Array([10n, 20n, 30n]).buffer },
      {
        type: "u64",
        values: new BigUint64Array([
          10_000_000n,
          10_000_000n,
          10_000_000n,
        ]).buffer,
      },
      {
        type: "u64",
        values: new BigUint64Array([
          5_000_000n,
          6_000_000n,
          7_000_000n,
        ]).buffer,
      },
      {
        type: "f64",
        values: new Float64Array([1, 2, 99]).buffer,
        validity: new Uint8Array([0b011]).buffer,
      },
      {
        type: "f64",
        values: new Float64Array([5, 10, 99]).buffer,
        validity: new Uint8Array([0b011]).buffer,
      },
    ],
  };
  store.append(batch);
  store.append({
    table_id: 1,
    rows: 1,
    columns: [
      { type: "u32", values: new Uint32Array([4]).buffer },
    ],
  });
  return {
    panel: new ExtensionPanel(
      "cpu-instance",
      manifest,
      store,
      manifest.panels[0]!,
      0,
    ),
  };
}

describe("extension panel components", () => {
  it("renders and presents a CPU panel from only tables plus components", () => {
    const { panel } = cpuFixture();
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);

    expect(panel.error).toBeUndefined();
    expect(context.fills.length).toBeGreaterThanOrEqual(3);
    expect(context.strokes.length).toBeGreaterThan(3);
    expect(context.texts).toContain("4");

    const hit = panel.hitTest(300, 60, VIEWPORT);
    expect(hit).toMatchObject({ table: "cpu", row: 1 });
    expect(panel.tooltip(hit!)).toEqual([
      { label: "Window", value: "10.00ms" },
      { label: "CPU time", value: "6.00ms" },
      { label: "Cores", value: "2" },
      { label: "Total CPU", value: "10.0%" },
    ]);

    expect(panel.presentation(VIEWPORT, 15)).toEqual({
      swatches: [
        {
          label: "available parallelism",
          color: "#ffcf99",
          sample: "rule",
          value: "4",
        },
      ],
      readout: [
        { label: "avg", value: "1.5" },
        { label: "max", value: "2" },
      ],
    });
  });

  it("preserves decreasing and repeated polyline coordinates for a dinosaur", () => {
    const text = utf8(["💩", "❤️", ""]);
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "dino",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
              { name: "message", type: "utf8" },
            ],
          },
        ],
        panels: [
          {
            title: "Dinosaur",
            x_axis: { type: "linear", domain: [0, 100] },
            scales: [
              {
                name: "body",
                domain: { mode: "fixed", min: 0, max: 10 },
              },
            ],
            components: [
              { name: "background/v1", color: "#15351f" },
              {
                name: "polyline/v1",
                table: "dino",
                x: "x",
                y: "y",
                scale: "body",
                color: "#66d17a",
                line_width: 3,
              },
              {
                name: "tooltip/v1",
                table: "dino",
                match: { x: "x", y: "y" },
                items: [{ label: "Dino says", column: "message" }],
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: 3,
      columns: [
        { type: "f64", values: new Float64Array([10, 18, 10]).buffer },
        { type: "f64", values: new Float64Array([3, 4, 3]).buffer },
        { type: "utf8", ...text },
      ],
    });
    const panel = new ExtensionPanel(
      "dino-instance",
      manifest,
      store,
      manifest.panels[0]!,
      0,
    );
    const viewport = { ...VIEWPORT, height: 120 };
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, viewport);

    expect(panel.error).toBeUndefined();
    expect(context.fills[1]?.[0]).toBe("#15351f");
    const hit = panel.hitTest(156, 80, viewport);
    expect(hit?.row).toBe(1);
    expect(panel.tooltip(hit!)).toEqual([
      { label: "Dino says", value: "❤️" },
    ]);
  });

  it("rejects unsorted line data with a useful polyline hint", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "points",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Broken",
            x_axis: { type: "linear" },
            scales: [
              { name: "y", domain: { mode: "visible", include: [0] } },
            ],
            components: [
              {
                name: "line/v1",
                table: "points",
                x: "x",
                y: "y",
                scale: "y",
                color: "red",
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: 3,
      columns: [
        { type: "f64", values: new Float64Array([0, 2, 1]).buffer },
        { type: "f64", values: new Float64Array([0, 1, 2]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "broken",
      manifest,
      store,
      manifest.panels[0]!,
      0,
    );
    expect(panel.error).toContain("use polyline/v1");
  });

  it("hit-tests overlaid line and step layers in reverse Z order", () => {
    const labels = utf8(["line", "line", "line"]);
    const stepLabels = utf8(["step", "step", "step"]);
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "points",
            columns: [
              { name: "x", type: "u64" },
              { name: "line_y", type: "f64" },
              { name: "step_y", type: "f64" },
              { name: "line_label", type: "utf8" },
              { name: "step_label", type: "utf8" },
            ],
          },
        ],
        panels: [
          {
            title: "Overlay",
            x_axis: { type: "time" },
            scales: [
              { name: "y", domain: { mode: "fixed", min: 0, max: 10 } },
            ],
            components: [
              {
                name: "line/v1",
                table: "points",
                x: "x",
                y: "line_y",
                scale: "y",
                color: "green",
              },
              {
                name: "step-line/v1",
                table: "points",
                x: "x",
                y: "step_y",
                scale: "y",
                color: "orange",
              },
              {
                name: "tooltip/v1",
                table: "points",
                match: { x: "x", y: "line_y" },
                items: [{ label: "Series", column: "line_label" }],
              },
              {
                name: "tooltip/v1",
                table: "points",
                match: { x: "x", y: "step_y" },
                items: [{ label: "Series", column: "step_label" }],
              },
              {
                name: "readout/v1",
                table: "points",
                match: { x: "x", y: "line_y" },
                items: [
                  {
                    label: "visible max",
                    column: "line_y",
                    reduce: "max",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: 3,
      columns: [
        { type: "u64", values: new BigUint64Array([0n, 5n, 10n]).buffer },
        { type: "f64", values: new Float64Array([99, 5, 99]).buffer },
        { type: "f64", values: new Float64Array([5, 5, 5]).buffer },
        { type: "utf8", ...labels },
        { type: "utf8", ...stepLabels },
      ],
    });
    const panel = new ExtensionPanel(
      "overlay",
      manifest,
      store,
      manifest.panels[0]!,
      0,
    );
    const viewport = { ...VIEWPORT, start: 2, end: 8 };
    const hit = panel.hitTest(300, 52, viewport);
    expect(hit?.channels["y"]).toBe("step_y");
    expect(panel.tooltip(hit!)).toEqual([
      { label: "Series", value: "step" },
    ]);
    expect(panel.presentation(viewport, null).readout).toEqual([
      { label: "visible max", value: "5" },
    ]);
  });

  it("surfaces an unknown component as a panel-local error", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [],
        panels: [
          {
            title: "Future",
            components: [{ name: "heatmap/v3" }],
          },
        ],
      }),
    );
    const panel = new ExtensionPanel(
      "future",
      manifest,
      new ExtensionStore(manifest),
      manifest.panels[0]!,
      0,
    );
    expect(panel.error).toBe("Viewer does not support component heatmap/v3");
  });
});
