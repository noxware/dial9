import { describe, expect, it, vi } from "vitest";
import { ExtensionStore, type ColumnarBatch } from "./columnar.js";
import { ColumnReader } from "./data.js";
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
  readonly operations: readonly unknown[][] = [];
  #path: unknown[][] = [];

  clearRect(): void {}
  fillRect(...args: unknown[]): void {
    (this.fills as unknown[][]).push([this.fillStyle, this.globalAlpha, ...args]);
    (this.operations as unknown[][]).push(["fill", this.fillStyle, ...args]);
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
    (this.operations as unknown[][]).push(["stroke", this.strokeStyle]);
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
                column: "cores",
                domain: {
                  min: 0,
                  max: { table: "settings", column: "capacity" },
                  fallback_scale: "usage",
                },
                stops: [
                  { at: 0, color: "#4fc3f7" },
                  { at: 1, color: "#ef4444" },
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
      store,
      manifest.panels[0]!,
      0,
    ),
  };
}

describe("extension panel components", () => {
  it("shares interval indexes between layers with the same bounds", () => {
    const original = ColumnReader.prototype.number;
    let endReads = 0;
    const number = vi
      .spyOn(ColumnReader.prototype, "number")
      .mockImplementation(function (this: ColumnReader, row: number) {
        if (this.schema.name === "end") endReads += 1;
        return original.call(this, row);
      });
    try {
      cpuFixture();
      expect(endReads).toBe(3);
    } finally {
      number.mockRestore();
    }
  });

  it("renders and presents a CPU panel from only tables plus components", () => {
    const { panel } = cpuFixture();
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);

    expect(panel.error).toBeUndefined();
    expect(context.fills.length).toBeGreaterThanOrEqual(3);
    expect(context.strokes.length).toBeGreaterThan(3);
    expect(context.texts).toContain("4");
    expect(
      context.strokes.some((stroke) => {
        const move = stroke[2] as readonly unknown[];
        const line = stroke[3] as readonly unknown[];
        return move?.[0] === "move" &&
          line?.[0] === "line" &&
          move[1] === line[1] &&
          move[2] !== line[2];
      }),
    ).toBe(true);

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

  it("reuses viewport domains and reducer results during pointer updates", () => {
    const { panel } = cpuFixture();
    const number = vi.spyOn(ColumnReader.prototype, "number");
    try {
      const first = panel.presentation(VIEWPORT, null);
      const readsAfterFirstPresentation = number.mock.calls.length;
      expect(readsAfterFirstPresentation).toBeGreaterThan(0);

      expect(panel.xValueAt(300, { ...VIEWPORT })).toBe(15);
      expect(panel.presentation({ ...VIEWPORT }, null)).toEqual(first);
      expect(number).toHaveBeenCalledTimes(readsAfterFirstPresentation);

      panel.presentation({ ...VIEWPORT, start: 5 }, null);
      expect(number.mock.calls.length).toBeGreaterThan(
        readsAfterFirstPresentation,
      );
    } finally {
      number.mockRestore();
    }
  });

  it("preserves decreasing and repeated polyline coordinates for a dinosaur", () => {
    const body = [
      [10, 3], [18, 4], [28, 5.8], [40, 7], [52, 6.8], [59, 7.8],
      [66, 8.4], [76, 8.2], [78, 7], [69, 6.7], [63, 5.4], [68, 4.8],
      [62, 5.1], [56, 3.8], [56, 1.2], [50, 1.2], [48, 3.5],
      [38, 3.6], [38, 1.1], [32, 1.1], [34, 4.1], [25, 4.4], [10, 3],
    ] as const;
    const flames = [
      [78, 7.6], [84, 8.5], [82, 7.5], [90, 7.8], [84, 6.8], [78, 7.2],
    ] as const;
    const bodyText = utf8([
      "💩", "💩", "", "", "", "❤️", "❤️", "❤️", "❤️", "❤️", "", "",
      "", "", "", "", "", "", "", "", "", "💩", "💩",
    ]);
    const flameText = utf8(flames.map(() => "🔥"));
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "dino_body",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
              { name: "message", type: "utf8" },
            ],
          },
          {
            name: "dino_flames",
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
                table: "dino_body",
                x: "x",
                y: "y",
                scale: "body",
                color: "#66d17a",
              },
              {
                name: "polyline/v1",
                table: "dino_flames",
                x: "x",
                y: "y",
                scale: "body",
                color: "#ff7043",
              },
              {
                name: "tooltip/v1",
                table: "dino_body",
                match: { x: "x", y: "y" },
                items: [{ label: "Dino says", column: "message" }],
              },
              {
                name: "tooltip/v1",
                table: "dino_flames",
                match: { x: "x", y: "y" },
                items: [{ label: "Science", column: "message" }],
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: body.length,
      columns: [
        { type: "f64", values: new Float64Array(body.map(([x]) => x)).buffer },
        { type: "f64", values: new Float64Array(body.map(([, y]) => y)).buffer },
        { type: "utf8", ...bodyText },
      ],
    });
    store.append({
      table_id: 1,
      rows: flames.length,
      columns: [
        { type: "f64", values: new Float64Array(flames.map(([x]) => x)).buffer },
        { type: "f64", values: new Float64Array(flames.map(([, y]) => y)).buffer },
        { type: "utf8", ...flameText },
      ],
    });
    const panel = new ExtensionPanel(
      "dino-instance",
      store,
      manifest.panels[0]!,
      0,
    );
    const viewport = { ...VIEWPORT, height: 120 };
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, viewport);

    expect(panel.error).toBeUndefined();
    expect(context.fills[1]?.[0]).toBe("#15351f");
    expect(
      context.strokes.filter((stroke) => stroke[0] === "#66d17a"),
    ).toHaveLength(body.length - 1);
    expect(
      context.strokes.filter((stroke) => stroke[0] === "#ff7043"),
    ).toHaveLength(flames.length - 1);

    const tail = panel.hitTest(140, 84.4, viewport);
    expect(panel.tooltip(tail!)).toEqual([
      { label: "Dino says", value: "💩" },
    ]);
    const head = panel.hitTest(404, 36.56, viewport);
    expect(panel.tooltip(head!)).toEqual([
      { label: "Dino says", value: "❤️" },
    ]);
    const flame = panel.hitTest(436, 33.8, viewport);
    expect(flame?.table).toBe("dino_flames");
    expect(panel.tooltip(flame!)).toEqual([
      { label: "Science", value: "🔥" },
    ]);
  });

  it("turns null geometry into a gap instead of joining valid rows", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "points",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64", nullable: true },
            ],
          },
        ],
        panels: [
          {
            title: "Gaps",
            x_axis: { type: "linear", domain: [0, 20] },
            scales: [
              { name: "y", domain: { mode: "fixed", min: 0, max: 10 } },
            ],
            components: [
              {
                name: "line/v1",
                table: "points",
                x: "x",
                y: "y",
                scale: "y",
                color: "cyan",
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
        { type: "f64", values: new Float64Array([0, 10, 20]).buffer },
        {
          type: "f64",
          values: new Float64Array([2, 9, 8]).buffer,
          validity: new Uint8Array([0b101]).buffer,
        },
      ],
    });
    const panel = new ExtensionPanel(
      "gaps",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);

    expect(context.strokes).toHaveLength(3);
    expect(context.fills.filter((fill) => fill[0] === "cyan")).toHaveLength(2);
  });

  it("derives a visible domain from a line crossing the viewport", () => {
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
            title: "Crossing",
            scales: [
              { name: "y", domain: { mode: "visible" } },
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
      rows: 2,
      columns: [
        { type: "f64", values: new Float64Array([0, 10]).buffer },
        { type: "f64", values: new Float64Array([100, 200]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "crossing",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();
    panel.render(
      context as unknown as CanvasRenderingContext2D,
      { ...VIEWPORT, start: 4, end: 6 },
    );

    expect(context.texts).toContain("160");
    expect(context.texts).toContain("140");
  });

  it("keeps backgrounds in component order and hits isolated points", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "point",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Ordered",
            x_axis: { type: "linear", domain: [0, 10] },
            scales: [
              { name: "y", domain: { mode: "fixed", min: 0, max: 10 } },
            ],
            components: [
              {
                name: "line/v1",
                table: "point",
                x: "x",
                y: "y",
                scale: "y",
                color: "red",
              },
              { name: "background/v1", color: "#123456" },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: 1,
      columns: [
        { type: "f64", values: new Float64Array([5]).buffer },
        { type: "f64", values: new Float64Array([5]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "ordered",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);
    const pointDraw = context.operations.findIndex(
      (operation) => operation[0] === "fill" && operation[1] === "red",
    );
    const backgroundDraw = context.operations.findIndex(
      (operation) =>
        operation[0] === "fill" && operation[1] === "#123456",
    );

    expect(pointDraw).toBeGreaterThanOrEqual(0);
    expect(backgroundDraw).toBeGreaterThan(pointDraw);
    expect(panel.hitTest(300, 52, VIEWPORT)).toMatchObject({ row: 0 });
  });

  it("does not draw intervals that only touch a viewport boundary", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "intervals",
            columns: [
              { name: "start", type: "f64" },
              { name: "end", type: "f64" },
              { name: "y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Boundaries",
            x_axis: { type: "time" },
            scales: [
              { name: "y", domain: { mode: "fixed", min: 0, max: 10 } },
            ],
            components: [
              {
                name: "interval-area/v1",
                table: "intervals",
                start: "start",
                end: "end",
                y: "y",
                scale: "y",
                color: "magenta",
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows: 2,
      columns: [
        { type: "f64", values: new Float64Array([-1, 30]).buffer },
        { type: "f64", values: new Float64Array([0, 31]).buffer },
        { type: "f64", values: new Float64Array([5, 5]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "boundaries",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();
    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);

    expect(context.fills.some((fill) => fill[0] === "magenta")).toBe(false);
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
          {
            title: "Broken intervals",
            scales: [
              { name: "y", domain: { mode: "visible", include: [0] } },
            ],
            components: [
              {
                name: "interval-area/v1",
                table: "points",
                start: "x",
                end: "y",
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
      store,
      manifest.panels[0]!,
      0,
    );
    expect(panel.error).toContain("use polyline/v1");
    const intervalPanel = new ExtensionPanel(
      "broken-intervals",
      store,
      manifest.panels[1]!,
      1,
    );
    expect(intervalPanel.error).toContain(
      "interval-area/v1 requires x to be nondecreasing",
    );
  });

  it("reports invalid scalar cardinality and fixed scalar values locally", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "bounds",
            columns: [
              { name: "min", type: "f64", nullable: true },
              { name: "max", type: "f64", nullable: true },
            ],
          },
        ],
        panels: [
          {
            title: "Scalar bounds",
            scales: [
              {
                name: "y",
                domain: {
                  mode: "fixed",
                  min: { table: "bounds", column: "min" },
                  max: { table: "bounds", column: "max" },
                },
              },
            ],
            components: [],
          },
        ],
      }),
    );
    const tooMany = new ExtensionStore(manifest);
    tooMany.append({
      table_id: 0,
      rows: 2,
      columns: [
        { type: "f64", values: new Float64Array([0, 0]).buffer },
        { type: "f64", values: new Float64Array([1, 1]).buffer },
      ],
    });
    expect(
      new ExtensionPanel(
        "scalar-cardinality",
        tooMany,
        manifest.panels[0]!,
        0,
      ).error,
    ).toContain("requires exactly one row; got 2");

    const nullMaximum = new ExtensionStore(manifest);
    nullMaximum.append({
      table_id: 0,
      rows: 1,
      columns: [
        {
          type: "f64",
          values: new Float64Array([0]).buffer,
          validity: new Uint8Array([1]).buffer,
        },
        {
          type: "f64",
          values: new Float64Array([0]).buffer,
          validity: new Uint8Array([0]).buffer,
        },
      ],
    });
    expect(
      new ExtensionPanel(
        "scalar-value",
        nullMaximum,
        manifest.panels[0]!,
        0,
      ).error,
    ).toBe("Fixed scale y requires finite min less than max");
  });

  it("bounds dense sorted Canvas paths by horizontal pixels", () => {
    const rows = 10_000;
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "dense",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Dense",
            x_axis: { type: "linear" },
            scales: [
              { name: "y", domain: { mode: "visible", include: [0] } },
            ],
            components: [
              {
                name: "line/v1",
                table: "dense",
                x: "x",
                y: "y",
                scale: "y",
                color: "#4fc3f7",
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    store.append({
      table_id: 0,
      rows,
      columns: [
        {
          type: "f64",
          values: Float64Array.from({ length: rows }, (_, row) => row).buffer,
        },
        {
          type: "f64",
          values: Float64Array.from(
            { length: rows },
            (_, row) => Math.sin(row / 10),
          ).buffer,
        },
      ],
    });
    const panel = new ExtensionPanel(
      "dense",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();
    panel.render(
      context as unknown as CanvasRenderingContext2D,
      { ...VIEWPORT, width: 140 },
    );

    // 40 drawable pixels × at most four representatives, plus grid strokes.
    expect(context.strokes.length).toBeLessThanOrEqual(165);
  });

  it("keeps a transient ramp color when downsampling dense rows", () => {
    const rows = 30;
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "dense",
            columns: [
              { name: "x", type: "f64" },
              { name: "y", type: "f64" },
              { name: "warning", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Warnings",
            x_axis: { type: "linear", domain: [0, rows] },
            scales: [
              { name: "y", domain: { mode: "fixed", min: 0, max: 2 } },
            ],
            components: [
              {
                name: "line/v1",
                table: "dense",
                x: "x",
                y: "y",
                scale: "y",
                color: {
                  column: "warning",
                  stops: [
                    { at: 0, color: "#4fc3f7" },
                    { at: 100, color: "#ef4444" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const store = new ExtensionStore(manifest);
    const warnings = new Float64Array(rows);
    warnings[15] = 100;
    store.append({
      table_id: 0,
      rows,
      columns: [
        {
          type: "f64",
          values: Float64Array.from({ length: rows }, (_, row) => row).buffer,
        },
        { type: "f64", values: new Float64Array(rows).fill(1).buffer },
        { type: "f64", values: warnings.buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "warnings",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();

    panel.render(
      context as unknown as CanvasRenderingContext2D,
      { ...VIEWPORT, width: VIEWPORT.labelWidth + 1 },
    );

    expect(context.strokes.some((stroke) => stroke[0] === "#ef4444")).toBe(
      true,
    );
  });

  it("falls back to the visible scale for an unavailable color domain", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "intervals",
            columns: [
              { name: "start", type: "u64" },
              { name: "end", type: "u64" },
              { name: "cores", type: "f64" },
            ],
          },
          {
            name: "settings",
            columns: [
              { name: "capacity", type: "f64", nullable: true },
            ],
          },
        ],
        panels: [
          {
            title: "Usage",
            scales: [
              {
                name: "usage",
                domain: {
                  mode: "visible",
                  include: [
                    0,
                    1,
                    { table: "settings", column: "capacity" },
                  ],
                },
              },
            ],
            components: [
              {
                name: "interval-area/v1",
                table: "intervals",
                start: "start",
                end: "end",
                y: "cores",
                scale: "usage",
                color: {
                  column: "cores",
                  domain: {
                    min: 0,
                    max: { table: "settings", column: "capacity" },
                    fallback_scale: "usage",
                  },
                  stops: [
                    { at: 0, color: "#4fc3f7" },
                    { at: 1, color: "#ef4444" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const populate = (target: ExtensionStore): void => {
      target.append({
        table_id: 0,
        rows: 1,
        columns: [
          { type: "u64", values: new BigUint64Array([0n]).buffer },
          { type: "u64", values: new BigUint64Array([30n]).buffer },
          { type: "f64", values: new Float64Array([2]).buffer },
        ],
      });
      target.append({
        table_id: 1,
        rows: 1,
        columns: [
          {
            type: "f64",
            values: new Float64Array([0]).buffer,
            validity: new Uint8Array([0]).buffer,
          },
        ],
      });
    };
    const store = new ExtensionStore(manifest);
    populate(store);
    const panel = new ExtensionPanel(
      "usage",
      store,
      manifest.panels[0]!,
      0,
    );
    const context = new FakeContext();

    panel.render(context as unknown as CanvasRenderingContext2D, VIEWPORT);

    expect(
      context.fills.some(
        (fill) => fill[0] === "#ef4444" && fill[1] === 0.38,
      ),
    ).toBe(true);

    const source = structuredClone(manifest) as unknown as {
      panels: Array<{
        components: Array<{
          color?: { domain?: { fallback_scale?: string } };
        }>;
      }>;
    };
    delete source.panels[0]!.components[0]!.color!.domain!.fallback_scale;
    const invalidManifest = parseExtensionManifestJson(JSON.stringify(source));
    const invalidStore = new ExtensionStore(invalidManifest);
    populate(invalidStore);
    const invalidPanel = new ExtensionPanel(
      "invalid",
      invalidStore,
      invalidManifest.panels[0]!,
      0,
    );
    expect(invalidPanel.error).toContain(
      "color domain is unavailable and has no fallback scale",
    );
  });

  it("hit-tests overlaid line and step layers in reverse Z order", () => {
    const labels = utf8(["line", "line", "line"]);
    const stepLabels = utf8(["step-0", "step-1", "step-2"]);
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
                match: { x: "x", y: "step_y" },
                items: [
                  {
                    label: "sample",
                    column: "step_label",
                  },
                  {
                    label: "visible max",
                    column: "step_y",
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
      store,
      manifest.panels[0]!,
      0,
    );
    const viewport = { ...VIEWPORT, start: 2, end: 8 };
    const hit = panel.hitTest(300, 52, viewport);
    expect(hit?.channels["y"]).toBe("step_y");
    expect(panel.tooltip(hit!)).toEqual([
      { label: "Series", value: "step-1" },
    ]);
    expect(panel.presentation(viewport, null).readout).toEqual([
      { label: "visible max", value: "5" },
    ]);
    expect(panel.presentation(viewport, 3, hit).readout).toEqual([
      { label: "sample", value: "step-1" },
      { label: "visible max", value: "5" },
    ]);
  });

  it("uses a weighted aggregate's interval mapping and clamps after reduction", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "usage",
            columns: [
              { name: "start", type: "u64" },
              { name: "end", type: "u64" },
              { name: "raw_percent", type: "f64" },
              { name: "plot_x", type: "u64" },
              { name: "plot_y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Usage",
            x_axis: { type: "time" },
            scales: [
              { name: "usage", domain: { mode: "fixed", min: 0, max: 200 } },
            ],
            components: [
              {
                name: "line/v1",
                table: "usage",
                x: "plot_x",
                y: "plot_y",
                scale: "usage",
                color: "blue",
              },
              {
                name: "readout/v1",
                table: "usage",
                items: [
                  {
                    label: "avg",
                    column: "raw_percent",
                    reduce: {
                      name: "time_weighted_mean",
                      start: "start",
                      end: "end",
                    },
                    clamp: { max: 100 },
                    unit: "%",
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
      rows: 2,
      columns: [
        { type: "u64", values: new BigUint64Array([0n, 10n]).buffer },
        { type: "u64", values: new BigUint64Array([10n, 20n]).buffer },
        { type: "f64", values: new Float64Array([200, 50]).buffer },
        { type: "u64", values: new BigUint64Array([100n, 110n]).buffer },
        { type: "f64", values: new Float64Array([1, 2]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "usage",
      store,
      manifest.panels[0]!,
      0,
    );

    expect(panel.error).toBeUndefined();
    expect(panel.presentation({ ...VIEWPORT, end: 20 }, null).readout).toEqual([
      { label: "avg", value: "100.0%" },
    ]);
  });

  it("rejects simple viewport reducers without a graphical mapping", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "values",
            columns: [{ name: "value", type: "f64" }],
          },
        ],
        panels: [
          {
            title: "Unmapped",
            components: [
              {
                name: "readout/v1",
                table: "values",
                items: [
                  {
                    label: "max",
                    column: "value",
                    reduce: "max",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const panel = new ExtensionPanel(
      "unmapped",
      new ExtensionStore(manifest),
      manifest.panels[0]!,
      0,
    );

    expect(panel.error).toBe(
      "readout/v1 simple reducers require a matching graphical component for viewport filtering",
    );
  });

  it("expresses queue depth with layered scales, swatches, cursor values, and viewport reducers", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "queue_depth",
            columns: [
              { name: "time_ns", type: "u64" },
              { name: "end_ns", type: "u64" },
              { name: "global", type: "u32" },
              { name: "max_local", type: "u32" },
              { name: "active_tasks", type: "u32" },
            ],
          },
        ],
        panels: [
          {
            title: "Queue Depth",
            scales: [
              {
                name: "queue",
                domain: { mode: "visible", include: [0] },
              },
              {
                name: "tasks",
                domain: { mode: "visible", include: [0] },
              },
            ],
            components: [
              {
                name: "interval-area/v1",
                table: "queue_depth",
                start: "time_ns",
                end: "end_ns",
                y: "global",
                scale: "queue",
                color: "#4fc3f7",
              },
              {
                name: "step-line/v1",
                table: "queue_depth",
                x: "time_ns",
                y: "global",
                scale: "queue",
                color: "#4fc3f7",
              },
              {
                name: "step-line/v1",
                table: "queue_depth",
                x: "time_ns",
                y: "max_local",
                scale: "queue",
                color: "#ff8a65",
              },
              {
                name: "step-line/v1",
                table: "queue_depth",
                x: "time_ns",
                y: "active_tasks",
                scale: "tasks",
                color: "#81c784",
              },
              {
                name: "swatch/v1",
                label: "Global",
                color: "#4fc3f7",
                sample: "area",
              },
              {
                name: "swatch/v1",
                label: "Max local",
                color: "#ff8a65",
                sample: "line",
              },
              {
                name: "swatch/v1",
                label: "Active tasks",
                color: "#81c784",
                sample: "line",
              },
              {
                name: "readout/v1",
                table: "queue_depth",
                match: { x: "time_ns", y: "global" },
                items: [
                  { label: "Global Q", column: "global" },
                  { label: "Local max", column: "max_local" },
                  { label: "Active tasks", column: "active_tasks" },
                  {
                    label: "visible max",
                    column: "global",
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
      rows: 4,
      columns: [
        {
          type: "u64",
          values: new BigUint64Array([0n, 10n, 20n, 30n]).buffer,
        },
        {
          type: "u64",
          values: new BigUint64Array([10n, 20n, 30n, 40n]).buffer,
        },
        { type: "u32", values: new Uint32Array([1, 4, 2, 3]).buffer },
        { type: "u32", values: new Uint32Array([2, 3, 5, 1]).buffer },
        { type: "u32", values: new Uint32Array([8, 10, 9, 12]).buffer },
      ],
    });
    const panel = new ExtensionPanel(
      "queue",
      store,
      manifest.panels[0]!,
      0,
    );
    const zoomedViewport = { ...VIEWPORT, start: 12, end: 18 };
    const context = new FakeContext();
    panel.render(
      context as unknown as CanvasRenderingContext2D,
      zoomedViewport,
    );
    expect(context.texts).toContain("4");
    expect(context.texts).toContain("tasks 10");
    expect(panel.presentation(zoomedViewport, 18).readout).toContainEqual({
      label: "visible max",
      value: "4",
    });

    expect(panel.presentation(VIEWPORT, 18)).toEqual({
      swatches: [
        { label: "Global", color: "#4fc3f7", sample: "area" },
        { label: "Max local", color: "#ff8a65", sample: "line" },
        { label: "Active tasks", color: "#81c784", sample: "line" },
      ],
      readout: [
        { label: "Global Q", value: "4" },
        { label: "Local max", value: "3" },
        { label: "Active tasks", value: "10" },
        { label: "visible max", value: "4" },
      ],
    });
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
      new ExtensionStore(manifest),
      manifest.panels[0]!,
      0,
    );
    expect(panel.error).toBe("Viewer does not support component heatmap/v3");
  });
});
