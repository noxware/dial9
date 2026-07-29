import { html, type TemplateResult } from "lit-html";
import {
  clampX,
  createCanvasSizer,
  nsToDrawX,
  type CanvasSizer,
} from "../../lib/canvas/index.js";
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
  fieldChartLabel,
  hasFieldChartData,
  isFieldChartKind,
  isGraphableFieldValue,
  materializeFieldChart,
  nextFieldChartId,
  visibleFieldChartRange,
  visibleFieldChartStats,
  type FieldChartInterval,
  type FieldChartPoint,
  type FieldChartSeries,
} from "./field-chart-model.js";
import {
  orderedManagedTrackIds,
  removeTrackIdsFromLayout,
} from "./track-management.js";

export const FIELD_CHART_TRACK_HEIGHT = 96;
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

type FieldChartDefinition = Omit<FieldChartSpec, "id">;
type FieldChartRequest = Omit<FieldChartSpec, "id" | "kind">;

export interface FieldChartsController {
  /** Render one row inside the shell-owned unified track column. */
  rowTemplate(spec: FieldChartSpec, trackHeight: number): TemplateResult;
  /** Size and paint one field-chart canvas inside the shell render pass. */
  paint(
    spec: FieldChartSpec,
    canvas: HTMLCanvasElement,
    drawW: number,
    trackHeight: number,
    dpr: number,
    viewStart: number,
    viewEnd: number,
  ): void;
  /** Drop hover geometry when the shared track shell collapses this row. */
  deactivate(id: string): void;
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
  semanticKey: string;
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

/**
 * Create the dynamic field-chart renderer. The shell owns row placement,
 * collapse and drag; this controller owns only chart data, paint/hit state,
 * tooltip and the semantic fallback dialog.
 */
export function createFieldCharts(
  doc: Document,
  store: ViewerStore,
  deps: FieldChartsDeps,
): FieldChartsController {
  const cache = new Map<string, CachedSeries>();
  const painted = new Map<string, PaintedChart>();
  const sizers = new WeakMap<
    HTMLCanvasElement,
    CanvasSizer<CanvasRenderingContext2D>
  >();
  const tooltip = createTooltip(doc);
  const dialog = new FieldChartDialog(doc, deps.esc, add);

  function seriesFor(
    trace: ParsedTrace,
    spec: FieldChartSpec,
  ): FieldChartSeries {
    const semanticKey = fieldChartKey(spec);
    const existing = cache.get(spec.id);
    if (
      existing?.trace === trace &&
      existing.semanticKey === semanticKey
    ) {
      return existing.series;
    }
    const series = materializeFieldChart(trace.customEvents ?? [], spec);
    cache.set(spec.id, { trace, semanticKey, series });
    return series;
  }

  function add(definition: FieldChartDefinition): void {
    const state = store.getState();
    if (
      state.view.fieldCharts.some(
        (existing) => fieldChartKey(existing) === fieldChartKey(definition),
      )
    ) {
      deps.notify(
        `${definition.eventName} · ${definition.field} is already graphed`,
        "info",
      );
      return;
    }
    const trace = state.trace.trace;
    if (trace === null) {
      deps.notify("Load a trace before creating a field chart", "error");
      return;
    }
    const spec: FieldChartSpec = {
      id: nextFieldChartId(state.view.fieldCharts),
      ...definition,
    };
    const series = seriesFor(trace, spec);
    if (!hasFieldChartData(series)) {
      cache.delete(spec.id);
      deps.notify(
        `${spec.eventName} · ${spec.field} has no compatible values for ${kindLabel(spec.kind)}`,
        "error",
      );
      return;
    }
    const fieldCharts = [...state.view.fieldCharts, spec];
    store.update("uiPrefs", {
      trackOrder: [
        ...orderedManagedTrackIds(
          state.uiPrefs.trackOrder,
          state.view.fieldCharts.map((chart) => chart.id),
        ),
        spec.id,
      ],
    });
    store.update("view", {
      fieldCharts,
    });
  }

  function remove(spec: FieldChartSpec): void {
    const state = store.getState();
    const current = state.view.fieldCharts;
    const next = current.filter((item) => item.id !== spec.id);
    if (next.length === current.length) return;
    tooltip.hide();
    cache.delete(spec.id);
    painted.delete(spec.id);
    store.update(
      "uiPrefs",
      removeTrackIdsFromLayout(
        state.uiPrefs.trackOrder,
        state.uiPrefs.collapsed,
        [spec.id],
      ),
    );
    store.update("view", { fieldCharts: next });
  }

  function rowTemplate(
    spec: FieldChartSpec,
    trackHeight: number,
  ): TemplateResult {
    const state = store.getState();
    const trace = state.trace.trace;
    const series = trace === null ? null : seriesFor(trace, spec);
    const stats =
      series === null
        ? null
        : visibleFieldChartStats(
            series,
            state.viewport.viewStart,
            state.viewport.viewEnd,
          );
    const readout =
      stats === null || series === null
        ? "No values in view"
        : `avg ${formatReadoutValue(stats.avg, series.unit)} · max ${formatReadoutValue(stats.max, series.unit)}`;
    const title = `${spec.eventName} · ${spec.field}`;
    const label = fieldChartLabel(spec.field);
    return html`
      <div
        class="d9-track d9-field-chart"
        data-track-id=${spec.id}
        style="height:${trackHeight}px"
      >
        <div class="d9-track-label" id="d9-track-label-${spec.id}">
          <span class="d9-track-name" title=${title}>${label}</span>
        </div>
        <div class="d9-track-canvas-wrap d9-field-chart-body">
          <span class="d9-field-chart-readout">${readout}</span>
          <button
            type="button"
            class="d9-field-chart-close"
            title="Close chart"
            aria-label=${`Close ${title}`}
            @click=${() => remove(spec)}
          >
            ×
          </button>
          <canvas
            class="d9-track-canvas d9-field-chart-canvas"
            data-track-canvas=${spec.id}
            aria-labelledby="d9-track-label-${spec.id}"
            aria-label=${`${title}, ${kindLabel(spec.kind)} chart`}
            role="img"
            @mousemove=${(event: MouseEvent) =>
              onPointerMove(event, spec.id)}
            @mouseleave=${() => tooltip.hide()}
          ></canvas>
        </div>
      </div>
    `;
  }

  function paint(
    spec: FieldChartSpec,
    canvas: HTMLCanvasElement,
    drawW: number,
    trackHeight: number,
    dpr: number,
    viewStart: number,
    viewEnd: number,
  ): void {
    const state = store.getState();
    const trace = state.trace.trace;
    if (trace === null || drawW <= 0) return;
    let sizer = sizers.get(canvas);
    if (sizer === undefined) {
      sizer = createCanvasSizer<CanvasRenderingContext2D>(canvas);
      sizers.set(canvas, sizer);
    }
    const ctx = sizer.ensure(drawW, trackHeight, dpr);
    painted.set(
      spec.id,
      paintChart(
        ctx,
        spec,
        seriesFor(trace, spec),
        viewStart,
        viewEnd,
        drawW,
        trackHeight,
      ),
    );
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

  const unsubscribe = store.subscribe(["view"], (state) => {
    const active = new Set(state.view.fieldCharts.map((chart) => chart.id));
    for (const id of cache.keys()) {
      if (!active.has(id)) cache.delete(id);
    }
    for (const id of painted.keys()) {
      if (!active.has(id)) painted.delete(id);
    }
    if (active.size === 0) tooltip.hide();
  });

  return {
    rowTemplate,
    paint,
    deactivate(id): void {
      painted.delete(id);
      tooltip.hide();
    },
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
      const invalidIds: string[] = [];
      for (const spec of state.view.fieldCharts) {
        if (hasFieldChartData(seriesFor(trace, spec))) valid.push(spec);
        else invalidIds.push(spec.id);
      }
      if (invalidIds.length === 0) return;
      for (const id of invalidIds) {
        cache.delete(id);
        painted.delete(id);
      }
      store.update(
        "uiPrefs",
        removeTrackIdsFromLayout(
          state.uiPrefs.trackOrder,
          state.uiPrefs.collapsed,
          invalidIds,
        ),
      );
      store.update("view", { fieldCharts: valid });
      deps.notify(
        `${invalidIds.length} field chart${invalidIds.length === 1 ? "" : "s"} from the URL had no compatible trace data`,
        "error",
      );
    },
    dispose(): void {
      unsubscribe();
      dialog.dispose();
      tooltip.dispose();
      cache.clear();
      painted.clear();
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
  const paintStart =
    series.kind === "gauge" ? Math.max(0, range.start - 1) : range.start;
  const paintEnd =
    series.kind === "gauge"
      ? Math.min(series.points.length, range.end + 1)
      : range.end;
  let min = 0;
  let max = 0;
  let hasData = false;
  if (series.kind === "gauge") {
    for (let i = paintStart; i < paintEnd; i++) {
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
          paintStart,
          paintEnd,
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
  ctx.strokeStyle = SERIES;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = start; i < end; i++) {
    const point = points[i]!;
    const x = nsToDrawX(point.timestamp, viewStart, viewEnd, drawW);
    const y = valueY(point.value, min, max, top, height);
    if (i === start || point.breakBefore) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

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
  readonly #submit: (spec: FieldChartDefinition) => void;
  readonly #unregisterEsc: () => void;
  #pending: FieldChartRequest | null = null;
  #restoreFocus: HTMLElement | null = null;

  constructor(
    doc: Document,
    esc: EscCascade,
    submit: (spec: FieldChartDefinition) => void,
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
      const spec = { ...this.#pending, kind: this.#select.value };
      this.close();
      this.#submit(spec);
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
    request: FieldChartRequest,
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
