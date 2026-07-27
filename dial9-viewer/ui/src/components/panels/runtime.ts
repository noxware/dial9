import { LABEL_W, timePanelLayout } from "../../lib/canvas/layout.js";
import type { TimePanelLayout } from "../../lib/canvas/layout.js";
import type { ColumnView, IntervalData, PointData } from "./data.js";
import type {
  GraphComponent,
  PanelComponent,
  PanelData,
  ReadoutComponent,
  ReadoutItem,
  ResolvedPanel,
  SwatchComponent,
  TooltipComponent,
} from "./model.js";

const PANEL_HEIGHT = 92;
const CHART_TOP = 20;
const CHART_BOTTOM = 8;
const GRID_COLOR = "rgba(255,255,255,0.07)";
const AXIS_COLOR = "#667";
const PANEL_BACKGROUND = "#111b2e";
const HIT_TOLERANCE = 10;

export interface PanelViewport {
  readonly start: number;
  readonly end: number;
  readonly scrollbarWidth: number;
}

export interface PanelRuntime {
  readonly elements: readonly HTMLElement[];
  setPanels(panels: readonly ResolvedPanel[]): void;
  render(viewport: PanelViewport): void;
  dispose(): void;
}

export interface MountPanelRuntimeOptions {
  readonly container: HTMLElement;
  readonly before: HTMLElement;
  readonly tooltip: HTMLElement;
  readonly isCollapsed: (key: string) => boolean;
  readonly onPanelCreated: (panel: HTMLElement) => void;
  readonly onPointerTime?: (timestamp: number | null) => void;
}

interface PanelDom {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly legend: HTMLElement;
  readonly readout: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  panel: ResolvedPanel;
  viewport: PanelViewport | null;
  layout: TimePanelLayout | null;
  projection: Projection | null;
  hits: HitLayer[];
}

interface Projection {
  readonly min: number;
  readonly max: number;
  readonly bottom: number;
  y(value: number): number;
}

interface Hit {
  readonly data: PanelData;
  readonly row: number;
}

interface HitLayer {
  hit(x: number, y: number, timestamp: number): Hit | null;
}

interface PointSegment {
  readonly row1: number;
  readonly row2: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

interface RenderInterval {
  start: number;
  end: number;
  value: number;
}

export function mountPanelRuntime(options: MountPanelRuntimeOptions): PanelRuntime {
  const doms = new Map<string, PanelDom>();
  let disposed = false;

  function setPanels(panels: readonly ResolvedPanel[]): void {
    if (disposed) return;
    const wanted = new Set(panels.map((panel) => panel.key));
    for (const [key, dom] of doms) {
      if (wanted.has(key)) continue;
      dom.root.remove();
      doms.delete(key);
    }
    for (const panel of panels) {
      let dom = doms.get(panel.key);
      if (dom === undefined) {
        dom = createPanelDom(panel, options);
        options.container.insertBefore(dom.root, options.before);
        options.onPanelCreated(dom.root);
        doms.set(panel.key, dom);
      }
      dom.panel = panel;
      updatePanelChrome(dom);
    }
  }

  function render(viewport: PanelViewport): void {
    if (disposed) return;
    for (const dom of doms.values()) renderPanel(dom, viewport, options.isCollapsed);
  }

  return {
    get elements() {
      return [...doms.values()].map((dom) => dom.root);
    },
    setPanels,
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      hideTooltip(options.tooltip);
      for (const dom of doms.values()) dom.root.remove();
      doms.clear();
    },
  };
}

function createPanelDom(
  panel: ResolvedPanel,
  options: MountPanelRuntimeOptions,
): PanelDom {
  const root = document.createElement("div");
  root.className = "d9-composable-panel foldable-panel is-collapsed";
  root.dataset.panelKey = panel.key;

  const label = document.createElement("div");
  label.className = "chart-label";
  const title = document.createElement("span");
  title.className = "d9-composable-panel-title";
  const legend = document.createElement("span");
  legend.className = "d9-composable-panel-legend panel-expanded-label";
  label.append(title, legend);

  const readout = document.createElement("span");
  readout.className = "d9-composable-panel-readout";
  const canvas = document.createElement("canvas");
  root.append(label, readout, canvas);

  const dom: PanelDom = {
    root,
    title,
    legend,
    readout,
    canvas,
    panel,
    viewport: null,
    layout: null,
    projection: null,
    hits: [],
  };

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const layout = dom.layout;
    if (
      layout === null ||
      x < LABEL_W ||
      x > LABEL_W + layout.drawW
    ) {
      clearHover(dom, options);
      return;
    }

    const timestamp = layout.panelXToNs(x);
    options.onPointerTime?.(timestamp);
    let hit: Hit | null = null;
    for (let i = dom.hits.length - 1; i >= 0; i--) {
      hit = dom.hits[i]?.hit(x, y, timestamp) ?? null;
      if (hit !== null) break;
    }
    if (hit === null || !showHitTooltip(dom.panel, hit, options.tooltip, event)) {
      canvas.style.cursor = "default";
      hideTooltip(options.tooltip);
      return;
    }
    canvas.style.cursor = "crosshair";
  });
  canvas.addEventListener("mouseleave", () => clearHover(dom, options));

  updatePanelChrome(dom);
  return dom;
}

