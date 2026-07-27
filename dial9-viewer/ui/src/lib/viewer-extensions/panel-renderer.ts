import { KNOWN_COMPONENT_NAMES } from "./manifest.js";
import {
  chunkValue,
  type CellValue,
  type TableStore,
} from "./tables.js";
import type {
  ColorRamp,
  ColorSpec,
  ComponentManifest,
  DomainValue,
  LoadedExtension,
  PanelManifest,
  ReadoutItem,
  Reducer,
  ScalarRef,
  ScaleManifest,
  TooltipItem,
} from "./index.js";

const PANEL_HEIGHT = 92;
const CHART_TOP = 20;
const CHART_BOTTOM_PADDING = 8;
const HIT_TOLERANCE = 10;
const DEFAULT_COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#b388ff", "#ff8a65"];
const GRAPH_COMPONENTS = new Set([
  "interval-area/v1",
  "interval-line/v1",
  "line/v1",
  "step-line/v1",
  "polyline/v1",
]);
const SUPPORTED_COMPONENTS = new Set<string>(KNOWN_COMPONENT_NAMES);

export interface PanelViewport {
  readonly start: number;
  readonly end: number;
  readonly labelWidth: number;
  readonly scrollbarWidth: number;
  readonly formatTimestamp?: (timestamp: number) => string;
}

interface ScaleDomain {
  min: number;
  max: number;
}

interface Projector {
  readonly chartTop: number;
  readonly chartBottom: number;
  readonly drawLeft: number;
  readonly drawRight: number;
  readonly xMin: number;
  readonly xMax: number;
  x(value: number): number;
  xClamped(value: number): number;
  y(scale: string, value: number): number;
  yClamped(scale: string, value: number): number;
}

interface ComponentHit {
  readonly table: string;
  readonly row: number;
  readonly channels: Readonly<Record<string, string>>;
  score(x: number, y: number): number | null;
}

interface LinePoint {
  readonly row: number;
  readonly x: number;
  readonly y: number | null;
}

interface IndexedRow {
  readonly row: number;
  readonly value: number;
}

interface IndexedInterval {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

interface IntervalLineDatum extends IndexedInterval {
  readonly y: number;
}

interface IntervalLineSegment {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly startY: number;
  readonly endY: number;
}

interface VisibleRows {
  readonly table: TableStore;
  readonly rows: readonly number[];
}

interface ScalarValueRef extends ScalarRef {
  readonly unit?: string;
}

interface TooltipComponent {
  readonly name: "tooltip/v1";
  readonly table: string;
  readonly match?: Readonly<Record<string, string>>;
  readonly items: readonly TooltipItem[];
}

interface ReadoutComponent {
  readonly name: "readout/v1";
  readonly table: string;
  readonly match?: Readonly<Record<string, string>>;
  readonly items: readonly ReadoutItem[];
}

/**
 * One manifest panel rendered with viewer-owned layout and visual policy.
 *
 * Component array order is drawing order. The class intentionally exposes no
 * Canvas handle or physical rendering options to extension code.
 */
export class SemanticPanelRenderer {
  readonly element: HTMLDivElement;

  readonly #extension: LoadedExtension;
  readonly #panel: PanelManifest;
  readonly #panelIndex: number;
  readonly #tooltip: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #title: HTMLSpanElement;
  readonly #legend: HTMLSpanElement;
  readonly #readout: HTMLSpanElement;
  readonly #error: HTMLDivElement;
  readonly #indexCache = new Map<string, NumericRowIndex | IntervalRowIndex>();
  readonly #reductionCache = new Map<string, number | null>();
  readonly #collapseKey: string;
  #hits: ComponentHit[] = [];
  #viewport: PanelViewport | null = null;
  #reductionViewportKey = "";
  #currentHit: ComponentHit | null = null;
  #pointerX: number | null = null;
  #collapsed = false;

