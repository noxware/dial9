// Streaming viewer-extension benchmark over generated, output-dense D9TF.
//
// From the repository root:
//
//   cargo build --profile viewer-extension --target wasm32-unknown-unknown \
//     -p dial9-viewer-extension-demo --lib
//   cargo run --release -p dial9-viewer-extension-demo \
//     --features trace-fixture --bin make_trace -- \
//     /tmp/dial9-extension-250k.bin 250000
//   cargo run --release -p dial9-viewer-extension-demo \
//     --features trace-fixture --bin make_trace -- \
//     /tmp/dial9-extension-large.bin 1000000
//   DIAL9_EXTENSION_WASM="$PWD/target/wasm32-unknown-unknown/viewer-extension/dial9_viewer_extension_demo.wasm" \
//   DIAL9_EXTENSION_TRACE_250K=/tmp/dial9-extension-250k.bin \
//   DIAL9_EXTENSION_TRACE_LARGE=/tmp/dial9-extension-large.bin \
//     npm --prefix dial9-viewer/ui run bench -- \
//       src/lib/viewer-extension/viewer-extension.bench.ts
//
// Compilation and the reference viewer parse happen at module setup, outside
// every timed benchmark function. The timed paths instantiate an already
// compiled module and feed the same fixed-size chunks used by the phase probe.
// Node does not model browser Worker scheduling or transferable postMessage
// cost faithfully, so this benchmark deliberately does not report either.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bench, describe } from "vitest";
import { parseTraceBuffer } from "../trace/load.js";
import {
  copyOutputBatch,
  readGuestError,
  validateExtensionExports,
  wasmU32Result,
  type ExtensionAbiExports,
} from "./abi.js";
import {
  batchTransferables,
  type ColumnarBatch,
} from "./columnar.js";
import {
  loadExtensionModule,
  type ExtensionGuest,
} from "./module.js";
import {
  parseExtensionManifestBytes,
  VIEWER_EXTENSION_MANIFEST_SECTION,
  type ExtensionManifest,
} from "./manifest.js";

const RESOURCE_EVENT = "ProcessResourceUsageEvent";
const CHUNK_BYTES = 256 * 1024;
const PHASE_RUNS = 3;
const BOUNDED_MEMORY_SLOP = 2 * 1024 * 1024;

interface TraceConfig {
  readonly label: string;
  readonly path: string;
  readonly expectedRows?: number;
}

interface Reference {
  readonly resourceRows: number;
  readonly capacity: string | null;
}

interface Summary {
  readonly rows: number[];
  readonly batches: number[];
  hostBytes: number;
  guestInitialBytes: number;
  guestPeakBytes: number;
  guestFinalBytes: number;
  firstComputedBatchInputBytes: number | null;
  batchesBeforeFinish: number;
}

interface PhaseTimes {
  inputCopyMs: number;
  decodeComputeMs: number;
  copyValidationMs: number;
  totalMs: number;
}

interface PreparedTrace {
  readonly label: string;
  readonly path: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly reference: Reference;
  readonly summary: Summary;
  readonly phases: PhaseTimes;
}

let benchmarkSink: unknown;

function configuredPath(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return null;
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw new Error(`${name} does not exist: ${resolved}`);
  }
  return resolved;
}