function clearHover(dom: PanelDom, options: MountPanelRuntimeOptions): void {
  dom.canvas.style.cursor = "default";
  options.onPointerTime?.(null);
  hideTooltip(options.tooltip);
}

function updatePanelChrome(dom: PanelDom): void {
  dom.title.textContent = dom.panel.title;
  dom.legend.replaceChildren(
    ...dom.panel.components
      .filter((component): component is SwatchComponent => component.name === "swatch/v1")
      .map(swatchElement),
  );
}

function swatchElement(component: SwatchComponent): HTMLElement {
  const item = document.createElement("span");
  item.className = "d9-composable-panel-legend-item";
  const swatch = document.createElement("span");
  swatch.className = `d9-composable-panel-swatch is-${component.kind}`;
  swatch.style.color = component.color;
  item.append(swatch);
  const value = component.value === undefined
    ? component.label
    : `${component.label} (${formatValue(component.value, component.unit)})`;
  item.append(document.createTextNode(value));
  return item;
}

function renderPanel(
  dom: PanelDom,
  viewport: PanelViewport,
  isCollapsed: (key: string) => boolean,
): void {
  dom.viewport = viewport;
  updateReadout(dom, viewport);
  if (isCollapsed(dom.panel.key)) {
    dom.hits = [];
    return;
  }

  const width = dom.root.getBoundingClientRect().width;
  const layout = timePanelLayout({
    pw: width,
    scrollbarW: viewport.scrollbarWidth,
    viewStart: viewport.start,
    viewEnd: viewport.end,
  });
  dom.layout = layout;
  const context = resizeCanvas(dom.canvas, width, PANEL_HEIGHT);
  context.clearRect(0, 0, width, PANEL_HEIGHT);
  context.fillStyle = PANEL_BACKGROUND;
  context.fillRect(0, 0, width, PANEL_HEIGHT);
  dom.hits = [];
  if (!(layout.drawW > 0) || !(viewport.end > viewport.start)) return;

  const graphs = dom.panel.components.filter(isGraphComponent);
  for (const component of graphs) {
    if (component.name !== "background/v1") continue;
    context.fillStyle = component.color;
    context.fillRect(0, 0, width, PANEL_HEIGHT);
  }

  const projection = panelProjection(dom.panel, viewport);
  dom.projection = projection;
  drawGridAndAxis(context, layout, projection);

  context.save();
  context.beginPath();
  context.rect(LABEL_W, CHART_TOP, layout.drawW, projection.bottom - CHART_TOP);
  context.clip();
  for (const component of graphs) {
    const hit = drawGraph(context, component, layout, projection, viewport);
    if (hit !== null) dom.hits.push(hit);
  }
  context.restore();
}