  constructor(
    extension: LoadedExtension,
    panel: PanelManifest,
    panelIndex: number,
    tooltip: HTMLElement,
  ) {
    this.#extension = extension;
    this.#panel = panel;
    this.#panelIndex = panelIndex;
    this.#tooltip = tooltip;
    this.#collapseKey =
      `dial9.viewer.extensionPanelCollapsed.${extension.identity.name}.${panelIndex}`;

    this.element = document.createElement("div");
    this.element.className = "d9-extension-panel foldable-panel";
    this.element.dataset.panelKey = `${extension.identity.id}-${panelIndex}`;
    this.element.dataset.xAxis = panel.x_axis.kind;

    const label = document.createElement("div");
    label.className = "chart-label";
    label.setAttribute("role", "button");
    label.setAttribute("tabindex", "0");

    this.#title = document.createElement("span");
    this.#title.className = "d9-extension-title";
    this.#title.textContent = panel.title;
    label.appendChild(this.#title);

    this.#legend = document.createElement("span");
    this.#legend.className = "d9-extension-legend panel-expanded-label";
    label.appendChild(this.#legend);

    this.#readout = document.createElement("span");
    this.#readout.className = "d9-extension-readout panel-expanded-label";

    this.#error = document.createElement("div");
    this.#error.className = "d9-extension-error";
    this.#error.hidden = true;

    this.#canvas = document.createElement("canvas");
    this.#canvas.setAttribute("aria-label", panel.title);

    this.element.append(label, this.#readout, this.#error, this.#canvas);

    const toggle = (): void => {
      this.#setCollapsed(!this.#collapsed);
      this.render(this.#viewport);
    };
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    this.element.addEventListener("click", (event) => {
      if (!this.#collapsed || event.target === label || label.contains(event.target as Node)) {
        return;
      }
      event.stopPropagation();
      toggle();
    });

    this.#canvas.addEventListener("mousemove", (event) => this.#onMouseMove(event));
    this.#canvas.addEventListener("mouseleave", () => this.#onMouseLeave());

    this.#setCollapsed(readStorage(this.#collapseKey) === "collapsed", false);
    this.#renderLegend();
    this.#showCompatibilityError();
  }

  destroy(): void {
    if (this.#tooltip.dataset.extensionPanel === this.element.dataset.panelKey) {
      this.#hideTooltip();
    }
    this.element.remove();
  }

  render(viewport: PanelViewport | null): void {
    this.#viewport = viewport;
    const reductionViewportKey =
      viewport === null ? "" : `${viewport.start}:${viewport.end}`;
    if (reductionViewportKey !== this.#reductionViewportKey) {
      this.#reductionViewportKey = reductionViewportKey;
      this.#reductionCache.clear();
    }
    this.#renderLegend();
    if (viewport === null || this.#error.hidden === false || this.#collapsed) {
      this.#hits = [];
      return;
    }

    const width = this.element.clientWidth;
    const drawLeft = viewport.labelWidth;
    const drawRight = width - viewport.scrollbarWidth;
    if (width <= 0 || drawRight <= drawLeft) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(PANEL_HEIGHT * dpr));
    if (this.#canvas.width !== pixelWidth || this.#canvas.height !== pixelHeight) {
      this.#canvas.width = pixelWidth;
      this.#canvas.height = pixelHeight;
    }
    const context = this.#canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, PANEL_HEIGHT);
    context.fillStyle = "#111b2e";
    context.fillRect(0, 0, width, PANEL_HEIGHT);

    const xDomain = this.#xDomain(viewport);
    const visible = this.#visibleRows(xDomain);
    const domains = this.#scaleDomains(visible);
    const projector = makeProjector(
      drawLeft,
      drawRight,
      CHART_TOP,
      PANEL_HEIGHT - CHART_BOTTOM_PADDING,
      xDomain,
      domains,
    );

    drawGrid(context, projector, this.#panel.y_scales[0], domains);

    this.#hits = [];
    for (const [componentIndex, component] of this.#panel.components.entries()) {
      if (component.name === "background/v1") {
        const color = this.#backgroundColor(component);
        if (color !== null) {
          context.fillStyle = color;
          context.fillRect(0, 0, width, PANEL_HEIGHT);
          drawGrid(context, projector, this.#panel.y_scales[0], domains);
        }
        continue;
      }
      if (
        !GRAPH_COMPONENTS.has(component.name) &&
        component.name !== "horizontal-rule/v1"
      ) {
        continue;
      }
      context.save();
      context.beginPath();
      context.rect(
        projector.drawLeft,
        projector.chartTop,
        projector.drawRight - projector.drawLeft,
        projector.chartBottom - projector.chartTop,
      );
      context.clip();
      switch (component.name) {
        case "interval-area/v1":
        case "interval-line/v1":
          this.#drawIntervals(context, projector, component, componentIndex, xDomain);
          break;
        case "line/v1":
          if (hasIntervalChannels(component)) {
            this.#drawIntervalLinearLine(
              context,
              projector,
              component,
              componentIndex,
              xDomain,
            );
          } else {
            this.#drawSortedLine(context, projector, component, componentIndex, xDomain);
          }
          break;
        case "step-line/v1":
          this.#drawSortedLine(context, projector, component, componentIndex, xDomain);
          break;
        case "polyline/v1":
          this.#drawPolyline(context, projector, component, componentIndex);
          break;
        case "horizontal-rule/v1":
          this.#drawHorizontalRule(context, projector, component);
          break;
      }
      context.restore();
    }

    this.#renderReadout();
  }

  #setCollapsed(collapsed: boolean, persist = true): void {
    this.#collapsed = collapsed;
    this.element.classList.toggle("is-collapsed", collapsed);
    const label = this.element.querySelector(".chart-label");
    label?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (persist) writeStorage(this.#collapseKey, collapsed ? "collapsed" : "expanded");
  }

  #showCompatibilityError(): void {
    const unknown = this.#panel.components.find(
      (component) => !SUPPORTED_COMPONENTS.has(component.name),
    );
    if (unknown === undefined) return;
    this.#error.hidden = false;
    this.#error.textContent =
      `This viewer does not implement component ${JSON.stringify(unknown.name)}.`;
    this.#canvas.hidden = true;
    this.#readout.hidden = true;
  }

  #xDomain(viewport: PanelViewport): readonly [number, number] {
    if (this.#panel.x_axis.kind === "time") {
      return nonemptyDomain(viewport.start, viewport.end);
    }
    let min = Infinity;
    let max = -Infinity;
    for (const component of this.#panel.components) {
      if (!GRAPH_COMPONENTS.has(component.name)) continue;
      const record = componentRecord(component);
      const tableName = stringProperty(record, "table");
      if (hasIntervalChannels(component)) {
        const index = this.#intervalIndex(
          tableName,
          stringProperty(record, "start"),
          stringProperty(record, "end"),
        );
        if (index.length === 0) continue;
        min = Math.min(min, index.first);
        max = Math.max(max, index.last);
      } else {
        const index = this.#numericIndex(tableName, stringProperty(record, "x"));
        if (index.length === 0) continue;
        min = Math.min(min, index.first);
        max = Math.max(max, index.last);
      }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 1;
    if (this.#panel.x_axis.min !== undefined) min = this.#panel.x_axis.min;
    if (this.#panel.x_axis.max !== undefined) max = this.#panel.x_axis.max;
    return nonemptyDomain(min, max);
  }

  #visibleRows(xDomain: readonly [number, number]): ReadonlyMap<number, VisibleRows> {
    const rows = new Map<number, VisibleRows>();
    for (const [index, component] of this.#panel.components.entries()) {
      if (!GRAPH_COMPONENTS.has(component.name)) continue;
      const record = componentRecord(component);
      const tableName = stringProperty(record, "table");
      const table = this.#extension.tables.table(tableName);
      let visible: readonly number[];
      if (hasIntervalChannels(component)) {
        visible = this.#intervalIndex(
          tableName,
          stringProperty(record, "start"),
          stringProperty(record, "end"),
        ).rowsInRange(xDomain[0], xDomain[1]);
      } else if (component.name === "polyline/v1") {
        visible = allRows(table);
      } else {
        visible = this.#numericIndex(
          tableName,
          stringProperty(record, "x"),
        ).rowsInRange(xDomain[0], xDomain[1], 1);
      }
      rows.set(index, { table, rows: visible });
    }
    return rows;
  }

