import type {
  ColumnarBatch,
  ColumnChunk,
  NumericColumnChunk,
  Utf8ColumnChunk,
} from "./columnar.js";
import type {
  ColumnSchema,
  ColumnType,
  ExtensionManifest,
  TableSchema,
} from "./manifest.js";

export const VIEWER_EXTENSION_ABI_VERSION = 1;
export const OUTPUT_DESCRIPTOR_VERSION = 1;

const HEADER_WORDS = 4;
const COLUMN_WORDS = 8;
const WORD_BYTES = 4;
const VALIDITY_FLAG = 1;

const COLUMN_KIND: Readonly<Record<number, ColumnType>> = {
  1: "f64",
  2: "i64",
  3: "u64",
  4: "u32",
  5: "u8",
  6: "utf8",
};

const COLUMN_WIDTH: Readonly<Record<Exclude<ColumnType, "utf8">, number>> = {
  f64: 8,
  i64: 8,
  u64: 8,
  u32: 4,
  u8: 1,
};

export class ExtensionAbiError extends Error {
  constructor(message: string) {
    super(`Invalid viewer extension ABI output: ${message}`);
    this.name = "ExtensionAbiError";
  }
}

function fail(message: string): never {
  throw new ExtensionAbiError(message);
}

function hostBuffer(memory: WebAssembly.Memory): ArrayBuffer {
  const buffer = memory.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    return fail("shared WebAssembly memory is unsupported");
  }
  return buffer;
}

function checkedU32(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    fail(`${name} is not a u32`);
  }
  return value;
}

export function wasmU32Result(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < -0x8000_0000 ||
    value > 0x7fff_ffff
  ) {
    fail(`${name} is not a WebAssembly i32`);
  }
  return value >>> 0;
}

function checkedProduct(left: number, right: number, name: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) fail(`${name} overflows`);
  return result;
}

function range(
  buffer: ArrayBuffer,
  pointerValue: number,
  lengthValue: number,
  name: string,
  alignment = 1,
): { readonly pointer: number; readonly length: number } {
  const pointer = checkedU32(pointerValue, `${name} pointer`);
  const length = checkedU32(lengthValue, `${name} length`);
  if (length === 0) {
    if (pointer !== 0) fail(`${name} has a nonzero pointer for an empty buffer`);
    return { pointer, length };
  }
  if (pointer % alignment !== 0) {
    fail(`${name} pointer is not ${alignment}-byte aligned`);
  }
  const end = pointer + length;
  if (!Number.isSafeInteger(end) || end > buffer.byteLength) {
    fail(`${name} range is outside WebAssembly memory`);
  }
  return { pointer, length };
}

function emptyRange(pointer: number, length: number, name: string): void {
  if (pointer !== 0 || length !== 0) fail(`${name} must be empty`);
}

function copyRange(
  buffer: ArrayBuffer,
  source: { readonly pointer: number; readonly length: number },
): ArrayBuffer {
  return buffer.slice(source.pointer, source.pointer + source.length);
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function continuation(bytes: Uint8Array, index: number): boolean {
  return index < bytes.length && isContinuation(bytes[index]!);
}

function validateUtf8(bytes: Uint8Array, name: string): void {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    if (first >= 0xc2 && first <= 0xdf) {
      if (!continuation(bytes, index + 1)) fail(`${name} is not valid UTF-8`);
      index += 2;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index + 1];
      if (
        second === undefined ||
        !continuation(bytes, index + 2) ||
        (first === 0xe0 && (second < 0xa0 || second > 0xbf)) ||
        (first === 0xed && (second < 0x80 || second > 0x9f)) ||
        (first !== 0xe0 && first !== 0xed && !isContinuation(second))
      ) {
        fail(`${name} is not valid UTF-8`);
      }
      index += 3;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index + 1];
      if (
        second === undefined ||
        !continuation(bytes, index + 2) ||
        !continuation(bytes, index + 3) ||
        (first === 0xf0 && (second < 0x90 || second > 0xbf)) ||
        (first === 0xf4 && (second < 0x80 || second > 0x8f)) ||
        (first !== 0xf0 && first !== 0xf4 && !isContinuation(second))
      ) {
        fail(`${name} is not valid UTF-8`);
      }
      index += 4;
      continue;
    }
    fail(`${name} is not valid UTF-8`);
  }
}

