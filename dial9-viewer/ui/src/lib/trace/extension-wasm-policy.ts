/**
 * Static policy for attacker-controlled viewer-extension modules.
 *
 * This runs before WebAssembly compilation or instantiation. The browser and
 * viewer are trusted; the trace and the module embedded in it are not.
 */

export const REQUIRED_EXTENSION_FUNCTION_EXPORTS = [
  "dial9_abi_version",
  "dial9_input_alloc",
  "dial9_push",
  "dial9_finish",
  "dial9_output_ptr",
  "dial9_output_len",
  "dial9_error_ptr",
  "dial9_error_len",
] as const;

export interface ExtensionWasmPolicyLimits {
  readonly maxModuleBytes: number;
  readonly maxMemoryPages: number;
  readonly maxTableElements: number;
  readonly maxSections: number;
  readonly maxTypes: number;
  readonly maxFunctions: number;
  readonly maxGlobals: number;
  readonly maxDataSegments: number;
  readonly maxElementSegments: number;
}

export const DEFAULT_EXTENSION_WASM_POLICY_LIMITS: ExtensionWasmPolicyLimits = {
  maxModuleBytes: 2 * 1024 * 1024,
  maxMemoryPages: 1024,
  maxTableElements: 4096,
  maxSections: 256,
  maxTypes: 16_384,
  maxFunctions: 65_536,
  maxGlobals: 16_384,
  maxDataSegments: 16_384,
  maxElementSegments: 1024,
};

export interface ExtensionWasmMetadata {
  readonly byteLength: number;
  readonly memory: {
    readonly initialPages: number;
    readonly maximumPages: number;
  };
  readonly table: {
    readonly initialElements: number;
    readonly maximumElements: number;
  } | null;
  readonly typeCount: number;
  readonly functionCount: number;
  readonly globalCount: number;
  readonly dataSegmentCount: number;
  readonly elementSegmentCount: number;
  readonly codeBytes: number;
  readonly customSectionCount: number;
}

export type ExtensionWasmPolicyErrorCode =
  | "too-large"
  | "invalid-header"
  | "malformed"
  | "unsupported-section"
  | "section-order"
  | "duplicate-section"
  | "limit-exceeded"
  | "imports-forbidden"
  | "start-forbidden"
  | "invalid-table"
  | "invalid-memory"
  | "invalid-export"
  | "invalid-abi"
  | "invalid-module";

export interface ExtensionWasmPolicyError {
  readonly code: ExtensionWasmPolicyErrorCode;
  readonly message: string;
  readonly offset?: number;
}

export type ExtensionWasmPolicyResult =
  | { readonly ok: true; readonly metadata: ExtensionWasmMetadata }
  | { readonly ok: false; readonly error: ExtensionWasmPolicyError };

type FunctionExportName = (typeof REQUIRED_EXTENSION_FUNCTION_EXPORTS)[number];

interface FunctionType {
  readonly parameters: readonly number[];
  readonly results: readonly number[];
}

interface MemoryMetadata {
  readonly initialPages: number;
  readonly maximumPages: number;
}

interface TableMetadata {
  readonly initialElements: number;
  readonly maximumElements: number;
}

interface GlobalType {
  readonly valueType: number;
  readonly mutable: boolean;
}

interface ParsedPolicy {
  readonly memory: MemoryMetadata;
  readonly table: TableMetadata | null;
  readonly types: readonly FunctionType[];
  readonly functionTypeIndices: readonly number[];
  readonly globals: readonly GlobalType[];
  readonly dataSegmentCount: number;
  readonly elementSegmentCount: number;
  readonly codeBytes: number;
  readonly customSectionCount: number;
}

class PolicyFailure extends Error {
  constructor(
    readonly code: ExtensionWasmPolicyErrorCode,
    message: string,
    readonly offset?: number
  ) {
    super(message);
  }
}

class Reader {
  offset: number;

  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.byteLength,
    offset = 0
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  readByte(context: string): number {
    if (this.offset >= this.end) {
      fail("malformed", `Unexpected end of module while reading ${context}`, this.offset);
    }
    return this.bytes[this.offset++]!;
  }