  #scaleDomains(visible: ReadonlyMap<number, VisibleRows>): ReadonlyMap<string, ScaleDomain> {
    const extents = new Map<string, ScaleDomain>();
    for (const scale of this.#panel.y_scales) {
      extents.set(scale.name, { min: Infinity, max: -Infinity });
    }
    for (const [componentIndex, component] of this.#panel.components.entries()) {
      if (!GRAPH_COMPONENTS.has(component.name)) continue;
      const record = componentRecord(component);
      const scaleName = optionalString(record.scale) ?? "default";
      const extent = extents.get(scaleName);
      const componentRows = visible.get(componentIndex);
      if (extent === undefined || componentRows === undefined) continue;
      const yColumn = stringProperty(record, "y");
      for (const row of componentRows.rows) {
        const value = numeric(componentRows.table.value(row, yColumn));
        if (value === null) continue;
        extent.min = Math.min(extent.min, value);
        extent.max = Math.max(extent.max, value);
      }
    }
    for (const component of this.#panel.components) {
      if (component.name !== "horizontal-rule/v1") continue;
      const record = componentRecord(component);
      const scaleName = optionalString(record.scale) ?? "default";
      const extent = extents.get(scaleName);
      const value = this.#domainValue(record.value as DomainValue);
      if (extent !== undefined && value !== null) {
        extent.min = Math.min(extent.min, value);
        extent.max = Math.max(extent.max, value);
      }
    }

    for (const scale of this.#panel.y_scales) {
      const extent = extents.get(scale.name)!;
      const declaredMin = this.#domainValue(scale.min);
      const declaredMax = this.#domainValue(scale.max);
      if (!Number.isFinite(extent.min)) extent.min = 0;
      if (!Number.isFinite(extent.max)) extent.max = 1;
      if (scale.include_zero !== false) {
        extent.min = Math.min(0, extent.min);
        extent.max = Math.max(0, extent.max);
      }
      if (declaredMin !== null) extent.min = declaredMin;
      if (declaredMax !== null) extent.max = declaredMax;
      if (!(extent.max > extent.min)) {
        if (extent.min === 0) extent.max = 1;
        else {
          const padding = Math.max(1, Math.abs(extent.min) * 0.05);
          extent.min -= padding;
          extent.max += padding;
        }
      }
      if (declaredMax === null && extent.max > 0 && extent.max < 1) extent.max = 1;
    }
    return extents;
  }

