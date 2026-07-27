import type {
  ColumnSchema,
  ColumnType,
  ExtensionManifest,
  TableSchema,
} from "./manifest.js";

export interface NumericColumnChunk {
  readonly type: Exclude<ColumnType, "utf8">;
  readonly values: ArrayBuffer;
  readonly validity?: ArrayBuffer;
}

export interface Utf8ColumnChunk {
  readonly type: "utf8";
  readonly bytes: ArrayBuffer;
  readonly offsets: ArrayBuffer;
  readonly validity?: ArrayBuffer;
}

export type ColumnChunk = NumericColumnChunk | Utf8ColumnChunk;

export interface ColumnarBatch {
  readonly table_id: number;
  readonly rows: number;
  readonly columns: readonly ColumnChunk[];
}

export type Cell = number | bigint | string | null;

export function batchTransferables(batch: ColumnarBatch): ArrayBuffer[] {
  const result: ArrayBuffer[] = [];
  for (const column of batch.columns) {
    if (column.type === "utf8") {
      result.push(column.bytes, column.offsets);
    } else {
      result.push(column.values);
    }
    if (column.validity !== undefined) result.push(column.validity);
  }
  return result;
}

function validityAt(validity: ArrayBuffer | undefined, row: number): boolean {
  if (validity === undefined) return true;
  const bytes = new Uint8Array(validity);
  return (bytes[row >>> 3]! & (1 << (row & 7))) !== 0;
}

function numericCell(column: NumericColumnChunk, row: number): number | bigint {
  switch (column.type) {
    case "f64":
      return new Float64Array(column.values)[row]!;
    case "i64":
      return new BigInt64Array(column.values)[row]!;
    case "u64":
      return new BigUint64Array(column.values)[row]!;
    case "u32":
      return new Uint32Array(column.values)[row]!;
    case "u8":
      return new Uint8Array(column.values)[row]!;
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function utf8Cell(column: Utf8ColumnChunk, row: number): string {
  const offsets = new Uint32Array(column.offsets);
  const start = offsets[row]!;
  const end = offsets[row + 1]!;
  return UTF8_DECODER.decode(new Uint8Array(column.bytes, start, end - start));
}

export class ExtensionTable {
  readonly schema: TableSchema;
  #batches: ColumnarBatch[] = [];
  #starts: number[] = [];
  #rows = 0;

  constructor(schema: TableSchema) {
    this.schema = schema;
  }

  get rowCount(): number {
    return this.#rows;
  }

  get batches(): readonly ColumnarBatch[] {
    return this.#batches;
  }

  append(batch: ColumnarBatch): void {
    if (!Number.isSafeInteger(batch.rows) || batch.rows < 0) {
      throw new Error(`Invalid row count for table ${this.schema.name}`);
    }
    if (batch.columns.length !== this.schema.columns.length) {
      throw new Error(
        `Batch for ${this.schema.name} has ${batch.columns.length} columns; expected ${this.schema.columns.length}`,
      );
    }
    for (let index = 0; index < batch.columns.length; index += 1) {
      if (batch.columns[index]!.type !== this.schema.columns[index]!.type) {
        throw new Error(
          `Batch column ${this.schema.name}.${this.schema.columns[index]!.name} has the wrong type`,
        );
      }
    }
    if (!Number.isSafeInteger(this.#rows + batch.rows)) {
      throw new Error(`Row count for table ${this.schema.name} is too large`);
    }
    this.#starts.push(this.#rows);
    this.#rows += batch.rows;
    this.#batches.push(batch);
  }

  columnIndex(name: string): number {
    const index = this.schema.columns.findIndex((column) => column.name === name);
    if (index < 0) throw new Error(`Unknown column ${this.schema.name}.${name}`);
    return index;
  }

  columnSchema(name: string): ColumnSchema {
    return this.schema.columns[this.columnIndex(name)]!;
  }

  cell(column: string | number, row: number): Cell {
    const columnIndex =
      typeof column === "number" ? column : this.columnIndex(column);
    if (
      !Number.isSafeInteger(row) ||
      row < 0 ||
      row >= this.#rows ||
      columnIndex < 0 ||
      columnIndex >= this.schema.columns.length
    ) {
      throw new RangeError(`Cell is outside table ${this.schema.name}`);
    }
    const batchIndex = this.#batchAt(row);
    const localRow = row - this.#starts[batchIndex]!;
    const chunk = this.#batches[batchIndex]!.columns[columnIndex]!;
    if (!validityAt(chunk.validity, localRow)) return null;
    return chunk.type === "utf8"
      ? utf8Cell(chunk, localRow)
      : numericCell(chunk, localRow);
  }

  *rows(start = 0, end = this.#rows): Generator<number> {
    const from = Math.max(0, Math.trunc(start));
    const to = Math.min(this.#rows, Math.trunc(end));
    for (let row = from; row < to; row += 1) yield row;
  }

  #batchAt(row: number): number {
    let low = 0;
    let high = this.#starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.#starts[middle]! <= row) low = middle;
      else high = middle;
    }
    return low;
  }
}

export class ExtensionStore {
  readonly manifest: ExtensionManifest;
  readonly tables: readonly ExtensionTable[];
  #byName: ReadonlyMap<string, ExtensionTable>;

  constructor(manifest: ExtensionManifest) {
    this.manifest = manifest;
    this.tables = manifest.tables.map((schema) => new ExtensionTable(schema));
    this.#byName = new Map(this.tables.map((table) => [table.schema.name, table]));
  }

  append(batch: ColumnarBatch): void {
    const table = this.tables[batch.table_id];
    if (table === undefined) {
      throw new Error(`Batch references unknown table ID ${batch.table_id}`);
    }
    table.append(batch);
  }

  table(name: string): ExtensionTable {
    const table = this.#byName.get(name);
    if (table === undefined) throw new Error(`Unknown extension table ${name}`);
    return table;
  }
}
