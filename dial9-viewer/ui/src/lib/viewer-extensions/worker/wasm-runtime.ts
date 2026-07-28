import { manifestFromModule } from "../manifest.js";
import {
  VIEWER_EXTENSION_ABI_VERSION,
  type ColumnChunk,
  type ColumnManifest,
  type RecordBatch,
  type ViewerExtensionManifest,
} from "../types.js";

const DESCRIPTOR_HEADER_BYTES = 16;
const COLUMN_DESCRIPTOR_BYTES = 32;

const COLUMN_TAGS = {
  f64: 1,
  i64: 2,
  u64: 3,
  u32: 4,
  u8: 5,
  utf8: 6,
} as const;

interface ExtensionExports {
  readonly memory: WebAssembly.Memory;
  readonly dial9_abi_version: () => number;
  readonly dial9_input_alloc: (length: number) => number;
  readonly dial9_push: (length: number) => number;
  readonly dial9_finish: () => number;
  readonly dial9_output_next: () => number;
  readonly dial9_output_descriptor_len: () => number;
  readonly dial9_output_ack: () => number;
  readonly dial9_error_ptr: () => number;
  readonly dial9_error_len: () => number;
}

export interface PreparedExtension {
  readonly manifest: ViewerExtensionManifest;
  readonly runtime: ExtensionRuntime;
}

export interface ExtensionRuntime {
  push(bytes: Uint8Array): RecordBatch[];
  finish(): RecordBatch[];
}

export async function prepareExtension(bytes: BufferSource): Promise<PreparedExtension> {
  const module = await WebAssembly.compile(bytes);
  return prepareCompiledExtension(module);
}

export async function prepareCompiledExtension(
  module: WebAssembly.Module,
): Promise<PreparedExtension> {
  requireLittleEndianTypedArrays();
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(`WASM extension imports ${imports.length} host capability/capabilities`);
  }
  validateModuleExports(module);
  const manifest = manifestFromModule(module);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = validateInstanceExports(instance.exports);
  if (unsigned(exports.dial9_abi_version()) !== VIEWER_EXTENSION_ABI_VERSION) {
    throw new Error(
      `WASM extension ABI is ${unsigned(exports.dial9_abi_version())}; expected ${VIEWER_EXTENSION_ABI_VERSION}`,
    );
  }
  return { manifest, runtime: new WasmExtensionRuntime(exports, manifest) };
}

export class WasmExtensionRuntime implements ExtensionRuntime {
  readonly #exports: ExtensionExports;
  readonly #manifest: ViewerExtensionManifest;

  constructor(exports: ExtensionExports, manifest: ViewerExtensionManifest) {
    this.#exports = exports;
    this.#manifest = manifest;
  }

  get memoryBytes(): number {
    return this.#exports.memory.buffer.byteLength;
  }

