import { describe, expect, it } from "vitest";
import {
  clipSegment,
  pointToSegmentDistance,
} from "./geometry.js";

const RECTANGLE = { left: 0, top: 0, right: 10, bottom: 10 };

describe("viewer extension geometry", () => {
  it("clips crossing segments without changing their slope", () => {
    expect(
      clipSegment({ x1: -10, y1: -10, x2: 20, y2: 20 }, RECTANGLE),
    ).toEqual({ x1: 0, y1: 0, x2: 10, y2: 10 });
    expect(
      clipSegment({ x1: -10, y1: 5, x2: 20, y2: 5 }, RECTANGLE),
    ).toEqual({ x1: 0, y1: 5, x2: 10, y2: 5 });
  });

  it("rejects wholly outside segments and retains boundary segments", () => {
    expect(
      clipSegment({ x1: -2, y1: 2, x2: -1, y2: 8 }, RECTANGLE),
    ).toBeUndefined();
    expect(
      clipSegment({ x1: 0, y1: 0, x2: 0, y2: 10 }, RECTANGLE),
    ).toEqual({ x1: 0, y1: 0, x2: 0, y2: 10 });
  });

  it("measures distance to the nearest point on a segment", () => {
    const segment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(5, 4, segment)).toBe(4);
    expect(pointToSegmentDistance(-3, 4, segment)).toBe(5);
  });
});
