import { html, render, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import {
  LABEL_W,
  clampX,
  createCanvasSizer,
  nsToDrawX,
  type CanvasSizer,
} from "../../lib/canvas/index.js";
import { lanesScrollbarWidth } from "../../lib/canvas/track-layout.js";
import { formatFieldValue } from "../../lib/trace/index.js";
import type { CustomTraceEvent, ParsedTrace } from "../../lib/trace/index.js";
import type { ViewerStore } from "../../store/store.js";
import type {
  FieldChartKind,
  FieldChartSpec,
} from "../../types/state.js";
import {
  createTooltip,
  tooltipRowsTemplate,
} from "../../components/overlay/tooltip.js";
import type { EscCascade } from "./esc-cascade.js";
import { ESC_PRIORITY } from "./esc-cascade.js";
import {
  FIELD_CHART_KINDS,
  fieldChartKey,
  hasFieldChartData,
  isFieldChartKind,
  isGraphableFieldValue,
  materializeFieldChart,
  visibleFieldChartRange,
  visibleFieldChartStats,
  type FieldChartInterval,
  type FieldChartPoint,
  type FieldChartSeries,
} from "./field-chart-model.js";

const ROW_HEIGHT = 96;
const CHART_TOP = 24;
const CHART_BOTTOM = 9;
const BACKGROUND = "#121b2e";
const GRID = "rgba(255,255,255,0.07)";
const AXIS = "#737995";
const SERIES = "#4fc3f7";
const AREA = "rgba(79,195,247,0.30)";
const EMPTY = "#737995";

export type FieldChartNoticeType = "info" | "error";

export interface FieldChartsDeps {
  esc: EscCascade;
  notify(message: string, type: FieldChartNoticeType): void;
}

export interface FieldChartsController {
  /** Whether the inspector should offer a graph action for this field. */
  canGraphField(event: CustomTraceEvent, field: string): boolean;
  /** Create directly from metadata, or open the interpretation dialog. */
  openField(
    event: CustomTraceEvent,
    field: string,
    restoreFocus?: HTMLElement,
  ): void;
  /** Drop invalid specs restored from the initial URL after its trace loads. */
  reconcileRestoredCharts(): void;
  dispose(): void;
}

interface CachedSeries {
  trace: ParsedTrace;
  series: FieldChartSeries;
}

interface PaintedChart {
  spec: FieldChartSpec;
  series: FieldChartSeries;
  viewStart: number;
  viewEnd: number;
  drawW: number;
  chartTop: number;
  chartHeight: number;
  min: number;
  max: number;
}

interface RowModel {
  spec: FieldChartSpec;
  series: FieldChartSeries;
  readout: string;
}

/**
 * Mount the dynamic field-chart stack. Durable state contains only specs;
 * materialized data, canvas state, hit-test geometry and the tooltip all live
 * here and are released when a chart closes.
 */
export function mountFieldCharts(
  host: HTMLElement,
  trackColumn: HTMLElement,
  store: ViewerStore,
  deps: FieldChartsDeps,
): FieldChartsController {
  const cache = new Map<string, CachedSeries>();
  const painted = new Map<string, PaintedChart>();
  const sizers = new WeakMap<
    HTMLCanvasElement,
    CanvasSizer<CanvasRenderingContext2D>
  >();
  const tooltip = createTooltip(host.ownerDocument);
  const dialog = new FieldChartDialog(host.ownerDocument, deps.esc, add);

  function seriesFor(
    trace: ParsedTrace,
    spec: FieldChartSpec,
  ): FieldChartSeries {
    const key = fieldChartKey(spec);
    const existing = cache.get(key);
    if (existing?.trace === trace) return existing.series;
    const series = materializeFieldChart(trace.customEvents ?? [], spec);
    cache.set(key, { trace, series });
    return series;
  }

  function add(spec: FieldChartSpec): boolean {
    const state = store.getState();
    if (
      state.view.fieldCharts.some(
        (existing) => fieldChartKey(existing) === fieldChartKey(spec),
      )
    ) {
      deps.notify(`${spec.eventName} · ${spec.field} is already graphed`, "info");
      return false;
    }
    const trace = state.trace.trace;
    if (trace === null) {
      deps.notify("Load a trace before creating a field chart", "error");
      return false;
    }
    const series = seriesFor(trace, spec);
    if (!hasFieldChartData(series)) {
      cache.delete(fieldChartKey(spec));
      deps.notify(
        `${spec.eventName} · ${spec.field} has no compatible values for ${kindLabel(spec.kind)}`,
        "error",
      );
      return false;
    }
    store.update("view", {
      fieldCharts: [...state.view.fieldCharts, spec],
    });
    return true;
  }

  function remove(spec: FieldChartSpec): void {
    const key = fieldChartKey(spec);
    const current = store.getState().view.fieldCharts;
    const next = current.filter((item) => fieldChartKey(item) !== key);
    if (next.length === current.length) return;
    tooltip.hide();
    cache.delete(key);
    painted.delete(key);
    store.update("view", { fieldCharts: next });
  }

  function rows(): RowModel[] {
    const state = store.getState();
    const trace = state.trace.trace;
    if (trace === null) return [];
    return state.view.fieldCharts.map((spec) => {
      const series = seriesFor(trace, spec);
      const stats = visibleFieldChartStats(
        series,
        state.viewport.viewStart,
        state.viewport.viewEnd,
      );
      return {
        spec,
        series,
        readout:
          stats === null
            ? "No values in view"
            : `avg ${formatReadoutValue(stats.avg, series.unit)} · max ${formatReadoutValue(stats.max, series.unit)}`,
      };
    });
  }

  function rowTemplate(row: RowModel): TemplateResult {
    const key = fieldChartKey(row.spec);
    const title = `${row.spec.eventName} · ${row.spec.field}`;
    return html`
      <div
        class="d9-field-chart"
        data-field-chart-key=${key}
        style="height:${ROW_HEIGHT}px"
      >
        <div class="d9-field-chart-label" title=${title}>
          <span>${title}</span>
        </div>
        <div class="d9-field-chart-body">
          <span class="d9-field-chart-readout">${row.readout}</span>
          <button
            type="button"
            class="d9-field-chart-close"
            title="Close chart"
            aria-label=${`Close ${title}`}
            @click=${() => remove(row.spec)}
          >
            ×
          </button>
          <canvas
            class="d9-field-chart-canvas"
            data-field-chart-canvas=${key}
            aria-label=${`${title}, ${kindLabel(row.spec.kind)} chart`}
            role="img"
            @mousemove=${(event: MouseEvent) => onPointerMove(event, key)}
            @mouseleave=${() => tooltip.hide()}
          ></canvas>
        </div>
      </div>
    `;
  }

  function renderPass(): void {
    const activeRows = rows();
    const activeKeys = new Set(activeRows.map((row) => fieldChartKey(row.spec)));
    for (const key of cache.keys()) {
      if (!activeKeys.has(key)) cache.delete(key);
    }
    for (const key of painted.keys()) {
      if (!activeKeys.has(key)) painted.delete(key);
    }
    if (activeRows.length === 0) tooltip.hide();

    render(
      html`${repeat(
        activeRows,
        (row) => fieldChartKey(row.spec),
        rowTemplate,
      )}`,
      host,
    );

    const state = store.getState();
    const drawW =
      trackColumn.clientWidth - LABEL_W - lanesScrollbarWidth(trackColumn);
    const dpr =
      (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) || 1;
    if (drawW <= 0) return;

    const canvases = new Map<string, HTMLCanvasElement>();
    for (const canvas of host.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-field-chart-canvas]",
    )) {
      const key = canvas.dataset["fieldChartCanvas"];
      if (key !== undefined) canvases.set(key, canvas);
    }
    for (const row of activeRows) {
      const key = fieldChartKey(row.spec);
      const canvas = canvases.get(key);
      if (canvas === undefined) continue;
      let sizer = sizers.get(canvas);
      if (sizer === undefined) {
        sizer = createCanvasSizer(canvas);
        sizers.set(canvas, sizer);
      }
      const ctx = sizer.ensure(drawW, ROW_HEIGHT, dpr);
      const chart = paintChart(
        ctx,
        row.spec,
        row.series,
        state.viewport.viewStart,
        state.viewport.viewEnd,
        drawW,
        ROW_HEIGHT,
      );
      painted.set(key, chart);
    }
  }

  function onPointerMove(event: MouseEvent, key: string): void {
    const chart = painted.get(key);
    const canvas = event.currentTarget;
    if (
      chart === undefined ||
      !(canvas instanceof HTMLCanvasElement) ||
      chart.drawW <= 0
    ) {
      tooltip.hide();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = datumAt(chart, x, y);
    if (hit === null) {
      tooltip.hide();
      return;
    }
    tooltip.show(
      tooltipRowsTemplate([
        [
          {
            label: `${chart.spec.field}:`,
            value: formatFieldValue(hit, chart.series.unit),
          },
        ],
      ]),
      { clientX: event.clientX, clientY: event.clientY },
    );
  }

  const unsubscribe = store.subscribe(
    ["trace", "viewport", "view"],
    () => renderPass(),
  );
  renderPass();

  return {
    canGraphField(event, field): boolean {
      return (
        isFieldChartKind(event.kinds?.[field]) ||
        isGraphableFieldValue(event.fields?.[field])
      );
    },
    openField(event, field, restoreFocus): void {
      const metadataKind = event.kinds?.[field];
      if (isFieldChartKind(metadataKind)) {
        add({ eventName: event.name, field, kind: metadataKind });
        return;
      }
      dialog.open(
        { eventName: event.name, field },
        restoreFocus,
      );
    },
    reconcileRestoredCharts(): void {
      const state = store.getState();
      const trace = state.trace.trace;
      if (trace === null || state.view.fieldCharts.length === 0) return;
      const valid: FieldChartSpec[] = [];
      let invalid = 0;
      for (const spec of state.view.fieldCharts) {
        if (hasFieldChartData(seriesFor(trace, spec))) valid.push(spec);
        else invalid++;
      }
      if (invalid === 0) return;
      store.update("view", { fieldCharts: valid });
      deps.notify(
        `${invalid} field chart${invalid === 1 ? "" : "s"} from the URL had no compatible trace data`,
        "error",
      );
    },
    dispose(): void {
      unsubscribe();
      dialog.dispose();
      tooltip.dispose();
      cache.clear();
      painted.clear();
      render(html``, host);
    },
  };
}