  #drawIntervals(
    context: CanvasRenderingContext2D,
    projector: Projector,
    component: ComponentManifest,
    componentIndex: number,
    xDomain: readonly [number, number],
  ): void {
    const record = componentRecord(component);
    const tableName = stringProperty(record, "table");
    const startColumn = stringProperty(record, "start");
    const endColumn = stringProperty(record, "end");
    const yColumn = stringProperty(record, "y");
    const scale = optionalString(record.scale) ?? "default";
    const table = this.#extension.tables.table(tableName);
    let intervals = this.#intervalIndex(tableName, startColumn, endColumn)
      .entriesInRange(xDomain[0], xDomain[1])
      .flatMap((entry): IndexedInterval[] => {
        const y = numeric(table.value(entry.row, yColumn));
        return y === null ? [] : [entry];
      });
    const drawWidth = projector.drawRight - projector.drawLeft;
    if (intervals.length > drawWidth * 4) {
      intervals = coalesceIntervals(intervals, table, yColumn, projector);
    }
    const channels = Object.freeze({
      start: startColumn,
      end: endColumn,
      y: yColumn,
    });
    let previousLine:
      | { readonly end: number; readonly y: number }
      | null = null;

    for (const interval of intervals) {
      const yValue = numeric(table.value(interval.row, yColumn));
      if (yValue === null || !(interval.end > interval.start)) continue;
      const x1 = projector.xClamped(interval.start);
      const x2 = projector.xClamped(interval.end);
      if (!(x2 > x1)) continue;
      const y = projector.yClamped(scale, yValue);
      const zero = projector.yClamped(scale, 0);
      const color = this.#componentColor(record.color as ColorSpec | undefined, table, interval.row, componentIndex);

      if (component.name === "interval-area/v1") {
        context.save();
        context.globalAlpha = 0.38;
        context.fillStyle = color;
        context.fillRect(x1, Math.min(y, zero), Math.max(1, x2 - x1), Math.abs(zero - y));
        context.restore();
        this.#hits.push({
          table: tableName,
          row: interval.row,
          channels,
          score: (mx, my) =>
            mx >= x1 &&
            mx <= x2 &&
            my >= Math.min(y, zero) &&
            my <= Math.max(y, zero)
              ? 0
              : null,
        });
      } else {
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        if (
          previousLine !== null &&
          previousLine.end === interval.start &&
          interval.start >= projector.xMin &&
          interval.start <= projector.xMax
        ) {
          const connectorX = projector.x(interval.start);
          context.beginPath();
          context.moveTo(connectorX, previousLine.y);
          context.lineTo(connectorX, y);
          context.stroke();
          this.#hits.push(
            lineHit(
              tableName,
              interval.row,
              channels,
              connectorX,
              previousLine.y,
              connectorX,
              y,
            ),
          );
        }
        context.beginPath();
        context.moveTo(x1, y);
        context.lineTo(x2, y);
        context.stroke();
        this.#hits.push(lineHit(tableName, interval.row, channels, x1, y, x2, y));
        previousLine = { end: interval.end, y };
      }
    }
  }

  #drawIntervalLinearLine(
    context: CanvasRenderingContext2D,
    projector: Projector,
    component: ComponentManifest,
    componentIndex: number,
    xDomain: readonly [number, number],
  ): void {
    const record = componentRecord(component);
    const tableName = stringProperty(record, "table");
    const startColumn = stringProperty(record, "start");
    const endColumn = stringProperty(record, "end");
    const yColumn = stringProperty(record, "y");
    const scale = optionalString(record.scale) ?? "default";
    const table = this.#extension.tables.table(tableName);
    let intervals = this.#intervalIndex(tableName, startColumn, endColumn)
      .entriesInRange(xDomain[0], xDomain[1])
      .flatMap((entry): IntervalLineDatum[] => {
        const y = numeric(table.value(entry.row, yColumn));
        return y === null ? [] : [{ ...entry, y }];
      });
    const drawWidth = projector.drawRight - projector.drawLeft;
    if (intervals.length > drawWidth * 4) {
      intervals = coalesceIntervals(intervals, table, yColumn, projector)
        .map((entry) => ({
          ...entry,
          y: numeric(table.value(entry.row, yColumn))!,
        }));
    }
    const channels = Object.freeze({
      start: startColumn,
      end: endColumn,
      y: yColumn,
    });

    for (const segment of intervalLinearSegments(intervals)) {
      const x1 = projector.xClamped(segment.start);
      const x2 = projector.xClamped(segment.end);
      if (!(x2 > x1)) continue;
      const y1 = projector.yClamped(scale, segment.startY);
      const y2 = projector.yClamped(scale, segment.endY);
      context.strokeStyle = this.#componentColor(
        record.color as ColorSpec | undefined,
        table,
        segment.row,
        componentIndex,
      );
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
      this.#hits.push(
        lineHit(tableName, segment.row, channels, x1, y1, x2, y2),
      );
    }
  }

  #drawSortedLine(
    context: CanvasRenderingContext2D,
    projector: Projector,
    component: ComponentManifest,
    componentIndex: number,
    xDomain: readonly [number, number],
  ): void {
    const record = componentRecord(component);
    const tableName = stringProperty(record, "table");
    const xColumn = stringProperty(record, "x");
    const yColumn = stringProperty(record, "y");
    const scale = optionalString(record.scale) ?? "default";
    const table = this.#extension.tables.table(tableName);
    const rows = this.#numericIndex(tableName, xColumn).rowsInRange(
      xDomain[0],
      xDomain[1],
      1,
    );
    const points = rows.map((row): LinePoint => ({
      row,
      x: numeric(table.value(row, xColumn))!,
      y: numeric(table.value(row, yColumn)),
    }));
    const channels = Object.freeze({ x: xColumn, y: yColumn });
    const runs = splitLineRuns(points);
    for (const originalRun of runs) {
      const run = downsampleLine(originalRun, projector);
      if (run.length === 1) {
        const point = run[0]!;
        const x = projector.x(point.x);
        const y = projector.yClamped(scale, point.y!);
        const color = this.#componentColor(
          record.color as ColorSpec | undefined,
          table,
          point.row,
          componentIndex,
        );
        context.fillStyle = color;
        context.fillRect(x - 1.5, y - 1.5, 3, 3);
        this.#hits.push(pointHit(tableName, point.row, channels, x, y));
        continue;
      }
      for (let index = 1; index < run.length; index++) {
        const previous = run[index - 1]!;
        const current = run[index]!;
        const color = this.#componentColor(
          record.color as ColorSpec | undefined,
          table,
          current.row,
          componentIndex,
        );
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.beginPath();
        if (component.name === "step-line/v1") {
          const x1 = projector.x(previous.x);
          const x2 = projector.x(current.x);
          const previousY = projector.yClamped(scale, previous.y!);
          const y = projector.yClamped(scale, current.y!);
          context.moveTo(x1, previousY);
          context.lineTo(x1, y);
          context.lineTo(x2, y);
          context.stroke();
          this.#hits.push(
            lineHit(tableName, current.row, channels, x1, previousY, x1, y),
            lineHit(tableName, current.row, channels, x1, y, x2, y),
          );
        } else {
          const x1 = projector.x(previous.x);
          const y1 = projector.yClamped(scale, previous.y!);
          const x2 = projector.x(current.x);
          const y2 = projector.yClamped(scale, current.y!);
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
          this.#hits.push(lineHit(tableName, current.row, channels, x1, y1, x2, y2));
        }
      }
    }
  }

  #drawPolyline(
    context: CanvasRenderingContext2D,
    projector: Projector,
    component: ComponentManifest,
    componentIndex: number,
  ): void {
    const record = componentRecord(component);
    const tableName = stringProperty(record, "table");
    const xColumn = stringProperty(record, "x");
    const yColumn = stringProperty(record, "y");
    const scale = optionalString(record.scale) ?? "default";
    const table = this.#extension.tables.table(tableName);
    const channels = Object.freeze({ x: xColumn, y: yColumn });
    let previous: LinePoint | null = null;
    table.forEachRow((row) => {
      const x = numeric(table.value(row, xColumn));
      const y = numeric(table.value(row, yColumn));
      if (x === null || y === null) {
        previous = null;
        return;
      }
      const current = { row, x, y };
      if (previous !== null) {
        const x1 = projector.x(previous.x);
        const y1 = projector.yClamped(scale, previous.y!);
        const x2 = projector.x(current.x);
        const y2 = projector.yClamped(scale, current.y);
        if (
          Math.max(x1, x2) >= projector.drawLeft &&
          Math.min(x1, x2) <= projector.drawRight
        ) {
          context.strokeStyle = this.#componentColor(
            record.color as ColorSpec | undefined,
            table,
            row,
            componentIndex,
          );
          context.lineWidth = 2.5;
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
          this.#hits.push(lineHit(tableName, row, channels, x1, y1, x2, y2));
        }
      }
      previous = current;
    });
  }

  #drawHorizontalRule(
    context: CanvasRenderingContext2D,
    projector: Projector,
    component: ComponentManifest,
  ): void {
    const record = componentRecord(component);
    const value = this.#domainValue(record.value as DomainValue);
    if (value === null) return;
    const scale = optionalString(record.scale) ?? "default";
    const y = projector.yClamped(scale, value);
    context.save();
    context.strokeStyle = optionalString(record.color) ?? "#ffcf99";
    context.globalAlpha = 0.72;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.moveTo(projector.drawLeft, y);
    context.lineTo(projector.drawRight, y);
    context.stroke();
    context.restore();
  }

  #componentColor(
    spec: ColorSpec | undefined,
    table: TableStore,
    row: number,
    componentIndex: number,
  ): string {
    if (typeof spec === "string") return spec;
    if (spec !== undefined) {
      const value = numeric(table.value(row, spec.column));
      if (value !== null) return rampColor(spec, value);
    }
    return DEFAULT_COLORS[componentIndex % DEFAULT_COLORS.length]!;
  }

  #backgroundColor(component: ComponentManifest): string | null {
    const value = componentRecord(component).color;
    if (typeof value === "string") return value;
    if (isScalarRef(value)) {
      const scalar = this.#scalar(value);
      return typeof scalar === "string" ? scalar : null;
    }
    return null;
  }

  #renderLegend(): void {
    const signature = JSON.stringify(
      this.#panel.components
        .filter((component) => component.name === "swatch/v1")
        .map((component) => component),
    );
    if (this.#legend.dataset.signature === signature && this.#legend.childNodes.length > 0) {
      return;
    }
    this.#legend.dataset.signature = signature;
    this.#legend.replaceChildren();
    for (const component of this.#panel.components) {
      if (component.name !== "swatch/v1") continue;
      const record = componentRecord(component);
      let text = stringProperty(record, "label");
      if (isScalarRef(record.value)) {
        const ref = record.value as ScalarValueRef;
        const value = this.#scalar(ref);
        if (value === null) continue;
        text += ` (${formatValue(value, ref.unit)})`;
      }
      const item = document.createElement("span");
      item.className = "d9-extension-legend-item";
      const swatch = document.createElement("span");
      swatch.className =
        `d9-extension-legend-swatch is-${stringProperty(record, "shape")}`;
      swatch.style.color = stringProperty(record, "color");
      item.append(swatch);
      item.append(document.createTextNode(text));
      this.#legend.append(item);
    }
    this.#legend.hidden = this.#legend.childNodes.length === 0;
  }

  #renderReadout(): void {
    const values: string[] = [];
    for (const component of this.#panel.components) {
      if (component.name !== "readout/v1") continue;
      const readout = component as unknown as ReadoutComponent;
      const table = this.#extension.tables.table(readout.table);
      for (const item of readout.items) {
        const value = this.#readoutValue(
          table,
          readout.table,
          readout.match,
          item,
        );
        if (value === null) continue;
        values.push(`${item.label} ${formatValue(value, item.unit)}`);
      }
    }
    this.#readout.textContent = values.join(" · ");
    this.#readout.hidden = values.length === 0;
  }

  #readoutValue(
    table: TableStore,
    tableName: string,
    match: Readonly<Record<string, string>> | undefined,
    item: ReadoutItem,
  ): CellValue {
    if (item.sample !== undefined || item.reduce === undefined) {
      if (item.sample === "cursor") {
        const row = this.#rowAtCursor(tableName, match);
        return row === null ? null : table.value(row, item.column);
      }
      if (
        this.#currentHit?.table !== tableName ||
        !channelsMatch(this.#currentHit.channels, match)
      ) {
        return null;
      }
      return table.value(this.#currentHit.row, item.column);
    }
    const viewport = this.#viewport;
    if (viewport === null) return null;
    const range =
      this.#panel.x_axis.kind === "time"
        ? ([viewport.start, viewport.end] as const)
        : this.#xDomain(viewport);
    return this.#reduceViewport(
      tableName,
      table,
      item.column,
      item.reduce,
      range,
      match,
    );
  }

  #reduceViewport(
    tableName: string,
    table: TableStore,
    column: string,
    reducer: Reducer,
    range: readonly [number, number],
    match: Readonly<Record<string, string>> | undefined,
  ): number | null {
    const cacheKey =
      `${tableName}:${column}:${JSON.stringify(reducer)}:${JSON.stringify(match)}:${range[0]}:${range[1]}`;
    if (this.#reductionCache.has(cacheKey)) {
      return this.#reductionCache.get(cacheKey) ?? null;
    }
    let result: number | null;
    if (typeof reducer !== "string") {
      const rows = this.#intervalIndex(tableName, reducer.start, reducer.end)
        .rowsInRange(range[0], range[1]);
      let weighted = 0;
      let weight = 0;
      for (const row of rows) {
        const value = numeric(table.value(row, column));
        const start = numeric(table.value(row, reducer.start));
        const end = numeric(table.value(row, reducer.end));
        if (value === null || start === null || end === null) continue;
        const overlap =
          Math.min(end, range[1]) - Math.max(start, range[0]);
        if (!(overlap > 0)) continue;
        weighted += value * overlap;
        weight += overlap;
      }
      result = weight > 0 ? weighted / weight : null;
    } else {
      const rows = this.#rowsForTableRange(tableName, range, match);
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const row of rows) {
        const value = numeric(table.value(row, column));
        if (value === null) continue;
        count++;
        sum += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      switch (reducer) {
        case "count":
          result = count;
          break;
        case "sum":
          result = count > 0 ? sum : null;
          break;
        case "mean":
          result = count > 0 ? sum / count : null;
          break;
        case "min":
          result = count > 0 ? min : null;
          break;
        case "max":
          result = count > 0 ? max : null;
          break;
      }
    }
    this.#reductionCache.set(cacheKey, result);
    return result;
  }

  #rowsForTableRange(
    tableName: string,
    range: readonly [number, number],
    match?: Readonly<Record<string, string>>,
  ): readonly number[] {
    const mapping = this.#matchedTableChannels(tableName, match);
    if (match !== undefined && mapping === null) return [];
    if (mapping?.start !== undefined && mapping.end !== undefined) {
      return this.#intervalIndex(tableName, mapping.start, mapping.end)
        .rowsInRange(range[0], range[1]);
    }
    if (mapping?.x !== undefined) {
      return this.#numericIndex(tableName, mapping.x)
        .rowsInRange(range[0], range[1]);
    }
    return allRows(this.#extension.tables.table(tableName));
  }

  #rowAtCursor(
    tableName: string,
    match?: Readonly<Record<string, string>>,
  ): number | null {
    if (this.#pointerX === null) return null;
    const mapping = this.#matchedTableChannels(tableName, match);
    if (mapping?.start !== undefined && mapping.end !== undefined) {
      const rows = this.#intervalIndex(tableName, mapping.start, mapping.end)
        .entriesInRange(this.#pointerX, this.#pointerX);
      return rows.length === 0 ? null : rows[rows.length - 1]!.row;
    }
    if (mapping?.x !== undefined) {
      return this.#numericIndex(tableName, mapping.x).nearestRow(this.#pointerX);
    }
    return null;
  }

  #matchedTableChannels(
    tableName: string,
    match: Readonly<Record<string, string>> | undefined,
  ): Readonly<Record<string, string>> | null {
    if (match === undefined) return this.#tableChannels(tableName);
    for (const component of this.#panel.components) {
      if (!GRAPH_COMPONENTS.has(component.name)) continue;
      const record = componentRecord(component);
      if (record.table !== tableName) continue;
      const channels = hasIntervalChannels(component)
        ? {
            start: stringProperty(record, "start"),
            end: stringProperty(record, "end"),
            y: stringProperty(record, "y"),
          }
        : {
            x: stringProperty(record, "x"),
            y: stringProperty(record, "y"),
          };
      if (channelsMatch(channels, match)) return channels;
    }
    return null;
  }

  #tableChannels(tableName: string): Readonly<Record<string, string>> | null {
    for (const component of this.#panel.components) {
      if (!GRAPH_COMPONENTS.has(component.name)) continue;
      const record = componentRecord(component);
      if (record.table !== tableName) continue;
      if (hasIntervalChannels(component)) {
        return {
          start: stringProperty(record, "start"),
          end: stringProperty(record, "end"),
          y: stringProperty(record, "y"),
        };
      }
      return {
        x: stringProperty(record, "x"),
        y: stringProperty(record, "y"),
      };
    }
    return null;
  }

  #domainValue(value: DomainValue | undefined): number | null {
    if (value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return numeric(this.#scalar(value));
  }

  #scalar(reference: ScalarRef): CellValue {
    const table = this.#extension.tables.table(reference.table);
    if (table.rowCount === 0) return null;
    if (reference.select === "last") {
      return table.value(table.rowCount - 1, reference.column);
    }
    if (reference.reduce === undefined || reference.select === "first") {
      return table.value(0, reference.column);
    }
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    table.forEachRow((row) => {
      const value = numeric(table.value(row, reference.column));
      if (value === null) return;
      count++;
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    switch (reference.reduce) {
      case "count":
        return count;
      case "sum":
        return count > 0 ? sum : null;
      case "mean":
        return count > 0 ? sum / count : null;
      case "min":
        return count > 0 ? min : null;
      case "max":
        return count > 0 ? max : null;
    }
  }

  #numericIndex(table: string, column: string): NumericRowIndex {
    const key = `point:${table}:${column}`;
    const cached = this.#indexCache.get(key);
    if (cached instanceof NumericRowIndex) return cached;
    const index = new NumericRowIndex(this.#extension.tables.table(table), column);
    this.#indexCache.set(key, index);
    return index;
  }

  #intervalIndex(table: string, start: string, end: string): IntervalRowIndex {
    const key = `interval:${table}:${start}:${end}`;
    const cached = this.#indexCache.get(key);
    if (cached instanceof IntervalRowIndex) return cached;
    const index = new IntervalRowIndex(this.#extension.tables.table(table), start, end);
    this.#indexCache.set(key, index);
    return index;
  }

  #onMouseMove(event: MouseEvent): void {
    if (this.#viewport === null || this.#collapsed || !this.#error.hidden) return;
    const rect = this.#canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const drawLeft = this.#viewport.labelWidth;
    const drawRight = rect.width - this.#viewport.scrollbarWidth;
    if (x < drawLeft || x > drawRight) {
      this.#onMouseLeave();
      return;
    }
    const xDomain = this.#xDomain(this.#viewport);
    this.#pointerX =
      xDomain[0] +
      ((x - drawLeft) / Math.max(1, drawRight - drawLeft)) *
        (xDomain[1] - xDomain[0]);
    let hit: ComponentHit | null = null;
    for (let index = this.#hits.length - 1; index >= 0; index--) {
      const candidate = this.#hits[index]!;
      if (candidate.score(x, y) !== null) {
        hit = candidate;
        break;
      }
    }
    this.#currentHit = hit;
    this.#canvas.style.cursor = hit === null ? "default" : "crosshair";
    this.#renderReadout();
    if (hit === null) {
      this.#hideTooltip();
      return;
    }
    const tooltip = this.#tooltipForHit(hit);
    if (tooltip === null) {
      this.#hideTooltip();
      return;
    }
    this.#showTooltip(tooltip, hit, event);
  }

  #onMouseLeave(): void {
    this.#currentHit = null;
    this.#pointerX = null;
    this.#canvas.style.cursor = "default";
    this.#renderReadout();
    this.#hideTooltip();
  }

  #tooltipForHit(hit: ComponentHit): TooltipComponent | null {
    for (const component of this.#panel.components) {
      if (component.name !== "tooltip/v1") continue;
      const tooltip = component as unknown as TooltipComponent;
      if (tooltip.table !== hit.table) continue;
      if (!channelsMatch(hit.channels, tooltip.match)) continue;
      return tooltip;
    }
    return null;
  }

  #showTooltip(
    component: TooltipComponent,
    hit: ComponentHit,
    event: MouseEvent,
  ): void {
    const table = this.#extension.tables.table(hit.table);
    const fragment = document.createDocumentFragment();
    let rendered = 0;
    for (const item of component.items) {
      const value = table.value(hit.row, item.column);
      if (value === null || value === "") continue;
      if (rendered > 0) fragment.append(document.createElement("br"));
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = `${item.label}:`;
      const formatted = document.createElement("span");
      formatted.className = "value";
      formatted.textContent = formatTooltipValue(
        value,
        item.unit,
        this.#viewport?.formatTimestamp,
      );
      fragment.append(label, document.createTextNode(" "), formatted);
      rendered++;
    }
    if (rendered === 0) {
      this.#hideTooltip();
      return;
    }
    this.#tooltip.replaceChildren(fragment);
    this.#tooltip.dataset.extensionPanel = this.element.dataset.panelKey ?? "";
    this.#tooltip.style.display = "block";
    placeTooltip(this.#tooltip, event);
  }

  #hideTooltip(): void {
    if (
      this.#tooltip.dataset.extensionPanel !== undefined &&
      this.#tooltip.dataset.extensionPanel !== this.element.dataset.panelKey
    ) {
      return;
    }
    delete this.#tooltip.dataset.extensionPanel;
    this.#tooltip.style.display = "none";
  }
}

