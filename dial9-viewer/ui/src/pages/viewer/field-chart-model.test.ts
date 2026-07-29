import { describe, expect, it } from "vitest";
import type { CustomTraceEvent } from "../../lib/trace/index.js";
import type { FieldChartSpec } from "../../types/state.js";
import {
  hasFieldChartData,
  compareFieldChartIds,
  fieldChartLabel,
  isFieldChartId,
  isGraphableFieldValue,
  materializeFieldChart,
  nextFieldChartId,
  visibleFieldChartStats,
} from "./field-chart-model.js";

function event(
  timestamp: number,
  value: unknown,
  name = "Metric",
): CustomTraceEvent {
  return {
    name,
    timestamp,
    fields: { value } as CustomTraceEvent["fields"],
    units: { value: "ns" },
  };
}

function spec(kind: FieldChartSpec["kind"]): FieldChartSpec {
  return { id: "fc1", eventName: "Metric", field: "value", kind };
}

describe("field chart materialization", () => {
  it("sorts only the requested gauge values without mutating the trace", () => {
    const events = [
      event(30, 3),
      event(10, 1),
      event(15, 99, "Other"),
      event(20, null),
      event(25, "2"),
    ];
    const order = events.map((item) => item.timestamp);

    const series = materializeFieldChart(events, spec("gauge"));

    expect(events.map((item) => item.timestamp)).toEqual(order);
    expect(series.kind).toBe("gauge");
    if (series.kind !== "gauge") throw new Error("expected gauge");
    expect(series.points.map((point) => [point.timestamp, point.value])).toEqual([
      [10, 1],
      [25, 2],
      [30, 3],
    ]);
    expect(series.points.map((point) => point.breakBefore)).toEqual([
      true,
      true,
      false,
    ]);
    expect(series.unit).toBe("ns");
  });

  it("uses exact integer deltas and resets a monotonic counter on decrease", () => {
    const base = 9_007_199_254_740_993n;
    const series = materializeFieldChart(
      [
        event(40, base + 14n),
        event(10, base),
        event(20, base + 3n),
        event(30, 2n),
      ],
      spec("counter"),
    );

    expect(series.kind).toBe("counter");
    if (series.kind === "gauge") throw new Error("expected intervals");
    expect(
      series.intervals.map((interval) => [
        interval.start,
        interval.end,
        interval.displayValue,
      ]),
    ).toEqual([
      [10, 20, 3n],
      [30, 40, 9_007_199_254_741_005n],
    ]);
  });

  it("keeps negative up/down deltas", () => {
    const series = materializeFieldChart(
      [event(1, 10), event(2, 4), event(3, 9)],
      spec("up_down_counter"),
    );

    expect(series.kind).toBe("up_down_counter");
    if (series.kind === "gauge") throw new Error("expected intervals");
    expect(series.intervals.map((interval) => interval.displayValue)).toEqual([
      -6n,
      5n,
    ]);
  });

  it("breaks continuity on invalid values and skips equal timestamps", () => {
    const series = materializeFieldChart(
      [
        event(1, 10),
        event(2, null),
        event(3, 30),
        event(3, 31),
        event(4, 35),
      ],
      spec("counter"),
    );

    expect(series.kind).toBe("counter");
    if (series.kind === "gauge") throw new Error("expected intervals");
    expect(series.intervals).toHaveLength(1);
    expect(series.intervals[0]).toMatchObject({
      start: 3,
      end: 4,
      displayValue: 4n,
    });
  });

  it("computes point and overlap-weighted interval viewport stats", () => {
    const gauge = materializeFieldChart(
      [event(0, 100), event(10, 2), event(20, 4), event(30, 100)],
      spec("gauge"),
    );
    expect(visibleFieldChartStats(gauge, 5, 25)).toEqual({ avg: 3, max: 4 });

    const intervals = materializeFieldChart(
      [event(0, 0), event(10, 10), event(30, 50)],
      spec("up_down_counter"),
    );
    expect(visibleFieldChartStats(intervals, 5, 25)).toEqual({
      avg: 32.5,
      max: 40,
    });
  });

  it("reports whether a requested chart has drawable data", () => {
    expect(
      hasFieldChartData(materializeFieldChart([event(1, 1)], spec("gauge"))),
    ).toBe(true);
    expect(
      hasFieldChartData(materializeFieldChart([event(1, 1)], spec("counter"))),
    ).toBe(false);
  });
});

describe("field chart identity and labels", () => {
  it("validates, allocates and numerically orders short ids", () => {
    expect(isFieldChartId("fc1")).toBe(true);
    expect(isFieldChartId("fc0")).toBe(false);
    expect(isFieldChartId("field1")).toBe(false);
    expect(nextFieldChartId([
      { ...spec("gauge"), id: "fc1" },
      { ...spec("counter"), id: "fc3" },
    ])).toBe("fc4");
    expect(["fc10", "fc2", "fc1"].sort(compareFieldChartIds)).toEqual([
      "fc1",
      "fc2",
      "fc10",
    ]);
  });

  it("humanizes a field name without rewriting its words", () => {
    expect(fieldChartLabel("involuntary_context_switches")).toBe(
      "Involuntary context switches",
    );
  });
});

describe("graphable values", () => {
  it("accepts finite numbers, bigints and canonical decimal strings", () => {
    expect(isGraphableFieldValue(1.5)).toBe(true);
    expect(isGraphableFieldValue(2n)).toBe(true);
    expect(isGraphableFieldValue("-1.25e+3")).toBe(true);
  });

  it("rejects coercion-only and non-finite values", () => {
    for (const value of [" 1", "01", "0x10", "", "Infinity", NaN, null, true]) {
      expect(isGraphableFieldValue(value)).toBe(false);
    }
  });
});
