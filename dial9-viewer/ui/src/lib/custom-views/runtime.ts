import {
  expandSteps,
  type Vertex,
} from "../canvas/stroke.js";
import { formatFieldValue } from "../trace/format.js";
import type {
  ColumnarTable,
  DrawingComponent,
  HorizontalRuleComponent,
  IntervalAreaComponent,
  IntervalLineComponent,
  LegendItem,
  LegendModel,
  LineComponent,
  NumericColumn,
  PanelComponent,
  PanelHit,
  PanelManifest,
  PanelRenderResult,
  PanelViewport,
  PolylineComponent,
  ScaleDomain,
  ScaleSpec,
  StepLineComponent,
  TableCell,
  TableColumn,
  TextComponent,
  TooltipComponent,
  TooltipRow,
  Utf8Column,
  ViewBundle,
} from "./types.js";

interface RowRange {
  readonly start: number;
  readonly end: number;
}

interface XDomain {
  readonly min: number;
  readonly max: number;
}

interface SelectedPoint extends Vertex {
  readonly row: number;
  readonly value: number;
}

interface SelectedInterval {
  readonly row: number;
  readonly value: number;
  readonly left: number;
  readonly right: number;
  readonly y: number;
}

interface PointHitGrid {
  readonly cellSize: number;
  readonly columns: ReadonlyMap<
    number,
    ReadonlyMap<number, readonly SelectedPoint[]>
  >;
}

interface PointSelectionCache {
  readonly source: ColumnarTable;
  readonly viewportStart: number;
  readonly viewportEnd: number;
  readonly width: number;
  readonly height: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly segments: readonly (readonly SelectedPoint[])[];
  readonly hitGrid: PointHitGrid;
}

interface IntervalSelectionCache {
  readonly source: ColumnarTable;
  readonly viewportStart: number;
  readonly viewportEnd: number;
  readonly width: number;
  readonly height: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly intervals: readonly SelectedInterval[];
}

const pointSelectionCache = new WeakMap<object, PointSelectionCache>();
const intervalSelectionCache = new WeakMap<object, IntervalSelectionCache>();

function table(bundle: ViewBundle, name: string): ColumnarTable {
  const value = bundle.tables[name];
  if (value === undefined) throw new RangeError(`Unknown custom-view table: ${name}`);
  return value;
}

function column(source: ColumnarTable, name: string): TableColumn {
  const value = source.columns[name];
  if (value === undefined) throw new RangeError(`Unknown custom-view column: ${name}`);
  return value;
}

function numericColumn(source: ColumnarTable, name: string): NumericColumn {
  const value = column(source, name);
  if (Array.isArray(value)) {
    throw new TypeError(`Custom-view column is not numeric: ${name}`);
  }
  return value as NumericColumn;
}

function utf8Column(source: ColumnarTable, name: string): Utf8Column {
  const value = column(source, name);
  if (!Array.isArray(value)) {
    throw new TypeError(`Custom-view column is not UTF-8: ${name}`);
  }
  return value as Utf8Column;
}

function numericAt(source: NumericColumn, row: number): number {
  const value = source[row];
  if (value === undefined) throw new RangeError(`Custom-view row is out of range: ${row}`);
  return Number(value);
}

function cellAt(source: TableColumn, row: number): TableCell {
  const value = source[row];
  if (value === undefined) throw new RangeError(`Custom-view row is out of range: ${row}`);
  return value;
}

function xDomain(panel: PanelManifest, viewport: PanelViewport): XDomain {
  if (panel.x?.kind === "linear") {
    return { min: panel.x.min, max: panel.x.max };
  }
  return { min: viewport.startNs, max: viewport.endNs };
}

function xToPixel(value: number, domain: XDomain, width: number): number {
  return ((value - domain.min) / (domain.max - domain.min || 1)) * width;
}

function pixelToX(pixel: number, domain: XDomain, width: number): number {
  return domain.min + (pixel / (width || 1)) * (domain.max - domain.min);
}