  readVarU32(context: string): number {
    const start = this.offset;
    let value = 0;

    for (let byteIndex = 0; byteIndex < 5; byteIndex += 1) {
      const byte = this.readByte(context);
      const payload = byte & 0x7f;

      if (byteIndex === 4 && payload > 0x0f) {
        fail("malformed", `${context} exceeds u32`, start);
      }
      value += payload * 2 ** (7 * byteIndex);

      if ((byte & 0x80) === 0) {
        if (byteIndex > 0 && payload === 0) {
          fail("malformed", `${context} uses a non-canonical LEB128`, start);
        }
        return value;
      }
    }

    fail("malformed", `${context} exceeds five LEB128 bytes`, start);
  }

  readName(context: string): string {
    const length = this.readVarU32(`${context} length`);
    const bytes = this.readBytes(length, context);
    try {
      return UTF8_DECODER.decode(bytes);
    } catch {
      fail("malformed", `${context} is not valid UTF-8`, this.offset - length);
    }
  }

  readBytes(length: number, context: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("malformed", `${context} extends beyond its section`, this.offset);
    }
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  readSection(length: number, context: string): Reader {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("malformed", `${context} extends beyond the module`, this.offset);
    }
    const start = this.offset;
    this.offset += length;
    return new Reader(this.bytes, start + length, start);
  }

  expectEnd(context: string): void {
    if (this.offset !== this.end) {
      fail("malformed", `${context} has trailing bytes`, this.offset);
    }
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const WASM_VERSION_1 = [0x01, 0x00, 0x00, 0x00] as const;

// Data-count is encoded with id 12 but, by specification, is ordered before
// code (id 10) and data (id 11).
const SECTION_ORDER = new Map<number, number>([
  [1, 1], // type
  [2, 2], // import
  [3, 3], // function
  [4, 4], // table
  [5, 5], // memory
  [6, 6], // global
  [7, 7], // export
  [8, 8], // start
  [9, 9], // element
  [12, 10], // data count
  [10, 11], // code
  [11, 12], // data
]);

const ABI_SIGNATURES: Readonly<
  Record<FunctionExportName, { readonly parameters: readonly number[]; readonly results: readonly number[] }>
> = {
  dial9_abi_version: { parameters: [], results: [0x7f] },
  dial9_input_alloc: { parameters: [0x7f], results: [0x7f] },
  dial9_push: { parameters: [0x7f], results: [0x7f] },
  dial9_finish: { parameters: [], results: [0x7f] },
  dial9_output_ptr: { parameters: [], results: [0x7f] },
  dial9_output_len: { parameters: [], results: [0x7f] },
  dial9_error_ptr: { parameters: [], results: [0x7f] },
  dial9_error_len: { parameters: [], results: [0x7f] },
};

/**
 * Validate a raw, self-contained WebAssembly extension before compilation.
 */
export function validateExtensionWasm(
  source: ArrayBuffer | Uint8Array,
  overrides: Partial<ExtensionWasmPolicyLimits> = {}
): ExtensionWasmPolicyResult {
  try {
    const limits = resolveLimits(overrides);
    const bytes =
      source instanceof Uint8Array
        ? source
        : new Uint8Array(source);

    if (bytes.byteLength > limits.maxModuleBytes) {
      fail(
        "too-large",
        `Module is ${bytes.byteLength} bytes; maximum is ${limits.maxModuleBytes}`
      );
    }

    const parsed = parsePolicy(bytes, limits);

    // The policy parser rejects dangerous or needlessly expensive structure.
    // The engine remains the authoritative validator for instruction bodies,
    // constant expressions, and cross-section typing.
    let valid = false;
    try {
      valid = WebAssembly.validate(bytes);
    } catch {
      valid = false;
    }
    if (!valid) {
      fail("invalid-module", "WebAssembly engine rejected the module");
    }

    return {
      ok: true,
      metadata: {
        byteLength: bytes.byteLength,
        memory: parsed.memory,
        table: parsed.table,
        typeCount: parsed.types.length,
        functionCount: parsed.functionTypeIndices.length,
        globalCount: parsed.globals.length,
        dataSegmentCount: parsed.dataSegmentCount,
        elementSegmentCount: parsed.elementSegmentCount,
        codeBytes: parsed.codeBytes,
        customSectionCount: parsed.customSectionCount,
      },
    };
  } catch (error) {
    if (error instanceof PolicyFailure) {
      const structured: ExtensionWasmPolicyError = {
        code: error.code,
        message: error.message,
        ...(error.offset === undefined ? {} : { offset: error.offset }),
      };
      return { ok: false, error: structured };
    }
    return {
      ok: false,
      error: {
        code: "malformed",
        message: error instanceof Error ? error.message : "Malformed WebAssembly module",
      },
    };
  }
}

function parsePolicy(
  bytes: Uint8Array,
  limits: ExtensionWasmPolicyLimits
): ParsedPolicy {
  const reader = new Reader(bytes);
  readHeader(reader);

  const seenSections = new Set<number>();
  let lastSectionOrder = 0;
  let sectionCount = 0;
  let customSectionCount = 0;

  let types: FunctionType[] = [];
  let functionTypeIndices: number[] = [];
  let table: TableMetadata | null = null;
  let memory: MemoryMetadata | null = null;
  let globals: GlobalType[] = [];
  let dataSegmentCount = 0;
  let declaredDataCount: number | null = null;
  let elementSegmentCount = 0;
  let codeFunctionCount: number | null = null;
  let codeBytes = 0;
  let exports: Map<string, { kind: number; index: number }> | null = null;

  while (reader.remaining > 0) {
    sectionCount += 1;
    enforceLimit(sectionCount, limits.maxSections, "sections", reader.offset);

    const idOffset = reader.offset;
    const id = reader.readByte("section id");
    const payloadLength = reader.readVarU32("section size");
    const section = reader.readSection(payloadLength, `section ${id}`);

    if (id === 0) {
      customSectionCount += 1;
      section.readName("custom section name");
      continue;
    }

    const order = SECTION_ORDER.get(id);
    if (order === undefined) {
      fail("unsupported-section", `Unsupported WebAssembly section ${id}`, idOffset);
    }
    if (seenSections.has(id)) {
      fail("duplicate-section", `Section ${id} appears more than once`, idOffset);
    }
    if (order < lastSectionOrder) {
      fail("section-order", `Section ${id} is out of order`, idOffset);
    }
    seenSections.add(id);
    lastSectionOrder = order;

    switch (id) {
      case 1:
        types = readTypes(section, limits);
        break;
      case 2:
        readImports(section);
        break;
      case 3:
        functionTypeIndices = readFunctions(section, limits);
        break;
      case 4:
        table = readTable(section, limits);
        break;
      case 5:
        memory = readMemory(section, limits);
        break;
      case 6:
        globals = readGlobals(section, limits);
        break;
      case 7:
        exports = readExports(section);
        break;
      case 8:
        fail("start-forbidden", "A start function is not allowed", idOffset);
      case 9:
        elementSegmentCount = readCountOnly(
          section,
          limits.maxElementSegments,
          "element segments"
        );
        break;
      case 10: {
        const code = readCode(section, limits);
        codeFunctionCount = code.functionCount;
        codeBytes = code.codeBytes;
        break;
      }
      case 11:
        dataSegmentCount = readCountOnly(
          section,
          limits.maxDataSegments,
          "data segments"
        );
        break;
      case 12:
        declaredDataCount = section.readVarU32("declared data count");
        enforceLimit(
          declaredDataCount,
          limits.maxDataSegments,
          "declared data segments",
          section.offset
        );
        section.expectEnd("data-count section");
        break;
    }
  }

  if (memory === null) {
    fail("invalid-memory", "Module must define exactly one memory");
  }
  if (codeFunctionCount === null) {
    fail("invalid-abi", "Module has no code section");
  }
  if (codeFunctionCount !== functionTypeIndices.length) {
    fail(
      "invalid-abi",
      `Function section declares ${functionTypeIndices.length} functions but code contains ${codeFunctionCount}`
    );
  }
  if (declaredDataCount !== null && declaredDataCount !== dataSegmentCount) {
    fail(
      "malformed",
      `Data-count section declares ${declaredDataCount} segments but data section contains ${dataSegmentCount}`
    );
  }

  validateExports(exports, functionTypeIndices, types, globals);

  return {
    memory,
    table,
    types,
    functionTypeIndices,
    globals,
    dataSegmentCount,
    elementSegmentCount,
    codeBytes,
    customSectionCount,
  };
}

function readHeader(reader: Reader): void {
  if (reader.remaining < WASM_MAGIC.length + WASM_VERSION_1.length) {
    fail("invalid-header", "Input is too short to be a WebAssembly module", reader.offset);
  }
  for (const expected of WASM_MAGIC) {
    if (reader.readByte("WebAssembly magic") !== expected) {
      fail("invalid-header", "Input is not a raw WebAssembly module", reader.offset - 1);
    }
  }
  for (const expected of WASM_VERSION_1) {
    if (reader.readByte("WebAssembly version") !== expected) {
      fail(
        "invalid-header",
        "Only core WebAssembly binary version 1 is supported",
        reader.offset - 1
      );
    }
  }
}

function readTypes(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): FunctionType[] {
  const count = reader.readVarU32("type count");
  enforceLimit(count, limits.maxTypes, "types", reader.offset);
  const types: FunctionType[] = [];

  for (let index = 0; index < count; index += 1) {
    if (reader.readByte("function type") !== 0x60) {
      fail("unsupported-section", "Only core function types are allowed", reader.offset - 1);
    }
    const parameters = readValueTypes(reader, "function parameters");
    const results = readValueTypes(reader, "function results");
    types.push({ parameters, results });
  }
  reader.expectEnd("type section");
  return types;
}

function readValueTypes(reader: Reader, context: string): number[] {
  const count = reader.readVarU32(`${context} count`);
  if (count > 1024) {
    fail("limit-exceeded", `${context} exceeds 1024 values`, reader.offset);
  }
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(readValueType(reader, context));
  }
  return values;
}

