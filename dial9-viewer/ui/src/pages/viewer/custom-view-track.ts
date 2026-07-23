import { html, render, type TemplateResult } from "lit-html";
import { styleMap } from "lit-html/directives/style-map.js";
import { createCanvasSizer, type CanvasSizer } from "../../lib/canvas/dpr.js";
import {
  hitTestPanel,
  legendModel,
  renderPanel as renderCustomPanel,
  tooltipRows,
  type LegendItem,
  type LegendModel,
  type PanelManifest,
  type PanelViewport,
  type ScaleDomain,
  type TooltipRow,
  type ViewBundle,
} from "../../lib/custom-views/index.js";
import type {
  CustomViewTrackId,
  TrackSpec,
} from "../../lib/canvas/track-layout.js";
import { TRACKS } from "../../lib/canvas/track-layout.js";
import {
  createTooltip,
  tooltipRowsTemplate,
  type CursorPos,
  type TooltipHandle,
} from "../../components/overlay/tooltip.js";
import type { ViewerExtension } from "../../types/trace.js";

export interface CustomViewTrackSpec extends TrackSpec {
  readonly id: CustomViewTrackId;
}

export interface CustomViewTrackDefinition {
  readonly track: CustomViewTrackSpec;
  readonly extensionName: string;
  readonly bundle: ViewBundle;
  readonly panel: PanelManifest;
}

const MAX_CUSTOM_VIEW_BACKING_PIXELS = 4 * 1024 * 1024;

/** Bound attacker-controlled custom canvases without changing their CSS size. */
export function customViewBackingDpr(
  width: number,
  height: number,
  requestedDpr: number,
): number {
  const cssPixels = Math.max(1, width * height);
  return Math.min(
    Math.max(requestedDpr, Number.EPSILON),
    Math.sqrt(MAX_CUSTOM_VIEW_BACKING_PIXELS / cssPixels),
  );
}