function exactBytes(file: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(readFileSync(file));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function eventRate(events: number, elapsedMs: number): string {
  return `${(events / elapsedMs / 1_000).toFixed(2)} M events/s`;
}

function byteRate(bytes: number, elapsedMs: number): string {
  return `${(bytes / 1024 / 1024 / (elapsedMs / 1_000)).toFixed(2)} MiB/s`;
}

async function parseReference(bytes: Uint8Array): Promise<Reference> {
  const trace = await parseTraceBuffer(exactArrayBuffer(bytes));
  let resourceRows = 0;
  for (const event of trace.customEvents) {
    if (event.name === RESOURCE_EVENT) resourceRows += 1;
  }
  return {
    resourceRows,
    capacity:
      trace.segmentMetadata?.get("process.available_parallelism") ?? null,
  };
}

function summary(manifest: ExtensionManifest, initialMemory: number): Summary {
  return {
    rows: manifest.tables.map(() => 0),
    batches: manifest.tables.map(() => 0),
    hostBytes: 0,
    guestInitialBytes: initialMemory,
    guestPeakBytes: initialMemory,
    guestFinalBytes: initialMemory,
    firstComputedBatchInputBytes: null,
    batchesBeforeFinish: 0,
  };
}

function computedTableIds(manifest: ExtensionManifest): ReadonlySet<number> {
  const names = new Set([
    "cpu_intervals",
    "context_intervals",
    "context_samples",
  ]);
  return new Set(
    manifest.tables.flatMap((table, tableId) =>
      names.has(table.name) ? [tableId] : [],
    ),
  );
}

function observeMemory(result: Summary, bytes: number): void {
  result.guestPeakBytes = Math.max(result.guestPeakBytes, bytes);
  result.guestFinalBytes = bytes;
}

function accountBatch(
  result: Summary,
  batch: ColumnarBatch,
  computedIds: ReadonlySet<number>,
  inputBytes: number,
  beforeFinish: boolean,
): void {
  result.rows[batch.table_id] =
    (result.rows[batch.table_id] ?? 0) + batch.rows;
  result.batches[batch.table_id] =
    (result.batches[batch.table_id] ?? 0) + 1;
  for (const buffer of batchTransferables(batch)) {
    result.hostBytes += buffer.byteLength;
  }
  if (
    result.firstComputedBatchInputBytes === null &&
    computedIds.has(batch.table_id)
  ) {
    result.firstComputedBatchInputBytes = inputBytes;
  }
  if (beforeFinish) result.batchesBeforeFinish += 1;
}

function assertReferenceRows(
  manifest: ExtensionManifest,
  result: Summary,
  reference: Reference,
): void {
  const expected = new Map<string, number>([
    ["cpu_intervals", Math.max(0, reference.resourceRows - 1)],
    ["context_intervals", Math.max(0, reference.resourceRows - 1)],
    ["context_samples", reference.resourceRows],
    ["settings", 1],
  ]);
  for (let tableId = 0; tableId < manifest.tables.length; tableId += 1) {
    const table = manifest.tables[tableId]!;
    const rows = expected.get(table.name);
    if (rows !== undefined && result.rows[tableId] !== rows) {
      throw new Error(
        `${table.name} emitted ${result.rows[tableId]} rows; expected ${rows}`,
      );
    }
  }
  if (reference.resourceRows > 1 && result.firstComputedBatchInputBytes === null) {
    throw new Error("extension emitted computed tables only during finish");
  }
}

function sameSummary(left: Summary, right: Summary): boolean {
  return (
    JSON.stringify(left.rows) === JSON.stringify(right.rows) &&
    JSON.stringify(left.batches) === JSON.stringify(right.batches) &&
    left.hostBytes === right.hostBytes &&
    left.firstComputedBatchInputBytes === right.firstComputedBatchInputBytes &&
    left.batchesBeforeFinish === right.batchesBeforeFinish
  );
}

async function driveLoadedGuest(
  guest: ExtensionGuest,
  bytes: Uint8Array,
): Promise<Summary> {
  const result = summary(guest.manifest, guest.linearMemoryByteLength);
  const computedIds = computedTableIds(guest.manifest);
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
    for (const batch of guest.push(bytes.subarray(offset, end))) {
      accountBatch(result, batch, computedIds, end, true);
    }
    observeMemory(result, guest.linearMemoryByteLength);
  }
  for (const batch of guest.finish()) {
    accountBatch(result, batch, computedIds, bytes.byteLength, false);
  }
  observeMemory(result, guest.linearMemoryByteLength);
  return result;
}

function guestFailure(
  exports: ExtensionAbiExports,
  operation: string,
): never {
  const detail = readGuestError(exports);
  throw new Error(
    detail.length === 0
      ? `guest ${operation} failed`
      : `guest ${operation} failed: ${detail}`,
  );
}

function memoryBytes(exports: ExtensionAbiExports): number {
  const buffer = exports.memory.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error("shared WebAssembly memory is unsupported");
  }
  return buffer.byteLength;
}

function drain(
  exports: ExtensionAbiExports,
  manifest: ExtensionManifest,
  result: Summary,
  computedIds: ReadonlySet<number>,
  inputBytes: number,
  beforeFinish: boolean,
  copyAndValidate: boolean,
): void {
  for (;;) {
    const status = exports.dial9_output_next();
    if (status === 0) return;
    if (status === -1) return guestFailure(exports, "output");
    if (status !== 1) {
      throw new Error(`dial9_output_next returned ${status}`);
    }
    if (copyAndValidate) {
      const pointer = wasmU32Result(
        exports.dial9_output_descriptor_ptr(),
        "output descriptor pointer",
      );
      const length = wasmU32Result(
        exports.dial9_output_descriptor_len(),
        "output descriptor length",
      );
      accountBatch(
        result,
        copyOutputBatch(exports.memory, pointer, length, manifest),
        computedIds,
        inputBytes,
        beforeFinish,
      );
    }
    if (exports.dial9_output_ack() !== 0) {
      return guestFailure(exports, "output ack");
    }
    observeMemory(result, memoryBytes(exports));
  }
}