function paintChart(
  ctx: CanvasRenderingContext2D,
  spec: FieldChartSpec,
  series: FieldChartSeries,
  viewStart: number,
  viewEnd: number,
  drawW: number,
  height: number,
): PaintedChart {
  ctx.clearRect(0, 0, drawW, height);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, drawW, height);

  const chartTop = CHART_TOP;
  const chartHeight = Math.max(0, height - CHART_TOP - CHART_BOTTOM);
  const range = visibleFieldChartRange(series, viewStart, viewEnd);
  let min = 0;
  let max = 0;
  let hasData = false;
  if (series.kind === "gauge") {
    for (let i = range.start; i < range.end; i++) {
      const value = series.points[i]!.value;
      min = Math.min(min, value);
      max = Math.max(max, value);
      hasData = true;
    }
  } else {
    for (let i = range.start; i < range.end; i++) {
      const value = series.intervals[i]!.value;
      min = Math.min(min, value);
      max = Math.max(max, value);
      hasData = true;
    }
  }
  if (min === max) max = min + 1;

  if (chartHeight > 0 && viewEnd > viewStart) {
    paintGrid(ctx, drawW, chartTop, chartHeight, min, max);
    if (hasData) {
      if (series.kind === "gauge") {
        paintPoints(
          ctx,
          series.points,
          range.start,
          range.end,
          viewStart,
          viewEnd,
          drawW,
          chartTop,
          chartHeight,
          min,
          max,
        );
      } else {
        paintIntervals(
          ctx,
          series.intervals,
          range.start,
          range.end,
          viewStart,
          viewEnd,
          drawW,
          chartTop,
          chartHeight,
          min,
          max,
        );
      }
    } else {
      ctx.fillStyle = EMPTY;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("No values in view", 8, chartTop + 17);
    }
  }

  return {
    spec,
    series,
    viewStart,
    viewEnd,
    drawW,
    chartTop,
    chartHeight,
    min,
    max,
  };
}

function paintGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  height: number,
  min: number,
  max: number,
): void {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i <= 3; i++) {
    const y = top + (height * i) / 4;
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();

  ctx.fillStyle = AXIS;
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.fillText(compactNumber(max), 3, top + 9);
  ctx.fillText(compactNumber(min), 3, top + height - 2);
}

function paintPoints(
  ctx: CanvasRenderingContext2D,
  points: readonly FieldChartPoint[],
  start: number,
  end: number,
  viewStart: number,
  viewEnd: number,
  drawW: number,
  top: number,
  height: number,
  min: number,
  max: number,
): void {
  ctx.fillStyle = SERIES;
  for (let i = start; i < end; i++) {
    const point = points[i]!;
    const x = nsToDrawX(point.timestamp, viewStart, viewEnd, drawW);
    const y = valueY(point.value, min, max, top, height);
    ctx.fillRect(Math.round(x) - 1.5, Math.round(y) - 1.5, 3, 3);
  }
}

function paintIntervals(
  ctx: CanvasRenderingContext2D,
  intervals: readonly FieldChartInterval[],
  start: number,
  end: number,
  viewStart: number,
  viewEnd: number,
  drawW: number,
  top: number,
  height: number,
  min: number,
  max: number,
): void {
  const baseline = valueY(0, min, max, top, height);
  ctx.fillStyle = AREA;
  for (let i = start; i < end; i++) {
    const interval = intervals[i]!;
    const x1 = clampX(
      nsToDrawX(interval.start, viewStart, viewEnd, drawW),
      drawW,
    );
    const x2 = clampX(
      nsToDrawX(interval.end, viewStart, viewEnd, drawW),
      drawW,
    );
    const y = valueY(interval.value, min, max, top, height);
    ctx.fillRect(x1, Math.min(y, baseline), Math.max(1, x2 - x1), Math.abs(baseline - y));
  }

  ctx.strokeStyle = SERIES;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let previous: FieldChartInterval | null = null;
  for (let i = start; i < end; i++) {
    const interval = intervals[i]!;
    const x1 = clampX(
      nsToDrawX(interval.start, viewStart, viewEnd, drawW),
      drawW,
    );
    const x2 = clampX(
      nsToDrawX(interval.end, viewStart, viewEnd, drawW),
      drawW,
    );
    const y = valueY(interval.value, min, max, top, height);
    if (previous !== null && previous.end === interval.start) {
      ctx.lineTo(x1, y);
    } else {
      ctx.moveTo(x1, y);
    }
    ctx.lineTo(x2, y);
    previous = interval;
  }
  ctx.stroke();
}

