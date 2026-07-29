import { describe, expect, it } from "vitest";
import {
  formatTooltipValue,
  formatValue,
  pointToSegmentDistance,
} from "./panel-renderer.js";

describe("semantic panel presentation", () => {
  it("formats known units and leaves unknown units generic", () => {
    expect(formatValue(1_234_000, "ns")).toBe("1.23ms");
    expect(formatValue(4.44, "%")).toBe("4.4%");
    expect(formatValue(1.234, "cores")).toBe("1.23 cores");
    expect(formatValue(1.234)).toBe("1.23");
  });

  it("delegates timestamps to the host viewer formatter", () => {
    expect(
      formatTooltipValue(
        148_560_000_000n,
        "timestamp",
        (timestamp) => `+${((timestamp - 145_420_000_000) / 1e9).toFixed(2)}s`,
      ),
    ).toBe("+3.14s");
  });

  it("measures line hits against the nearest point on the segment", () => {
    expect(pointToSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointToSegmentDistance(-4, 0, 0, 0, 10, 0)).toBe(4);
    expect(pointToSegmentDistance(4, 5, 1, 1, 1, 1)).toBe(5);
  });
});
