import type { Cell, ExtensionStore } from "./columnar.js";
import { ColumnReader, TableReader } from "./data.js";
import { formatAxisValue, formatExtensionValue } from "./format.js";
import {
  clipSegment,
  pointToSegmentDistance,
  type Rectangle,
  type Segment,
} from "./geometry.js";
import type {
  ComponentMatch,
  DisplayItem,
  DrawingComponent,
  FixedScaleDomain,
  HorizontalRuleComponent,
  IntervalAreaComponent,
  IntervalLineComponent,
  NumericValue,
  PanelSpec,
  PointLineComponent,
  PresentationComponent,
  ReadoutComponent,
  ReadoutItem,
  ScaleSpec,
  SeriesColor,
  SwatchComponent,
  TooltipComponent,
} from "./manifest.js";
import {
  minMaxRowsByPixel,
  SAMPLE_GAP,
} from "./sampling.js";

export interface PanelViewport {
  readonly start: number;
  readonly end: number;
  readonly width: number;
  readonly height: number;
  readonly labelWidth: number;
  readonly rightInset?: number;
}

export interface PanelHit {
  readonly instanceId: string;
  readonly panelIndex: number;
  readonly componentIndex: number;
  readonly table: string;
  readonly row: number;
  readonly channels: Readonly<Record<string, string>>;
}

export interface PresentedValue {
  readonly label: string;
  readonly value: string;
}

export interface PresentedSwatch {
  readonly label: string;
  readonly color: string;
  readonly sample: "line" | "area" | "rule";
  readonly value?: string;
}

export interface PanelPresentation {
  readonly swatches: readonly PresentedSwatch[];
  readonly readout: readonly PresentedValue[];
}

interface SortedColumnIndex {
  readonly values: Float64Array;
  readonly rows: Uint32Array;
  lowerBound(value: number): number;
  upperBound(value: number): number;
  nearestRow(value: number): number | undefined;
  rowRange(
    start: number,
    end: number,
    pad: number,
  ): readonly [number, number];
}

interface BackgroundRuntime {
  readonly kind: "background";
  readonly componentIndex: number;
  readonly spec: Extract<DrawingComponent, { name: "background/v1" }>;
  readonly channels: Readonly<Record<string, string>>;
}

interface IntervalRuntime {
  readonly kind: "interval";
  readonly componentIndex: number;
  readonly spec: IntervalAreaComponent | IntervalLineComponent;
  readonly table: TableReader;
  readonly start: ColumnReader;
  readonly end: ColumnReader;
  readonly y: ColumnReader;
  readonly color: ColumnReader | undefined;
  readonly startIndex: SortedColumnIndex;
  readonly prefixMaxEnd: Float64Array;
  readonly channels: Readonly<Record<string, string>>;
}

interface PointRuntime {
  readonly kind: "point";
  readonly componentIndex: number;
  readonly spec: PointLineComponent;
  readonly table: TableReader;
  readonly x: ColumnReader;
  readonly y: ColumnReader;
  readonly color: ColumnReader | undefined;
  readonly xIndex: SortedColumnIndex | undefined;
  readonly channels: Readonly<Record<string, string>>;
}

interface RuleRuntime {
  readonly kind: "rule";
  readonly componentIndex: number;
  readonly spec: HorizontalRuleComponent;
  readonly channels: Readonly<Record<string, string>>;
}

type DrawingRuntime =
  | BackgroundRuntime
  | IntervalRuntime
  | PointRuntime
  | RuleRuntime;

interface Layout {
  readonly viewport: PanelViewport;
  readonly xStart: number;
  readonly xEnd: number;
  readonly drawWidth: number;
  readonly chartTop: number;
  readonly chartHeight: number;
  readonly domains: ReadonlyMap<string, readonly [number, number]>;
}

function* drawingRows(
  start: number,
  end: number,
  sampled: readonly number[] | null,
): Generator<number> {
  if (sampled !== null) {
    yield* sampled;
    return;
  }
  for (let row = start; row < end; row += 1) yield row;
}