function readValueType(reader: Reader, context: string): number {
  const type = reader.readByte(context);
  if (
    type !== 0x7f && // i32
    type !== 0x7e && // i64
    type !== 0x7d && // f32
    type !== 0x7c && // f64
    type !== 0x7b && // v128
    type !== 0x70 && // funcref
    type !== 0x6f // externref
  ) {
    fail(
      "unsupported-section",
      `Unsupported value type 0x${type.toString(16)}`,
      reader.offset - 1
    );
  }
  return type;
}

function readImports(reader: Reader): void {
  const count = reader.readVarU32("import count");
  if (count !== 0) {
    fail("imports-forbidden", "Viewer extensions must not import any capability", reader.offset);
  }
  reader.expectEnd("import section");
}

function readFunctions(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): number[] {
  const count = reader.readVarU32("function count");
  enforceLimit(count, limits.maxFunctions, "functions", reader.offset);
  const typeIndices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    typeIndices.push(reader.readVarU32("function type index"));
  }
  reader.expectEnd("function section");
  return typeIndices;
}

function readTable(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): TableMetadata | null {
  const count = reader.readVarU32("table count");
  if (count === 0) {
    reader.expectEnd("table section");
    return null;
  }
  if (count !== 1) {
    fail("invalid-table", "Module may define at most one table", reader.offset);
  }

  if (reader.readByte("table element type") !== 0x70) {
    fail("invalid-table", "The internal table must contain funcref values", reader.offset - 1);
  }
  const flagsOffset = reader.offset;
  const flags = reader.readVarU32("table flags");
  if (flags !== 0x01) {
    fail(
      "invalid-table",
      "The internal table must have an explicit maximum and use 32-bit indices",
      flagsOffset
    );
  }
  const initialElements = reader.readVarU32("initial table elements");
  const maximumElements = reader.readVarU32("maximum table elements");
  if (initialElements > maximumElements) {
    fail("invalid-table", "Initial table size exceeds its maximum", reader.offset);
  }
  if (maximumElements > limits.maxTableElements) {
    fail(
      "invalid-table",
      `Table maximum is ${maximumElements} elements; policy maximum is ${limits.maxTableElements}`,
      reader.offset
    );
  }
  reader.expectEnd("table section");
  return { initialElements, maximumElements };
}

