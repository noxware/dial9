import type { CustomTraceEvent } from "../../lib/trace/index.js";
import type {
  FieldChartKind,
  FieldChartSpec,
} from "../../types/state.js";

const INTEGER_DECIMAL = /^-?(?:0|[1-9]\d*)$/;
const DECIMAL =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const FIELD_CHART_ID = /^fc([1-9]\d*)$/;

export const FIELD_CHART_KINDS: readonly FieldChartKind[] = [
  "gauge",
  "counter",
  "up_down_counter",
];

export interface FieldChartPoint {
  timestamp: number;
  /** Finite coordinate used by statistics and the canvas. */
  value: number;
  /** Exact source value used by the tooltip where possible. */
  displayValue: number | bigint | string;
  /** True when this sample starts a new line segment. */
  breakBefore: boolean;
}

export interface FieldChartInterval {
  start: number;
  end: number;
  /** Finite coordinate used by statistics and the canvas. */
  value: number;
  /** Exact delta used by the tooltip where possible. */
  displayValue: number | bigint;
}

export type FieldChartSeries =
  | {
      kind: "gauge";
      unit: string | undefined;
      points: readonly FieldChartPoint[];
    }
  | {
      kind: "counter" | "up_down_counter";
      unit: string | undefined;
      intervals: readonly FieldChartInterval[];
    };

export interface FieldChartStats {
  avg: number;
  max: number;
}

export interface FieldChartVisibleRange {
  start: number;
  end: number;
}

interface NumericFieldValue {
  number: number;
  integer: bigint | null;
  displayValue: number | bigint | string;
}

/** True for the three stable semantic values accepted by Rust and the URL. */
export function isFieldChartKind(value: unknown): value is FieldChartKind {
  return FIELD_CHART_KINDS.some((kind) => kind === value);
}

/** Collision-free semantic key; the stable track id is deliberately excluded. */
export function fieldChartKey(
  spec: Pick<FieldChartSpec, "eventName" | "field" | "kind">,
): string {
  return JSON.stringify([spec.eventName, spec.field, spec.kind]);
}

/** Whether a string is a valid short field-chart track id. */
export function isFieldChartId(value: unknown): value is string {
  return typeof value === "string" && FIELD_CHART_ID.test(value);
}

/** Allocate the first unused short id. */
export function nextFieldChartId(
  charts: readonly FieldChartSpec[],
): string {
  const used = new Set(charts.map((chart) => chart.id));
  for (let next = 1; ; next++) {
    const id = `fc${next}`;
    if (!used.has(id)) return id;
  }
}

/** Stable numeric ordering used when a URL omits `track-order`. */
export function compareFieldChartIds(left: string, right: string): number {
  const leftDigits = FIELD_CHART_ID.exec(left)?.[1] ?? "";
  const rightDigits = FIELD_CHART_ID.exec(right)?.[1] ?? "";
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length - rightDigits.length;
  }
  return leftDigits < rightDigits ? -1 : leftDigits > rightDigits ? 1 : 0;
}

/** Compact human label for the fixed-width track gutter. */
export function fieldChartLabel(field: string): string {
  const words = field.replace(/[_-]+/g, " ").trim();
  return words.length === 0
    ? field
    : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * Whether one decoded value can seed a numeric chart. Strings deliberately
 * accept only canonical decimal syntax: whitespace, hex, Infinity and
 * JavaScript coercion oddities are not numeric event fields.
 */
export function isGraphableFieldValue(value: unknown): boolean {
  return numericFieldValue(value) !== null;
}

/**
 * Materialize only the requested event type and field. The input array is
 * never mutated; the filtered subset is timestamp-sorted once.
 */
export function materializeFieldChart(
  events: readonly CustomTraceEvent[],
  spec: FieldChartSpec,
): FieldChartSeries {
  const matching = events
    .filter((event) => event.name === spec.eventName)
    .map((event) => ({
      timestamp: event.timestamp,
      value: event.fields?.[spec.field],
      unit: event.units?.[spec.field],
    }))
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);

  const unit = matching.find((event) => event.unit !== undefined)?.unit;
  if (spec.kind === "gauge") {
    const points: FieldChartPoint[] = [];
    let breakBefore = true;
    for (const event of matching) {
      const value = numericFieldValue(event.value);
      if (value === null) {
        breakBefore = true;
        continue;
      }
      points.push({
        timestamp: event.timestamp,
        value: value.number,
        displayValue: value.displayValue,
        breakBefore,
      });
      breakBefore = false;
    }
    return { kind: "gauge", unit, points };
  }

  const intervals: FieldChartInterval[] = [];
  let previous: { timestamp: number; value: NumericFieldValue } | null = null;
  for (const event of matching) {
    const current = numericFieldValue(event.value);
    if (current === null) {
      previous = null;
      continue;
    }
    if (previous === null) {
      previous = { timestamp: event.timestamp, value: current };
      continue;
    }

    // A same-timestamp value replaces the baseline without creating a
    // zero-width interval.
    if (event.timestamp <= previous.timestamp) {
      previous = { timestamp: event.timestamp, value: current };
      continue;
    }

    const delta = subtract(current, previous.value);
    if (
      delta !== null &&
      (spec.kind === "up_down_counter" || !isNegative(delta.displayValue))
    ) {
      intervals.push({
        start: previous.timestamp,
        end: event.timestamp,
        value: delta.number,
        displayValue: delta.displayValue,
      });
    }
    // A monotonic decrease is a reset: omit its interval, then use the new
    // value as the next baseline.
    previous = { timestamp: event.timestamp, value: current };
  }

  return { kind: spec.kind, unit, intervals };
}

