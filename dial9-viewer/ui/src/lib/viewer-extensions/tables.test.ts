import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { ExtensionTableStore } from "./tables.js";

const manifest = parseManifest(
  JSON.stringify({
    version: 1,
    tables: [
      {
        name: "values",
        columns: [
          { name: "time", type: "u64" },
          { name: "value", type: "f64", nullable: true },
          { name: "label", type: "utf8" },
        ],
      },
    ],
    panels: [],
  }),
);

describe("chunked extension tables", () => {
  it("keeps batches chunked and resolves bigint, gaps, and UTF-8 lazily", () => {
    const store = new ExtensionTableStore(manifest);
    store.append({
      table: 0,
      rows: 2,
      columns: [
        {
          type: "u64",
          values: new BigUint64Array([10n, 20n]),
          validity: null,
          rows: 2,
        },
        {
          type: "f64",
          values: new Float64Array([1.5, 999]),
          validity: new Uint8Array([0b0000_0001]),
          rows: 2,
        },
        {
          type: "utf8",
          offsets: new Uint32Array([0, 4, 6]),
          data: new TextEncoder().encode("🔥ok"),
          validity: null,
          rows: 2,
        },
      ],
    });
    store.append({
      table: 0,
      rows: 1,
      columns: [
        {
          type: "u64",
          values: new BigUint64Array([30n]),
          validity: null,
          rows: 1,
        },
        {
          type: "f64",
          values: new Float64Array([3.5]),
          validity: new Uint8Array([1]),
          rows: 1,
        },
        {
          type: "utf8",
          offsets: new Uint32Array([0, 5]),
          data: new TextEncoder().encode("three"),
          validity: null,
          rows: 1,
        },
      ],
    });

    const table = store.table("values");
    expect(table.batches).toHaveLength(2);
    expect(table.rowCount).toBe(3);
    expect(table.value(0, "time")).toBe(10n);
    expect(table.value(1, "value")).toBeNull();
    expect(table.value(0, "label")).toBe("🔥");
    expect(table.value(1, "label")).toBe("ok");
    expect(table.value(2, "label")).toBe("three");
  });

  it("rejects a batch that disagrees with the manifest", () => {
    const store = new ExtensionTableStore(manifest);
    expect(() =>
      store.append({
        table: 0,
        rows: 1,
        columns: [
          {
            type: "f64",
            values: new Float64Array([1]),
            validity: null,
            rows: 1,
          },
        ],
      }),
    ).toThrow(/columns/);
  });
});