function copyValidity(
  buffer: ArrayBuffer,
  schema: ColumnSchema,
  rows: number,
  flags: number,
  pointer: number,
  length: number,
  name: string,
): ArrayBuffer | undefined {
  if ((flags & ~VALIDITY_FLAG) !== 0) fail(`${name} has unknown flags`);
  const present = (flags & VALIDITY_FLAG) !== 0;
  if (!present) {
    emptyRange(pointer, length, `${name} validity`);
    return undefined;
  }
  if (!schema.nullable) {
    fail(`${name} supplies validity for a non-nullable column`);
  }
  const expected = Math.ceil(rows / 8);
  if (length !== expected) {
    fail(`${name} validity has ${length} bytes; expected ${expected}`);
  }
  const source = range(buffer, pointer, length, `${name} validity`);
  return copyRange(buffer, source);
}

function copyNumericColumn(
  buffer: ArrayBuffer,
  schema: ColumnSchema,
  rows: number,
  flags: number,
  primaryPointer: number,
  primaryLength: number,
  auxiliaryPointer: number,
  auxiliaryLength: number,
  validityPointer: number,
  validityLength: number,
  name: string,
): NumericColumnChunk {
  if (schema.type === "utf8") return fail(`${name} has an invalid numeric kind`);
  const width = COLUMN_WIDTH[schema.type];
  const expected = checkedProduct(rows, width, `${name} byte length`);
  if (primaryLength !== expected) {
    fail(`${name} has ${primaryLength} value bytes; expected ${expected}`);
  }
  const values = range(
    buffer,
    primaryPointer,
    primaryLength,
    `${name} values`,
    width,
  );
  emptyRange(auxiliaryPointer, auxiliaryLength, `${name} auxiliary buffer`);
  const validity = copyValidity(
    buffer,
    schema,
    rows,
    flags,
    validityPointer,
    validityLength,
    name,
  );
  const result: {
    type: NumericColumnChunk["type"];
    values: ArrayBuffer;
    validity?: ArrayBuffer;
  } = {
    type: schema.type,
    values: copyRange(buffer, values),
  };
  if (validity !== undefined) result.validity = validity;
  return result;
}

function copyUtf8Column(
  buffer: ArrayBuffer,
  schema: ColumnSchema,
  rows: number,
  flags: number,
  primaryPointer: number,
  primaryLength: number,
  auxiliaryPointer: number,
  auxiliaryLength: number,
  validityPointer: number,
  validityLength: number,
  name: string,
): Utf8ColumnChunk {
  const expectedOffsets = checkedProduct(rows + 1, 4, `${name} offsets length`);
  if (auxiliaryLength !== expectedOffsets) {
    fail(`${name} has ${auxiliaryLength} offset bytes; expected ${expectedOffsets}`);
  }
  const bytesSource = range(
    buffer,
    primaryPointer,
    primaryLength,
    `${name} bytes`,
  );
  const offsetsSource = range(
    buffer,
    auxiliaryPointer,
    auxiliaryLength,
    `${name} offsets`,
    4,
  );
  const bytes = new Uint8Array(
    buffer,
    bytesSource.pointer,
    bytesSource.length,
  );
  const offsets = new DataView(
    buffer,
    offsetsSource.pointer,
    offsetsSource.length,
  );
  let prior = 0;
  for (let row = 0; row <= rows; row += 1) {
    const offset = offsets.getUint32(row * 4, true);
    if (row === 0 && offset !== 0) {
      fail(`${name} offsets must begin at zero`);
    }
    if (offset < prior || offset > bytes.length) {
      fail(`${name} offsets are not monotonic within the byte buffer`);
    }
    if (
      offset > 0 &&
      offset < bytes.length &&
      isContinuation(bytes[offset]!)
    ) {
      fail(`${name} offset ${row} splits a UTF-8 code point`);
    }
    prior = offset;
  }
  if (prior !== bytes.length) {
    fail(`${name} final offset does not equal its byte length`);
  }
  validateUtf8(bytes, `${name} bytes`);

  const validity = copyValidity(
    buffer,
    schema,
    rows,
    flags,
    validityPointer,
    validityLength,
    name,
  );
  const result: {
    type: "utf8";
    bytes: ArrayBuffer;
    offsets: ArrayBuffer;
    validity?: ArrayBuffer;
  } = {
    type: "utf8",
    bytes: copyRange(buffer, bytesSource),
    offsets: copyRange(buffer, offsetsSource),
  };
  if (validity !== undefined) result.validity = validity;
  return result;
}

function copyColumn(
  buffer: ArrayBuffer,
  schema: ColumnSchema,
  rows: number,
  descriptor: DataView,
  word: number,
  name: string,
): ColumnChunk {
  const read = (offset: number): number =>
    descriptor.getUint32((word + offset) * WORD_BYTES, true);
  const kind = read(0);
  const type = COLUMN_KIND[kind];
  if (type === undefined) fail(`${name} has unknown kind ${kind}`);
  if (type !== schema.type) {
    fail(`${name} has type ${type}; manifest requires ${schema.type}`);
  }
  const args = [
    buffer,
    schema,
    rows,
    read(1),
    read(2),
    read(3),
    read(4),
    read(5),
    read(6),
    read(7),
    name,
  ] as const;
  return type === "utf8"
    ? copyUtf8Column(...args)
    : copyNumericColumn(...args);
}

