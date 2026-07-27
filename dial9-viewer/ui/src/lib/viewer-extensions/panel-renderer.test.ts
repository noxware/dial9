import { describe, expect, it } from "vitest";
import {
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

  it("measures line hits against the nearest point on the segment", () => {
    expect(pointToSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointToSegmentDistance(-4, 0, 0, 0, 10, 0)).toBe(4);
    expect(pointToSegmentDistance(4, 5, 1, 1, 1, 1)).toBe(5);
  });
});
