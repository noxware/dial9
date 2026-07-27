import type {
  ColumnChunk,
  ColumnManifest,
  RecordBatch,
  TableManifest,
  ViewerExtensionManifest,
} from "./types.js";

export type CellValue = number | bigint | string | null;

export class ExtensionTableStore {
  readonly manifest: ViewerExtensionManifest;
  readonly #tables: readonly TableStore[];

  constructor(manifest: ViewerExtensionManifest) {
    this.manifest = manifest;
    this.#tables = manifest.tables.map((table) => new TableStore(table));
  }

  append(batch: RecordBatch): void {
    const table = this.#tables[batch.table];
    if (table === undefined) throw new Error(`batch references unknown table ${batch.table}`);
    table.append(batch);
  }

  table(name: string): TableStore {
    const index = this.manifest.tables.findIndex((table) => table.name === name);
    if (index < 0) throw new Error(`unknown extension table ${JSON.stringify(name)}`);
    return this.#tables[index]!;
  }

  tableAt(index: number): TableStore {
    const table = this.#tables[index];
    if (table === undefined) throw new Error(`unknown extension table ${index}`);
    return table;
  }
}

export interface StoredBatch {
  readonly rowOffset: number;
  readonly rows: number;
  readonly columns: readonly ColumnChunk[];
}

export class TableStore {
  readonly schema: TableManifest;
  readonly #columnIndices: ReadonlyMap<string, number>;
  readonly #batches: StoredBatch[] = [];
  #rows = 0;

  constructor(schema: TableManifest) {
    this.schema = schema;
    this.#columnIndices = new Map(schema.columns.map((column, index) => [column.name, index]));
  }

  get rowCount(): number {
    return this.#rows;
  }

  get batches(): readonly StoredBatch[] {
    return this.#batches;
  }

  append(batch: RecordBatch): void {
    if (batch.columns.length !== this.schema.columns.length) {
      throw new Error(
        `table ${this.schema.name} batch has ${batch.columns.length} columns; expected ${this.schema.columns.length}`,
      );
    }
    for (let index = 0; index < batch.columns.length; index++) {
      validateColumnChunk(
        batch.columns[index]!,
        this.schema.columns[index]!,
        batch.rows,
        `${this.schema.name}.${this.schema.columns[index]!.name}`,
      );
    }
    this.#batches.push({
      rowOffset: this.#rows,
      rows: batch.rows,
      columns: batch.columns,
    });
    this.#rows += batch.rows;
  }

  columnIndex(name: string): number {
    const index = this.#columnIndices.get(name);
    if (index === undefined) {
      throw new Error(`unknown extension column ${this.schema.name}.${name}`);
    }
    return index;
  }

  column(name: string): ColumnManifest {
    return this.schema.columns[this.columnIndex(name)]!;
  }

  value(row: number, column: string | number): CellValue {
    if (!Number.isInteger(row) || row < 0 || row >= this.#rows) return null;
    const columnIndex = typeof column === "number" ? column : this.columnIndex(column);
    const batchIndex = this.#batchIndex(row);
    const batch = this.#batches[batchIndex]!;
    const chunk = batch.columns[columnIndex];
    if (chunk === undefined) throw new Error(`extension column index ${columnIndex} is out of range`);
    return chunkValue(chunk, row - batch.rowOffset);
  }

  forEachRow(callback: (row: number, batch: StoredBatch, localRow: number) => void): void {
    for (const batch of this.#batches) {
      for (let localRow = 0; localRow < batch.rows; localRow++) {
        callback(batch.rowOffset + localRow, batch, localRow);
      }
    }
  }

  #batchIndex(row: number): number {
    let low = 0;
    let high = this.#batches.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const batch = this.#batches[middle]!;
      if (row >= batch.rowOffset + batch.rows) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

const utf8Cache = new WeakMap<object, Map<number, string>>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function chunkValue(chunk: ColumnChunk, row: number): CellValue {
  if (row < 0 || row >= chunk.rows || !isValid(chunk.validity, row)) return null;
  if (chunk.type !== "utf8") {
    const values = chunk.values as unknown as { readonly [index: number]: number | bigint };
    return values[row] ?? null;
  }
  let cache = utf8Cache.get(chunk);
  if (cache === undefined) {
    cache = new Map();
    utf8Cache.set(chunk, cache);
  }
  const cached = cache.get(row);
  if (cached !== undefined) return cached;
  const start = chunk.offsets[row]!;
  const end = chunk.offsets[row + 1]!;
  const value = utf8Decoder.decode(chunk.data.subarray(start, end));
  cache.set(row, value);
  return value;
}

export function isValid(validity: Uint8Array | null, row: number): boolean {
  return validity === null || (validity[row >> 3]! & (1 << (row & 7))) !== 0;
}

function validateColumnChunk(
  chunk: ColumnChunk,
  schema: ColumnManifest,
  rows: number,
  path: string,
): void {
  if (chunk.type !== schema.type) throw new Error(`${path} batch type does not match its schema`);
  if (chunk.rows !== rows) throw new Error(`${path} batch row count does not match its table`);
  if (!schema.nullable && chunk.validity !== null) {
    throw new Error(`${path} is not nullable but received a validity bitmap`);
  }
  const expectedValidity = Math.ceil(rows / 8);
  if (chunk.validity !== null && chunk.validity.byteLength !== expectedValidity) {
    throw new Error(`${path} has an invalid validity bitmap length`);
  }
  if (chunk.type === "utf8") {
    if (chunk.offsets.length !== rows + 1) throw new Error(`${path} has invalid UTF-8 offsets`);
    return;
  }
  if ((chunk.values as unknown as { length: number }).length !== rows) {
    throw new Error(`${path} has an invalid value count`);
  }
}