function datumAt(
  chart: PaintedChart,
  x: number,
  y: number,
): number | bigint | string | null {
  if (
    x < 0 ||
    x > chart.drawW ||
    y < chart.chartTop ||
    y > chart.chartTop + chart.chartHeight ||
    !(chart.viewEnd > chart.viewStart)
  ) {
    return null;
  }
  const timestamp =
    chart.viewStart +
    (x / chart.drawW) * (chart.viewEnd - chart.viewStart);
  if (chart.series.kind === "gauge") {
    const point = nearestPoint(chart.series.points, timestamp);
    if (point === null) return null;
    const pointX = nsToDrawX(
      point.timestamp,
      chart.viewStart,
      chart.viewEnd,
      chart.drawW,
    );
    const pointY = valueY(
      point.value,
      chart.min,
      chart.max,
      chart.chartTop,
      chart.chartHeight,
    );
    return Math.hypot(pointX - x, pointY - y) <= 8
      ? point.displayValue
      : null;
  }
  return intervalAt(chart.series.intervals, timestamp)?.displayValue ?? null;
}

function nearestPoint(
  points: readonly FieldChartPoint[],
  timestamp: number,
): FieldChartPoint | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  const right = points[lo] ?? null;
  const left = lo > 0 ? points[lo - 1]! : null;
  if (left === null) return right;
  if (right === null) return left;
  return timestamp - left.timestamp <= right.timestamp - timestamp
    ? left
    : right;
}