class NumericRowIndex {
  readonly #entries: readonly IndexedRow[];

  constructor(table: TableStore, column: string) {
    const entries: IndexedRow[] = [];
    table.forEachRow((row, batch, localRow) => {
      const value = numeric(chunkValue(batch.columns[table.columnIndex(column)]!, localRow));
      if (value !== null) entries.push({ row, value });
    });
    entries.sort((left, right) => left.value - right.value || left.row - right.row);
    this.#entries = entries;
  }

  get length(): number {
    return this.#entries.length;
  }

  get first(): number {
    return this.#entries[0]?.value ?? 0;
  }

  get last(): number {
    return this.#entries[this.#entries.length - 1]?.value ?? 1;
  }

  rowsInRange(min: number, max: number, margin = 0): readonly number[] {
    if (this.#entries.length === 0) return [];
    const start = Math.max(0, lowerBound(this.#entries, min, (entry) => entry.value) - margin);
    const end = Math.min(
      this.#entries.length,
      upperBound(this.#entries, max, (entry) => entry.value) + margin,
    );
    return this.#entries.slice(start, end).map((entry) => entry.row);
  }

  nearestRow(value: number): number | null {
    if (this.#entries.length === 0) return null;
    const index = lowerBound(this.#entries, value, (entry) => entry.value);
    if (index === 0) return this.#entries[0]!.row;
    if (index === this.#entries.length) return this.#entries[index - 1]!.row;
    const before = this.#entries[index - 1]!;
    const after = this.#entries[index]!;
    return value - before.value <= after.value - value ? before.row : after.row;
  }
}

class IntervalRowIndex {
  readonly #entries: readonly IndexedInterval[];
  readonly #prefixMax: Float64Array;

  constructor(table: TableStore, startColumn: string, endColumn: string) {
    const entries: IndexedInterval[] = [];
    const startIndex = table.columnIndex(startColumn);
    const endIndex = table.columnIndex(endColumn);
    table.forEachRow((row, batch, localRow) => {
      const start = numeric(chunkValue(batch.columns[startIndex]!, localRow));
      const end = numeric(chunkValue(batch.columns[endIndex]!, localRow));
      if (start !== null && end !== null) entries.push({ row, start, end });
    });
    entries.sort((left, right) => left.start - right.start || left.row - right.row);
    this.#entries = entries;
    this.#prefixMax = new Float64Array(entries.length);
    let max = -Infinity;
    for (let index = 0; index < entries.length; index++) {
      max = Math.max(max, entries[index]!.end);
      this.#prefixMax[index] = max;
    }
  }

  get length(): number {
    return this.#entries.length;
  }

  get first(): number {
    return this.#entries[0]?.start ?? 0;
  }

  get last(): number {
    return this.#prefixMax[this.#prefixMax.length - 1] ?? 1;
  }

  entriesInRange(min: number, max: number): IndexedInterval[] {
    const end = upperBound(this.#entries, max, (entry) => entry.start);
    const start = lowerBoundArray(this.#prefixMax, min);
    const result: IndexedInterval[] = [];
    for (let index = start; index < end; index++) {
      const entry = this.#entries[index]!;
      if (entry.end >= min) result.push(entry);
    }
    return result;
  }

  rowsInRange(min: number, max: number): readonly number[] {
    return this.entriesInRange(min, max).map((entry) => entry.row);
  }
}

function makeProjector(
  drawLeft: number,
  drawRight: number,
  chartTop: number,
  chartBottom: number,
  xDomain: readonly [number, number],
  scales: ReadonlyMap<string, ScaleDomain>,
): Projector {
  const xSpan = xDomain[1] - xDomain[0];
  const x = (value: number): number =>
    drawLeft + ((value - xDomain[0]) / xSpan) * (drawRight - drawLeft);
  const y = (scaleName: string, value: number): number => {
    const scale = scales.get(scaleName) ?? scales.values().next().value as ScaleDomain;
    return (
      chartBottom -
      ((value - scale.min) / (scale.max - scale.min)) *
        (chartBottom - chartTop)
    );
  };
  return {
    chartTop,
    chartBottom,
    drawLeft,
    drawRight,
    xMin: xDomain[0],
    xMax: xDomain[1],
    x,
    xClamped: (value) => clamp(x(value), drawLeft, drawRight),
    y,
    yClamped: (scale, value) => clamp(y(scale, value), chartTop, chartBottom),
  };
}

function drawGrid(
  context: CanvasRenderingContext2D,
  projector: Projector,
  primaryScale: ScaleManifest | undefined,
  domains: ReadonlyMap<string, ScaleDomain>,
): void {
  const scaleName = primaryScale?.name ?? "default";
  const domain = domains.get(scaleName) ?? domains.values().next().value as ScaleDomain;
  context.strokeStyle = "rgba(255,255,255,0.07)";
  context.lineWidth = 1;
  for (let index = 1; index <= 3; index++) {
    const y =
      projector.chartTop +
      ((projector.chartBottom - projector.chartTop) * index) / 4;
    context.beginPath();
    context.moveTo(projector.drawLeft, y);
    context.lineTo(projector.drawRight, y);
    context.stroke();
  }
  context.fillStyle = "#667";
  context.font = "10px monospace";
  context.textAlign = "right";
  context.fillText(formatTick(domain.max), projector.drawLeft - 6, projector.chartTop + 9);
  context.fillText(formatTick(domain.min), projector.drawLeft - 6, projector.chartBottom);
}

function splitLineRuns(points: readonly LinePoint[]): LinePoint[][] {
  const runs: LinePoint[][] = [];
  let run: LinePoint[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function channelsMatch(
  channels: Readonly<Record<string, string>>,
  match: Readonly<Record<string, string>> | undefined,
): boolean {
  return (
    match === undefined ||
    Object.entries(match).every(([channel, column]) => channels[channel] === column)
  );
}

function hasIntervalChannels(component: ComponentManifest): boolean {
  const record = componentRecord(component);
  return (
    component.name.startsWith("interval-") ||
    (component.name === "line/v1" &&
      typeof record.start === "string" &&
      typeof record.end === "string")
  );
}

function intervalLinearSegments(
  intervals: readonly IntervalLineDatum[],
): IntervalLineSegment[] {
  return intervals.flatMap((interval, index): IntervalLineSegment[] => {
    if (!(interval.end > interval.start)) return [];
    const next = intervals[index + 1];
    const endY =
      next !== undefined && interval.end === next.start ? next.y : interval.y;
    return [{
      row: interval.row,
      start: interval.start,
      end: interval.end,
      startY: interval.y,
      endY,
    }];
  });
}

function downsampleLine(
  points: readonly LinePoint[],
  projector: Projector,
): readonly LinePoint[] {
  const width = Math.max(1, Math.floor(projector.drawRight - projector.drawLeft));
  if (points.length <= width * 4) return points;
  const kept: number[] = [];
  let start = 0;
  while (start < points.length) {
    const pixel = Math.floor(projector.x(points[start]!.x));
    let end = start + 1;
    let min = start;
    let max = start;
    while (end < points.length && Math.floor(projector.x(points[end]!.x)) === pixel) {
      if (points[end]!.y! < points[min]!.y!) min = end;
      if (points[end]!.y! > points[max]!.y!) max = end;
      end++;
    }
    kept.push(start, min, max, end - 1);
    start = end;
  }
  const unique = [...new Set(kept)].sort((left, right) => left - right);
  return unique.map((index) => points[index]!);
}

function coalesceIntervals(
  intervals: readonly IndexedInterval[],
  table: TableStore,
  yColumn: string,
  projector: Projector,
): IndexedInterval[] {
  const result: IndexedInterval[] = [];
  let start = 0;
  while (start < intervals.length) {
    const pixel = Math.floor(projector.xClamped(intervals[start]!.start));
    let end = start + 1;
    let representative = intervals[start]!;
    let max = numeric(table.value(representative.row, yColumn)) ?? -Infinity;
    let groupStart = representative.start;
    let groupEnd = representative.end;
    while (
      end < intervals.length &&
      Math.floor(projector.xClamped(intervals[end]!.start)) === pixel
    ) {
      const candidate = intervals[end]!;
      groupStart = Math.min(groupStart, candidate.start);
      groupEnd = Math.max(groupEnd, candidate.end);
      const value = numeric(table.value(candidate.row, yColumn));
      if (value !== null && value > max) {
        representative = candidate;
        max = value;
      }
      end++;
    }
    result.push({
      row: representative.row,
      start: groupStart,
      end: groupEnd,
    });
    start = end;
  }
  return result;
}

function lineHit(
  table: string,
  row: number,
  channels: Readonly<Record<string, string>>,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): ComponentHit {
  return {
    table,
    row,
    channels,
    score: (x, y) => {
      const distance = pointToSegmentDistance(x, y, x1, y1, x2, y2);
      return distance <= HIT_TOLERANCE ? distance : null;
    },
  };
}

function pointHit(
  table: string,
  row: number,
  channels: Readonly<Record<string, string>>,
  x: number,
  y: number,
): ComponentHit {
  return {
    table,
    row,
    channels,
    score: (mx, my) => {
      const distance = Math.hypot(mx - x, my - y);
      return distance <= HIT_TOLERANCE ? distance : null;
    },
  };
}

export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const position = clamp(
    ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy),
    0,
    1,
  );
  return Math.hypot(
    px - (x1 + position * dx),
    py - (y1 + position * dy),
  );
}

export function formatValue(value: CellValue, unit?: string): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  const number = typeof value === "bigint" ? Number(value) : value;
  if (unit === "ns") return formatDuration(number);
  if (unit === "%") return `${trimFixed(number, 1)}%`;
  const formatted = formatNumber(number);
  return unit === undefined ? formatted : `${formatted} ${unit}`;
}

export function formatTooltipValue(
  value: CellValue,
  unit: string | undefined,
  formatTimestamp?: (timestamp: number) => string,
): string {
  if (unit !== "timestamp") return formatValue(value, unit);
  const timestamp = numeric(value);
  if (timestamp === null) return "";
  return formatTimestamp?.(timestamp) ?? formatDuration(timestamp);
}

function formatDuration(nanoseconds: number): string {
  const value = Math.abs(nanoseconds);
  if (value < 1_000) return `${trimFixed(nanoseconds, 0)}ns`;
  if (value < 1_000_000) return `${trimFixed(nanoseconds / 1_000, 2)}µs`;
  if (value < 1_000_000_000) return `${trimFixed(nanoseconds / 1_000_000, 2)}ms`;
  return `${trimFixed(nanoseconds / 1_000_000_000, 2)}s`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return trimFixed(value, digits);
}

function formatTick(value: number): string {
  if (Math.abs(value) >= 10_000) return value.toExponential(1);
  return formatNumber(value);
}

function trimFixed(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function rampColor(ramp: ColorRamp, value: number): string {
  const stops = ramp.stops;
  if (value <= stops[0]!.value) return stops[0]!.color;
  if (value >= stops[stops.length - 1]!.value) return stops[stops.length - 1]!.color;
  for (let index = 1; index < stops.length; index++) {
    const right = stops[index]!;
    if (value > right.value) continue;
    const left = stops[index - 1]!;
    const amount = (value - left.value) / (right.value - left.value || 1);
    const leftRgb = parseHexColor(left.color);
    const rightRgb = parseHexColor(right.color);
    if (leftRgb === null || rightRgb === null) return amount < 0.5 ? left.color : right.color;
    const channels = leftRgb.map(
      (channel, channelIndex) =>
        Math.round(channel + (rightRgb[channelIndex]! - channel) * amount),
    );
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
  }
  return stops[stops.length - 1]!.color;
}

function parseHexColor(color: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (match === null) return null;
  const hex = match[1]!;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function placeTooltip(tooltip: HTMLElement, event: MouseEvent): void {
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const x = Math.min(event.clientX + 12, window.innerWidth - width - 8);
  let y = event.clientY + 16;
  if (y + height > window.innerHeight - 8) y = event.clientY - height - 8;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function componentRecord(
  component: ComponentManifest,
): Readonly<Record<string, unknown>> {
  return component;
}

function stringProperty(
  record: Readonly<Record<string, unknown>>,
  property: string,
): string {
  const value = record[property];
  if (typeof value !== "string") {
    throw new Error(`validated component property ${property} is not a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isScalarRef(value: unknown): value is ScalarRef {
  return typeof value === "object" && value !== null && "table" in value && "column" in value;
}

function numeric(value: CellValue): number | null {
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function allRows(table: TableStore): readonly number[] {
  return Array.from({ length: table.rowCount }, (_, index) => index);
}

function nonemptyDomain(min: number, max: number): readonly [number, number] {
  if (max > min) return [min, max];
  return [min, min + 1];
}

function lowerBound<T>(
  values: readonly T[],
  target: number,
  value: (entry: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (value(values[middle]!) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound<T>(
  values: readonly T[],
  target: number,
  value: (entry: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (value(values[middle]!) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBoundArray(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is optional when storage is unavailable.
  }
}