function driveRawGuest(
  exports: ExtensionAbiExports,
  manifest: ExtensionManifest,
  bytes: Uint8Array,
  copyAndValidate: boolean,
  phases?: PhaseTimes,
): Summary {
  const result = summary(manifest, memoryBytes(exports));
  const computedIds = computedTableIds(manifest);
  const totalStart = phases === undefined ? 0 : performance.now();

  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);

    let start = phases === undefined ? 0 : performance.now();
    const pointer = wasmU32Result(
      exports.dial9_input_reserve(chunk.byteLength),
      "input pointer",
    );
    const buffer = exports.memory.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error("shared WebAssembly memory is unsupported");
    }
    const inputEnd = pointer + chunk.byteLength;
    if (!Number.isSafeInteger(inputEnd) || inputEnd > buffer.byteLength) {
      throw new Error("input range is outside WebAssembly memory");
    }
    new Uint8Array(buffer, pointer, chunk.byteLength).set(chunk);
    if (phases !== undefined) {
      phases.inputCopyMs += performance.now() - start;
      start = performance.now();
    }

    if (exports.dial9_push(chunk.byteLength) !== 0) {
      return guestFailure(exports, "push");
    }
    if (phases !== undefined) {
      phases.decodeComputeMs += performance.now() - start;
      start = performance.now();
    }
    observeMemory(result, memoryBytes(exports));
    drain(
      exports,
      manifest,
      result,
      computedIds,
      end,
      true,
      copyAndValidate,
    );
    if (phases !== undefined) {
      phases.copyValidationMs += performance.now() - start;
    }
  }

  let start = phases === undefined ? 0 : performance.now();
  if (exports.dial9_finish() !== 0) {
    return guestFailure(exports, "finish");
  }
  if (phases !== undefined) {
    phases.decodeComputeMs += performance.now() - start;
    start = performance.now();
  }
  drain(
    exports,
    manifest,
    result,
    computedIds,
    bytes.byteLength,
    false,
    copyAndValidate,
  );
  if (phases !== undefined) {
    phases.copyValidationMs += performance.now() - start;
    phases.totalMs += performance.now() - totalStart;
  }
  observeMemory(result, memoryBytes(exports));
  return result;
}

async function instantiate(
  module: WebAssembly.Module,
): Promise<ExtensionAbiExports> {
  const instance = await WebAssembly.instantiate(module, {});
  return validateExtensionExports(instance.exports);
}

async function profilePhases(
  module: WebAssembly.Module,
  manifest: ExtensionManifest,
  bytes: Uint8Array,
  expected: Summary,
): Promise<PhaseTimes> {
  const samples: PhaseTimes[] = [];
  for (let run = 0; run < PHASE_RUNS; run += 1) {
    const exports = await instantiate(module);
    const phases: PhaseTimes = {
      inputCopyMs: 0,
      decodeComputeMs: 0,
      copyValidationMs: 0,
      totalMs: 0,
    };
    const actual = driveRawGuest(exports, manifest, bytes, true, phases);
    if (!sameSummary(expected, actual)) {
      throw new Error("raw ABI phase probe disagrees with loadExtensionModule");
    }
    samples.push(phases);
  }
  return {
    inputCopyMs: median(samples.map((sample) => sample.inputCopyMs)),
    decodeComputeMs: median(samples.map((sample) => sample.decodeComputeMs)),
    copyValidationMs: median(
      samples.map((sample) => sample.copyValidationMs),
    ),
    totalMs: median(samples.map((sample) => sample.totalMs)),
  };
}

function report(
  input: PreparedTrace,
  manifest: ExtensionManifest,
  wasmBytes: number,
): void {
  const tableRows = manifest.tables
    .map((table, tableId) => {
      const rows = input.summary.rows[tableId]!;
      const batches = input.summary.batches[tableId]!;
      return rows === 0 ? null : `${table.name}=${rows}/${batches}`;
    })
    .filter((value): value is string => value !== null)
    .join(", ");
  const first = input.summary.firstComputedBatchInputBytes;
  console.info(
    [
      `viewer-extension benchmark [${input.label}]`,
      `  trace: ${input.path}`,
      `  input: ${input.reference.resourceRows.toLocaleString()} resource events, ${mib(input.bytes.byteLength)}`,
      `  module: ${mib(wasmBytes)}; chunk: ${mib(CHUNK_BYTES)}`,
      `  phase median (${PHASE_RUNS} runs; setup excluded): input copy ${ms(input.phases.inputCopyMs)}, decode + compute ${ms(input.phases.decodeComputeMs)}, output copy + validation ${ms(input.phases.copyValidationMs)}, total ${ms(input.phases.totalMs)}`,
      `  throughput: ${eventRate(input.reference.resourceRows, input.phases.decodeComputeMs)} decode + compute; ${byteRate(input.bytes.byteLength, input.phases.totalMs)} end-to-end ABI`,
      `  output rows/batches: ${tableRows}`,
      `  host column buffers: ${mib(input.summary.hostBytes)}`,
      `  guest linear memory initial/peak/final: ${mib(input.summary.guestInitialBytes)} / ${mib(input.summary.guestPeakBytes)} / ${mib(input.summary.guestFinalBytes)}`,
      `  incremental output: ${input.summary.batchesBeforeFinish} batches before finish; first computed batch ${first === null ? "not emitted" : `after ${mib(first)} (${((first / input.bytes.byteLength) * 100).toFixed(1)}% of input)`}`,
      "  Worker scheduling and postMessage transfer: not measured in Node",
    ].join("\n"),
  );
}

