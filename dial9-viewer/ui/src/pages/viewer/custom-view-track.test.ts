import { describe, expect, it, vi } from "vitest";
import type {
  ColumnarTable,
  LegendModel,
  PanelManifest,
  TableColumn,
  TooltipRow,
  ViewBundle,
} from "../../lib/custom-views/index.js";
import type { ViewerExtension } from "../../types/trace.js";
import type { TrackId } from "../../lib/canvas/track-layout.js";
import type { AxisInputs } from "./axis.js";
import type { CpuInputs } from "./cpu.js";
import { sizeTracks, type TracksViewModel } from "./tracks.js";
import {
  createCustomViewTrack,
  customViewBackingDpr,
  discoverCustomViewTracks,
  groupCustomViewLegendItems,
  type CustomViewTooltipPresenter,
  type CustomViewTrackDeps,
} from "./custom-view-track.js";

function columnar(columns: Readonly<Record<string, TableColumn>>): ColumnarTable {
  return { length: Object.values(columns)[0]?.length ?? 0, columns };
}

function extension(
  name: string,
  panels: readonly PanelManifest[],
  tables: ViewBundle["tables"] = {},
): ViewerExtension {
  return { name, bundle: { panels, tables } };
}

interface FakeContext {
  setTransform(): void;
  clearRect(): void;
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly style = { width: "", height: "", cursor: "" };
  readonly dataset: DOMStringMap = {};
  readonly context: FakeContext = { setTransform() {}, clearRect() {} };
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  getContext(_kind: "2d"): FakeContext {
    return this.context;
  }