function isGraphComponent(component: PanelComponent): component is GraphComponent {
  return component.name === "background/v1" ||
    component.name === "interval-area/v1" ||
    component.name === "interval-line/v1" ||
    component.name === "polyline/v1" ||
    component.name === "horizontal-rule/v1";
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas is unavailable");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}

function panelProjection(panel: ResolvedPanel, viewport: PanelViewport): Projection {
  let min = panel.yDomain?.min ?? 0;
  let max = panel.yDomain?.max ?? min + 1;
  let sawValue = panel.yDomain?.max !== undefined;
  for (const value of panel.yDomain?.include ?? []) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sawValue = true;
  }
  for (const component of panel.components) {
    if (component.name === "horizontal-rule/v1") {
      min = Math.min(min, component.value);
      max = Math.max(max, component.value);
      sawValue = true;
      continue;
    }
    if (
      component.name !== "interval-area/v1" &&
      component.name !== "interval-line/v1" &&
      component.name !== "polyline/v1"
    ) continue;
    const data = component.data;
    const [first, last] = visibleRows(data, viewport);
    for (let row = first; row < last; row++) {
      if (!rowTouchesViewport(data, row, viewport)) continue;
      const value = data.y.get(row);
      if (value === null || !Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sawValue = true;
    }
  }
  if (!sawValue || !(max > min)) max = min + 1;
  const bottom = PANEL_HEIGHT - CHART_BOTTOM;
  return {
    min,
    max,
    bottom,
    y(value) {
      return bottom - ((value - min) / (max - min)) * (bottom - CHART_TOP);
    },
  };
}

function rowTouchesViewport(
  data: PanelData,
  row: number,
  viewport: PanelViewport,
): boolean {
  if ("start" in data) {
    const start = data.start.get(row);
    const end = data.end.get(row);
    return start !== null && end !== null &&
      end >= viewport.start && start <= viewport.end;
  }
  const x = data.x.get(row);
  return x !== null && x >= viewport.start && x <= viewport.end;
}

function visibleRows(
  data: PanelData,
  viewport: PanelViewport,
): readonly [number, number] {
  return "start" in data
    ? visibleIntervalRows(data, viewport.start, viewport.end)
    : [0, data.length];
}

export function visibleIntervalRows(
  data: IntervalData,
  viewStart: number,
  viewEnd: number,
): readonly [number, number] {
  let low = 0;
  let high = data.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const end = data.end.get(middle);
    if (end === null) return [0, data.length];
    if (end < viewStart) low = middle + 1;
    else high = middle;
  }
  const first = low;
  high = data.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const start = data.start.get(middle);
    if (start === null) return [0, data.length];
    if (start <= viewEnd) low = middle + 1;
    else high = middle;
  }
  return [first, low];
}

function drawGridAndAxis(
  context: CanvasRenderingContext2D,
  layout: TimePanelLayout,
  projection: Projection,
): void {
  context.fillStyle = AXIS_COLOR;
  context.font = "10px monospace";
  context.textAlign = "right";
  context.fillText(formatNumber(projection.max), LABEL_W - 6, CHART_TOP + 9);
  context.fillText(formatNumber(projection.min), LABEL_W - 6, projection.bottom);
  context.strokeStyle = GRID_COLOR;
  context.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = CHART_TOP + ((projection.bottom - CHART_TOP) * i) / 4;
    context.beginPath();
    context.moveTo(LABEL_W, y);
    context.lineTo(LABEL_W + layout.drawW, y);
    context.stroke();
  }
}

function drawGraph(
  context: CanvasRenderingContext2D,
  component: GraphComponent,
  layout: TimePanelLayout,
  projection: Projection,
  viewport: PanelViewport,
): HitLayer | null {
  switch (component.name) {
    case "background/v1":
      return null;
    case "horizontal-rule/v1": {
      const y = projection.y(component.value);
      context.strokeStyle = component.color;
      context.lineWidth = 1;
      context.setLineDash([4, 3]);
      context.beginPath();
      context.moveTo(LABEL_W, y);
      context.lineTo(LABEL_W + layout.drawW, y);
      context.stroke();
      context.setLineDash([]);
      return null;
    }
    case "interval-area/v1":
      drawIntervalArea(context, component.data, component.color, layout, projection, viewport);
      return intervalHitLayer(component.data, projection, true);
    case "interval-line/v1":
      drawIntervalLine(context, component.data, component.color, layout, projection, viewport);
      return intervalHitLayer(component.data, projection, false);
    case "polyline/v1":
      return drawPolyline(context, component.data, component.color, layout, projection);
  }
}

function drawIntervalArea(
  context: CanvasRenderingContext2D,
  data: IntervalData,
  color: string,
  layout: TimePanelLayout,
  projection: Projection,
  viewport: PanelViewport,
): void {
  context.fillStyle = alphaColor(color, 0.38);
  for (const interval of renderIntervals(data, viewport, layout.drawW)) {
    const x1 = layout.nsToPanelXClamped(interval.start);
    const x2 = layout.nsToPanelXClamped(interval.end);
    if (!(x2 > x1)) continue;
    const y = projection.y(interval.value);
    context.fillRect(x1, y, x2 - x1, projection.bottom - y);
  }
}