function readMemory(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): MemoryMetadata {
  const count = reader.readVarU32("memory count");
  if (count !== 1) {
    fail("invalid-memory", "Module must define exactly one memory", reader.offset);
  }

  const flagsOffset = reader.offset;
  const flags = reader.readVarU32("memory flags");
  if ((flags & 0x04) !== 0) {
    fail("invalid-memory", "memory64 is not allowed", flagsOffset);
  }
  if ((flags & 0x02) !== 0) {
    fail("invalid-memory", "Shared memory is not allowed", flagsOffset);
  }
  if ((flags & 0x01) === 0) {
    fail("invalid-memory", "Memory must declare an explicit maximum", flagsOffset);
  }
  if (flags !== 0x01) {
    fail("invalid-memory", `Unsupported memory flags 0x${flags.toString(16)}`, flagsOffset);
  }

  const initialPages = reader.readVarU32("initial memory pages");
  const maximumPages = reader.readVarU32("maximum memory pages");
  if (initialPages > maximumPages) {
    fail("invalid-memory", "Initial memory exceeds its maximum", reader.offset);
  }
  if (maximumPages > limits.maxMemoryPages) {
    fail(
      "invalid-memory",
      `Memory maximum is ${maximumPages} pages; policy maximum is ${limits.maxMemoryPages}`,
      reader.offset
    );
  }
  reader.expectEnd("memory section");
  return { initialPages, maximumPages };
}