  getBoundingClientRect(): DOMRect {
    const width = Number.parseFloat(this.style.width) || this.width;
    const height = Number.parseFloat(this.style.height) || this.height;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    };
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    let entries = this.listeners.get(type);
    if (entries === undefined) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: { clientX?: number; clientY?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      const value = event as Event;
      if (typeof listener === "function") listener(value);
      else listener.handleEvent(value);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function canvas(value: FakeCanvas): HTMLCanvasElement {
  return value as unknown as HTMLCanvasElement;
}

const noRender: NonNullable<CustomViewTrackDeps["renderPanel"]> = (
  _ctx,
  _bundle,
  _panel,
  _viewport,
) => ({ domains: new Map() });

describe("custom-view discovery", () => {
  it("discovers every panel from two bundles with stable collision-safe ids", () => {
    const firstPanel: PanelManifest = {
      id: `same"panel`,
      title: "<First panel>",
      height: 70,
      components: [],
    };
    const secondPanel: PanelManifest = {
      ...firstPanel,
      title: "Second panel",
      height: 80,
    };
    const extensions = [
      extension("same extension", [firstPanel]),
      extension("same extension", [secondPanel]),
    ];

    const first = discoverCustomViewTracks(extensions);
    const again = discoverCustomViewTracks(extensions);
    expect(first.map((definition) => definition.track.id)).toEqual(
      again.map((definition) => definition.track.id),
    );
    expect(new Set(first.map((definition) => definition.track.id)).size).toBe(2);
    expect(first.map((definition) => definition.track.label)).toEqual([
      "<First panel>",
      "Second panel",
    ]);
    expect(
      first.every((definition) =>
        definition.track.id.startsWith("custom-view:"),
      ),
    ).toBe(true);
    expect(first[1]!.track.id).toMatch(/:2$/);
    expect(first[0]!.track.id).not.toContain('"');
  });
});

describe("custom-view controller", () => {
  it("caps physical backing pixels without changing panel geometry", () => {
    const dpr = customViewBackingDpr(4096, 512, 4);
    expect(dpr).toBeCloseTo(Math.sqrt(2));
    expect(4096 * dpr * 512 * dpr).toBeLessThanOrEqual(
      4 * 1024 * 1024 + 1,
    );
  });

  it("isolates a renderer exception to its panel", () => {
    const panel: PanelManifest = {
      id: "broken",
      title: "Broken",
      height: 80,
      components: [],
    };
    const definition = discoverCustomViewTracks([
      extension("demo", [panel]),
    ])[0]!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const controller = createCustomViewTrack(definition, {
      renderPanel() {
        calls++;
        throw new Error("bad recipe");
      },
      renderLegends() {},
    });
    const fake = new FakeCanvas();

    expect(() =>
      controller.paint(canvas(fake), 100, 80, 1, 0, 10),
    ).not.toThrow();
    expect(() =>
      controller.paint(canvas(fake), 100, 80, 1, 0, 10),
    ).not.toThrow();
    expect(calls).toBe(1);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("isolates a missing canvas context to its panel", () => {
    const panel: PanelManifest = {
      id: "no-context",
      title: "No context",
      height: 80,
      components: [],
    };
    const definition = discoverCustomViewTracks([
      extension("demo", [panel]),
    ])[0]!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createCustomViewTrack(definition, {
      renderPanel: noRender,
      renderLegends() {},
    });
    const fake = new FakeCanvas();
    Object.defineProperty(fake, "getContext", { value: () => null });

    expect(() =>
      controller.paint(canvas(fake), 100, 80, 1, 0, 10),
    ).not.toThrow();
    expect(() =>
      controller.paint(canvas(fake), 100, 80, 1, 0, 10),
    ).not.toThrow();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("owns DPR sizing and delegates the exact bundle/panel/viewport", () => {
    const panel: PanelManifest = {
      id: "linear",
      title: "Linear",
      height: 80,
      x: { kind: "linear", min: 0, max: 10 },
      components: [],
    };
    const ext = extension("demo", [panel]);
    const definition = discoverCustomViewTracks([ext])[0]!;
    const calls: {
      bundle: ViewBundle;
      panel: PanelManifest;
      width: number;
      height: number;
      startNs: number;
      endNs: number;
    }[] = [];
    const controller = createCustomViewTrack(definition, {
      renderPanel(_ctx, bundle, renderedPanel, viewport) {
        calls.push({
          bundle,
          panel: renderedPanel,
          width: viewport.width,
          height: viewport.height,
          startNs: viewport.startNs,
          endNs: viewport.endNs,
        });
        return { domains: new Map() };
      },
      renderLegends() {},
    });
    const fake = new FakeCanvas();

    controller.paint(canvas(fake), 200, 80, 2, 1_000, 2_000);

    expect(fake.width).toBe(400);
    expect(fake.height).toBe(160);
    expect(calls).toEqual([
      {
        bundle: ext.bundle,
        panel,
        width: 200,
        height: 80,
        startNs: 1_000,
        endNs: 2_000,
      },
    ]);
  });

  it("is delegated by the generic track column without a panel-id branch", () => {
    const panel: PanelManifest = {
      id: "arbitrary-panel",
      title: "Arbitrary",
      height: 65,
      components: [],
    };
    const definition = discoverCustomViewTracks([
      extension("extension", [panel]),
    ])[0]!;
    const fake = new FakeCanvas();
    fake.dataset["trackCanvas"] = definition.track.id;
    const paints: number[][] = [];
    const controller = {
      id: definition.track.id,
      rowTemplate(): never {
        throw new Error("not used by sizing");
      },
      paint(
        _canvas: HTMLCanvasElement,
        drawW: number,
        height: number,
        dpr: number,
        viewStart: number,
        viewEnd: number,
      ) {
        paints.push([drawW, height, dpr, viewStart, viewEnd]);
      },
      dispose() {},
    };
    const vm: TracksViewModel = {
      hasTrace: true,
      taskSelected: false,
      viewStart: 10,
      viewEnd: 20,
      axis: {} as AxisInputs,
      cpu: {} as CpuInputs,
      trackOrder: [],
      collapsed: {},
      emptyTracks: new Set<TrackId>(),
      lanesViewportHeight: 130,
      customTracks: [definition.track],
    };
    const column = {
      clientWidth: 300,
      querySelector: () => null,
      querySelectorAll: () => [canvas(fake)],
    } as unknown as HTMLElement;

    const sizing = sizeTracks(
      column,
      vm,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map([[definition.track.id, controller]]),
    );

    expect(paints).toEqual([[200, 65, 1, 10, 20]]);
    expect(sizing.at(-1)).toEqual({
      id: definition.track.id,
      drawW: 200,
      height: 65,
    });
  });

  it("updates two independent corner legends at the cursor and clears on leave", () => {
    const panel: PanelManifest = {
      id: "legends",
      title: "Legends",
      height: 60,
      components: [
        {
          id: "left",
          kind: "legend",
          position: "top-left",
          items: [{ label: "Left static" }],
          atCursor: [
            {
              input: "series",
              xColumn: "x",
              valueColumn: "a",
              label: "A",
            },
          ],
        },
        {
          id: "right",
          kind: "legend",
          position: "top-right",
          items: [{ label: "Right static" }],
          atCursor: [
            {
              input: "series",
              xColumn: "x",
              valueColumn: "b",
              label: "B",
            },
          ],
        },
      ],
    };
    const ext = extension("demo", [panel], {
      series: columnar({
        x: new Float64Array([0, 10]),
        a: new Float64Array([1, 2]),
        b: new Float64Array([3, 4]),
      }),
    });
    const definition = discoverCustomViewTracks([ext])[0]!;
    const rendered: (readonly LegendModel[])[] = [];
    const controller = createCustomViewTrack(definition, {
      renderPanel: noRender,
      renderLegends(_canvas, _panel, models) {
        rendered.push(models);
      },
    });
    const fake = new FakeCanvas();
    controller.paint(canvas(fake), 100, 60, 1, 0, 10);

    fake.dispatch("pointermove", { clientX: 100, clientY: 30 });
    const atCursor = groupCustomViewLegendItems(panel, rendered.at(-1)!);
    expect(atCursor.left).toEqual([
      { label: "Left static" },
      { label: "A", value: "2" },
    ]);
    expect(atCursor.right).toEqual([
      { label: "Right static" },
      { label: "B", value: "4" },
    ]);

    controller.paint(canvas(fake), 100, 60, 1, 0, 10);
    const afterRepaint = groupCustomViewLegendItems(panel, rendered.at(-1)!);
    expect(afterRepaint.left).toEqual([
      { label: "Left static" },
      { label: "A", value: "2" },
    ]);
    expect(afterRepaint.right).toEqual([
      { label: "Right static" },
      { label: "B", value: "4" },
    ]);

    fake.dispatch("pointerleave");
    const cleared = groupCustomViewLegendItems(panel, rendered.at(-1)!);
    expect(cleared.left).toEqual([{ label: "Left static" }]);
    expect(cleared.right).toEqual([{ label: "Right static" }]);

    controller.dispose();
    expect(fake.listenerCount("pointermove")).toBe(0);
    expect(fake.listenerCount("pointerleave")).toBe(0);
  });

  it("shows the tooltip belonging to the topmost overlapping component", () => {
    const panel: PanelManifest = {
      id: "overlap",
      title: "Overlap",
      height: 100,
      scales: [{ id: "y", min: 0, max: 2 }],
      components: [
        {
          id: "bottom",
          kind: "interval-area",
          input: "series",
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
          kind: "interval-area",
          input: "series",
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
    const ext = extension("demo", [panel], {
      series: columnar({
        start: new Float64Array([0]),
        end: new Float64Array([10]),
        value: new Float64Array([1]),
      }),
    });
    const definition = discoverCustomViewTracks([ext])[0]!;
    const shown: (readonly TooltipRow[])[] = [];
    let hidden = 0;
    let disposed = 0;
    const tooltip: CustomViewTooltipPresenter = {
      show(rows) {
        shown.push(rows);
      },
      hide() {
        hidden++;
      },
      dispose() {
        disposed++;
      },
    };
    const controller = createCustomViewTrack(definition, {
      renderPanel: noRender,
      renderLegends() {},
      createTooltipPresenter: () => tooltip,
    });
    const fake = new FakeCanvas();
    controller.paint(canvas(fake), 100, 100, 1, 0, 10);

    fake.dispatch("pointermove", { clientX: 50, clientY: 50 });
    expect(shown.at(-1)).toEqual([{ label: "Top", value: "1" }]);
    expect(fake.style.cursor).toBe("pointer");

    controller.paint(canvas(fake), 100, 100, 1, 0, 10);
    expect(shown.at(-1)).toEqual([{ label: "Top", value: "1" }]);
    expect(shown).toHaveLength(2);

    fake.dispatch("pointerleave");
    expect(hidden).toBe(1);
    expect(fake.style.cursor).toBe("default");
    controller.dispose();
    expect(disposed).toBe(1);
  });
});
