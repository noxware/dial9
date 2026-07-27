import type {
  ColumnChunk,
  NumericColumnChunk,
  Utf8ColumnChunk,
} from "./columnar.js";
import { ExtensionTable, type Cell } from "./columnar.js";
import type { ColumnSchema } from "./manifest.js";

type NumericValues =
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | Uint32Array
  | Uint8Array;

interface BaseReadChunk {
  readonly start: number;
  readonly rows: number;
  readonly validity?: Uint8Array;
}

interface NumericReadChunk extends BaseReadChunk {
  readonly type: NumericColumnChunk["type"];
  readonly values: NumericValues;
}

interface Utf8ReadChunk extends BaseReadChunk {
  readonly type: "utf8";
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
}

type ReadChunk = NumericReadChunk | Utf8ReadChunk;

function numericValues(column: NumericColumnChunk): NumericValues {
  switch (column.type) {
    case "f64":
      return new Float64Array(column.values);
    case "i64":
      return new BigInt64Array(column.values);
    case "u64":
      return new BigUint64Array(column.values);
    case "u32":
      return new Uint32Array(column.values);
    case "u8":
      return new Uint8Array(column.values);
  }
}

function readChunk(
  column: ColumnChunk,
  start: number,
  rows: number,
): ReadChunk {
  const validity =
    column.validity === undefined
      ? undefined
      : new Uint8Array(column.validity);
  if (column.type === "utf8") {
    const result: {
      type: "utf8";
      start: number;
      rows: number;
      bytes: Uint8Array;
      offsets: Uint32Array;
      validity?: Uint8Array;
    } = {
      type: "utf8",
      start,
      rows,
      bytes: new Uint8Array(column.bytes),
      offsets: new Uint32Array(column.offsets),
    };
    if (validity !== undefined) result.validity = validity;
    return result;
  }
  const result: {
    type: NumericColumnChunk["type"];
    start: number;
    rows: number;
    values: NumericValues;
    validity?: Uint8Array;
  } = {
    type: column.type,
    start,
    rows,
    values: numericValues(column),
  };
  if (validity !== undefined) result.validity = validity;
  return result;
}

function valid(chunk: ReadChunk, localRow: number): boolean {
  const bitmap = chunk.validity;
  return (
    bitmap === undefined ||
    (bitmap[localRow >>> 3]! & (1 << (localRow & 7))) !== 0
  );
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ColumnReader {
  readonly schema: ColumnSchema;
  readonly rowCount: number;
  readonly #chunks: readonly ReadChunk[];
  #cachedChunkIndex = 0;

  constructor(table: ExtensionTable, columnIndex: number) {
    const schema = table.schema.columns[columnIndex];
    if (schema === undefined) throw new RangeError("column index");
    this.schema = schema;
    this.rowCount = table.rowCount;
    let start = 0;
    this.#chunks = table.batches.map((batch) => {
      const chunk = readChunk(batch.columns[columnIndex]!, start, batch.rows);
      start += batch.rows;
      return chunk;
    });
  }

  cell(row: number): Cell {
    const { chunk, localRow } = this.#locate(row);
    if (!valid(chunk, localRow)) return null;
    if (chunk.type === "utf8") {
      const start = chunk.offsets[localRow]!;
      const end = chunk.offsets[localRow + 1]!;
      return TEXT_DECODER.decode(chunk.bytes.subarray(start, end));
    }
    return chunk.values[localRow]!;
  }

  number(row: number): number | null {
    const { chunk, localRow } = this.#locate(row);
    if (!valid(chunk, localRow) || chunk.type === "utf8") return null;
    const value = chunk.values[localRow]!;
    const result = typeof value === "bigint" ? Number(value) : value;
    return Number.isFinite(result) ? result : null;
  }

  lowerBound(value: number): number {
    let low = 0;
    let high = this.rowCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = this.number(middle);
      if (candidate === null || candidate >= value) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  upperBound(value: number): number {
    let low = 0;
    let high = this.rowCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = this.number(middle);
      if (candidate === null || candidate > value) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  isNondecreasing(): boolean {
    let prior = -Infinity;
    for (let row = 0; row < this.rowCount; row += 1) {
      const value = this.number(row);
      if (value === null) continue;
      if (value < prior) return false;
      prior = value;
    }
    return true;
  }

  #locate(row: number): { chunk: ReadChunk; localRow: number } {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rowCount) {
      throw new RangeError(`row ${row} is outside column ${this.schema.name}`);
    }

    const cached = this.#chunks[this.#cachedChunkIndex]!;
    if (row >= cached.start && row < cached.start + cached.rows) {
      return { chunk: cached, localRow: row - cached.start };
    }

    const direction = row < cached.start ? -1 : 1;
    let adjacentIndex = this.#cachedChunkIndex + direction;
    while (
      adjacentIndex >= 0 &&
      adjacentIndex < this.#chunks.length &&
      this.#chunks[adjacentIndex]!.rows === 0
    ) {
      adjacentIndex += direction;
    }
    const adjacent = this.#chunks[adjacentIndex];
    if (
      adjacent !== undefined &&
      row >= adjacent.start &&
      row < adjacent.start + adjacent.rows
    ) {
      this.#cachedChunkIndex = adjacentIndex;
      return { chunk: adjacent, localRow: row - adjacent.start };
    }

    let low = 0;
    let high = this.#chunks.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.#chunks[middle]!.start <= row) low = middle;
      else high = middle;
    }
    this.#cachedChunkIndex = low;
    const chunk = this.#chunks[low]!;
    return { chunk, localRow: row - chunk.start };
  }
}

export class TableReader {
  readonly table: ExtensionTable;
  readonly #columns = new Map<string, ColumnReader>();

  constructor(table: ExtensionTable) {
    this.table = table;
  }

  get rowCount(): number {
    return this.table.rowCount;
  }

  column(name: string): ColumnReader {
    let reader = this.#columns.get(name);
    if (reader !== undefined) return reader;
    reader = new ColumnReader(this.table, this.table.columnIndex(name));
    this.#columns.set(name, reader);
    return reader;
  }
}
