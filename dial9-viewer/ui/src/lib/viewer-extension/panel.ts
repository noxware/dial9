import type { Cell, ExtensionStore } from "./columnar.js";
import { ColumnReader, TableReader } from "./data.js";
import { formatAxisValue, formatExtensionValue } from "./format.js";
import {
  clipSegment,
  interpolateValue,
  normalizeValue,
  pointToSegmentDistance,
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
  ScalarReference,
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
  rowAtOrBefore(value: number): number | undefined;
  rowRange(
    start: number,
    end: number,
    pad: number,
  ): readonly [number, number];
}

interface IntervalIndex {
  readonly startIndex: SortedColumnIndex;
  readonly prefixMaxEnd: Float64Array;
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

const SECONDARY_SCALE_WIDTH = 76;

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

function makeSortedIndex(
  column: ColumnReader,
  componentName: DrawingComponent["name"],
): SortedColumnIndex {
  const values: number[] = [];
  const rows: number[] = [];
  let prior = -Infinity;
  for (let row = 0; row < column.rowCount; row += 1) {
    const value = column.number(row);
    if (value === null) continue;
    if (value < prior) {
      const hint =
        componentName === "line/v1" || componentName === "step-line/v1"
          ? "; use polyline/v1 for arbitrary-order paths"
          : "";
      throw new Error(
        `${componentName} requires ${column.schema.name} to be nondecreasing${hint}`,
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
    rowAtOrBefore(value): number | undefined {
      const at = upperBound(value);
      return at === 0 ? undefined : sourceRows[at - 1];
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
  readonly #intervalIndexes = new Map<
    ColumnReader,
    Map<ColumnReader, IntervalIndex>
  >();
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
    let linearDomain: readonly [number, number] | undefined;
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
      this.#validateScalarReferences();
      this.#validateFixedScales();
      this.#validateColorDomains();
      linearDomain =
        spec.x_axis.type === "linear"
          ? spec.x_axis.domain ?? this.#deriveLinearDomain()
          : undefined;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    this.error = error;
    this.#linearDomain = linearDomain;
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

    for (const [index, scale] of this.spec.scales.entries()) {
      const domain = layout.domains.get(scale.name);
      if (domain !== undefined) {
        context.fillStyle = "#667";
        context.font = "10px monospace";
        const secondary = index > 0;
        context.textAlign = secondary ? "left" : "right";
        const x = secondary
          ? labelWidth +
            layout.drawWidth +
            6 +
            (index - 1) * SECONDARY_SCALE_WIDTH
          : labelWidth - 6;
        context.fillText(
          secondary
            ? `${scale.name} ${formatAxisValue(domain[1])}`
            : formatAxisValue(domain[1]),
          x,
          layout.chartTop + 9,
        );
        context.fillText(
          formatAxisValue(domain[0]),
          x,
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
    hit: PanelHit | null = null,
  ): PanelPresentation {
    if (this.error !== undefined) return { swatches: [], readout: [] };
    const layout = this.#layout(viewport);
    const swatches: PresentedSwatch[] = [];
    const readout: PresentedValue[] = [];
    for (const component of this.#presentations) {
      if (component.name === "swatch/v1") {
        swatches.push(this.#swatch(component));
      } else if (component.name === "readout/v1") {
        readout.push(...this.#readout(component, layout, pointerX, hit));
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
    return interpolateValue(
      layout.xStart,
      layout.xEnd,
      (pixelX - viewport.labelWidth) / layout.drawWidth,
    );
  }

  #table(name: string): TableReader {
    let table = this.#tables.get(name);
    if (table !== undefined) return table;
    table = new TableReader(this.#store.table(name));
    this.#tables.set(name, table);
    return table;
  }

  #index(
    column: ColumnReader,
    componentName: DrawingComponent["name"],
  ): SortedColumnIndex {
    let index = this.#sortedIndexes.get(column);
    if (index !== undefined) return index;
    index = makeSortedIndex(column, componentName);
    this.#sortedIndexes.set(column, index);
    return index;
  }

  #intervalIndex(
    start: ColumnReader,
    end: ColumnReader,
    componentName: IntervalAreaComponent["name"] | IntervalLineComponent["name"],
  ): IntervalIndex {
    let byEnd = this.#intervalIndexes.get(start);
    if (byEnd === undefined) {
      byEnd = new Map();
      this.#intervalIndexes.set(start, byEnd);
    }
    let index = byEnd.get(end);
    if (index !== undefined) return index;

    const startIndex = this.#index(start, componentName);
    const prefixMaxEnd = new Float64Array(end.rowCount);
    let maximum = -Infinity;
    for (let row = 0; row < end.rowCount; row += 1) {
      const value = end.number(row);
      if (value !== null && value > maximum) maximum = value;
      prefixMaxEnd[row] = maximum;
    }
    index = {
      startIndex,
      prefixMaxEnd,
    };
    byEnd.set(end, index);
    return index;
  }

  #validateScalarReferences(): void {
    const validate = (
      value: number | string | ScalarReference | undefined,
    ): void => {
      if (typeof value !== "object" || value === null) return;
      const rows = this.#store.table(value.table).rowCount;
      if (rows !== 1) {
        throw new Error(
          `Scalar reference ${value.table}.${value.column} requires exactly one row; got ${rows}`,
        );
      }
    };
    for (const scale of this.spec.scales) {
      if (scale.domain.mode === "visible") {
        for (const value of scale.domain.include) validate(value);
      } else {
        validate(scale.domain.min);
        validate(scale.domain.max);
      }
    }
    for (const component of this.spec.components) {
      if ("unsupported" in component) continue;
      switch (component.name) {
        case "background/v1":
          validate(component.color);
          break;
        case "interval-area/v1":
          validate(component.baseline);
          if (typeof component.color !== "string") {
            validate(component.color.domain?.min);
            validate(component.color.domain?.max);
          }
          break;
        case "interval-line/v1":
        case "line/v1":
        case "step-line/v1":
        case "polyline/v1":
          if (typeof component.color !== "string") {
            validate(component.color.domain?.min);
            validate(component.color.domain?.max);
          }
          break;
        case "horizontal-rule/v1":
          validate(component.y);
          break;
        case "swatch/v1":
          validate(component.value);
          break;
      }
    }
  }

  #validateFixedScales(): void {
    for (const scale of this.spec.scales) {
      if (scale.domain.mode !== "fixed") continue;
      const minimum = this.#numberValue(scale.domain.min);
      const maximum = this.#numberValue(scale.domain.max);
      if (
        minimum === null ||
        maximum === null ||
        !Number.isFinite(minimum) ||
        !Number.isFinite(maximum) ||
        minimum >= maximum
      ) {
        throw new Error(
          `Fixed scale ${scale.name} requires finite min less than max`,
        );
      }
    }
  }

  #validateColorDomains(): void {
    for (const component of this.spec.components) {
      if (
        "unsupported" in component ||
        !("color" in component) ||
        typeof component.color === "string" ||
        !("stops" in component.color) ||
        component.color.domain === undefined
      ) {
        continue;
      }
      const minimum = this.#numberValue(component.color.domain.min);
      const maximum = this.#numberValue(component.color.domain.max);
      if (minimum !== null && maximum !== null) {
        if (minimum >= maximum) {
          throw new Error(
            `${component.name} color domain requires finite min less than max`,
          );
        }
      } else if (component.color.domain.fallback_scale === undefined) {
        throw new Error(
          `${component.name} color domain is unavailable and has no fallback scale`,
        );
      }
    }
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
        const { startIndex, prefixMaxEnd } = this.#intervalIndex(
          start,
          end,
          component.name,
        );
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
            component.name === "polyline/v1"
              ? undefined
              : this.#index(x, component.name),
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
      viewport.width -
        viewport.labelWidth -
        (viewport.rightInset ?? 0) -
        Math.max(0, this.spec.scales.length - 1) * SECONDARY_SCALE_WIDTH,
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
        this.#includePointDomain(drawing, xStart, xEnd, include);
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

  #includePointDomain(
    drawing: PointRuntime,
    xStart: number,
    xEnd: number,
    include: (value: number | null) => void,
  ): void {
    const [start, end] = this.#visibleRows(drawing, xStart, xEnd);
    let prior:
      | { readonly x: number; readonly y: number }
      | undefined;
    for (let row = start; row < end; row += 1) {
      const x = drawing.x.number(row);
      const y = drawing.y.number(row);
      if (x === null || y === null) {
        prior = undefined;
        continue;
      }
      if (x >= xStart && x <= xEnd) include(y);
      if (prior !== undefined) {
        const minimumX = Math.min(prior.x, x);
        const maximumX = Math.max(prior.x, x);
        if (maximumX >= xStart && minimumX <= xEnd) {
          if (drawing.spec.name === "step-line/v1") {
            include(prior.y);
            if (x >= xStart && x <= xEnd) include(y);
          } else if (x === prior.x) {
            include(prior.y);
            include(y);
          } else {
            const clippedStart = Math.max(minimumX, xStart);
            const clippedEnd = Math.min(maximumX, xEnd);
            include(
              interpolateValue(
                prior.y,
                y,
                normalizeValue(clippedStart, prior.x, x),
              ),
            );
            include(
              interpolateValue(
                prior.y,
                y,
                normalizeValue(clippedEnd, prior.x, x),
              ),
            );
          }
        }
      }
      prior = { x, y };
    }
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
      normalizeValue(value, layout.xStart, layout.xEnd) * layout.drawWidth
    );
  }

  #y(value: number, scale: string, layout: Layout): number {
    const domain = layout.domains.get(scale) ?? [0, 1];
    return (
      layout.chartTop +
      layout.chartHeight -
      normalizeValue(value, domain[0], domain[1]) * layout.chartHeight
    );
  }

  #projectSegment(
    segment: Segment,
    scale: string,
    layout: Layout,
  ): Segment | undefined {
    const domain = layout.domains.get(scale);
    if (domain === undefined) return undefined;
    const clipped = clipSegment(segment, {
      left: layout.xStart,
      right: layout.xEnd,
      top: domain[0],
      bottom: domain[1],
    });
    return clipped === undefined
      ? undefined
      : {
          x1: this.#x(clipped.x1, layout),
          y1: this.#y(clipped.y1, scale, layout),
          x2: this.#x(clipped.x2, layout),
          y2: this.#y(clipped.y2, scale, layout),
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

  #colorDomain(
    color: SeriesColor,
    layout: Layout,
  ): readonly [number, number] | undefined {
    if (typeof color === "string" || color.domain === undefined) {
      return undefined;
    }
    const minimum = this.#numberValue(color.domain.min);
    const maximum = this.#numberValue(color.domain.max);
    if (minimum !== null && maximum !== null && minimum < maximum) {
      return [minimum, maximum];
    }
    return color.domain.fallback_scale === undefined
      ? undefined
      : layout.domains.get(color.domain.fallback_scale);
  }

  #rowColorValue(
    drawing: IntervalRuntime | PointRuntime,
    row: number,
    domain: readonly [number, number] | undefined,
  ): number | null {
    const color = drawing.spec.color;
    let value = drawing.color?.number(row) ?? null;
    if (
      typeof color !== "string" &&
      color.domain !== undefined
    ) {
      if (value !== null && domain !== undefined) {
        value = interpolateValue(
          color.stops[0]!.at,
          color.stops.at(-1)!.at,
          normalizeValue(value, domain[0], domain[1]),
        );
      } else {
        value = null;
      }
    }
    return value;
  }

  #rowColor(
    drawing: IntervalRuntime | PointRuntime,
    row: number,
    domain: readonly [number, number] | undefined,
  ): string {
    return rampColor(
      drawing.spec.color,
      this.#rowColorValue(drawing, row, domain),
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
      const value =
        typeof drawing.spec.color === "string"
          ? drawing.spec.color
          : this.#cellValue(
              drawing.spec.color.table,
              drawing.spec.color.column,
            );
      if (typeof value === "string") {
        context.fillStyle = value;
        context.globalAlpha = 1;
        context.fillRect(
          layout.viewport.labelWidth,
          layout.chartTop,
          layout.drawWidth,
          layout.chartHeight,
        );
      }
      return;
    }
    if (drawing.kind === "rule") {
      const value = this.#numberValue(drawing.spec.y);
      if (value === null) return;
      context.strokeStyle = drawing.spec.color;
      this.#stroke(context, drawing.spec);
      context.globalAlpha = 1;
      const domain = layout.domains.get(drawing.spec.scale);
      if (
        domain === undefined ||
        value < domain[0] ||
        value > domain[1]
      ) {
        return;
      }
      const y = this.#y(value, drawing.spec.scale, layout);
      context.beginPath();
      context.moveTo(layout.viewport.labelWidth, y);
      context.lineTo(layout.viewport.labelWidth + layout.drawWidth, y);
      context.stroke();
      context.globalAlpha = 1;
      return;
    }
    if (drawing.kind === "interval") {
      const colorDomain = this.#colorDomain(drawing.spec.color, layout);
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
        drawing.color === undefined
          ? undefined
          : (row) => this.#rowColorValue(drawing, row, colorDomain),
        typeof drawing.spec.color === "string"
          ? undefined
          : drawing.spec.color.stops.map((stop) => stop.at),
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
          xEnd <= layout.xStart ||
          xStart >= layout.xEnd
        ) {
          prior = undefined;
          continue;
        }
        const x1 = this.#x(Math.max(xStart, layout.xStart), layout);
        const x2 = this.#x(Math.min(xEnd, layout.xEnd), layout);
        const color = this.#rowColor(drawing, row, colorDomain);
        if (drawing.spec.name === "interval-area/v1") {
          const baseline = this.#numberValue(drawing.spec.baseline);
          if (baseline === null) continue;
          const domain = layout.domains.get(drawing.spec.scale);
          if (domain === undefined) continue;
          const clippedY = this.#y(
            Math.max(domain[0], Math.min(domain[1], value)),
            drawing.spec.scale,
            layout,
          );
          const clippedBaselineY = this.#y(
            Math.max(domain[0], Math.min(domain[1], baseline)),
            drawing.spec.scale,
            layout,
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
            const connector = this.#projectSegment(
              {
                x1: xStart,
                y1: prior.value,
                x2: xStart,
                y2: value,
              },
              drawing.spec.scale,
              layout,
            );
            if (connector !== undefined) {
              context.beginPath();
              context.moveTo(connector.x1, connector.y1);
              context.lineTo(connector.x2, connector.y2);
              context.stroke();
            }
          }
          const domain = layout.domains.get(drawing.spec.scale);
          if (
            domain !== undefined &&
            value >= domain[0] &&
            value <= domain[1]
          ) {
            const y = this.#y(value, drawing.spec.scale, layout);
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
    const colorDomain = this.#colorDomain(drawing.spec.color, layout);
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
            drawing.color === undefined
              ? undefined
              : (row) => this.#rowColorValue(drawing, row, colorDomain),
            typeof drawing.spec.color === "string"
              ? undefined
              : drawing.spec.color.stops.map((stop) => stop.at),
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
    const append = (segment: Segment, color: string): boolean => {
      const clipped = this.#projectSegment(
        segment,
        drawing.spec.scale,
        layout,
      );
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
          readonly xValue: number;
          readonly yValue: number;
          connected: boolean;
        }
      | undefined;
    const drawIsolatedPoint = (): void => {
      if (prior === undefined || prior.connected) return;
      const domain = layout.domains.get(drawing.spec.scale);
      if (
        domain === undefined ||
        prior.xValue < layout.xStart ||
        prior.xValue > layout.xEnd ||
        prior.yValue < domain[0] ||
        prior.yValue > domain[1]
      ) return;
      const x = this.#x(prior.xValue, layout);
      const y = this.#y(prior.yValue, drawing.spec.scale, layout);
      context.fillStyle =
        constantColor ?? this.#rowColor(drawing, prior.row, colorDomain);
      context.fillRect(x - 1.5, y - 1.5, 3, 3);
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
        xValue,
        yValue,
        connected: false,
      };
      if (prior !== undefined) {
        const color = constantColor ?? this.#rowColor(
          drawing,
          row,
          colorDomain,
        );
        let connected: boolean;
        if (drawing.spec.name === "step-line/v1") {
          const horizontal = append(
            {
              x1: prior.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: prior.yValue,
            },
            color,
          );
          const vertical = append(
            {
              x1: current.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: current.yValue,
            },
            color,
          );
          connected = horizontal || vertical;
        } else {
          connected = append(
            {
              x1: prior.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: current.yValue,
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
      const xValue = interpolateValue(
        layout.xStart,
        layout.xEnd,
        (x - layout.viewport.labelWidth) / layout.drawWidth,
      );
      const [start, end] = this.#visibleRows(drawing, xValue, xValue);
      const domain = layout.domains.get(drawing.spec.scale);
      if (domain === undefined) return undefined;
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
        if (drawing.spec.name === "interval-line/v1") {
          if (
            value >= domain[0] &&
            value <= domain[1] &&
            Math.abs(y - this.#y(value, drawing.spec.scale, layout)) <= 6
          ) return row;
          if (row > 0) {
            const previousEnd = drawing.end.number(row - 1);
            const previousValue = drawing.y.number(row - 1);
            if (
              previousEnd === rowStart &&
              previousValue !== null
            ) {
              const connector = this.#projectSegment(
                {
                  x1: rowStart,
                  y1: previousValue,
                  x2: rowStart,
                  y2: value,
                },
                drawing.spec.scale,
                layout,
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
          const valueY = this.#y(
            Math.max(domain[0], Math.min(domain[1], value)),
            drawing.spec.scale,
            layout,
          );
          const baselineY = this.#y(
            Math.max(domain[0], Math.min(domain[1], baseline)),
            drawing.spec.scale,
            layout,
          );
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

    const toleranceStart = interpolateValue(
      layout.xStart,
      layout.xEnd,
      (x - layout.viewport.labelWidth - 6) / layout.drawWidth,
    );
    const toleranceEnd = interpolateValue(
      layout.xStart,
      layout.xEnd,
      (x - layout.viewport.labelWidth + 6) / layout.drawWidth,
    );
    const [start, end] =
      drawing.spec.name === "polyline/v1"
        ? this.#visibleRows(drawing, layout.xStart, layout.xEnd)
        : this.#visibleRows(
            drawing,
            Math.min(toleranceStart, toleranceEnd),
            Math.max(toleranceStart, toleranceEnd),
          );
    const domain = layout.domains.get(drawing.spec.scale);
    if (domain === undefined) return undefined;
    let prior:
      | {
          readonly row: number;
          readonly xValue: number;
          readonly yValue: number;
        }
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
        xValue,
        yValue,
      };
      if (
        xValue >= layout.xStart &&
        xValue <= layout.xEnd &&
        yValue >= domain[0] &&
        yValue <= domain[1]
      ) {
        const distance = Math.hypot(
          x - this.#x(xValue, layout),
          y - this.#y(yValue, drawing.spec.scale, layout),
        );
        if (
          distance <= 6 &&
          (best === undefined || distance < best.distance)
        ) {
          best = { row, distance };
        }
      }
      if (prior !== undefined) {
        let distance: number;
        let hitRow: number;
        if (drawing.spec.name === "step-line/v1") {
          const horizontalSegment = this.#projectSegment(
            {
              x1: prior.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: prior.yValue,
            },
            drawing.spec.scale,
            layout,
          );
          const verticalSegment = this.#projectSegment(
            {
              x1: current.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: current.yValue,
            },
            drawing.spec.scale,
            layout,
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
            Math.abs(
              y -
                this.#y(
                  Math.max(domain[0], Math.min(domain[1], prior.yValue)),
                  drawing.spec.scale,
                  layout,
                ),
            ) <=
              Math.abs(
                y -
                  this.#y(
                    Math.max(domain[0], Math.min(domain[1], current.yValue)),
                    drawing.spec.scale,
                    layout,
                  ),
              )
              ? prior.row
              : current.row;
        } else {
          const segment = this.#projectSegment(
            {
              x1: prior.xValue,
              y1: prior.yValue,
              x2: current.xValue,
              y2: current.yValue,
            },
            drawing.spec.scale,
            layout,
          );
          distance =
            segment === undefined
              ? Infinity
              : pointToSegmentDistance(x, y, segment);
          hitRow =
            Math.hypot(
              x -
                this.#x(
                  Math.max(
                    layout.xStart,
                    Math.min(layout.xEnd, prior.xValue),
                  ),
                  layout,
                ),
              y -
                this.#y(
                  Math.max(domain[0], Math.min(domain[1], prior.yValue)),
                  drawing.spec.scale,
                  layout,
                ),
            ) <=
            Math.hypot(
              x -
                this.#x(
                  Math.max(
                    layout.xStart,
                    Math.min(layout.xEnd, current.xValue),
                  ),
                  layout,
                ),
              y -
                this.#y(
                  Math.max(domain[0], Math.min(domain[1], current.yValue)),
                  drawing.spec.scale,
                  layout,
                ),
            )
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
      if (
        drawing.spec.name === "step-line/v1" &&
        drawing.xIndex !== undefined
      ) {
        const row = drawing.xIndex.rowAtOrBefore(x);
        if (row === undefined || drawing.y.number(row) === null) {
          return undefined;
        }
        const rowX = drawing.x.number(row);
        if (rowX === x) return row;
        if (row + 1 >= drawing.table.rowCount) return undefined;
        const nextX = drawing.x.number(row + 1);
        const nextY = drawing.y.number(row + 1);
        return nextX !== null && nextY !== null && x < nextX
          ? row
          : undefined;
      }
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
    hit: PanelHit | null,
  ): readonly PresentedValue[] {
    const drawing = this.#matchingDrawing(component.table, component.match);
    const table = this.#table(component.table);
    const hitRow =
      hit !== null &&
      hit.instanceId === this.instanceId &&
      hit.panelIndex === this.panelIndex &&
      hit.table === component.table &&
      hit.row >= 0 &&
      hit.row < table.rowCount &&
      channelsMatch(hit.channels, component.match)
        ? hit.row
        : undefined;
    const sampledRow =
      hitRow ??
      (pointerX === null || drawing === undefined
        ? undefined
        : this.#sampleRow(drawing, pointerX));
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
        if (value !== null && item.clamp !== undefined) {
          if (item.clamp.min !== undefined) {
            value = Math.max(item.clamp.min, value);
          }
          if (item.clamp.max !== undefined) {
            value = Math.min(item.clamp.max, value);
          }
        }
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
      const y = drawing.y.number(row);
      if (x === null || y === null) return false;
      if (x >= startValue && x <= endValue) return true;
      if (
        drawing.spec.name !== "step-line/v1" ||
        row + 1 >= drawing.table.rowCount
      ) return false;
      const nextX = drawing.x.number(row + 1);
      const nextY = drawing.y.number(row + 1);
      return (
        nextX !== null &&
        nextY !== null &&
        x < endValue &&
        nextX > startValue
      );
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
