import { describe, expect, it } from "vitest";
import {
  batchTransferables,
  ExtensionStore,
  type ColumnarBatch,
} from "./columnar.js";
import type { ExtensionManifest } from "./manifest.js";

const MANIFEST: ExtensionManifest = {
  version: 1,
  tables: [
    {
      name: "points",
      columns: [
        { name: "time", type: "u64", nullable: false },
        { name: "value", type: "f64", nullable: true },
        { name: "label", type: "utf8", nullable: false },
      ],
    },
  ],
  panels: [],
};

function batch(
  times: readonly bigint[],
  values: readonly number[],
  labels: readonly string[],
  validity?: readonly number[],
): ColumnarBatch {
  const encoded = labels.map((label) => new TextEncoder().encode(label));
  const offsets = new Uint32Array(labels.length + 1);
  let byteLength = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    byteLength += encoded[index]!.length;
    offsets[index + 1] = byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let at = 0;
  for (const value of encoded) {
    bytes.set(value, at);
    at += value.length;
  }
  const valueColumn: {
    type: "f64";
    values: ArrayBuffer;
    validity?: ArrayBuffer;
  } = {
    type: "f64",
    values: new Float64Array(values).buffer,
  };
  if (validity !== undefined) {
    valueColumn.validity = new Uint8Array(validity).buffer;
  }
  return {
    table_id: 0,
    rows: times.length,
    columns: [
      { type: "u64", values: new BigUint64Array(times).buffer },
      valueColumn,
      { type: "utf8", bytes: bytes.buffer, offsets: offsets.buffer },
    ],
  };
}

describe("extension columnar store", () => {
  it("keeps batches chunked and resolves cells across their boundaries", () => {
    const store = new ExtensionStore(MANIFEST);
    store.append(batch([10n, 20n], [1.5, 2.5], ["alpha", "💩"], [0b01]));
    store.append(batch([30n], [3.5], ["omega"]));

    const table = store.table("points");
    expect(table.rowCount).toBe(3);
    expect(table.batches).toHaveLength(2);
    expect([...table.rows()]).toEqual([0, 1, 2]);
    expect(table.cell("time", 2)).toBe(30n);
    expect(table.cell("value", 0)).toBe(1.5);
    expect(table.cell("value", 1)).toBeNull();
    expect(table.cell("label", 1)).toBe("💩");
    expect(table.cell(2, 2)).toBe("omega");
  });

  it("enumerates every transferable buffer exactly once", () => {
    const value = batch([1n], [2], ["three"], [1]);
    const transferables = batchTransferables(value);
    expect(transferables).toHaveLength(5);
    expect(new Set(transferables).size).toBe(5);
  });

  it("rejects table, shape, type, and row access mismatches", () => {
    const store = new ExtensionStore(MANIFEST);
    expect(() =>
      store.append({ table_id: 3, rows: 0, columns: [] }),
    ).toThrow("unknown table ID");
    expect(() =>
      store.append({ table_id: 0, rows: 0, columns: [] }),
    ).toThrow("has 0 columns");
    const value = batch([1n], [2], ["three"]);
    const wrong = {
      ...value,
      columns: [
        { type: "u32" as const, values: new Uint32Array([1]).buffer },
        ...value.columns.slice(1),
      ],
    };
    expect(() => store.append(wrong)).toThrow("wrong type");

    store.append(value);
    expect(() => store.table("missing")).toThrow("Unknown extension table");
    expect(() => store.table("points").cell("missing", 0)).toThrow(
      "Unknown column",
    );
    expect(() => store.table("points").cell("time", 1)).toThrow(RangeError);
  });
});
