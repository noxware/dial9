import { describe, expect, it } from "vitest";
import { arrayColumn, intervalData } from "./data.js";
import type { ReadoutItem } from "./model.js";
import {
  formatNumber,
  formatValue,
  intervalAt,
  reduce,
  renderIntervals,
  visibleIntervalRows,
  type PanelViewport,
} from "./runtime.js";

const viewport: PanelViewport = { start: 5, end: 25, scrollbarWidth: 0 };
const data = intervalData(
  arrayColumn([0, 10, 20]),
  arrayColumn([10, 20, 30]),
  arrayColumn([1, 3, 5]),
);

describe("panel runtime data operations", () => {
  it("finds half-open-style adjacent intervals consistently at boundaries", () => {
    expect(intervalAt(data, 4)).toBe(0);
    expect(intervalAt(data, 14)).toBe(1);
    expect(intervalAt(data, 24)).toBe(2);
    expect(intervalAt(data, 31)).toBeNull();
  });

  it("binary-searches the visible interval slice", () => {
    expect(visibleIntervalRows(data, 11, 19)).toEqual([1, 2]);
    expect(visibleIntervalRows(data, 5, 25)).toEqual([0, 3]);
    expect(visibleIntervalRows(data, 31, 40)).toEqual([3, 3]);
  });

  it("keeps gaps while retaining the maximum interval per dense pixel", () => {
    const dense = intervalData(
      arrayColumn([0, 1, 2, 4, 5]),
      arrayColumn([1, 2, 3, 5, 6]),
      arrayColumn([1, 7, 3, 2, 4]),
    );
    expect(renderIntervals(dense, { start: 0, end: 6 }, 1)).toEqual([
      { start: 0, end: 3, value: 7 },
      { start: 4, end: 6, value: 4 },
    ]);
  });

  it("computes a visible time-weighted mean", () => {
    const item: ReadoutItem = {
      label: "avg",
      values: data.y,
      reduce: { name: "time-weighted-mean", start: data.start, end: data.end },
    };
    expect(reduce(item, data, viewport)).toBe(3);
  });

  it("reduces only rows touching the viewport", () => {
    const item: ReadoutItem = {
      label: "max",
      values: data.y,
      reduce: "max",
    };
    expect(reduce(item, data, { ...viewport, start: 11, end: 19 })).toBe(3);
  });

  it("matches the compact formatting used by the reference panels", () => {
    expect(formatNumber(0.4821)).toBe("0.48");
    expect(formatNumber(11)).toBe("11");
    expect(formatValue(4.44, "%")).toBe("4.4%");
    expect(formatValue(11, "cores")).toBe("11 cores");
    expect(formatValue(1.5)).toBe("1.5");
  });
});