function intervalAt(
  intervals: readonly FieldChartInterval[],
  timestamp: number,
): FieldChartInterval | null {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const interval = intervals[mid]!;
    if (timestamp < interval.start) hi = mid - 1;
    else if (timestamp > interval.end) lo = mid + 1;
    else return interval;
  }
  return null;
}

function valueY(
  value: number,
  min: number,
  max: number,
  top: number,
  height: number,
): number {
  return top + ((max - value) / (max - min || 1)) * height;
}

function formatReadoutValue(value: number, unit: string | undefined): string {
  return unit === undefined
    ? compactNumber(value)
    : formatFieldValue(Number(value.toPrecision(5)), unit);
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return String(Number(value.toPrecision(5)));
}

function kindLabel(kind: FieldChartKind): string {
  switch (kind) {
    case "gauge":
      return "Gauge";
    case "counter":
      return "Counter";
    case "up_down_counter":
      return "Up/down counter";
  }
}

class FieldChartDialog {
  readonly #dialog: HTMLDialogElement;
  readonly #title: HTMLHeadingElement;
  readonly #select: HTMLSelectElement;
  readonly #submit: (spec: FieldChartSpec) => boolean;
  readonly #unregisterEsc: () => void;
  #pending: Omit<FieldChartSpec, "kind"> | null = null;
  #restoreFocus: HTMLElement | null = null;

  constructor(
    doc: Document,
    esc: EscCascade,
    submit: (spec: FieldChartSpec) => boolean,
  ) {
    this.#submit = submit;
    this.#dialog = doc.createElement("dialog");
    this.#dialog.className = "d9-field-chart-dialog";
    this.#dialog.setAttribute("aria-labelledby", "d9-field-chart-dialog-title");

    const form = doc.createElement("form");
    this.#title = doc.createElement("h2");
    this.#title.id = "d9-field-chart-dialog-title";

    const label = doc.createElement("label");
    label.textContent = "Interpret as";
    this.#select = doc.createElement("select");
    for (const value of FIELD_CHART_KINDS) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = kindLabel(value);
      this.#select.append(option);
    }
    label.append(this.#select);

    const actions = doc.createElement("div");
    actions.className = "d9-field-chart-dialog-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const create = doc.createElement("button");
    create.type = "submit";
    create.className = "is-primary";
    create.textContent = "Create";
    actions.append(cancel, create);

    form.append(this.#title, label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#pending === null || !isFieldChartKind(this.#select.value)) {
        return;
      }
      if (this.#submit({ ...this.#pending, kind: this.#select.value })) {
        this.close();
      }
    });
    this.#dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.#dialog.addEventListener("close", () => this.restoreFocus());
    this.#dialog.append(form);
    doc.body.append(this.#dialog);

    this.#unregisterEsc = esc.register({
      name: "field-chart-dialog",
      priority: ESC_PRIORITY.popup,
      isOpen: () => this.#dialog.open,
      close: () => this.close(),
    });
  }

  open(
    request: Omit<FieldChartSpec, "kind">,
    restoreFocus: HTMLElement | undefined,
  ): void {
    this.#pending = request;
    this.#restoreFocus = restoreFocus ?? null;
    this.#title.textContent = `${request.eventName} · ${request.field}`;
    this.#select.value = "gauge";
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#select.focus();
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close();
    else this.restoreFocus();
  }

  dispose(): void {
    this.close();
    this.#unregisterEsc();
    this.#dialog.remove();
  }

  private restoreFocus(): void {
    const target = this.#restoreFocus;
    this.#pending = null;
    this.#restoreFocus = null;
    target?.focus();
  }
}
