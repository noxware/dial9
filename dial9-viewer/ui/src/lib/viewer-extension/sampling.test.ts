import { describe, expect, it } from "vitest";
import {
  minMaxRowsByPixel,
  SAMPLE_GAP,
} from "./sampling.js";

describe("viewer extension series sampling", () => {
  it("bounds dense series while preserving endpoints and extrema in source order", () => {
    const values = Array.from({ length: 1_000 }, (_, row) =>
      row === 123 ? -50 : row === 177 ? 80 : row / 1_000,
    );
    const rows = minMaxRowsByPixel(
      0,
      values.length,
      10,
      0,
      1_000,
      (row) => row,
      (row) => values[row]!,
    );

    expect(rows).not.toBeNull();
    expect(rows!.length).toBeLessThanOrEqual(40);
    expect(rows).toContain(0);
    expect(rows).toContain(123);
    expect(rows).toContain(177);
    expect(rows).toContain(999);
    expect([...rows!].sort((left, right) => left - right)).toEqual(rows);
  });

  it("keeps gaps without retaining every invalid row", () => {
    const rows = minMaxRowsByPixel(
      0,
      1_000,
      10,
      0,
      1_000,
      (row) => row,
      (row) => (row >= 400 && row < 600 ? null : row),
    );

    expect(rows?.filter((row) => row === SAMPLE_GAP)).toHaveLength(1);
    expect(rows!.at(rows!.indexOf(SAMPLE_GAP) - 1)).toBeLessThan(400);
    expect(rows!.at(rows!.indexOf(SAMPLE_GAP) + 1)).toBeGreaterThanOrEqual(
      600,
    );
  });

  it("avoids allocation when the visible range is already sparse", () => {
    expect(
      minMaxRowsByPixel(
        0,
        20,
        100,
        0,
        20,
        (row) => row,
        (row) => row,
      ),
    ).toBeNull();
  });
});