function readGlobals(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): GlobalType[] {
  const count = reader.readVarU32("global count");
  enforceLimit(count, limits.maxGlobals, "globals", reader.offset);
  const globals: GlobalType[] = [];

  for (let index = 0; index < count; index += 1) {
    const valueType = readValueType(reader, "global value type");
    if (
      valueType !== 0x7f &&
      valueType !== 0x7e &&
      valueType !== 0x7d &&
      valueType !== 0x7c
    ) {
      fail(
        "unsupported-section",
        "Viewer-extension globals must use numeric core value types",
        reader.offset - 1
      );
    }
    const mutability = reader.readByte("global mutability");
    if (mutability !== 0 && mutability !== 1) {
      fail("malformed", `Invalid global mutability ${mutability}`, reader.offset - 1);
    }
    readNumericConstantExpression(reader, valueType);
    globals.push({ valueType, mutable: mutability === 1 });
  }
  reader.expectEnd("global section");
  return globals;
}

function readNumericConstantExpression(reader: Reader, valueType: number): void {
  const opcode = reader.readByte("global initializer opcode");
  switch (valueType) {
    case 0x7f:
      if (opcode !== 0x41) invalidGlobalInitializer(reader);
      readCanonicalSignedLeb(reader, 32, "i32 global initializer");
      break;
    case 0x7e:
      if (opcode !== 0x42) invalidGlobalInitializer(reader);
      readCanonicalSignedLeb(reader, 64, "i64 global initializer");
      break;
    case 0x7d:
      if (opcode !== 0x43) invalidGlobalInitializer(reader);
      reader.readBytes(4, "f32 global initializer");
      break;
    case 0x7c:
      if (opcode !== 0x44) invalidGlobalInitializer(reader);
      reader.readBytes(8, "f64 global initializer");
      break;
  }
  if (reader.readByte("global initializer end") !== 0x0b) {
    invalidGlobalInitializer(reader);
  }
}

function invalidGlobalInitializer(reader: Reader): never {
  fail(
    "unsupported-section",
    "Globals must use a single numeric constant initializer",
    reader.offset - 1
  );
}

function readCanonicalSignedLeb(
  reader: Reader,
  bits: 32 | 64,
  context: string
): void {
  const start = reader.offset;
  const encoded: number[] = [];
  const maximumBytes = Math.ceil(bits / 7);
  let value = 0n;
  let shift = 0n;

  for (let index = 0; index < maximumBytes; index += 1) {
    const byte = reader.readByte(context);
    encoded.push(byte);
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;

    if ((byte & 0x80) === 0) {
      if ((byte & 0x40) !== 0) value |= -1n << shift;
      const minimum = -(1n << BigInt(bits - 1));
      const maximum = (1n << BigInt(bits - 1)) - 1n;
      if (value < minimum || value > maximum) {
        fail("malformed", `${context} exceeds i${bits}`, start);
      }
      if (!sameValues(encoded, encodeSignedLeb(value))) {
        fail("malformed", `${context} uses a non-canonical LEB128`, start);
      }
      return;
    }
  }
  fail("malformed", `${context} is too long`, start);
}

function encodeSignedLeb(value: bigint): number[] {
  const encoded: number[] = [];
  let remaining = value;
  while (true) {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    const signSet = (byte & 0x40) !== 0;
    const done =
      (remaining === 0n && !signSet) ||
      (remaining === -1n && signSet);
    if (!done) byte |= 0x80;
    encoded.push(byte);
    if (done) return encoded;
  }
}

function readExports(
  reader: Reader
): Map<string, { kind: number; index: number }> {
  const count = reader.readVarU32("export count");
  const minimumCount = REQUIRED_EXTENSION_FUNCTION_EXPORTS.length + 1;
  const maximumCount = minimumCount + 2;
  if (count < minimumCount || count > maximumCount) {
    fail(
      "invalid-export",
      `Module must export ${minimumCount} ABI values and at most two linker globals; found ${count}`,
      reader.offset
    );
  }

  const exports = new Map<string, { kind: number; index: number }>();
  for (let exportIndex = 0; exportIndex < count; exportIndex += 1) {
    const name = reader.readName("export name");
    const kind = reader.readByte("export kind");
    const index = reader.readVarU32("export index");
    if (exports.has(name)) {
      fail("invalid-export", `Duplicate export name ${JSON.stringify(name)}`, reader.offset);
    }
    exports.set(name, { kind, index });
  }
  reader.expectEnd("export section");
  return exports;
}