function drawIntervalLine(
  context: CanvasRenderingContext2D,
  data: IntervalData,
  color: string,
  layout: TimePanelLayout,
  projection: Projection,
  viewport: PanelViewport,
): void {
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  const intervals = renderIntervals(data, viewport, layout.drawW);
  let previousEnd: number | null = null;
  let previousValue: number | null = null;
  for (const interval of intervals) {
    const x1 = layout.nsToPanelXClamped(interval.start);
    const x2 = layout.nsToPanelXClamped(interval.end);
    if (previousEnd === interval.start && previousValue !== null) {
      context.beginPath();
      context.moveTo(x1, projection.y(previousValue));
      context.lineTo(x1, projection.y(interval.value));
      context.stroke();
    }
    if (x2 > x1) {
      context.beginPath();
      context.moveTo(x1, projection.y(interval.value));
      context.lineTo(x2, projection.y(interval.value));
      context.stroke();
    }
    previousEnd = interval.end;
    previousValue = interval.value;
  }
}

export function renderIntervals(
  data: IntervalData,
  viewport: Pick<PanelViewport, "start" | "end">,
  drawWidth: number,
): RenderInterval[] {
  const [first, last] = visibleIntervalRows(data, viewport.start, viewport.end);
  const visibleCount = last - first;
  const width = Math.floor(drawWidth);
  const sample = width > 0 && visibleCount > width * 4;
  const result: RenderInterval[] = [];
  let previousEnd: number | null = null;
  let previousPixel = -1;

  for (let row = first; row < last; row++) {
    const start = data.start.get(row);
    const end = data.end.get(row);
    const value = data.y.get(row);
    if (start === null || end === null || value === null) {
      previousEnd = null;
      previousPixel = -1;
      continue;
    }
    if (previousEnd !== null && previousEnd !== start) {
      previousPixel = -1;
    }
    if (!sample) {
      result.push({ start, end, value });
      previousEnd = end;
      continue;
    }

    const pixel = Math.max(
      0,
      Math.min(
        width - 1,
        Math.floor(((start - viewport.start) / (viewport.end - viewport.start)) * width),
      ),
    );
    const previous = result[result.length - 1];
    if (previous !== undefined && previousPixel === pixel && previousEnd === start) {
      previous.end = end;
      previous.value = Math.max(previous.value, value);
    } else {
      result.push({ start, end, value });
    }
    previousPixel = pixel;
    previousEnd = end;
  }
  return result;
}

function intervalHitLayer(
  data: IntervalData,
  projection: Projection,
  area: boolean,
): HitLayer {
  return {
    hit(_x, y, timestamp) {
      const row = intervalAt(data, timestamp);
      if (row === null) return null;
      const value = data.y.get(row);
      if (value === null) return null;
      const lineY = projection.y(value);
      const inside = area && y >= Math.min(lineY, projection.bottom) &&
        y <= Math.max(lineY, projection.bottom);
      return inside || Math.abs(y - lineY) <= HIT_TOLERANCE
        ? { data, row }
        : null;
    },
  };
}

export function intervalAt(data: IntervalData, timestamp: number): number | null {
  let low = 0;
  let high = data.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = data.start.get(middle);
    const end = data.end.get(middle);
    if (start === null || end === null) return intervalAtLinear(data, timestamp);
    if (timestamp < start) high = middle - 1;
    else if (timestamp > end) low = middle + 1;
    else return data.y.get(middle) === null ? null : middle;
  }
  return null;
}

function intervalAtLinear(data: IntervalData, timestamp: number): number | null {
  for (let row = 0; row < data.length; row++) {
    const start = data.start.get(row);
    const end = data.end.get(row);
    if (start !== null && end !== null && timestamp >= start && timestamp <= end) {
      return data.y.get(row) === null ? null : row;
    }
  }
  return null;
}

function drawPolyline(
  context: CanvasRenderingContext2D,
  data: PointData,
  color: string,
  layout: TimePanelLayout,
  projection: Projection,
): HitLayer | null {
  const segments: PointSegment[] = [];
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  let previous: { row: number; x: number; y: number } | null = null;
  for (let row = 0; row < data.length; row++) {
    const time = data.x.get(row);
    const value = data.y.get(row);
    if (time === null || value === null) {
      previous = null;
      continue;
    }
    const x = layout.nsToPanelX(time);
    const y = projection.y(value);
    if (previous === null) context.moveTo(x, y);
    else {
      context.lineTo(x, y);
      segments.push({
        row1: previous.row,
        row2: row,
        x1: previous.x,
        y1: previous.y,
        x2: x,
        y2: y,
      });
    }
    previous = { row, x, y };
  }
  context.stroke();
  if (segments.length === 0) return null;
  return {
    hit(x, y) {
      let best: { row: number; distance: number } | null = null;
      for (const segment of segments) {
        const distance = pointToSegmentDistance(x, y, segment);
        if (distance > HIT_TOLERANCE || (best !== null && distance >= best.distance)) {
          continue;
        }
        const first = Math.hypot(x - segment.x1, y - segment.y1);
        const second = Math.hypot(x - segment.x2, y - segment.y2);
        best = {
          row: first <= second ? segment.row1 : segment.row2,
          distance,
        };
      }
      return best === null ? null : { data, row: best.row };
    },
  };
}

