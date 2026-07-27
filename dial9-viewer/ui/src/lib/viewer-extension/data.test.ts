import { describe, expect, it } from "vitest";
import { ExtensionStore } from "./columnar.js";
import { ColumnReader } from "./data.js";
import { parseExtensionManifestJson } from "./manifest.js";

describe("viewer extension column readers", () => {
  it("keeps sequential and random reads correct across chunks", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "values",
            columns: [{ name: "value", type: "f64" }],
          },
        ],
        panels: [],
      }),
    );
    const store = new ExtensionStore(manifest);
    for (const values of [[1, 2], [], [3], [4, 5]]) {
      store.append({
        table_id: 0,
        rows: values.length,
        columns: [
          {
            type: "f64",
            values: new Float64Array(values).buffer,
          },
        ],
      });
    }
    const column = new ColumnReader(store.table("values"), 0);

    expect(
      Array.from({ length: column.rowCount }, (_, row) => column.number(row)),
    ).toEqual([1, 2, 3, 4, 5]);
    expect([4, 0, 3, 1, 2].map((row) => column.cell(row))).toEqual([
      5, 1, 4, 2, 3,
    ]);
  });
});