const wasmPath = configuredPath("DIAL9_EXTENSION_WASM");
const trace250kPath = configuredPath("DIAL9_EXTENSION_TRACE_250K");
const largeTracePath = configuredPath("DIAL9_EXTENSION_TRACE_LARGE");
const available = wasmPath !== null && trace250kPath !== null;
const wasmBytes = wasmPath === null ? null : exactBytes(wasmPath);
const compiled =
  wasmBytes === null ? null : await WebAssembly.compile(wasmBytes);
let manifest: ExtensionManifest | null = null;
if (compiled !== null) {
  const sections = WebAssembly.Module.customSections(
    compiled,
    VIEWER_EXTENSION_MANIFEST_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${VIEWER_EXTENSION_MANIFEST_SECTION} section; found ${sections.length}`,
    );
  }
  manifest = parseExtensionManifestBytes(new Uint8Array(sections[0]!));
}

const traceConfigs: TraceConfig[] =
  trace250kPath === null
    ? []
    : [
        {
          label: "250k",
          path: trace250kPath,
          expectedRows: 250_000,
        },
        ...(largeTracePath === null
          ? []
          : [{ label: "large", path: largeTracePath }]),
      ];
const prepared: PreparedTrace[] = [];
if (wasmBytes !== null && compiled !== null && manifest !== null) {
  for (const config of traceConfigs) {
    const bytes = exactBytes(config.path);
    const reference = await parseReference(bytes);
    if (
      config.expectedRows !== undefined &&
      reference.resourceRows !== config.expectedRows
    ) {
      throw new Error(
        `${config.label} trace has ${reference.resourceRows} resource events; expected ${config.expectedRows}`,
      );
    }
    if (reference.capacity !== "11") {
      throw new Error(
        `${config.label} trace has unexpected available parallelism ${String(reference.capacity)}`,
      );
    }

    // This is the production loader correctness run. Its compilation and
    // instantiation are intentionally outside all timed benchmark functions.
    const loaded = await loadExtensionModule(wasmBytes);
    const loadedSummary = await driveLoadedGuest(loaded, bytes);
    assertReferenceRows(manifest, loadedSummary, reference);
    const phases = await profilePhases(
      compiled,
      manifest,
      bytes,
      loadedSummary,
    );
    const input = {
      label: config.label,
      path: config.path,
      bytes,
      reference,
      summary: loadedSummary,
      phases,
    };
    prepared.push(input);
    report(input, manifest, wasmBytes.byteLength);
  }
}

if (prepared.length > 1) {
  const baseline = prepared[0]!;
  for (const input of prepared.slice(1)) {
    if (input.reference.resourceRows <= baseline.reference.resourceRows) {
      throw new Error(
        `${input.label} trace must contain more than ${baseline.reference.resourceRows} resource events`,
      );
    }
    const growth =
      input.summary.guestPeakBytes - baseline.summary.guestPeakBytes;
    if (growth > BOUNDED_MEMORY_SLOP) {
      throw new Error(
        `guest peak memory grew by ${mib(growth)} with trace size; expected bounded streaming`,
      );
    }
    console.info(
      `guest peak growth ${baseline.label} -> ${input.label}: ${mib(growth)} (bounded streaming check passed)`,
    );
  }
}

describe.skipIf(!available)(
  "viewer extension over generated D9TF",
  () => {
    for (const input of prepared) {
      const options = {
        time: 1_500,
        iterations: 3,
        warmupTime: 250,
        warmupIterations: 1,
      };

      bench(
        `${input.label}: precompiled decode + compute (output ack, no copy)`,
        async () => {
          const exports = await instantiate(compiled!);
          benchmarkSink = driveRawGuest(
            exports,
            manifest!,
            input.bytes,
            false,
          );
        },
        options,
      );

      bench(
        `${input.label}: precompiled decode + compute + output copy/validation`,
        async () => {
          const exports = await instantiate(compiled!);
          benchmarkSink = driveRawGuest(
            exports,
            manifest!,
            input.bytes,
            true,
          );
        },
        options,
      );
    }
  },
);