function pointToSegmentDistance(x: number, y: number, segment: PointSegment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - segment.x1, y - segment.y1);
  const ratio = Math.max(
    0,
    Math.min(1, ((x - segment.x1) * dx + (y - segment.y1) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(
    x - (segment.x1 + ratio * dx),
    y - (segment.y1 + ratio * dy),
  );
}

function updateReadout(dom: PanelDom, viewport: PanelViewport): void {
  const component = dom.panel.components.find(
    (candidate): candidate is ReadoutComponent => candidate.name === "readout/v1",
  );
  if (component === undefined) {
    dom.readout.textContent = "";
    return;
  }
  dom.readout.textContent = component.items
    .map((item) => `${item.label} ${formatValue(reduce(item, component.data, viewport), item.unit)}`)
    .join(" · ");
}

export function reduce(
  item: ReadoutItem,
  data: PanelData,
  viewport: PanelViewport,
): number {
  if (typeof item.reduce === "object") {
    let weighted = 0;
    let duration = 0;
    const [first, last] = visibleRows(data, viewport);
    for (let row = first; row < last; row++) {
      const start = item.reduce.start.get(row);
      const end = item.reduce.end.get(row);
      const value = item.values.get(row);
      if (start === null || end === null || value === null) continue;
      const overlap = Math.min(end, viewport.end) - Math.max(start, viewport.start);
      if (!(overlap > 0)) continue;
      weighted += overlap * value;
      duration += overlap;
    }
    return duration > 0 ? weighted / duration : 0;
  }

  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const [first, last] = visibleRows(data, viewport);
  for (let row = first; row < last; row++) {
    if (!rowTouchesViewport(data, row, viewport)) continue;
    const value = item.values.get(row);
    if (value === null || !Number.isFinite(value)) continue;
    count++;
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  switch (item.reduce) {
    case "count": return count;
    case "sum": return sum;
    case "mean": return count > 0 ? sum / count : 0;
    case "min": return count > 0 ? min : 0;
    case "max": return count > 0 ? max : 0;
  }
}

function showHitTooltip(
  panel: ResolvedPanel,
  hit: Hit,
  tooltip: HTMLElement,
  event: MouseEvent,
): boolean {
  const component = panel.components.find(
    (candidate): candidate is TooltipComponent =>
      candidate.name === "tooltip/v1" && candidate.data === hit.data,
  );
  if (component === undefined) return false;
  const rows = component.items.flatMap((item) => {
    const value = item.values.get(hit.row);
    return value === null || value === ""
      ? []
      : [{ label: item.label, value: formatValue(value, item.unit) }];
  });
  if (rows.length === 0) return false;

  const children: Node[] = [];
  rows.forEach((row, index) => {
    if (index > 0) children.push(document.createElement("br"));
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${row.label}:`;
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = row.value;
    children.push(label, document.createTextNode(" "), value);
  });
  tooltip.replaceChildren(...children);
  tooltip.style.display = "block";
  placeTooltip(tooltip, event);
  return true;
}

function hideTooltip(tooltip: HTMLElement): void {
  tooltip.style.display = "none";
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

function alphaColor(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (match === null) return color;
  const hex = match[1]!;
  return `rgba(${Number.parseInt(hex.slice(0, 2), 16)}, ` +
    `${Number.parseInt(hex.slice(2, 4), 16)}, ` +
    `${Number.parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const absolute = Math.abs(value);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return "-";
  if (unit === "%") {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(1)}%` : String(value);
  }
  if (unit === "ns") return formatDuration(Number(value));
  const formatted = typeof value === "number" ? formatNumber(value) : String(value);
  return unit === undefined ? formatted : `${formatted} ${unit}`;
}

function formatDuration(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return "0ns";
  if (ns < 1_000) return `${Math.round(ns)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  const seconds = ns / 1e9;
  return seconds < 60 ? `${seconds.toFixed(2)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}