function makeSortedIndex(column: ColumnReader): SortedColumnIndex {
  const values: number[] = [];
  const rows: number[] = [];
  let prior = -Infinity;
  for (let row = 0; row < column.rowCount; row += 1) {
    const value = column.number(row);
    if (value === null) continue;
    if (value < prior) {
      throw new Error(
        `${column.schema.name} must be nondecreasing; use polyline/v1 for source-order paths`,
      );
    }
    prior = value;
    values.push(value);
    rows.push(row);
  }
  const numeric = new Float64Array(values);
  const sourceRows = new Uint32Array(rows);
  const lowerBound = (value: number): number => {
    let low = 0;
    let high = numeric.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (numeric[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const upperBound = (value: number): number => {
    let low = 0;
    let high = numeric.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (numeric[middle]! <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    values: numeric,
    rows: sourceRows,
    lowerBound,
    upperBound,
    nearestRow(value): number | undefined {
      const at = lowerBound(value);
      if (at === 0) return sourceRows[0];
      if (at === numeric.length) return sourceRows.at(-1);
      return value - numeric[at - 1]! <= numeric[at]! - value
        ? sourceRows[at - 1]
        : sourceRows[at];
    },
    rowRange(start, end, pad): readonly [number, number] {
      if (numeric.length === 0) return [0, 0];
      const firstIndex = Math.max(0, lowerBound(start) - pad);
      const lastIndex = Math.min(numeric.length, upperBound(end) + pad);
      if (firstIndex >= lastIndex) return [0, 0];
      return [
        sourceRows[firstIndex]!,
        sourceRows[lastIndex - 1]! + 1,
      ];
    },
  };
}

function channelsMatch(
  channels: Readonly<Record<string, string>>,
  match: ComponentMatch | undefined,
): boolean {
  if (match === undefined) return true;
  for (const key of ["x", "start", "end", "y"] as const) {
    const expected = match[key];
    if (expected !== undefined && channels[key] !== expected) return false;
  }
  return true;
}

function hexColor(value: string): readonly [number, number, number] | undefined {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short !== null) {
    return [
      Number.parseInt(short[1]! + short[1]!, 16),
      Number.parseInt(short[2]! + short[2]!, 16),
      Number.parseInt(short[3]! + short[3]!, 16),
    ];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return long === null
    ? undefined
    : [
        Number.parseInt(long[1]!, 16),
        Number.parseInt(long[2]!, 16),
        Number.parseInt(long[3]!, 16),
      ];
}

function interpolateColor(
  start: string,
  end: string,
  ratio: number,
): string {
  const a = hexColor(start);
  const b = hexColor(end);
  if (a === undefined || b === undefined) return ratio < 0.5 ? start : end;
  const channel = (index: number): number =>
    Math.round(a[index]! + (b[index]! - a[index]!) * ratio);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function rampColor(color: SeriesColor, value: number | null): string {
  if (typeof color === "string") return color;
  const stops = color.stops;
  if (value === null || value <= stops[0]!.at) return stops[0]!.color;
  if (value >= stops.at(-1)!.at) return stops.at(-1)!.color;
  for (let index = 1; index < stops.length; index += 1) {
    const right = stops[index]!;
    if (value <= right.at) {
      const left = stops[index - 1]!;
      return interpolateColor(
        left.color,
        right.color,
        (value - left.at) / (right.at - left.at),
      );
    }
  }
  return stops.at(-1)!.color;
}

export class ExtensionPanel {
  readonly instanceId: string;
  readonly panelIndex: number;
  readonly spec: PanelSpec;
  readonly error: string | undefined;
  readonly #store: ExtensionStore;
  readonly #tables = new Map<string, TableReader>();
  readonly #sortedIndexes = new Map<ColumnReader, SortedColumnIndex>();
  readonly #drawings: DrawingRuntime[] = [];
  readonly #presentations: PresentationComponent[] = [];
  readonly #linearDomain: readonly [number, number] | undefined;

  constructor(
    instanceId: string,
    store: ExtensionStore,
    spec: PanelSpec,
    panelIndex: number,
  ) {
    this.instanceId = instanceId;
    this.panelIndex = panelIndex;
    this.spec = spec;
    this.#store = store;
    let error: string | undefined;
    try {
      for (const [componentIndex, component] of spec.components.entries()) {
        if ("unsupported" in component) {
          throw new Error(`Viewer does not support component ${component.name}`);
        }
        switch (component.name) {
          case "background/v1":
          case "interval-area/v1":
          case "interval-line/v1":
          case "line/v1":
          case "step-line/v1":
          case "polyline/v1":
          case "horizontal-rule/v1":
            this.#drawings.push(
              this.#compileDrawing(component, componentIndex),
            );
            break;
          case "tooltip/v1":
          case "readout/v1":
          case "swatch/v1":
            this.#presentations.push(component);
            break;
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    this.error = error;
    this.#linearDomain =
      spec.x_axis.type === "linear"
        ? spec.x_axis.domain ?? this.#deriveLinearDomain()
        : undefined;
  }

  render(
    context: CanvasRenderingContext2D,
    viewport: PanelViewport,
  ): void {
    const layout = this.#layout(viewport);
    const { width, height, labelWidth } = viewport;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111b2e";
    context.fillRect(0, 0, width, height);
    if (this.error !== undefined || layout.drawWidth <= 0) return;

    for (const drawing of this.#drawings) {
      if (drawing.kind !== "background") continue;
      const value =
        typeof drawing.spec.color === "string"
          ? drawing.spec.color
          : this.#cellValue(
              drawing.spec.color.table,
              drawing.spec.color.column,
            );
      if (typeof value === "string") {
        context.fillStyle = value;
        context.fillRect(0, 0, width, height);
      }
    }

    const firstDomain = this.spec.scales[0];
    if (firstDomain !== undefined) {
      const domain = layout.domains.get(firstDomain.name);
      if (domain !== undefined) {
        context.fillStyle = "#667";
        context.font = "10px monospace";
        context.textAlign = "right";
        context.fillText(
          formatAxisValue(domain[1]),
          labelWidth - 6,
          layout.chartTop + 9,
        );
        context.fillText(
          formatAxisValue(domain[0]),
          labelWidth - 6,
          layout.chartTop + layout.chartHeight,
        );
      }
    }
    context.strokeStyle = "rgba(255,255,255,0.07)";
    context.lineWidth = 1;
    context.setLineDash([]);
    for (let index = 1; index <= 3; index += 1) {
      const y = layout.chartTop + (layout.chartHeight * index) / 4;
      context.beginPath();
      context.moveTo(labelWidth, y);
      context.lineTo(labelWidth + layout.drawWidth, y);
      context.stroke();
    }

    context.save();
    context.beginPath();
    context.rect(
      labelWidth,
      layout.chartTop,
      layout.drawWidth,
      layout.chartHeight,
    );
    context.clip();
    for (const drawing of this.#drawings) {
      this.#draw(context, layout, drawing);
    }
    context.restore();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  hitTest(
    x: number,
    y: number,
    viewport: PanelViewport,
  ): PanelHit | undefined {
    if (this.error !== undefined) return undefined;
    const layout = this.#layout(viewport);
    if (
      x < viewport.labelWidth ||
      x > viewport.labelWidth + layout.drawWidth ||
      y < layout.chartTop ||
      y > layout.chartTop + layout.chartHeight
    ) {
      return undefined;
    }
    for (let index = this.#drawings.length - 1; index >= 0; index -= 1) {
      const drawing = this.#drawings[index]!;
      const row = this.#hitDrawing(drawing, x, y, layout);
      if (row !== undefined && "table" in drawing) {
        return {
          instanceId: this.instanceId,
          panelIndex: this.panelIndex,
          componentIndex: drawing.componentIndex,
          table: drawing.table.table.schema.name,
          row,
          channels: drawing.channels,
        };
      }
    }
    return undefined;
  }

  tooltip(hit: PanelHit): readonly PresentedValue[] {
    const result: PresentedValue[] = [];
    for (const component of this.#presentations) {
      if (
        component.name !== "tooltip/v1" ||
        component.table !== hit.table ||
        !channelsMatch(hit.channels, component.match)
      ) {
        continue;
      }
      const table = this.#table(component.table);
      for (const item of component.items) {
        const value = table.column(item.column).cell(hit.row);
        if (value === null) continue;
        result.push({
          label: item.label,
          value: formatExtensionValue(
            value,
            item.unit,
          ),
        });
      }
    }
    return result;
  }

  presentation(
    viewport: PanelViewport,
    pointerX: number | null,
  ): PanelPresentation {
    if (this.error !== undefined) return { swatches: [], readout: [] };
    const layout = this.#layout(viewport);
    const swatches: PresentedSwatch[] = [];
    const readout: PresentedValue[] = [];
    for (const component of this.#presentations) {
      if (component.name === "swatch/v1") {
        swatches.push(this.#swatch(component));
      } else if (component.name === "readout/v1") {
        readout.push(...this.#readout(component, layout, pointerX));
      }
    }
    return { swatches, readout };
  }

  xValueAt(pixelX: number, viewport: PanelViewport): number | null {
    const layout = this.#layout(viewport);
    if (
      pixelX < viewport.labelWidth ||
      pixelX > viewport.labelWidth + layout.drawWidth
    ) {
      return null;
    }
    return (
      layout.xStart +
      ((pixelX - viewport.labelWidth) / layout.drawWidth) *
        (layout.xEnd - layout.xStart)
    );
  }

  #table(name: string): TableReader {
    let table = this.#tables.get(name);
    if (table !== undefined) return table;
    table = new TableReader(this.#store.table(name));
    this.#tables.set(name, table);
    return table;
  }

  #index(column: ColumnReader): SortedColumnIndex {
    let index = this.#sortedIndexes.get(column);
    if (index !== undefined) return index;
    index = makeSortedIndex(column);
    this.#sortedIndexes.set(column, index);
    return index;
  }

  #compileDrawing(
    component: DrawingComponent,
    componentIndex: number,
  ): DrawingRuntime {
    switch (component.name) {
      case "background/v1":
        return {
          kind: "background",
          componentIndex,
          spec: component,
          channels: {},
        };
      case "horizontal-rule/v1":
        return {
          kind: "rule",
          componentIndex,
          spec: component,
          channels: { y: "scalar" },
        };
      case "interval-area/v1":
      case "interval-line/v1": {
        const table = this.#table(component.table);
        const start = table.column(component.start);
        const end = table.column(component.end);
        const startIndex = this.#index(start);
        const prefixMaxEnd = new Float64Array(table.rowCount);
        let maximum = -Infinity;
        for (let row = 0; row < table.rowCount; row += 1) {
          const value = end.number(row);
          if (value !== null && value > maximum) maximum = value;
          prefixMaxEnd[row] = maximum;
        }
        return {
          kind: "interval",
          componentIndex,
          spec: component,
          table,
          start,
          end,
          y: table.column(component.y),
          color:
            typeof component.color === "string"
              ? undefined
              : table.column(component.color.column),
          startIndex,
          prefixMaxEnd,
          channels: {
            start: component.start,
            end: component.end,
            y: component.y,
          },
        };
      }
      case "line/v1":
      case "step-line/v1":
      case "polyline/v1": {
        const table = this.#table(component.table);
        const x = table.column(component.x);
        return {
          kind: "point",
          componentIndex,
          spec: component,
          table,
          x,
          y: table.column(component.y),
          color:
            typeof component.color === "string"
              ? undefined
              : table.column(component.color.column),
          xIndex:
            component.name === "polyline/v1" ? undefined : this.#index(x),
          channels: { x: component.x, y: component.y },
        };
      }
    }
  }

  #deriveLinearDomain(): readonly [number, number] {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const drawing of this.#drawings) {
      const readers =
        drawing.kind === "point"
          ? [drawing.x]
          : drawing.kind === "interval"
            ? [drawing.start, drawing.end]
            : [];
      for (const reader of readers) {
        for (let row = 0; row < reader.rowCount; row += 1) {
          const value = reader.number(row);
          if (value === null) continue;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [0, 1];
    if (minimum === maximum) return [minimum, minimum + 1];
    return [minimum, maximum];
  }

  #layout(viewport: PanelViewport): Layout {
    const [xStart, xEnd] =
      this.spec.x_axis.type === "time"
        ? [viewport.start, viewport.end]
        : this.#linearDomain ?? [0, 1];
    const drawWidth = Math.max(
      0,
      viewport.width - viewport.labelWidth - (viewport.rightInset ?? 0),
    );
    const chartTop = 20;
    const chartHeight = Math.max(1, viewport.height - 28);
    const domains = new Map<string, readonly [number, number]>();
    for (const scale of this.spec.scales) {
      domains.set(
        scale.name,
        this.#scaleDomain(scale, xStart, xEnd),
      );
    }
    return {
      viewport,
      xStart,
      xEnd,
      drawWidth,
      chartTop,
      chartHeight,
      domains,
    };
  }

  #scaleDomain(
    scale: ScaleSpec,
    xStart: number,
    xEnd: number,
  ): readonly [number, number] {
    if (scale.domain.mode === "fixed") {
      return this.#fixedDomain(scale.domain);
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    const include = (value: number | null): void => {
      if (value === null || !Number.isFinite(value)) return;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    };
    for (const value of scale.domain.include) {
      include(this.#numberValue(value));
    }
    for (const drawing of this.#drawings) {
      if (!("scale" in drawing.spec) || drawing.spec.scale !== scale.name) {
        continue;
      }
      if (drawing.kind === "rule") {
        include(this.#numberValue(drawing.spec.y));
      } else if (drawing.kind === "interval") {
        const [start, end] = this.#visibleRows(drawing, xStart, xEnd);
        for (let row = start; row < end; row += 1) {
          if (this.#rowIntersectsRange(drawing, row, xStart, xEnd)) {
            include(drawing.y.number(row));
          }
        }
        if (drawing.spec.name === "interval-area/v1") {
          include(this.#numberValue(drawing.spec.baseline));
        }
      } else if (drawing.kind === "point") {
        const [start, end] = this.#visibleRows(drawing, xStart, xEnd);
        for (let row = start; row < end; row += 1) {
          if (this.#rowIntersectsRange(drawing, row, xStart, xEnd)) {
            include(drawing.y.number(row));
          }
        }
      }
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [0, 1];
    if (minimum === maximum) {
      if (minimum === 0) return [0, 1];
      const padding = Math.abs(minimum) * 0.05 || 1;
      return [minimum - padding, maximum + padding];
    }
    return [minimum, maximum];
  }

  #fixedDomain(domain: FixedScaleDomain): readonly [number, number] {
    const min = this.#numberValue(domain.min);
    const max = this.#numberValue(domain.max);
    return min !== null && max !== null && min < max ? [min, max] : [0, 1];
  }

  #numberValue(value: NumericValue): number | null {
    if (typeof value === "number") return value;
    if (this.#store.table(value.table).rowCount === 0) return null;
    return this.#table(value.table).column(value.column).number(0);
  }

  #cellValue(table: string, column: string): Cell {
    if (this.#store.table(table).rowCount === 0) return null;
    return this.#table(table).column(column).cell(0);
  }

  #x(value: number, layout: Layout): number {
    return (
      layout.viewport.labelWidth +
      ((value - layout.xStart) / (layout.xEnd - layout.xStart)) *
        layout.drawWidth
    );
  }

  #y(value: number, scale: string, layout: Layout): number {
    const domain = layout.domains.get(scale) ?? [0, 1];
    return (
      layout.chartTop +
      layout.chartHeight -
      ((value - domain[0]) / (domain[1] - domain[0])) * layout.chartHeight
    );
  }

  #plotRectangle(layout: Layout): Rectangle {
    return {
      left: layout.viewport.labelWidth,
      top: layout.chartTop,
      right: layout.viewport.labelWidth + layout.drawWidth,
      bottom: layout.chartTop + layout.chartHeight,
    };
  }

  #visibleRows(
    drawing: IntervalRuntime | PointRuntime,
    xStart: number,
    xEnd: number,
  ): readonly [number, number] {
    if (drawing.kind === "point") {
      return drawing.xIndex === undefined
        ? [0, drawing.table.rowCount]
        : drawing.xIndex.rowRange(xStart, xEnd, 1);
    }
    const lastIndex = drawing.startIndex.upperBound(xEnd);
    if (lastIndex === 0) return [0, 0];
    const lastRow = drawing.startIndex.rows[lastIndex - 1]! + 1;
    let low = 0;
    let high = lastRow;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (drawing.prefixMaxEnd[middle]! < xStart) low = middle + 1;
      else high = middle;
    }
    return [low, lastRow];
  }

  #rowColor(
    drawing: IntervalRuntime | PointRuntime,
    row: number,
  ): string {
    return rampColor(
      drawing.spec.color,
      drawing.color?.number(row) ?? null,
    );
  }

  #stroke(
    context: CanvasRenderingContext2D,
    spec: IntervalLineComponent | PointLineComponent | HorizontalRuleComponent,
  ): void {
    context.lineWidth = spec.name === "polyline/v1" ? 2 : 1.5;
    context.setLineDash(
      spec.name === "horizontal-rule/v1" ? [4, 3] : [],
    );
  }

  #draw(
    context: CanvasRenderingContext2D,
    layout: Layout,
    drawing: DrawingRuntime,
  ): void {
    if (drawing.kind === "background") {
      return;
    }
    if (drawing.kind === "rule") {
      const value = this.#numberValue(drawing.spec.y);
      if (value === null) return;
      context.strokeStyle = drawing.spec.color;
      this.#stroke(context, drawing.spec);
      context.globalAlpha = 1;
      const y = this.#y(value, drawing.spec.scale, layout);
      if (y < layout.chartTop || y > layout.chartTop + layout.chartHeight) {
        return;
      }
      context.beginPath();
      context.moveTo(layout.viewport.labelWidth, y);
      context.lineTo(layout.viewport.labelWidth + layout.drawWidth, y);
      context.stroke();
      context.globalAlpha = 1;
      return;
    }
    if (drawing.kind === "interval") {
      const [start, end] = this.#visibleRows(
        drawing,
        layout.xStart,
        layout.xEnd,
      );
      const sampled = minMaxRowsByPixel(
        start,
        end,
        layout.drawWidth,
        layout.xStart,
        layout.xEnd,
        (row) => drawing.start.number(row),
        (row) => drawing.y.number(row),
      );
      let prior:
        | {
            readonly row: number;
            readonly end: number;
            readonly value: number;
          }
        | undefined;
      for (const row of drawingRows(start, end, sampled)) {
        if (row === SAMPLE_GAP) {
          prior = undefined;
          continue;
        }
        const xStart = drawing.start.number(row);
        const xEnd = drawing.end.number(row);
        const value = drawing.y.number(row);
        if (
          xStart === null ||
          xEnd === null ||
          value === null ||
          xEnd <= xStart ||
          xEnd < layout.xStart ||
          xStart > layout.xEnd
        ) {
          prior = undefined;
          continue;
        }
        const x1 = this.#x(Math.max(xStart, layout.xStart), layout);
        const x2 = this.#x(Math.min(xEnd, layout.xEnd), layout);
        const y = this.#y(value, drawing.spec.scale, layout);
        const color = this.#rowColor(drawing, row);
        if (drawing.spec.name === "interval-area/v1") {
          const baseline = this.#numberValue(drawing.spec.baseline);
          if (baseline === null) continue;
          const baselineY = this.#y(baseline, drawing.spec.scale, layout);
          const top = layout.chartTop;
          const bottom = layout.chartTop + layout.chartHeight;
          const clippedY = Math.max(top, Math.min(bottom, y));
          const clippedBaselineY = Math.max(
            top,
            Math.min(bottom, baselineY),
          );
          context.fillStyle = color;
          context.globalAlpha = 0.38;
          context.fillRect(
            x1,
            Math.min(clippedY, clippedBaselineY),
            Math.max(1, x2 - x1),
            Math.abs(clippedBaselineY - clippedY),
          );
          context.globalAlpha = 1;
        } else {
          context.strokeStyle = color;
          this.#stroke(context, drawing.spec);
          context.globalAlpha = 1;
          if (
            prior !== undefined &&
            row === prior.row + 1 &&
            xStart === prior.end &&
            xStart >= layout.xStart &&
            xStart <= layout.xEnd
          ) {
            const connectorX = this.#x(xStart, layout);
            const connector = clipSegment(
              {
                x1: connectorX,
                y1: this.#y(prior.value, drawing.spec.scale, layout),
                x2: connectorX,
                y2: y,
              },
              this.#plotRectangle(layout),
            );
            if (connector !== undefined) {
              context.beginPath();
              context.moveTo(connector.x1, connector.y1);
              context.lineTo(connector.x2, connector.y2);
              context.stroke();
            }
          }
          if (
            y >= layout.chartTop &&
            y <= layout.chartTop + layout.chartHeight
          ) {
            context.beginPath();
            context.moveTo(x1, y);
            context.lineTo(x2, y);
            context.stroke();
          }
          context.globalAlpha = 1;
          prior = { row, end: xEnd, value };
        }
      }
      return;
    }
    this.#drawPointSeries(context, layout, drawing);
  }

  #drawPointSeries(
    context: CanvasRenderingContext2D,
    layout: Layout,
    drawing: PointRuntime,
  ): void {
    const [start, end] = this.#visibleRows(
      drawing,
      layout.xStart,
      layout.xEnd,
    );
    const sampled =
      drawing.spec.name === "polyline/v1"
        ? null
        : minMaxRowsByPixel(
            start,
            end,
            layout.drawWidth,
            layout.xStart,
            layout.xEnd,
            (row) => drawing.x.number(row),
            (row) => drawing.y.number(row),
          );
    this.#stroke(context, drawing.spec);
    context.globalAlpha = 1;
    context.lineJoin = "round";
    context.lineCap = "round";
    const constantColor =
      typeof drawing.spec.color === "string"
        ? drawing.spec.color
        : undefined;
    if (constantColor !== undefined) context.strokeStyle = constantColor;
    const rectangle = this.#plotRectangle(layout);
    const append = (segment: Segment, color: string): boolean => {
      const clipped = clipSegment(segment, rectangle);
      if (clipped === undefined) return false;
      context.strokeStyle = color;
      context.beginPath();
      context.moveTo(clipped.x1, clipped.y1);
      context.lineTo(clipped.x2, clipped.y2);
      context.stroke();
      return true;
    };
    let prior:
      | {
          readonly row: number;
          readonly x: number;
          readonly y: number;
          connected: boolean;
        }
      | undefined;
    const drawIsolatedPoint = (): void => {
      if (
        prior === undefined ||
        prior.connected ||
        prior.x < rectangle.left ||
        prior.x > rectangle.right ||
        prior.y < rectangle.top ||
        prior.y > rectangle.bottom
      ) {
        return;
      }
      context.fillStyle =
        constantColor ?? this.#rowColor(drawing, prior.row);
      context.fillRect(prior.x - 1.5, prior.y - 1.5, 3, 3);
    };
    for (const row of drawingRows(start, end, sampled)) {
      const xValue = row === SAMPLE_GAP ? null : drawing.x.number(row);
      const yValue = row === SAMPLE_GAP ? null : drawing.y.number(row);
      if (xValue === null || yValue === null) {
        drawIsolatedPoint();
        prior = undefined;
        continue;
      }
      const current = {
        row,
        x: this.#x(xValue, layout),
        y: this.#y(yValue, drawing.spec.scale, layout),
        connected: false,
      };
      if (prior !== undefined) {
        const color = constantColor ?? this.#rowColor(drawing, row);
        let connected: boolean;
        if (drawing.spec.name === "step-line/v1") {
          const horizontal = append(
            {
              x1: prior.x,
              y1: prior.y,
              x2: current.x,
              y2: prior.y,
            },
            color,
          );
          const vertical = append(
            {
              x1: current.x,
              y1: prior.y,
              x2: current.x,
              y2: current.y,
            },
            color,
          );
          connected = horizontal || vertical;
        } else {
          connected = append(
            {
              x1: prior.x,
              y1: prior.y,
              x2: current.x,
              y2: current.y,
            },
            color,
          );
        }
        prior.connected = connected;
        current.connected = connected;
      }
      drawIsolatedPoint();
      prior = current;
    }
    drawIsolatedPoint();
    context.globalAlpha = 1;
  }

  #hitDrawing(
    drawing: DrawingRuntime,
    x: number,
    y: number,
    layout: Layout,
  ): number | undefined {
    if (drawing.kind === "background" || drawing.kind === "rule") return undefined;
    if (drawing.kind === "interval") {
      const xValue =
        layout.xStart +
        ((x - layout.viewport.labelWidth) / layout.drawWidth) *
          (layout.xEnd - layout.xStart);
      const [start, end] = this.#visibleRows(drawing, xValue, xValue);
      for (let row = end - 1; row >= start; row -= 1) {
        const rowStart = drawing.start.number(row);
        const rowEnd = drawing.end.number(row);
        const value = drawing.y.number(row);
        if (
          rowStart === null ||
          rowEnd === null ||
          value === null ||
          xValue < rowStart ||
          xValue >= rowEnd
        ) {
          continue;
        }
        const valueY = this.#y(value, drawing.spec.scale, layout);
        if (drawing.spec.name === "interval-line/v1") {
          if (Math.abs(y - valueY) <= 6) return row;
          if (row > 0) {
            const previousEnd = drawing.end.number(row - 1);
            const previousValue = drawing.y.number(row - 1);
            if (
              previousEnd === rowStart &&
              previousValue !== null
            ) {
              const connector = clipSegment(
                {
                  x1: this.#x(rowStart, layout),
                  y1: this.#y(
                    previousValue,
                    drawing.spec.scale,
                    layout,
                  ),
                  x2: this.#x(rowStart, layout),
                  y2: valueY,
                },
                this.#plotRectangle(layout),
              );
              if (
                connector !== undefined &&
                pointToSegmentDistance(x, y, connector) <= 6
              ) {
                return Math.abs(y - connector.y1) <=
                  Math.abs(y - connector.y2)
                  ? row - 1
                  : row;
              }
            }
          }
        } else {
          const baseline = this.#numberValue(drawing.spec.baseline);
          if (baseline === null) continue;
          const baselineY = this.#y(baseline, drawing.spec.scale, layout);
          if (
            y >= Math.min(valueY, baselineY) - 3 &&
            y <= Math.max(valueY, baselineY) + 3
          ) {
            return row;
          }
        }
      }
      return undefined;
    }

    const xValue =
      layout.xStart +
      ((x - layout.viewport.labelWidth) / layout.drawWidth) *
        (layout.xEnd - layout.xStart);
    const tolerance =
      (Math.abs(layout.xEnd - layout.xStart) * 6) / layout.drawWidth;
    const [start, end] =
      drawing.spec.name === "polyline/v1"
        ? this.#visibleRows(drawing, layout.xStart, layout.xEnd)
        : this.#visibleRows(
            drawing,
            xValue - tolerance,
            xValue + tolerance,
          );
    let prior:
      | { readonly row: number; readonly x: number; readonly y: number }
      | undefined;
    let best: { readonly row: number; readonly distance: number } | undefined;
    for (let row = start; row < end; row += 1) {
      const xValue = drawing.x.number(row);
      const yValue = drawing.y.number(row);
      if (xValue === null || yValue === null) {
        prior = undefined;
        continue;
      }
      const current = {
        row,
        x: this.#x(xValue, layout),
        y: this.#y(yValue, drawing.spec.scale, layout),
      };
      if (prior !== undefined) {
        let distance: number;
        let hitRow: number;
        if (drawing.spec.name === "step-line/v1") {
          const horizontalSegment = clipSegment(
            {
              x1: prior.x,
              y1: prior.y,
              x2: current.x,
              y2: prior.y,
            },
            this.#plotRectangle(layout),
          );
          const verticalSegment = clipSegment(
            {
              x1: current.x,
              y1: prior.y,
              x2: current.x,
              y2: current.y,
            },
            this.#plotRectangle(layout),
          );
          const horizontal =
            horizontalSegment === undefined
              ? Infinity
              : pointToSegmentDistance(x, y, horizontalSegment);
          const vertical =
            verticalSegment === undefined
              ? Infinity
              : pointToSegmentDistance(x, y, verticalSegment);
          distance = Math.min(horizontal, vertical);
          hitRow =
            horizontal <= vertical ||
            Math.abs(y - prior.y) <= Math.abs(y - current.y)
              ? prior.row
              : current.row;
        } else {
          const segment = clipSegment(
            {
              x1: prior.x,
              y1: prior.y,
              x2: current.x,
              y2: current.y,
            },
            this.#plotRectangle(layout),
          );
          distance =
            segment === undefined
              ? Infinity
              : pointToSegmentDistance(x, y, segment);
          hitRow =
            Math.hypot(x - prior.x, y - prior.y) <=
            Math.hypot(x - current.x, y - current.y)
              ? prior.row
              : current.row;
        }
        if (
          distance <= 6 &&
          (best === undefined || distance < best.distance)
        ) {
          best = { row: hitRow, distance };
        }
      }
      prior = current;
    }
    return best?.row;
  }

  #matchingDrawing(
    table: string,
    match: ComponentMatch | undefined,
  ): IntervalRuntime | PointRuntime | undefined {
    return this.#drawings.find(
      (drawing): drawing is IntervalRuntime | PointRuntime =>
        (drawing.kind === "interval" || drawing.kind === "point") &&
        drawing.table.table.schema.name === table &&
        channelsMatch(drawing.channels, match),
    );
  }

  #sampleRow(
    drawing: IntervalRuntime | PointRuntime,
    x: number,
  ): number | undefined {
    if (drawing.kind === "point") {
      if (drawing.xIndex !== undefined) return drawing.xIndex.nearestRow(x);
      let best: { row: number; distance: number } | undefined;
      for (let row = 0; row < drawing.table.rowCount; row += 1) {
        const value = drawing.x.number(row);
        if (value === null) continue;
        const distance = Math.abs(value - x);
        if (best === undefined || distance < best.distance) {
          best = { row, distance };
        }
      }
      return best?.row;
    }
    const [start, end] = this.#visibleRows(drawing, x, x);
    for (let row = end - 1; row >= start; row -= 1) {
      const rowStart = drawing.start.number(row);
      const rowEnd = drawing.end.number(row);
      if (
        rowStart !== null &&
        rowEnd !== null &&
        x >= rowStart &&
        x < rowEnd
      ) {
        return row;
      }
    }
    return undefined;
  }

  #readout(
    component: ReadoutComponent,
    layout: Layout,
    pointerX: number | null,
  ): readonly PresentedValue[] {
    const drawing = this.#matchingDrawing(component.table, component.match);
    const table = this.#table(component.table);
    const sampledRow =
      pointerX === null || drawing === undefined
        ? undefined
        : this.#sampleRow(drawing, pointerX);
    return component.items.flatMap((item) => {
      let value: Cell;
      const reducer = item.reduce;
      if (reducer === undefined) {
        value =
          sampledRow === undefined
            ? null
            : table.column(item.column).cell(sampledRow);
      } else {
        value = this.#reduce(item, reducer, table, drawing, layout);
      }
      return value === null
        ? []
        : [
            {
              label: item.label,
              value: formatExtensionValue(
                value,
                item.unit,
              ),
            },
          ];
    });
  }

  #reduce(
    item: ReadoutItem,
    reducer: NonNullable<ReadoutItem["reduce"]>,
    table: TableReader,
    drawing: IntervalRuntime | PointRuntime | undefined,
    layout: Layout,
  ): number | null {
    const column = table.column(item.column);
    const [start, end] =
      drawing === undefined
        ? [0, table.rowCount]
        : this.#visibleRows(drawing, layout.xStart, layout.xEnd);
    if (typeof reducer === "object") {
      const starts = table.column(reducer.start);
      const ends = table.column(reducer.end);
      let weighted = 0;
      let weight = 0;
      for (let row = start; row < end; row += 1) {
        const value = column.number(row);
        const rowStart = starts.number(row);
        const rowEnd = ends.number(row);
        if (value === null || rowStart === null || rowEnd === null) continue;
        const overlap =
          Math.min(rowEnd, layout.xEnd) - Math.max(rowStart, layout.xStart);
        if (overlap <= 0) continue;
        weighted += value * overlap;
        weight += overlap;
      }
      return weight === 0 ? null : weighted / weight;
    }

    let count = 0;
    let sum = 0;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let row = start; row < end; row += 1) {
      if (!this.#rowIntersectsViewport(drawing, row, layout)) continue;
      const cell = column.cell(row);
      if (cell === null) continue;
      if (reducer === "count") {
        count += 1;
        continue;
      }
      const value = column.number(row);
      if (value === null) continue;
      count += 1;
      sum += value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    switch (reducer) {
      case "count":
        return count;
      case "sum":
        return count === 0 ? null : sum;
      case "mean":
        return count === 0 ? null : sum / count;
      case "min":
        return count === 0 ? null : minimum;
      case "max":
        return count === 0 ? null : maximum;
    }
    const exhaustive: never = reducer;
    return exhaustive;
  }

  #rowIntersectsViewport(
    drawing: IntervalRuntime | PointRuntime | undefined,
    row: number,
    layout: Layout,
  ): boolean {
    return (
      drawing === undefined ||
      this.#rowIntersectsRange(
        drawing,
        row,
        layout.xStart,
        layout.xEnd,
      )
    );
  }

  #rowIntersectsRange(
    drawing: IntervalRuntime | PointRuntime,
    row: number,
    startValue: number,
    endValue: number,
  ): boolean {
    if (drawing.kind === "point") {
      const x = drawing.x.number(row);
      return x !== null && x >= startValue && x <= endValue;
    }
    const start = drawing.start.number(row);
    const end = drawing.end.number(row);
    return (
      start !== null &&
      end !== null &&
      end > start &&
      end > startValue &&
      start < endValue
    );
  }

  #swatch(component: SwatchComponent): PresentedSwatch {
    const result: {
      label: string;
      color: string;
      sample: "line" | "area" | "rule";
      value?: string;
    } = {
      label: component.label,
      color: component.color,
      sample: component.sample,
    };
    if (component.value !== undefined) {
      const value = this.#cellValue(
        component.value.table,
        component.value.column,
      );
      if (value !== null) {
        result.value = formatExtensionValue(
          value,
          component.value.unit,
        );
      }
    }
    return result;
  }
}