function valueToY(value: number, domain: ScaleDomain, height: number): number {
  const ratio = (value - domain.min) / (domain.max - domain.min || 1);
  return height - ratio * height;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lowerBound(values: NumericColumn, target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (numericAt(values, mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values: NumericColumn, target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (numericAt(values, mid) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pointRows(
  source: ColumnarTable,
  xColumn: string,
  domain: XDomain,
): RowRange {
  const values = numericColumn(source, xColumn);
  return {
    start: lowerBound(values, domain.min),
    end: upperBound(values, domain.max),
  };
}

function pointSeriesRows(
  source: ColumnarTable,
  xColumn: string,
  domain: XDomain,
): RowRange {
  const visible = pointRows(source, xColumn, domain);
  return {
    start: Math.max(0, visible.start - 1),
    end: Math.min(source.length, visible.end + 1),
  };
}

function intervalRows(
  source: ColumnarTable,
  startColumn: string,
  endColumn: string,
  domain: XDomain,
): RowRange {
  const starts = numericColumn(source, startColumn);
  const ends = numericColumn(source, endColumn);
  return {
    start: lowerBound(ends, domain.min),
    end: upperBound(starts, domain.max),
  };
}

function isDrawingComponent(component: PanelComponent): component is DrawingComponent {
  return component.kind !== "tooltip" && component.kind !== "legend";
}

function componentRows(
  bundle: ViewBundle,
  component: Exclude<DrawingComponent, { readonly kind: "background" }>,
  domain: XDomain,
): RowRange {
  const source = table(bundle, component.input);
  switch (component.kind) {
    case "interval-area":
    case "interval-line":
      return intervalRows(
        source,
        component.startColumn,
        component.endColumn,
        domain,
      );
    case "line":
    case "step-line":
      return pointSeriesRows(source, component.xColumn, domain);
    case "polyline":
      // A polyline may move backward along x, so no contiguous row range can
      // represent the visible portion without changing its path.
      return { start: 0, end: source.length };
    case "text":
      return pointRows(source, component.xColumn, domain);
    case "horizontal-rule":
      return { start: 0, end: source.length };
  }
}

function finishDomain(
  spec: ScaleSpec,
  visibleMin: number,
  visibleMax: number,
): ScaleDomain {
  let derivedMin = visibleMin;
  let derivedMax = visibleMax;

  if (spec.includeZero === true) {
    derivedMin = Math.min(derivedMin, 0);
    derivedMax = Math.max(derivedMax, 0);
  }

  let min = spec.min ?? (Number.isFinite(derivedMin) ? derivedMin : undefined);
  let max = spec.max ?? (Number.isFinite(derivedMax) ? derivedMax : undefined);

  if (min === undefined && max === undefined) {
    min = 0;
    max = 1;
  } else if (min === undefined) {
    min = max! - 1;
  } else if (max === undefined) {
    max = min + 1;
  }

  let resolvedMin = min as number;
  let resolvedMax = max as number;
  if (
    spec.min !== undefined &&
    spec.max !== undefined &&
    resolvedMin > resolvedMax
  ) {
    throw new RangeError(`Scale ${spec.id} has min greater than max`);
  }
  if (resolvedMin > resolvedMax) {
    if (spec.min !== undefined) resolvedMax = resolvedMin + 1;
    else resolvedMin = resolvedMax - 1;
  }
  if (resolvedMin === resolvedMax) {
    if (resolvedMin === 0) {
      resolvedMax = 1;
    } else {
      const padding = Math.max(Math.abs(resolvedMin) * 0.05, 1e-9);
      resolvedMin -= padding;
      resolvedMax += padding;
    }
  }
  return { min: resolvedMin, max: resolvedMax };
}

/**
 * Resolve every named y domain from only the rows intersecting the current
 * panel x domain. Explicit scale bounds override the corresponding derived
 * side.
 */
export function computeScaleDomains(
  bundle: ViewBundle,
  panel: PanelManifest,
  viewport: PanelViewport,
): ReadonlyMap<string, ScaleDomain> {
  const domain = xDomain(panel, viewport);
  const result = new Map<string, ScaleDomain>();

  for (const spec of panel.scales ?? []) {
    let min = Infinity;
    let max = -Infinity;
    for (const component of panel.components) {
      if (
        !isDrawingComponent(component) ||
        component.kind === "background" ||
        component.scale !== spec.id
      ) {
        continue;
      }
      const source = table(bundle, component.input);
      const values = numericColumn(source, component.valueColumn);
      const rows = componentRows(bundle, component, domain);
      for (let row = rows.start; row < rows.end; row++) {
        const value = numericAt(values, row);
        if (!Number.isFinite(value)) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    result.set(spec.id, finishDomain(spec, min, max));
  }

  return result;
}

function requiredDomain(
  domains: ReadonlyMap<string, ScaleDomain>,
  scale: string,
): ScaleDomain {
  const domain = domains.get(scale);
  if (domain === undefined) throw new RangeError(`Unknown custom-view scale: ${scale}`);
  return domain;
}

function applyStroke(
  ctx: CanvasRenderingContext2D,
  color: string,
  lineWidth: number | undefined,
  dash: readonly number[] | undefined,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth ?? 1;
  ctx.setLineDash(dash === undefined ? [] : [...dash]);
}

function strokePolylines(
  ctx: CanvasRenderingContext2D,
  polylines: readonly (readonly Vertex[])[],
  color: string,
  lineWidth: number | undefined,
  dash: readonly number[] | undefined,
): void {
  if (!polylines.some((vertices) => vertices.length >= 2)) return;
  applyStroke(ctx, color, lineWidth, dash);
  const previousJoin = ctx.lineJoin;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const vertices of polylines) {
    if (vertices.length < 2) continue;
    const first = vertices[0]!;
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < vertices.length; index++) {
      const vertex = vertices[index]!;
      ctx.lineTo(vertex.x, vertex.y);
    }
  }
  ctx.stroke();
  ctx.lineJoin = previousJoin;
  ctx.setLineDash([]);
}

function renderBackground(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: Extract<DrawingComponent, { readonly kind: "background" }>,
  viewport: PanelViewport,
): void {
  const source = table(bundle, component.input);
  if (source.length === 0) return;
  ctx.fillStyle = utf8Column(source, component.colorColumn)[0] ?? "transparent";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
}

function selectedInterval(
  row: number,
  starts: NumericColumn,
  ends: NumericColumn,
  values: NumericColumn,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): SelectedInterval {
  const value = numericAt(values, row);
  return {
    row,
    value,
    left: clamp(
      xToPixel(numericAt(starts, row), x, viewport.width),
      0,
      viewport.width,
    ),
    right: clamp(
      xToPixel(numericAt(ends, row), x, viewport.width),
      0,
      viewport.width,
    ),
    y: clamp(valueToY(value, y, viewport.height), 0, viewport.height),
  };
}

function pixelIntervalSelection(
  rows: RowRange,
  starts: NumericColumn,
  ends: NumericColumn,
  values: NumericColumn,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly SelectedInterval[] {
  const columns = Math.ceil(viewport.width);
  if (columns <= 0) return [];

  const result: SelectedInterval[] = [];
  let columnIndex = -1;
  let first: SelectedInterval | null = null;
  let minimum: SelectedInterval | null = null;
  let maximum: SelectedInterval | null = null;
  let last: SelectedInterval | null = null;

  const flushColumn = (): void => {
    if (first === null || minimum === null || maximum === null || last === null) {
      return;
    }
    const candidates = [first, minimum, maximum, last].sort(
      (left, right) => left.row - right.row,
    );
    let previousRow = -1;
    for (const candidate of candidates) {
      if (candidate.row !== previousRow) result.push(candidate);
      previousRow = candidate.row;
    }
    first = null;
    minimum = null;
    maximum = null;
    last = null;
  };

  for (let row = rows.start; row < rows.end; row++) {
    const interval = selectedInterval(
      row,
      starts,
      ends,
      values,
      viewport,
      x,
      y,
    );
    const midpoint = (interval.left + interval.right) / 2;
    const nextColumn = Math.min(columns - 1, Math.floor(midpoint));
    if (columnIndex !== -1 && nextColumn !== columnIndex) flushColumn();
    columnIndex = nextColumn;
    first ??= interval;
    if (minimum === null || interval.value < minimum.value) minimum = interval;
    if (maximum === null || interval.value > maximum.value) maximum = interval;
    last = interval;
  }
  flushColumn();
  return result;
}

function intervalSelection(
  bundle: ViewBundle,
  component: IntervalAreaComponent | IntervalLineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly SelectedInterval[] {
  const source = table(bundle, component.input);
  const cached = intervalSelectionCache.get(component);
  if (
    cached !== undefined &&
    cached.source === source &&
    cached.viewportStart === viewport.startNs &&
    cached.viewportEnd === viewport.endNs &&
    cached.width === viewport.width &&
    cached.height === viewport.height &&
    cached.xMin === x.min &&
    cached.xMax === x.max &&
    cached.yMin === y.min &&
    cached.yMax === y.max
  ) {
    return cached.intervals;
  }

  const starts = numericColumn(source, component.startColumn);
  const ends = numericColumn(source, component.endColumn);
  const values = numericColumn(source, component.valueColumn);
  const rows = intervalRows(source, component.startColumn, component.endColumn, x);
  // Below this threshold, exact rendering is already pixel-bounded. Above it,
  // four source rows per horizontal pixel preserve entry, exit and both extrema.
  const exactBudget = Math.max(256, Math.ceil(viewport.width) * 4);
  let intervals: readonly SelectedInterval[];
  if (rows.end - rows.start <= exactBudget) {
    const exact: SelectedInterval[] = [];
    for (let row = rows.start; row < rows.end; row++) {
      exact.push(
        selectedInterval(row, starts, ends, values, viewport, x, y),
      );
    }
    intervals = exact;
  } else {
    intervals = pixelIntervalSelection(
      rows,
      starts,
      ends,
      values,
      viewport,
      x,
      y,
    );
  }

  intervalSelectionCache.set(component, {
    source,
    viewportStart: viewport.startNs,
    viewportEnd: viewport.endNs,
    width: viewport.width,
    height: viewport.height,
    xMin: x.min,
    xMax: x.max,
    yMin: y.min,
    yMax: y.max,
    intervals,
  });
  return intervals;
}

function renderIntervalArea(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: IntervalAreaComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): void {
  const baselineY = clamp(
    valueToY(component.baseline ?? 0, y, viewport.height),
    0,
    viewport.height,
  );
  ctx.fillStyle = component.color;
  for (const interval of intervalSelection(
    bundle,
    component,
    viewport,
    x,
    y,
  )) {
    const top = Math.min(interval.y, baselineY);
    ctx.fillRect(
      Math.min(interval.left, interval.right),
      top,
      Math.max(1, Math.abs(interval.right - interval.left)),
      Math.abs(interval.y - baselineY),
    );
  }
}

function renderIntervalLine(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: IntervalLineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): void {
  const intervals = intervalSelection(bundle, component, viewport, x, y);
  if (intervals.length === 0) return;
  applyStroke(ctx, component.color, component.lineWidth, component.dash);
  ctx.beginPath();
  for (const interval of intervals) {
    ctx.moveTo(interval.left, interval.y);
    ctx.lineTo(interval.right, interval.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function exactSteps(vertices: readonly Vertex[]): Vertex[] {
  if (vertices.length < 2) return [...vertices];
  const result: Vertex[] = [vertices[0]!];
  for (let index = 1; index < vertices.length; index++) {
    const previous = vertices[index - 1]!;
    const current = vertices[index]!;
    if (current.x !== previous.x) result.push({ x: current.x, y: previous.y });
    result.push(current);
  }
  return result;
}

function selectedPoint(
  row: number,
  xs: NumericColumn,
  values: NumericColumn,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
  clampX: boolean,
): SelectedPoint {
  const value = numericAt(values, row);
  const px = xToPixel(numericAt(xs, row), x, viewport.width);
  return {
    row,
    value,
    x: clampX ? clamp(px, 0, viewport.width) : px,
    y: clamp(valueToY(value, y, viewport.height), 0, viewport.height),
  };
}

function exactPointSelection(
  rows: RowRange,
  xs: NumericColumn,
  values: NumericColumn,
  gaps: NumericColumn | null,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly (readonly SelectedPoint[])[] {
  const result: SelectedPoint[][] = [];
  let current: SelectedPoint[] = [];
  const flush = (): void => {
    if (current.length >= 2) result.push(current);
    current = [];
  };
  for (let row = rows.start; row < rows.end; row++) {
    if (gaps !== null && numericAt(gaps, row) !== 0) flush();
    current.push(selectedPoint(row, xs, values, viewport, x, y, false));
  }
  flush();
  return result;
}

function pixelPointSelection(
  rows: RowRange,
  xs: NumericColumn,
  values: NumericColumn,
  gaps: NumericColumn | null,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly (readonly SelectedPoint[])[] {
  const columns = Math.ceil(viewport.width);
  if (columns <= 0) return [];

  // Four source points per column preserve entry/exit values and both extrema.
  // The larger budget leaves room for independent gap-delimited subpaths.
  const vertexBudget = Math.max(4096, columns * 8);
  const result: SelectedPoint[][] = [];
  let emittedVertices = 0;
  let exhausted = false;
  let current: SelectedPoint[] = [];
  let columnIndex = -1;
  let first: SelectedPoint | null = null;
  let minimum: SelectedPoint | null = null;
  let maximum: SelectedPoint | null = null;
  let last: SelectedPoint | null = null;

  const flushColumn = (): void => {
    if (first === null || minimum === null || maximum === null || last === null) return;
    const candidates = [first, minimum, maximum, last].sort(
      (left, right) => left.row - right.row,
    );
    let previousRow = -1;
    for (const candidate of candidates) {
      if (candidate.row !== previousRow) current.push(candidate);
      previousRow = candidate.row;
    }
    first = null;
    minimum = null;
    maximum = null;
    last = null;
  };
  const flushSegment = (): void => {
    flushColumn();
    if (current.length >= 2) {
      if (emittedVertices + current.length <= vertexBudget) {
        result.push(current);
        emittedVertices += current.length;
      } else {
        exhausted = true;
      }
    }
    current = [];
    columnIndex = -1;
  };

  for (let row = rows.start; row < rows.end && !exhausted; row++) {
    if (gaps !== null && numericAt(gaps, row) !== 0) flushSegment();
    if (exhausted) break;

    const point = selectedPoint(row, xs, values, viewport, x, y, true);
    const nextColumn = Math.min(columns - 1, Math.floor(point.x));
    if (columnIndex !== -1 && nextColumn !== columnIndex) flushColumn();
    columnIndex = nextColumn;
    first ??= point;
    if (minimum === null || point.value < minimum.value) minimum = point;
    if (maximum === null || point.value > maximum.value) maximum = point;
    last = point;
  }
  if (!exhausted) flushSegment();
  return result;
}

function pointHitGrid(
  segments: readonly (readonly SelectedPoint[])[],
): PointHitGrid {
  const cellSize = 32;
  const columns = new Map<number, Map<number, SelectedPoint[]>>();
  for (const segment of segments) {
    for (const point of segment) {
      const columnIndex = Math.floor(point.x / cellSize);
      const rowIndex = Math.floor(point.y / cellSize);
      let column = columns.get(columnIndex);
      if (column === undefined) {
        column = new Map();
        columns.set(columnIndex, column);
      }
      let cell = column.get(rowIndex);
      if (cell === undefined) {
        cell = [];
        column.set(rowIndex, cell);
      }
      cell.push(point);
    }
  }
  return { cellSize, columns };
}

function pointSelectionEntry(
  bundle: ViewBundle,
  component: LineComponent | StepLineComponent | PolylineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): PointSelectionCache {
  const source = table(bundle, component.input);
  const cached = pointSelectionCache.get(component);
  if (
    cached !== undefined &&
    cached.source === source &&
    cached.viewportStart === viewport.startNs &&
    cached.viewportEnd === viewport.endNs &&
    cached.width === viewport.width &&
    cached.height === viewport.height &&
    cached.xMin === x.min &&
    cached.xMax === x.max &&
    cached.yMin === y.min &&
    cached.yMax === y.max
  ) {
    return cached;
  }

  const xs = numericColumn(source, component.xColumn);
  const values = numericColumn(source, component.valueColumn);
  const gaps =
    component.gapColumn === undefined
      ? null
      : numericColumn(source, component.gapColumn);
  const rows =
    component.kind === "polyline"
      ? { start: 0, end: source.length }
      : pointSeriesRows(source, component.xColumn, x);
  const segments =
    component.kind === "polyline" || component.sampling === "none"
      ? exactPointSelection(rows, xs, values, gaps, viewport, x, y)
      : pixelPointSelection(rows, xs, values, gaps, viewport, x, y);
  const entry: PointSelectionCache = {
    source,
    viewportStart: viewport.startNs,
    viewportEnd: viewport.endNs,
    width: viewport.width,
    height: viewport.height,
    xMin: x.min,
    xMax: x.max,
    yMin: y.min,
    yMax: y.max,
    segments,
    hitGrid: pointHitGrid(segments),
  };
  pointSelectionCache.set(component, entry);
  return entry;
}

function pointSelection(
  bundle: ViewBundle,
  component: LineComponent | StepLineComponent | PolylineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly (readonly SelectedPoint[])[] {
  return pointSelectionEntry(bundle, component, viewport, x, y).segments;
}

function pointSegments(
  bundle: ViewBundle,
  component: LineComponent | StepLineComponent | PolylineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): readonly (readonly Vertex[])[] {
  return pointSelection(bundle, component, viewport, x, y).map((segment) => {
    if (component.kind !== "step-line") return segment;
    return component.sampling === "none"
      ? exactSteps(segment)
      : expandSteps(segment);
  });
}

function renderPointSeries(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: LineComponent | StepLineComponent | PolylineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): void {
  strokePolylines(
    ctx,
    pointSegments(bundle, component, viewport, x, y),
    component.color,
    component.lineWidth,
    component.dash,
  );
}

function renderHorizontalRule(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: HorizontalRuleComponent,
  viewport: PanelViewport,
  y: ScaleDomain,
): void {
  const source = table(bundle, component.input);
  const values = numericColumn(source, component.valueColumn);
  if (source.length === 0) return;
  applyStroke(ctx, component.color, component.lineWidth, component.dash);
  ctx.beginPath();
  for (let row = 0; row < source.length; row++) {
    const py = clamp(
      valueToY(numericAt(values, row), y, viewport.height),
      0,
      viewport.height,
    );
    ctx.moveTo(0, py);
    ctx.lineTo(viewport.width, py);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function renderText(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  component: TextComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
): void {
  const source = table(bundle, component.input);
  const xs = numericColumn(source, component.xColumn);
  const values = numericColumn(source, component.valueColumn);
  const texts = utf8Column(source, component.textColumn);
  const colors =
    component.colorColumn === undefined
      ? null
      : utf8Column(source, component.colorColumn);
  const rows = pointRows(source, component.xColumn, x);
  ctx.font = component.font ?? "12px sans-serif";
  ctx.textAlign = component.align ?? "center";
  ctx.textBaseline = "middle";
  for (let row = rows.start; row < rows.end; row++) {
    ctx.fillStyle = colors?.[row] ?? component.color ?? "#ffffff";
    ctx.fillText(
      texts[row] ?? "",
      xToPixel(numericAt(xs, row), x, viewport.width),
      clamp(valueToY(numericAt(values, row), y, viewport.height), 0, viewport.height),
    );
  }
}

/**
 * Paint a panel into an already CSS-pixel-scaled canvas context. The function
 * has no store or DOM dependencies; component order is the canvas z-order.
 */
export function renderPanel(
  ctx: CanvasRenderingContext2D,
  bundle: ViewBundle,
  panel: PanelManifest,
  viewport: PanelViewport,
): PanelRenderResult {
  const x = xDomain(panel, viewport);
  const domains = computeScaleDomains(bundle, panel, viewport);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  if (viewport.width <= 0 || viewport.height <= 0) return { domains };

  for (const component of panel.components) {
    switch (component.kind) {
      case "background":
        renderBackground(ctx, bundle, component, viewport);
        break;
      case "interval-area":
        renderIntervalArea(
          ctx,
          bundle,
          component,
          viewport,
          x,
          requiredDomain(domains, component.scale),
        );
        break;
      case "interval-line":
        renderIntervalLine(
          ctx,
          bundle,
          component,
          viewport,
          x,
          requiredDomain(domains, component.scale),
        );
        break;
      case "line":
      case "step-line":
      case "polyline":
        renderPointSeries(
          ctx,
          bundle,
          component,
          viewport,
          x,
          requiredDomain(domains, component.scale),
        );
        break;
      case "horizontal-rule":
        renderHorizontalRule(
          ctx,
          bundle,
          component,
          viewport,
          requiredDomain(domains, component.scale),
        );
        break;
      case "text":
        renderText(
          ctx,
          bundle,
          component,
          viewport,
          x,
          requiredDomain(domains, component.scale),
        );
        break;
      case "tooltip":
      case "legend":
        break;
    }
  }
  return { domains };
}

function tooltipFor(
  panel: PanelManifest,
  componentId: string,
): TooltipComponent | undefined {
  let result: TooltipComponent | undefined;
  for (const component of panel.components) {
    if (component.kind === "tooltip" && component.target === componentId) {
      result = component;
    }
  }
  return result;
}

function intervalHit(
  bundle: ViewBundle,
  component: IntervalAreaComponent | IntervalLineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
  cursorX: number,
  cursorY: number,
): number | null {
  let bestRow: number | null = null;
  let bestDistance = Infinity;
  const intervals = intervalSelection(bundle, component, viewport, x, y);
  for (let index = intervals.length - 1; index >= 0; index--) {
    const interval = intervals[index]!;
    const left = Math.min(interval.left, interval.right);
    const right = Math.max(interval.left, interval.right);
    const xTolerance =
      component.kind === "interval-area"
        ? 0
        : Math.max(0.5, (component.lineWidth ?? 1) / 2);
    const paintedRight =
      component.kind === "interval-area" ? left + Math.max(1, right - left) : right;
    if (cursorX < left - xTolerance || cursorX > paintedRight + xTolerance) {
      continue;
    }
    // Interval tooltips identify the topmost painted area at x. They do not
    // require the cursor to be vertically inside the baseline fill.
    if (component.kind === "interval-area") return interval.row;
    const distance = Math.abs(interval.y - cursorY);
    if (
      distance <= Math.max(6, (component.lineWidth ?? 1) + 4) &&
      distance < bestDistance
    ) {
      bestDistance = distance;
      bestRow = interval.row;
    }
  }
  return bestRow;
}

function pointSeriesHit(
  bundle: ViewBundle,
  component: LineComponent | StepLineComponent | PolylineComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
  cursorX: number,
  cursorY: number,
  radius: number,
): number | null {
  const radiusSquared = radius * radius;
  let bestRow: number | null = null;
  let bestDistance = radiusSquared;
  const { hitGrid } = pointSelectionEntry(
    bundle,
    component,
    viewport,
    x,
    y,
  );
  const firstColumn = Math.floor((cursorX - radius) / hitGrid.cellSize);
  const lastColumn = Math.floor((cursorX + radius) / hitGrid.cellSize);
  const firstRow = Math.floor((cursorY - radius) / hitGrid.cellSize);
  const lastRow = Math.floor((cursorY + radius) / hitGrid.cellSize);
  for (
    let columnIndex = firstColumn;
    columnIndex <= lastColumn;
    columnIndex++
  ) {
    const column = hitGrid.columns.get(columnIndex);
    if (column === undefined) continue;
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const cell = column.get(rowIndex);
      if (cell === undefined) continue;
      for (const point of cell) {
        const dx = point.x - cursorX;
        const dy = point.y - cursorY;
        const distance = dx * dx + dy * dy;
        if (
          distance <= radiusSquared &&
          (bestRow === null ||
            distance < bestDistance ||
            (distance === bestDistance && point.row > bestRow))
        ) {
          bestDistance = distance;
          bestRow = point.row;
        }
      }
    }
  }
  return bestRow;
}

function textHit(
  bundle: ViewBundle,
  component: TextComponent,
  viewport: PanelViewport,
  x: XDomain,
  y: ScaleDomain,
  cursorX: number,
  cursorY: number,
  radius: number,
): number | null {
  const source = table(bundle, component.input);
  const xs = numericColumn(source, component.xColumn);
  const values = numericColumn(source, component.valueColumn);
  const cursorValue = pixelToX(cursorX, x, viewport.width);
  const xRadius =
    (radius / (viewport.width || 1)) * Math.abs(x.max - x.min);
  const rows = {
    start: lowerBound(xs, cursorValue - xRadius),
    end: upperBound(xs, cursorValue + xRadius),
  };
  const radiusSquared = radius * radius;
  let bestRow: number | null = null;
  let bestDistance = radiusSquared;
  for (let row = rows.start; row < rows.end; row++) {
    const dx = xToPixel(numericAt(xs, row), x, viewport.width) - cursorX;
    const dy =
      clamp(valueToY(numericAt(values, row), y, viewport.height), 0, viewport.height) -
      cursorY;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestRow = row;
    }
  }
  return bestRow;
}

/**
 * Hit-test the painted stack from top to bottom. Only components targeted by a
 * tooltip participate, and the result references the source table row.
 */
export function hitTestPanel(
  bundle: ViewBundle,
  panel: PanelManifest,
  viewport: PanelViewport,
  cursorX: number,
  cursorY: number,
  knownDomains?: ReadonlyMap<string, ScaleDomain>,
): PanelHit | null {
  if (
    cursorX < 0 ||
    cursorX > viewport.width ||
    cursorY < 0 ||
    cursorY > viewport.height
  ) {
    return null;
  }

  const x = xDomain(panel, viewport);
  const domains = knownDomains ?? computeScaleDomains(bundle, panel, viewport);
  let fallbackDomains: ReadonlyMap<string, ScaleDomain> | null = null;
  const hitDomain = (scale: string): ScaleDomain => {
    const known = domains.get(scale);
    if (known !== undefined) return known;
    fallbackDomains ??= computeScaleDomains(bundle, panel, viewport);
    return requiredDomain(fallbackDomains, scale);
  };

  for (let index = panel.components.length - 1; index >= 0; index--) {
    const component = panel.components[index]!;
    if (!isDrawingComponent(component)) continue;
    const tooltip = tooltipFor(panel, component.id);
    if (tooltip === undefined) continue;

    let row: number | null = null;
    if (
      tooltip.strategy.kind === "interval" &&
      (component.kind === "interval-area" || component.kind === "interval-line")
    ) {
      row = intervalHit(
        bundle,
        component,
        viewport,
        x,
        hitDomain(component.scale),
        cursorX,
        cursorY,
      );
    } else if (
      tooltip.strategy.kind === "nearest-point" &&
      (component.kind === "line" ||
        component.kind === "step-line" ||
        component.kind === "polyline" ||
        component.kind === "text")
    ) {
      row =
        component.kind === "text"
          ? textHit(
              bundle,
              component,
              viewport,
              x,
              hitDomain(component.scale),
              cursorX,
              cursorY,
              tooltip.strategy.radius ?? 8,
            )
          : pointSeriesHit(
              bundle,
              component,
              viewport,
              x,
              hitDomain(component.scale),
              cursorX,
              cursorY,
              tooltip.strategy.radius ?? 8,
            );
    }
    if (row !== null) return { componentId: component.id, row };
  }
  return null;
}

/** Format the tooltip declaration associated with a hit from its source row. */
export function tooltipRows(
  bundle: ViewBundle,
  panel: PanelManifest,
  hit: PanelHit,
): readonly TooltipRow[] {
  const target = panel.components.find(
    (component): component is DrawingComponent =>
      isDrawingComponent(component) && component.id === hit.componentId,
  );
  const tooltip = tooltipFor(panel, hit.componentId);
  if (target === undefined || tooltip === undefined) return [];
  const source = table(bundle, target.input);
  return tooltip.rows.map((row): TooltipRow => {
    const value = cellAt(column(source, row.field), hit.row);
    return { label: row.label, value: formatFieldValue(value, row.unit) };
  });
}

function nearestRow(
  source: ColumnarTable,
  xColumn: string,
  cursorValue: number,
): number | null {
  if (source.length === 0) return null;
  const xs = numericColumn(source, xColumn);
  const after = lowerBound(xs, cursorValue);
  if (after === 0) return 0;
  if (after >= source.length) return source.length - 1;
  const before = after - 1;
  return cursorValue - numericAt(xs, before) <= numericAt(xs, after) - cursorValue
    ? before
    : after;
}

/**
 * Build DOM-neutral legend models. Static items are copied verbatim; an
 * at-cursor item reads only the nearest row from its named columnar table.
 */
export function legendModel(
  bundle: ViewBundle,
  panel: PanelManifest,
  cursorValue?: number,
): readonly LegendModel[] {
  const models: LegendModel[] = [];
  for (const component of panel.components) {
    if (component.kind !== "legend") continue;
    const items: LegendItem[] = [...(component.items ?? [])];
    if (cursorValue !== undefined) {
      for (const spec of component.atCursor ?? []) {
        const source = table(bundle, spec.input);
        const row = nearestRow(source, spec.xColumn, cursorValue);
        if (row !== null) {
          const value = formatFieldValue(
            cellAt(column(source, spec.valueColumn), row),
            spec.unit,
          );
          if (spec.color === undefined) {
            items.push({ label: spec.label, value });
          } else {
            items.push({ label: spec.label, value, color: spec.color });
          }
        }
      }
    }
    models.push({
      componentId: component.id,
      position: component.position ?? "top-right",
      items,
    });
  }
  return models;
}