function readCode(
  reader: Reader,
  limits: ExtensionWasmPolicyLimits
): { functionCount: number; codeBytes: number } {
  const functionCount = reader.readVarU32("code function count");
  enforceLimit(functionCount, limits.maxFunctions, "code functions", reader.offset);
  let codeBytes = 0;
  for (let index = 0; index < functionCount; index += 1) {
    const bodyLength = reader.readVarU32("function body size");
    reader.readBytes(bodyLength, "function body");
    codeBytes += bodyLength;
  }
  reader.expectEnd("code section");
  return { functionCount, codeBytes };
}

function readCountOnly(
  reader: Reader,
  maximum: number,
  context: string
): number {
  const count = reader.readVarU32(`${context} count`);
  enforceLimit(count, maximum, context, reader.offset);
  return count;
}

function validateExports(
  exports: Map<string, { kind: number; index: number }> | null,
  functionTypeIndices: readonly number[],
  types: readonly FunctionType[],
  globals: readonly GlobalType[]
): void {
  if (exports === null) {
    fail("invalid-export", "Module has no export section");
  }

  const memory = exports.get("memory");
  if (memory === undefined || memory.kind !== 2 || memory.index !== 0) {
    fail("invalid-export", 'Module must export its only memory as "memory"');
  }

  const linkerGlobals = ["__data_end", "__heap_base"] as const;
  const allowed = new Set<string>([
    "memory",
    ...REQUIRED_EXTENSION_FUNCTION_EXPORTS,
    ...linkerGlobals,
  ]);
  for (const name of exports.keys()) {
    if (!allowed.has(name)) {
      fail("invalid-export", `Unexpected export ${JSON.stringify(name)}`);
    }
  }

  const usedGlobalIndices = new Set<number>();
  for (const name of linkerGlobals) {
    const exported = exports.get(name);
    if (exported === undefined) continue;
    if (exported.kind !== 3) {
      fail("invalid-export", `${name} must be a global export`);
    }
    const global = globals[exported.index];
    if (global === undefined) {
      fail("invalid-export", `${name} references global ${exported.index}, which does not exist`);
    }
    if (global.valueType !== 0x7f || global.mutable) {
      fail("invalid-export", `${name} must be an immutable i32 global`);
    }
    if (usedGlobalIndices.has(exported.index)) {
      fail("invalid-export", `${name} aliases another linker global`);
    }
    usedGlobalIndices.add(exported.index);
  }

  const usedFunctionIndices = new Set<number>();
  for (const name of REQUIRED_EXTENSION_FUNCTION_EXPORTS) {
    const exported = exports.get(name);
    if (exported === undefined) {
      fail("invalid-export", `Missing required function export ${name}`);
    }
    if (exported.kind !== 0) {
      fail("invalid-export", `${name} must be a function export`);
    }
    if (exported.index >= functionTypeIndices.length) {
      fail("invalid-export", `${name} references function ${exported.index}, which does not exist`);
    }
    if (usedFunctionIndices.has(exported.index)) {
      fail("invalid-export", `${name} aliases another ABI function`);
    }
    usedFunctionIndices.add(exported.index);

    const typeIndex = functionTypeIndices[exported.index]!;
    const type = types[typeIndex];
    if (type === undefined) {
      fail("invalid-abi", `${name} references missing function type ${typeIndex}`);
    }
    const expected = ABI_SIGNATURES[name];
    if (
      !sameValues(type.parameters, expected.parameters) ||
      !sameValues(type.results, expected.results)
    ) {
      fail("invalid-abi", `${name} has the wrong WebAssembly signature`);
    }
  }
}

function sameValues(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveLimits(
  overrides: Partial<ExtensionWasmPolicyLimits>
): ExtensionWasmPolicyLimits {
  const limits = { ...DEFAULT_EXTENSION_WASM_POLICY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return limits;
}

function enforceLimit(
  actual: number,
  maximum: number,
  context: string,
  offset?: number
): void {
  if (actual > maximum) {
    fail(
      "limit-exceeded",
      `${context} count is ${actual}; maximum is ${maximum}`,
      offset
    );
  }
}

function fail(
  code: ExtensionWasmPolicyErrorCode,
  message: string,
  offset?: number
): never {
  throw new PolicyFailure(code, message, offset);
}