/** Lossless UTF-8 encoding keeps guest identifiers out of selectors and HTML ids. */
function idPart(value: string): string {
  let result = "";
  for (const byte of new TextEncoder().encode(value)) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

/**
 * Discover panels without editing the static track catalogue. Exact duplicate
 * extension/panel identities receive a deterministic occurrence suffix.
 */
export function discoverCustomViewTracks(
  extensions: readonly ViewerExtension[] | undefined,
): readonly CustomViewTrackDefinition[] {
  const result: CustomViewTrackDefinition[] = [];
  const used = new Set<string>(TRACKS.map((track) => track.id));

  for (const extension of extensions ?? []) {
    for (const panel of extension.bundle.panels) {
      const base = `custom-view:${idPart(extension.name)}:${idPart(panel.id)}`;
      let id = base;
      let occurrence = 2;
      while (used.has(id)) id = `${base}:${occurrence++}`;
      used.add(id);
      result.push({
        track: {
          id: id as CustomViewTrackId,
          label: panel.title,
          height: panel.height,
        },
        extensionName: extension.name,
        bundle: extension.bundle,
        panel,
      });
    }
  }
  return result;
}

export interface CustomViewLegendGroups {
  readonly left: readonly LegendItem[];
  readonly right: readonly LegendItem[];
}

/** Group independent legend components into their declared overlay corners. */
export function groupCustomViewLegendItems(
  panel: PanelManifest,
  models: readonly LegendModel[],
): CustomViewLegendGroups {
  const left: LegendItem[] = [];
  const right: LegendItem[] = [];
  for (const model of models) {
    const component = panel.components.find(
      (candidate) =>
        candidate.kind === "legend" && candidate.id === model.componentId,
    );
    if (component?.kind === "legend") {
      const target =
        (component.position ?? "top-right") === "top-left" ? left : right;
      target.push(...model.items);
    }
  }
  return { left, right };
}

function legendItemsTemplate(items: readonly LegendItem[]): TemplateResult {
  return html`${items.map(
    (item) => html`
      <li class="d9-custom-view-legend-item">
        ${item.color === undefined
          ? ""
          : html`<span
              class="d9-custom-view-legend-swatch"
              style=${styleMap({
                backgroundColor: item.color,
                color: item.color,
              })}
              aria-hidden="true"
            ></span>`}
        <span class="d9-custom-view-legend-label">${item.label}</span>
        ${item.value === undefined
          ? ""
          : html`<span class="d9-custom-view-legend-value">${item.value}</span>`}
      </li>
    `,
  )}`;
}

/** DOM-safe legend overlays; lit renders every guest label/value as text. */
export function customViewLegendsTemplate(
  panel: PanelManifest,
  models: readonly LegendModel[],
): TemplateResult {
  const { left, right } = groupCustomViewLegendItems(panel, models);
  return html`
    ${left.length === 0
      ? ""
      : html`<ul
          class="d9-custom-view-legend d9-custom-view-legend--left"
          aria-label="Panel legend"
        >
          ${legendItemsTemplate(left)}
        </ul>`}
    ${right.length === 0
      ? ""
      : html`<ul
          class="d9-custom-view-legend d9-custom-view-legend--right"
          aria-label="Panel legend"
        >
          ${legendItemsTemplate(right)}
        </ul>`}
  `;
}

export interface CustomViewTooltipPresenter {
  show(rows: readonly TooltipRow[], cursor: CursorPos): void;
  hide(): void;
  dispose(): void;
}

function defaultTooltipPresenter(): CustomViewTooltipPresenter {
  const tooltip: TooltipHandle = createTooltip();
  return {
    show(rows, cursor) {
      tooltip.show(
        tooltipRowsTemplate(
          rows.map((row) => [
            { label: `${row.label}:`, value: row.value },
          ]),
        ),
        cursor,
      );
    },
    hide() {
      tooltip.hide();
    },
    dispose() {
      tooltip.dispose();
    },
  };
}

export type CustomViewLegendRenderer = (
  canvas: HTMLCanvasElement,
  panel: PanelManifest,
  models: readonly LegendModel[],
) => void;

function renderLegendOverlays(
  canvas: HTMLCanvasElement,
  panel: PanelManifest,
  models: readonly LegendModel[],
): void {
  const row = canvas.closest<HTMLElement>(".d9-track--custom-view");
  const host = row?.querySelector<HTMLElement>("[data-custom-view-legends]");
  if (host !== undefined && host !== null) {
    render(customViewLegendsTemplate(panel, models), host);
  }
}

export interface CustomViewTrackDeps {
  readonly renderPanel?: typeof renderCustomPanel;
  readonly renderLegends?: CustomViewLegendRenderer;
  readonly createTooltipPresenter?: () => CustomViewTooltipPresenter;
}

export interface CustomViewTrackController {
  readonly id: CustomViewTrackId;
  rowTemplate(track: TrackSpec): TemplateResult;
  paint(
    canvas: HTMLCanvasElement,
    drawW: number,
    trackHeight: number,
    dpr: number,
    viewStart: number,
    viewEnd: number,
  ): void;
  dispose(): void;
}

function cursorDomainValue(
  panel: PanelManifest,
  viewport: PanelViewport,
  x: number,
): number {
  const ratio = x / (viewport.width || 1);
  if (panel.x?.kind === "linear") {
    return panel.x.min + ratio * (panel.x.max - panel.x.min);
  }
  return viewport.startNs + ratio * (viewport.endNs - viewport.startNs);
}

export function createCustomViewTrack(
  definition: CustomViewTrackDefinition,
  deps: CustomViewTrackDeps = {},
): CustomViewTrackController {
  const { track, bundle, panel } = definition;
  const renderer = deps.renderPanel ?? renderCustomPanel;
  const legendRenderer = deps.renderLegends ?? renderLegendOverlays;
  const tooltipFactory = deps.createTooltipPresenter ?? defaultTooltipPresenter;

  let canvasSizer: CanvasSizer<CanvasRenderingContext2D> | null = null;
  let attachedCanvas: HTMLCanvasElement | null = null;
  let lastViewport: PanelViewport | null = null;
  let lastDomains: ReadonlyMap<string, ScaleDomain> | null = null;
  let tooltip: CustomViewTooltipPresenter | null = null;
  let lastCursor: CursorPos | null = null;
  let failed = false;

  function isolateFailure(error: unknown): void {
    if (failed) return;
    failed = true;
    lastDomains = null;
    lastCursor = null;
    tooltip?.hide();
    if (attachedCanvas !== null) attachedCanvas.style.cursor = "default";
    console.warn(
      `[dial9 viewer extension] panel ${JSON.stringify(panel.id)} disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function presenter(): CustomViewTooltipPresenter {
    tooltip ??= tooltipFactory();
    return tooltip;
  }

  function localPoint(
    canvas: HTMLCanvasElement,
    cursor: CursorPos,
    viewport: PanelViewport,
  ): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((cursor.clientX - rect.left) / (rect.width || 1)) * viewport.width,
      y: ((cursor.clientY - rect.top) / (rect.height || 1)) * viewport.height,
    };
  }

  function presentInteraction(cursor: CursorPos): void {
    const canvas = attachedCanvas;
    const viewport = lastViewport;
    if (canvas === null || viewport === null || failed) return;
    const point = localPoint(canvas, cursor, viewport);
    if (
      point.x < 0 ||
      point.x > viewport.width ||
      point.y < 0 ||
      point.y > viewport.height
    ) {
      canvas.style.cursor = "default";
      tooltip?.hide();
      legendRenderer(canvas, panel, legendModel(bundle, panel));
      return;
    }
    legendRenderer(
      canvas,
      panel,
      legendModel(bundle, panel, cursorDomainValue(panel, viewport, point.x)),
    );

    const hit = hitTestPanel(
      bundle,
      panel,
      viewport,
      point.x,
      point.y,
      lastDomains ?? undefined,
    );
    if (hit === null) {
      canvas.style.cursor = "default";
      tooltip?.hide();
      return;
    }
    const rows = tooltipRows(bundle, panel, hit);
    if (rows.length === 0) {
      canvas.style.cursor = "default";
      tooltip?.hide();
      return;
    }
    canvas.style.cursor = "pointer";
    presenter().show(rows, cursor);
  }

  function onPointerMove(event: PointerEvent): void {
    lastCursor = { clientX: event.clientX, clientY: event.clientY };
    try {
      presentInteraction(lastCursor);
    } catch (error) {
      isolateFailure(error);
    }
  }

  function clearInteraction(): void {
    lastCursor = null;
    const canvas = attachedCanvas;
    if (canvas !== null) {
      canvas.style.cursor = "default";
      if (!failed) {
        try {
          legendRenderer(canvas, panel, legendModel(bundle, panel));
        } catch (error) {
          isolateFailure(error);
        }
      }
    }
    tooltip?.hide();
  }

  function attach(canvas: HTMLCanvasElement): void {
    if (attachedCanvas === canvas) return;
    if (attachedCanvas !== null) {
      attachedCanvas.removeEventListener("pointermove", onPointerMove);
      attachedCanvas.removeEventListener("pointerleave", clearInteraction);
    }
    attachedCanvas = canvas;
    canvasSizer = createCanvasSizer<CanvasRenderingContext2D>(canvas);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", clearInteraction);
  }

  function rowTemplate(rowTrack: TrackSpec): TemplateResult {
    const labelId = `${rowTrack.id}-label`;
    return html`
      <div
        class="d9-track d9-track--custom-view"
        data-track-id=${rowTrack.id}
        style="height:${rowTrack.height}px"
      >
        <div class="d9-track-label" id=${labelId}>
          <span class="d9-track-name">${rowTrack.label}</span>
        </div>
        <div class="d9-track-canvas-wrap d9-custom-view-canvas-wrap">
          <canvas
            class="d9-track-canvas d9-custom-view-canvas"
            data-track-canvas=${rowTrack.id}
            aria-labelledby=${labelId}
            role="img"
          ></canvas>
          <div
            class="d9-custom-view-legends"
            data-custom-view-legends
            aria-live="off"
          ></div>
        </div>
      </div>
    `;
  }

  function paint(
    canvas: HTMLCanvasElement,
    drawW: number,
    trackHeight: number,
    dpr: number,
    viewStart: number,
    viewEnd: number,
  ): void {
    if (failed) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      attach(canvas);
      const viewport: PanelViewport = {
        startNs: viewStart,
        endNs: viewEnd,
        width: drawW,
        height: trackHeight,
      };
      lastViewport = viewport;
      ctx = canvasSizer!.ensure(
        drawW,
        trackHeight,
        customViewBackingDpr(drawW, trackHeight, dpr),
      );
      lastDomains = renderer(ctx, bundle, panel, viewport).domains;
      if (lastCursor === null) {
        legendRenderer(canvas, panel, legendModel(bundle, panel));
      } else {
        presentInteraction(lastCursor);
      }
    } catch (error) {
      try {
        ctx?.clearRect(0, 0, drawW, trackHeight);
      } catch {
        // The panel is already being isolated; a failed canvas cannot be cleared.
      }
      isolateFailure(error);
    }
  }

  function dispose(): void {
    if (attachedCanvas !== null) {
      attachedCanvas.removeEventListener("pointermove", onPointerMove);
      attachedCanvas.removeEventListener("pointerleave", clearInteraction);
      attachedCanvas.style.cursor = "default";
    }
    tooltip?.dispose();
    tooltip = null;
    attachedCanvas = null;
    canvasSizer = null;
    lastViewport = null;
    lastDomains = null;
    lastCursor = null;
  }

  return {
    id: track.id,
    rowTemplate,
    paint,
    dispose,
  };
}
