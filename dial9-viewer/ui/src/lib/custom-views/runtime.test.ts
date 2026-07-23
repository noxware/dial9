import { describe, expect, it } from "vitest";
import {
  computeScaleDomains,
  hitTestPanel,
  legendModel,
  renderPanel,
  tooltipRows,
  type ColumnarTable,
  type PanelManifest,
  type PanelViewport,
  type TableColumn,
  type ViewBundle,
} from "./index.js";

interface PathCommand {
  readonly kind: "move" | "line";
  readonly x: number;
  readonly y: number;
}

interface Recording {
  readonly clears: { x: number; y: number; width: number; height: number }[];
  readonly fills: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
  }[];
  readonly strokes: {
    color: string;
    commands: readonly PathCommand[];
  }[];
  readonly texts: {
    text: string;
    x: number;
    y: number;
    color: string;
  }[];
}

function recordingContext(): {
  readonly ctx: CanvasRenderingContext2D;
  readonly recording: Recording;
} {
  const recording: Recording = {
    clears: [],
    fills: [],
    strokes: [],
    texts: [],
  };
  let path: PathCommand[] = [];
  const raw = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter" as CanvasLineJoin,
    font: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    clearRect(x: number, y: number, width: number, height: number) {
      recording.clears.push({ x, y, width, height });
    },
    fillRect(x: number, y: number, width: number, height: number) {
      recording.fills.push({
        x,
        y,
        width,
        height,
        color: String(raw.fillStyle),
      });
    },
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ kind: "move", x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ kind: "line", x, y });
    },
    stroke() {
      recording.strokes.push({
        color: String(raw.strokeStyle),
        commands: [...path],
      });
    },
    setLineDash(_segments: number[]) {},
    fillText(text: string, x: number, y: number) {
      recording.texts.push({
        text,
        x,
        y,
        color: String(raw.fillStyle),
      });
    },
  };
  return {
    ctx: raw as unknown as CanvasRenderingContext2D,
    recording,
  };
}

function columnar(columns: Readonly<Record<string, TableColumn>>): ColumnarTable {
  const first = Object.values(columns)[0];
  return { length: first?.length ?? 0, columns };
}

const TIME_VIEWPORT: PanelViewport = {
  startNs: 0,
  endNs: 30,
  width: 300,
  height: 100,
};

describe("custom-view CPU intervals", () => {
  const panel: PanelManifest = {
    id: "cpu",
    title: "CPU",
    height: 100,
    scales: [{ id: "cpu", includeZero: true }],
    components: [
      {
        id: "usage",
        kind: "interval-area",
        input: "cpu",
        startColumn: "start",
        endColumn: "end",
        valueColumn: "cores",
        scale: "cpu",
        color: "#4fc3f7",
      },
      {
        id: "capacity",
        kind: "horizontal-rule",
        input: "capacity",
        valueColumn: "cores",
        scale: "cpu",
        color: "#ffffff",
      },
      {
        id: "usage-tip",
        kind: "tooltip",
        target: "usage",
        strategy: { kind: "interval" },
        rows: [
          { label: "CPU time", field: "cpu_ns", unit: "ns" },
          { label: "Cores", field: "cores" },
        ],
      },
    ],
  };
  const bundle: ViewBundle = {
    panels: [panel],
    tables: {
      cpu: columnar({
        start: new Float64Array([0, 10, 20, 100]),
        end: new Float64Array([10, 20, 30, 110]),
        cores: new Float64Array([1, 2, 3, 1_000]),
        cpu_ns: new Float64Array([10, 20, 30, 1_000]),
      }),
      capacity: columnar({ cores: new Float64Array([4]) }),
    },
  };

  it("derives the y domain only from visible intervals and rules", () => {
    expect(computeScaleDomains(bundle, panel, TIME_VIEWPORT).get("cpu")).toEqual({
      min: 0,
      max: 4,
    });
  });

  it("renders visible bars and resolves structured interval tooltips", () => {
    const { ctx, recording } = recordingContext();
    renderPanel(ctx, bundle, panel, TIME_VIEWPORT);

    expect(recording.fills).toHaveLength(3);
    expect(recording.strokes.map((stroke) => stroke.color)).toContain("#ffffff");

    const hit = hitTestPanel(bundle, panel, TIME_VIEWPORT, 150, 50);
    expect(hit).toEqual({ componentId: "usage", row: 1 });
    expect(tooltipRows(bundle, panel, hit!)).toEqual([
      { label: "CPU time", value: "20ns" },
      { label: "Cores", value: "2" },
    ]);
  });
});

