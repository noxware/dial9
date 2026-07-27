import { describe, expect, it } from "vitest";
import {
  arrayColumn,
  intervalData,
  mappedColumn,
  projectedColumn,
} from "./data.js";

describe("panel columns", () => {
  it("projects existing rows lazily without materializing another array", () => {
    const rows = [{ value: 1 }, { value: 2 }];
    const values = projectedColumn(rows, (row) => row.value);
    rows[1]!.value = 7;
    expect(values.get(1)).toBe(7);
  });

  it("preserves nulls through mapped columns", () => {
    const values = mappedColumn(arrayColumn([2, null, 4]), (value) => value * 2);
    expect([values.get(0), values.get(1), values.get(2)]).toEqual([4, null, 8]);
  });

  it("rejects misaligned component inputs", () => {
    expect(() =>
      intervalData(
        arrayColumn([1]),
        arrayColumn([2, 3]),
        arrayColumn([4]),
      )
    ).toThrow("equal lengths");
  });
});