/** A chart can be created only when it has at least one drawable datum. */
export function hasFieldChartData(series: FieldChartSeries): boolean {
  return series.kind === "gauge"
    ? series.points.length > 0
    : series.intervals.length > 0;
}

/** Viewport-local avg/max used by the chart readout. */
export function visibleFieldChartStats(
  series: FieldChartSeries,
  viewStart: number,
  viewEnd: number,
): FieldChartStats | null {
  if (!(viewEnd > viewStart)) return null;
  const range = visibleFieldChartRange(series, viewStart, viewEnd);
  if (series.kind === "gauge") {
    let sum = 0;
    let max = -Infinity;
    let count = 0;
    for (let i = range.start; i < range.end; i++) {
      const point = series.points[i]!;
      sum += point.value;
      max = Math.max(max, point.value);
      count++;
    }
    return count > 0 ? { avg: sum / count, max } : null;
  }

  let weighted = 0;
  let duration = 0;
  let max = -Infinity;
  for (let i = range.start; i < range.end; i++) {
    const interval = series.intervals[i]!;
    const overlap =
      Math.min(interval.end, viewEnd) - Math.max(interval.start, viewStart);
    if (!(overlap > 0)) continue;
    weighted += interval.value * overlap;
    duration += overlap;
    max = Math.max(max, interval.value);
  }
  return duration > 0 ? { avg: weighted / duration, max } : null;
}

/** Half-open index range of datums touching the viewport. */
export function visibleFieldChartRange(
  series: FieldChartSeries,
  viewStart: number,
  viewEnd: number,
): FieldChartVisibleRange {
  if (!(viewEnd > viewStart)) return { start: 0, end: 0 };
  if (series.kind === "gauge") {
    return {
      start: lowerBoundPoint(series.points, viewStart),
      end: upperBoundPoint(series.points, viewEnd),
    };
  }
  return {
    start: firstOverlappingInterval(series.intervals, viewStart),
    end: firstIntervalStartingAtOrAfter(series.intervals, viewEnd),
  };
}

function numericFieldValue(value: unknown): NumericFieldValue | null {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isFinite(number)
      ? { number, integer: value, displayValue: value }
      : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return {
      number: value,
      integer: Number.isSafeInteger(value) ? BigInt(value) : null,
      displayValue: value,
    };
  }
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  if (INTEGER_DECIMAL.test(value)) {
    const integer = BigInt(value);
    const number = Number(integer);
    return Number.isFinite(number)
      ? { number, integer, displayValue: value }
      : null;
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? { number, integer: null, displayValue: value }
    : null;
}

function subtract(
  current: NumericFieldValue,
  previous: NumericFieldValue,
): { number: number; displayValue: number | bigint } | null {
  if (current.integer !== null && previous.integer !== null) {
    const displayValue = current.integer - previous.integer;
    const number = Number(displayValue);
    return Number.isFinite(number) ? { number, displayValue } : null;
  }
  const number = current.number - previous.number;
  return Number.isFinite(number) ? { number, displayValue: number } : null;
}

function isNegative(value: number | bigint): boolean {
  return typeof value === "bigint" ? value < 0n : value < 0;
}

function lowerBoundPoint(
  points: readonly FieldChartPoint[],
  timestamp: number,
): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundPoint(
  points: readonly FieldChartPoint[],
  timestamp: number,
): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.timestamp <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstOverlappingInterval(
  intervals: readonly FieldChartInterval[],
  timestamp: number,
): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid]!.end <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstIntervalStartingAtOrAfter(
  intervals: readonly FieldChartInterval[],
  timestamp: number,
): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid]!.start < timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