describe("pixel-bounded custom-view intervals", () => {
  it("preserves a subpixel spike and hit-tests the interval it painted", () => {
    const rows = 10_000;
    const spikeRow = 1_235;
    const start = Float64Array.from(
      { length: rows },
      (_, row) => row / rows,
    );
    const end = Float64Array.from(start, (value) => value + 1 / rows);
    const value = new Float64Array(rows);
    value.fill(10);
    value[spikeRow] = 100;
    value[rows - 1] = 20;
    const panel: PanelManifest = {
      id: "interval-spike",
      title: "Interval spike",
      height: 100,
      scales: [{ id: "y", min: 0, max: 100 }],
      components: [
        {
          id: "line",
          kind: "interval-line",
          input: "intervals",
          startColumn: "start",
          endColumn: "end",
          valueColumn: "value",
          scale: "y",
          color: "#abcdef",
        },
        {
          id: "tip",
          kind: "tooltip",
          target: "line",
          strategy: { kind: "interval" },
          rows: [{ label: "Value", field: "value" }],
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: { intervals: columnar({ start, end, value }) },
    };
    const viewport: PanelViewport = {
      startNs: 0,
      endNs: 100,
      width: 10,
      height: 100,
    };
    const { ctx, recording } = recordingContext();

    renderPanel(ctx, bundle, panel, viewport);

    const commands = recording.strokes.find(
      (stroke) => stroke.color === "#abcdef",
    )?.commands ?? [];
    expect(commands.map((command) => command.y)).toEqual([90, 90, 0, 0, 80, 80]);
    const spikeX =
      (((start[spikeRow]! + end[spikeRow]!) / 2) / viewport.endNs) *
      viewport.width;
    const hit = hitTestPanel(bundle, panel, viewport, spikeX, 0);
    expect(hit).toEqual({ componentId: "line", row: spikeRow });
    expect(tooltipRows(bundle, panel, hit!)).toEqual([
      { label: "Value", value: "100" },
    ]);
  });

  it("caps area fill operations by horizontal pixels while retaining extrema", () => {
    const rows = 100_000;
    const spikeRow = 54_321;
    const start = Float64Array.from({ length: rows }, (_, row) => row);
    const end = Float64Array.from(start, (value) => value + 0.5);
    const value = new Float64Array(rows);
    value.fill(1);
    value[spikeRow] = 100;
    const panel: PanelManifest = {
      id: "interval-budget",
      title: "Interval budget",
      height: 100,
      scales: [{ id: "y", min: 0, max: 100 }],
      components: [
        {
          id: "area",
          kind: "interval-area",
          input: "intervals",
          startColumn: "start",
          endColumn: "end",
          valueColumn: "value",
          scale: "y",
          color: "#123456",
        },
        {
          id: "tip",
          kind: "tooltip",
          target: "area",
          strategy: { kind: "interval" },
          rows: [{ label: "Value", field: "value" }],
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: { intervals: columnar({ start, end, value }) },
    };
    const viewport: PanelViewport = {
      startNs: 0,
      endNs: rows,
      width: 50,
      height: 100,
    };
    const { ctx, recording } = recordingContext();

    renderPanel(ctx, bundle, panel, viewport);

    expect(recording.fills.length).toBeLessThanOrEqual(viewport.width * 4);
    expect(
      recording.fills.some((fill) => fill.y === 0 && fill.height === 100),
    ).toBe(true);
    const spikeX = (spikeRow / rows) * viewport.width;
    const hit = hitTestPanel(bundle, panel, viewport, spikeX, 50);
    expect(hit).toEqual({ componentId: "area", row: spikeRow });
  });
});

describe("custom-view context-switch series", () => {
  const panel: PanelManifest = {
    id: "context-switches",
    title: "Context switches",
    height: 100,
    scales: [{ id: "switches", includeZero: true }],
    components: [
      {
        id: "voluntary",
        kind: "step-line",
        input: "voluntary",
        xColumn: "time",
        valueColumn: "delta",
        gapColumn: "gap",
        scale: "switches",
        sampling: "none",
        color: "#00aa00",
      },
      {
        id: "involuntary",
        kind: "line",
        input: "involuntary",
        xColumn: "time",
        valueColumn: "delta",
        scale: "switches",
        sampling: "pixel",
        color: "#aa00aa",
      },
      {
        id: "voluntary-tip",
        kind: "tooltip",
        target: "voluntary",
        strategy: { kind: "nearest-point", radius: 10 },
        rows: [{ label: "Voluntary", field: "delta" }],
      },
      {
        id: "involuntary-tip",
        kind: "tooltip",
        target: "involuntary",
        strategy: { kind: "nearest-point", radius: 10 },
        rows: [{ label: "Involuntary", field: "delta" }],
      },
      {
        id: "switch-legend",
        kind: "legend",
        items: [
          { label: "Voluntary", color: "#00aa00" },
          { label: "Involuntary", color: "#aa00aa" },
        ],
        atCursor: [
          {
            input: "voluntary",
            xColumn: "time",
            valueColumn: "delta",
            label: "Current voluntary",
          },
          {
            input: "involuntary",
            xColumn: "time",
            valueColumn: "delta",
            label: "Current involuntary",
          },
        ],
      },
    ],
  };
  const bundle: ViewBundle = {
    panels: [panel],
    tables: {
      voluntary: columnar({
        time: new Float64Array([0, 10, 20, 30]),
        delta: new Float64Array([0, 2, 1, 3]),
        // The counter decreased before row 2. The producer materialized the
        // invariant violation as a break before the new series.
        gap: new Uint8Array([0, 0, 1, 0]),
      }),
      involuntary: columnar({
        time: new Float64Array([0, 10, 20, 30]),
        delta: new Float64Array([0, 1, 2, 3]),
      }),
    },
  };

  it("keeps the already-materialized reset as two step subpaths", () => {
    const { ctx, recording } = recordingContext();
    renderPanel(ctx, bundle, panel, TIME_VIEWPORT);

    const voluntary = recording.strokes.find(
      (stroke) => stroke.color === "#00aa00",
    );
    expect(voluntary).toBeDefined();
    expect(
      voluntary!.commands.filter((command) => command.kind === "move"),
    ).toHaveLength(2);
    expect(recording.strokes.map((stroke) => stroke.color)).toContain("#aa00aa");
  });

  it("keeps a line visible when the viewport falls between two samples", () => {
    const { ctx, recording } = recordingContext();
    renderPanel(ctx, bundle, panel, {
      startNs: 12,
      endNs: 18,
      width: 60,
      height: 100,
    });

    expect(
      recording.strokes.find((stroke) => stroke.color === "#aa00aa")?.commands,
    ).toHaveLength(2);
  });

  it("builds static and nearest-at-cursor legend items", () => {
    expect(legendModel(bundle, panel, 17)).toEqual([
      {
        componentId: "switch-legend",
        position: "top-right",
        items: [
          { label: "Voluntary", color: "#00aa00" },
          { label: "Involuntary", color: "#aa00aa" },
          { label: "Current voluntary", value: "1" },
          { label: "Current involuntary", value: "2" },
        ],
      },
    ]);
  });
});

describe("pixel-sampled custom-view lines", () => {
  const viewport: PanelViewport = {
    startNs: 0,
    endNs: 100,
    width: 10,
    height: 100,
  };

  it("preserves first/min/max/last and hit-tests the points it paints", () => {
    const rows = 5_000;
    const spikeRow = 1_235;
    const time = Float64Array.from(
      { length: rows },
      (_, row) => row / rows,
    );
    const value = new Float64Array(rows);
    value[spikeRow] = 100;
    value[rows - 1] = 1;
    const panel: PanelManifest = {
      id: "sampled",
      title: "Sampled",
      height: 100,
      scales: [{ id: "y", min: 0, max: 100 }],
      components: [
        {
          id: "line",
          kind: "line",
          input: "points",
          xColumn: "time",
          valueColumn: "value",
          scale: "y",
          sampling: "pixel",
          color: "#abcdef",
        },
        {
          id: "tip",
          kind: "tooltip",
          target: "line",
          strategy: { kind: "nearest-point", radius: 0.2 },
          rows: [{ label: "Value", field: "value" }],
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: { points: columnar({ time, value }) },
    };
    const { ctx, recording } = recordingContext();

    renderPanel(ctx, bundle, panel, viewport);

    const commands = recording.strokes.find(
      (stroke) => stroke.color === "#abcdef",
    )?.commands;
    expect(commands?.map((command) => command.y)).toEqual([100, 0, 99]);
    const spikeX = (time[spikeRow]! / 100) * viewport.width;
    const hit = hitTestPanel(bundle, panel, viewport, spikeX, 0);
    expect(hit).toEqual({ componentId: "line", row: spikeRow });
    expect(tooltipRows(bundle, panel, hit!)).toEqual([
      { label: "Value", value: "100" },
    ]);
  });

  it("keeps gap-delimited pixel segments independent", () => {
    const panel: PanelManifest = {
      id: "sampled-gaps",
      title: "Sampled gaps",
      height: 100,
      scales: [{ id: "y", min: 0, max: 4 }],
      components: [
        {
          id: "line",
          kind: "line",
          input: "points",
          xColumn: "time",
          valueColumn: "value",
          gapColumn: "gap",
          scale: "y",
          sampling: "pixel",
          color: "#fedcba",
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: {
        points: columnar({
          time: new Float64Array([0, 0.1, 0.2, 0.3]),
          value: new Float64Array([1, 2, 3, 4]),
          gap: new Uint8Array([0, 0, 1, 0]),
        }),
      },
    };
    const { ctx, recording } = recordingContext();

    renderPanel(ctx, bundle, panel, viewport);

    const commands = recording.strokes.find(
      (stroke) => stroke.color === "#fedcba",
    )?.commands;
    expect(commands?.filter((command) => command.kind === "move")).toHaveLength(2);
  });

  it("bounds many independent pixel segments without splitting one", () => {
    const rows = 6_000;
    const panel: PanelManifest = {
      id: "sampled-budget",
      title: "Sampled budget",
      height: 100,
      scales: [{ id: "y", min: 0, max: 1 }],
      components: [
        {
          id: "line",
          kind: "line",
          input: "points",
          xColumn: "time",
          valueColumn: "value",
          gapColumn: "gap",
          scale: "y",
          sampling: "pixel",
          color: "#123456",
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: {
        points: columnar({
          time: Float64Array.from(
            { length: rows },
            (_, row) => row / 100_000,
          ),
          value: Float64Array.from(
            { length: rows },
            (_, row) => row % 2,
          ),
          gap: Uint8Array.from(
            { length: rows },
            (_, row) => Number(row > 0 && row % 2 === 0),
          ),
        }),
      },
    };
    const { ctx, recording } = recordingContext();

    renderPanel(ctx, bundle, panel, viewport);

    const commands = recording.strokes.find(
      (stroke) => stroke.color === "#123456",
    )?.commands ?? [];
    expect(commands).toHaveLength(4_096);
    expect(commands.filter((command) => command.kind === "move")).toHaveLength(
      2_048,
    );
  });
});

describe("exact point hit indexing", () => {
  it("finds the exact nearby row in a large unsampled series", () => {
    const rows = 100_000;
    const targetRow = 54_321;
    const x = Float64Array.from({ length: rows }, (_, row) => row);
    const value = new Float64Array(rows);
    const panel: PanelManifest = {
      id: "indexed-hit",
      title: "Indexed hit",
      height: 100,
      x: { kind: "linear", min: 0, max: rows },
      scales: [{ id: "y", min: 0, max: 1 }],
      components: [
        {
          id: "polyline",
          kind: "polyline",
          input: "points",
          xColumn: "x",
          valueColumn: "value",
          scale: "y",
          color: "#ffffff",
        },
        {
          id: "tip",
          kind: "tooltip",
          target: "polyline",
          strategy: { kind: "nearest-point", radius: 0.001 },
          rows: [{ label: "X", field: "x" }],
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: { points: columnar({ x, value }) },
    };
    const viewport: PanelViewport = {
      startNs: 0,
      endNs: 1,
      width: 1_000,
      height: 100,
    };

    expect(
      hitTestPanel(
        bundle,
        panel,
        viewport,
        (targetRow / rows) * viewport.width,
        viewport.height,
      ),
    ).toEqual({ componentId: "polyline", row: targetRow });
  });
});

describe("stacked hit testing", () => {
  it("tests drawing components in reverse z-order", () => {
    const shared = columnar({
      start: new Float64Array([0]),
      end: new Float64Array([30]),
      value: new Float64Array([1]),
    });
    const panel: PanelManifest = {
      id: "stack",
      title: "Stack",
      height: 100,
      scales: [{ id: "y", min: 0, max: 2 }],
      components: [
        {
          id: "bottom",
          kind: "interval-area",
          input: "shared",
          startColumn: "start",
          endColumn: "end",
          valueColumn: "value",
          scale: "y",
          color: "#111111",
        },
        {
          id: "bottom-tip",
          kind: "tooltip",
          target: "bottom",
          strategy: { kind: "interval" },
          rows: [{ label: "Bottom", field: "value" }],
        },
        {
          id: "top",
          kind: "interval-line",
          input: "shared",
          startColumn: "start",
          endColumn: "end",
          valueColumn: "value",
          scale: "y",
          color: "#eeeeee",
        },
        {
          id: "top-tip",
          kind: "tooltip",
          target: "top",
          strategy: { kind: "interval" },
          rows: [{ label: "Top", field: "value" }],
        },
      ],
    };
    const bundle: ViewBundle = {
      panels: [panel],
      tables: { shared },
    };

    expect(hitTestPanel(bundle, panel, TIME_VIEWPORT, 150, 50)).toEqual({
      componentId: "top",
      row: 0,
    });
    expect(hitTestPanel(bundle, panel, TIME_VIEWPORT, 150, 10)).toEqual({
      componentId: "bottom",
      row: 0,
    });
  });
});

describe("linear-axis dinosaur", () => {
  const panel: PanelManifest = {
    id: "dino",
    title: "Dino",
    height: 100,
    x: { kind: "linear", min: 0, max: 10 },
    scales: [{ id: "y", min: 0, max: 10 }],
    components: [
      {
        id: "green-background",
        kind: "background",
        input: "background",
        colorColumn: "color",
      },
      {
        id: "dino-outline",
        kind: "polyline",
        input: "dino",
        xColumn: "x",
        valueColumn: "y",
        gapColumn: "gap",
        scale: "y",
        color: "#00ff66",
        lineWidth: 2,
      },
      {
        id: "flames",
        kind: "text",
        input: "flames",
        xColumn: "x",
        valueColumn: "y",
        textColumn: "text",
        colorColumn: "color",
        scale: "y",
        font: "16px sans-serif",
      },
      {
        id: "dino-tip",
        kind: "tooltip",
        target: "dino-outline",
        strategy: { kind: "nearest-point", radius: 6 },
        rows: [{ label: "Reaction", field: "reaction" }],
      },
    ],
  };
  const bundle: ViewBundle = {
    panels: [panel],
    tables: {
      background: columnar({ color: ["#003300"] }),
      dino: columnar({
        x: new Float64Array([1, 2, 2, 4, 6, 6, 8, 5, 1.5]),
        y: new Float64Array([2, 2, 5, 7, 7, 4, 6, 4, 3]),
        gap: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0]),
        reaction: ["💩", "", "", "", "", "", "❤️", "", ""],
      }),
      flames: columnar({
        x: new Float64Array([8.5, 9]),
        y: new Float64Array([6, 6.5]),
        text: ["🔥", "🔥"],
        color: ["#ff8800", "#ff3300"],
      }),
    },
  };
  // Deliberately unrelated: a linear panel must not use the viewer's ns range.
  const viewport: PanelViewport = {
    startNs: 1_000_000,
    endNs: 2_000_000,
    width: 100,
    height: 100,
  };

  it("preserves arbitrary row order and gaps without sampling", () => {
    const { ctx, recording } = recordingContext();
    renderPanel(ctx, bundle, panel, viewport);

    expect(recording.fills[0]?.color).toBe("#003300");
    const outline = recording.strokes.find(
      (stroke) => stroke.color === "#00ff66",
    );
    expect(outline).toBeDefined();
    expect(outline!.commands.map((command) => command.x)).toEqual([
      10, 20, 20, 40, 60, 60, 80, 50, 15,
    ]);
    expect(
      outline!.commands.filter((command) => command.kind === "move"),
    ).toHaveLength(2);
    expect(recording.texts.map((entry) => entry.text)).toEqual(["🔥", "🔥"]);
  });

  it("uses the linear axis for tail/head hit testing and tooltip fields", () => {
    const tail = hitTestPanel(bundle, panel, viewport, 10, 80);
    expect(tail).toEqual({ componentId: "dino-outline", row: 0 });
    expect(tooltipRows(bundle, panel, tail!)).toEqual([
      { label: "Reaction", value: "💩" },
    ]);

    const head = hitTestPanel(bundle, panel, viewport, 80, 40);
    expect(head).toEqual({ componentId: "dino-outline", row: 6 });
    expect(tooltipRows(bundle, panel, head!)).toEqual([
      { label: "Reaction", value: "❤️" },
    ]);
  });
});