/**
 * Validate and copy one staged guest batch before its buffers are acknowledged.
 *
 * The caller must reacquire `memory.buffer` after the last guest export call
 * that yielded the descriptor pointer/length.
 */
export function copyOutputBatch(
  memory: WebAssembly.Memory,
  descriptorPointer: number,
  descriptorLength: number,
  manifest: ExtensionManifest,
): ColumnarBatch {
  const buffer = hostBuffer(memory);
  const descriptorRange = range(
    buffer,
    descriptorPointer,
    descriptorLength,
    "descriptor",
    4,
  );
  if (descriptorRange.length < HEADER_WORDS * WORD_BYTES) {
    return fail("descriptor is shorter than its header");
  }
  if (descriptorRange.length % WORD_BYTES !== 0) {
    return fail("descriptor length is not a whole number of words");
  }
  const descriptor = new DataView(
    buffer,
    descriptorRange.pointer,
    descriptorRange.length,
  );
  const readHeader = (word: number): number =>
    descriptor.getUint32(word * WORD_BYTES, true);
  if (readHeader(0) !== OUTPUT_DESCRIPTOR_VERSION) {
    fail(`descriptor version must be ${OUTPUT_DESCRIPTOR_VERSION}`);
  }
  const tableId = readHeader(1);
  const table: TableSchema | undefined = manifest.tables[tableId];
  if (table === undefined) fail(`descriptor references unknown table ID ${tableId}`);
  const rows = readHeader(2);
  const columnCount = readHeader(3);
  if (columnCount !== table.columns.length) {
    fail(
      `table ${table.name} has ${columnCount} columns; manifest requires ${table.columns.length}`,
    );
  }
  const expectedLength =
    (HEADER_WORDS + checkedProduct(columnCount, COLUMN_WORDS, "descriptor size")) *
    WORD_BYTES;
  if (descriptorRange.length !== expectedLength) {
    fail(
      `descriptor has ${descriptorRange.length} bytes; expected ${expectedLength}`,
    );
  }

  const columns = table.columns.map((schema, index) =>
    copyColumn(
      buffer,
      schema,
      rows,
      descriptor,
      HEADER_WORDS + index * COLUMN_WORDS,
      `${table.name}.${schema.name}`,
    ),
  );
  return { table_id: tableId, rows, columns };
}

export interface ExtensionAbiExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly dial9_abi_version: () => number;
  readonly dial9_input_reserve: (length: number) => number;
  readonly dial9_push: (length: number) => number;
  readonly dial9_finish: () => number;
  readonly dial9_output_next: () => number;
  readonly dial9_output_descriptor_ptr: () => number;
  readonly dial9_output_descriptor_len: () => number;
  readonly dial9_output_ack: () => number;
  readonly dial9_error_ptr: () => number;
  readonly dial9_error_len: () => number;
}

const FUNCTION_EXPORTS = [
  "dial9_abi_version",
  "dial9_input_reserve",
  "dial9_push",
  "dial9_finish",
  "dial9_output_next",
  "dial9_output_descriptor_ptr",
  "dial9_output_descriptor_len",
  "dial9_output_ack",
  "dial9_error_ptr",
  "dial9_error_len",
] as const;

export function validateExtensionExports(
  exports: WebAssembly.Exports,
): ExtensionAbiExports {
  if (!(exports["memory"] instanceof WebAssembly.Memory)) {
    return fail("module must export WebAssembly memory");
  }
  hostBuffer(exports["memory"]);
  for (const name of FUNCTION_EXPORTS) {
    if (typeof exports[name] !== "function") {
      fail(`module must export function ${name}`);
    }
  }
  const typed = exports as ExtensionAbiExports;
  if (typed.dial9_abi_version() !== VIEWER_EXTENSION_ABI_VERSION) {
    fail(`ABI version must be ${VIEWER_EXTENSION_ABI_VERSION}`);
  }
  return typed;
}

export function readGuestError(exports: ExtensionAbiExports): string {
  const pointer = wasmU32Result(exports.dial9_error_ptr(), "error pointer");
  const length = wasmU32Result(exports.dial9_error_len(), "error length");
  const buffer = hostBuffer(exports.memory);
  const source = range(buffer, pointer, length, "error");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(buffer, source.pointer, source.length),
    );
  } catch {
    return fail("guest error buffer is not valid UTF-8");
  }
}