  push(bytes: Uint8Array): RecordBatch[] {
    const pointer = unsigned(this.#exports.dial9_input_alloc(bytes.byteLength));
    memorySlice(this.#exports.memory, pointer, bytes.byteLength, "input").set(bytes);
    if (this.#exports.dial9_push(bytes.byteLength) !== 0) {
      throw new Error(readGuestError(this.#exports));
    }
    return this.#drain();
  }

  finish(): RecordBatch[] {
    if (this.#exports.dial9_finish() !== 0) {
      throw new Error(readGuestError(this.#exports));
    }
    return this.#drain();
  }

  #drain(): RecordBatch[] {
    const batches: RecordBatch[] = [];
    for (;;) {
      const pointer = unsigned(this.#exports.dial9_output_next());
      if (pointer === 0) return batches;
      const descriptorLength = unsigned(this.#exports.dial9_output_descriptor_len());
      const descriptorBytes = memorySlice(
        this.#exports.memory,
        pointer,
        descriptorLength,
        "output descriptor",
      );
      const batch = decodeBatch(this.#exports.memory, descriptorBytes, this.#manifest);
      if (this.#exports.dial9_output_ack() !== 0) {
        throw new Error(readGuestError(this.#exports) || "WASM extension rejected output ack");
      }
      batches.push(batch);
    }
  }
}

export function batchTransferables(batch: RecordBatch): Transferable[] {
  const transfer: Transferable[] = [];
  for (const column of batch.columns) {
    if (column.type === "utf8") {
      transfer.push(column.offsets.buffer, column.data.buffer);
    } else {
      transfer.push(column.values.buffer);
    }
    if (column.validity !== null) transfer.push(column.validity.buffer);
  }
  return transfer;
}

function decodeBatch(
  memory: WebAssembly.Memory,
  bytes: Uint8Array,
  manifest: ViewerExtensionManifest,
): RecordBatch {
  if (
    bytes.byteLength < DESCRIPTOR_HEADER_BYTES ||
    (bytes.byteLength - DESCRIPTOR_HEADER_BYTES) % COLUMN_DESCRIPTOR_BYTES !== 0
  ) {
    throw new Error("output descriptor has an invalid byte length");
  }
  const descriptor = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableIndex = descriptor.getUint32(0, true);
  const rows = descriptor.getUint32(4, true);
  const columnCount = descriptor.getUint32(8, true);
  if (descriptor.getUint32(12, true) !== 0) {
    throw new Error("output descriptor reserved bits are nonzero");
  }
  const expectedLength = DESCRIPTOR_HEADER_BYTES + columnCount * COLUMN_DESCRIPTOR_BYTES;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== bytes.byteLength) {
    throw new Error("output descriptor column count does not match its length");
  }
  const table = manifest.tables[tableIndex];
  if (table === undefined) throw new Error(`output references unknown table ${tableIndex}`);
  if (columnCount !== table.columns.length) {
    throw new Error(
      `output table ${table.name} has ${columnCount} columns; expected ${table.columns.length}`,
    );
  }

  const columns: ColumnChunk[] = [];
  for (let index = 0; index < columnCount; index++) {
    const offset = DESCRIPTOR_HEADER_BYTES + index * COLUMN_DESCRIPTOR_BYTES;
    columns.push(
      decodeColumn(memory, descriptor, offset, rows, table.columns[index]!, table.name),
    );
  }
  return { table: tableIndex, rows, columns };
}

function decodeColumn(
  memory: WebAssembly.Memory,
  descriptor: DataView,
  offset: number,
  rows: number,
  schema: ColumnManifest,
  tableName: string,
): ColumnChunk {
  const path = `${tableName}.${schema.name}`;
  const kind = descriptor.getUint32(offset, true);
  if (kind !== COLUMN_TAGS[schema.type]) {
    throw new Error(`${path} output type does not match its manifest`);
  }
  const flags = descriptor.getUint32(offset + 4, true);
  if ((flags & ~1) !== 0) throw new Error(`${path} output has unknown flags`);
  const valuesPointer = descriptor.getUint32(offset + 8, true);
  const valuesLength = descriptor.getUint32(offset + 12, true);
  const offsetsPointer = descriptor.getUint32(offset + 16, true);
  const offsetsLength = descriptor.getUint32(offset + 20, true);
  const validityPointer = descriptor.getUint32(offset + 24, true);
  const validityLength = descriptor.getUint32(offset + 28, true);
  const hasValidity = (flags & 1) !== 0;
  if (!schema.nullable && hasValidity) {
    throw new Error(`${path} is not nullable but emitted validity data`);
  }
  const expectedValidity = Math.ceil(rows / 8);
  if (hasValidity !== (validityLength !== 0)) {
    throw new Error(`${path} validity flag and length disagree`);
  }
  if (validityLength !== 0 && validityLength !== expectedValidity) {
    throw new Error(`${path} validity bitmap has the wrong length`);
  }
  const validity =
    validityLength === 0
      ? null
      : memorySlice(memory, validityPointer, validityLength, `${path} validity`).slice();
  validateTrailingValidity(validity, rows, path);

  if (schema.type === "utf8") {
    if (offsetsLength !== checkedByteLength(rows + 1, 4, `${path} offsets`)) {
      throw new Error(`${path} UTF-8 offsets have the wrong length`);
    }
    const offsetsBytes = memorySlice(
      memory,
      offsetsPointer,
      offsetsLength,
      `${path} offsets`,
    ).slice();
    const data = memorySlice(memory, valuesPointer, valuesLength, `${path} data`).slice();
    const offsets = new Uint32Array(offsetsBytes.buffer);
    validateUtf8(offsets, data, path);
    return { type: "utf8", offsets, data, validity, rows };
  }

  if (offsetsPointer !== 0 || offsetsLength !== 0) {
    throw new Error(`${path} numeric output must not have offsets`);
  }
  const width = schema.type === "u8" ? 1 : schema.type === "u32" ? 4 : 8;
  if (valuesLength !== checkedByteLength(rows, width, `${path} values`)) {
    throw new Error(`${path} values have the wrong length`);
  }
  const copied = memorySlice(memory, valuesPointer, valuesLength, `${path} values`).slice();
  switch (schema.type) {
    case "f64":
      return { type: "f64", values: new Float64Array(copied.buffer), validity, rows };
    case "i64":
      return { type: "i64", values: new BigInt64Array(copied.buffer), validity, rows };
    case "u64":
      return { type: "u64", values: new BigUint64Array(copied.buffer), validity, rows };
    case "u32":
      return { type: "u32", values: new Uint32Array(copied.buffer), validity, rows };
    case "u8":
      return { type: "u8", values: copied, validity, rows };
  }
}

function validateUtf8(offsets: Uint32Array, data: Uint8Array, path: string): void {
  if (offsets[0] !== 0 || offsets[offsets.length - 1] !== data.byteLength) {
    throw new Error(`${path} UTF-8 offsets do not span its data`);
  }
  let previous = 0;
  for (const offset of offsets) {
    if (offset < previous || offset > data.byteLength) {
      throw new Error(`${path} UTF-8 offsets are not monotonic`);
    }
    if (offset < data.byteLength && (data[offset]! & 0xc0) === 0x80) {
      throw new Error(`${path} UTF-8 offset is not a character boundary`);
    }
    previous = offset;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${path} contains invalid UTF-8`);
  }
}

function validateTrailingValidity(
  validity: Uint8Array | null,
  rows: number,
  path: string,
): void {
  if (validity === null || rows % 8 === 0 || validity.length === 0) return;
  const allowed = (1 << (rows % 8)) - 1;
  if ((validity[validity.length - 1]! & ~allowed) !== 0) {
    throw new Error(`${path} validity bitmap sets bits beyond its rows`);
  }
}

function memorySlice(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
  label: string,
): Uint8Array {
  const end = pointer + length;
  if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
    throw new Error(`${label} points outside WebAssembly memory`);
  }
  return new Uint8Array(memory.buffer, pointer, length);
}

function checkedByteLength(count: number, width: number, label: string): number {
  const length = count * width;
  if (!Number.isSafeInteger(length) || length > 0xffff_ffff) {
    throw new Error(`${label} exceeds the ABI length range`);
  }
  return length;
}

function readGuestError(exports: ExtensionExports): string {
  try {
    const pointer = unsigned(exports.dial9_error_ptr());
    const length = unsigned(exports.dial9_error_len());
    return (
      new TextDecoder("utf-8", { fatal: true }).decode(
        memorySlice(exports.memory, pointer, length, "extension error"),
      ) || "WASM extension failed"
    );
  } catch (error) {
    return error instanceof Error ? error.message : "WASM extension failed";
  }
}

function validateModuleExports(module: WebAssembly.Module): void {
  const exports = new Map(
    WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]),
  );
  const expected = new Map<string, WebAssembly.ImportExportKind>([
    ["memory", "memory"],
    ["dial9_abi_version", "function"],
    ["dial9_input_alloc", "function"],
    ["dial9_push", "function"],
    ["dial9_finish", "function"],
    ["dial9_output_next", "function"],
    ["dial9_output_descriptor_len", "function"],
    ["dial9_output_ack", "function"],
    ["dial9_error_ptr", "function"],
    ["dial9_error_len", "function"],
  ]);
  for (const [name, kind] of expected) {
    if (exports.get(name) !== kind) throw new Error(`WASM extension is missing ${name} ${kind}`);
  }
}

function validateInstanceExports(exports: WebAssembly.Exports): ExtensionExports {
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("WASM extension memory export is invalid");
  }
  for (const name of [
    "dial9_abi_version",
    "dial9_input_alloc",
    "dial9_push",
    "dial9_finish",
    "dial9_output_next",
    "dial9_output_descriptor_len",
    "dial9_output_ack",
    "dial9_error_ptr",
    "dial9_error_len",
  ] as const) {
    if (typeof exports[name] !== "function") {
      throw new Error(`WASM extension ${name} export is invalid`);
    }
  }
  return exports as unknown as ExtensionExports;
}

function unsigned(value: number): number {
  return value >>> 0;
}

function requireLittleEndianTypedArrays(): void {
  const word = new Uint16Array([1]);
  if (new Uint8Array(word.buffer)[0] !== 1) {
    throw new Error(
      "WASM viewer extensions require a little-endian host because column buffers use typed arrays",
    );
  }
}
