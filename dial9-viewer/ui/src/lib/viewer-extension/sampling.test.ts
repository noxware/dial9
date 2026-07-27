import { describe, expect, it } from "vitest";
import {
  minMaxRowsByPixel,
  SAMPLE_GAP,
} from "./sampling.js";

describe("viewer extension sampling", () => {
  it("keeps source-order endpoints and extrema in a dense pixel", () => {
    const values = Array.from({ length: 20 }, () => 5);
    values[3] = -1;
    values[7] = 10;

    expect(
      minMaxRowsByPixel(
        0,
        values.length,
        1,
        0,
        20,
        (row) => row,
        (row) => values[row]!,
      ),
    ).toEqual([0, 3, 7, 19]);
  });

  it("retains a gap between independently sampled runs", () => {
    expect(
      minMaxRowsByPixel(
        0,
        20,
        1,
        0,
        20,
        (row) => row,
        (row) => (row === 10 ? null : row),
      ),
    ).toEqual([0, 9, SAMPLE_GAP, 11, 19]);
  });

  it("retains color extrema and both sides of their transitions", () => {
    expect(
      minMaxRowsByPixel(
        0,
        20,
        1,
        0,
        20,
        (row) => row,
        () => 1,
        (row) => (row === 10 ? 100 : 0),
        [0, 50, 100],
      ),
    ).toEqual([0, 9, 10, 11, 19]);
  });

  it("retains intermediate ramp bands between repeated extrema", () => {
    expect(
      minMaxRowsByPixel(
        0,
        30,
        1,
        0,
        30,
        (row) => row,
        () => 1,
        (row) => {
          if (row === 10 || row === 12) return 100;
          if (row === 11) return 50;
          return 0;
        },
        [0, 50, 100],
      ),
    ).toEqual([0, 9, 10, 11, 12, 13, 29]);
  });
});
