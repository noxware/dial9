// End-to-end CPU/context-switch derivation over a generated D9TF event stream.
//
//   cargo build -p viewer-extension-demo --target wasm32-unknown-unknown \
//     --profile viewer-extension
//   cargo run -p viewer-extension-demo --features trace-fixture \
//     --bin make_trace -- /tmp/viewer-extension-bench.bin 250000
//   DIAL9_EXTENSION_WASM=../../target/wasm32-unknown-unknown/viewer-extension/viewer_extension_demo.wasm \
//   DIAL9_EXTENSION_TRACE=/tmp/viewer-extension-bench.bin \
//     npm run bench:viewer-extension
//
// Compilation and the reference JS parse happen outside measured functions.

import { existsSync, readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { parseTraceBuffer } from "../trace/index.js";
import { ExtensionTableStore, type TableStore } from "./tables.js";
import type { RecordBatch } from "./types.js";
import {
  batchTransferables,
  prepareCompiledExtension,
  type WasmExtensionRuntime,
} from "./worker/wasm-runtime.js";

const RESOURCE_EVENT = "ProcessResourceUsageEvent";
const CHUNK_BYTES = 1024 * 1024;
const TRACE_PATH = process.env["DIAL9_EXTENSION_TRACE"];
const WASM_PATH = process.env["DIAL9_EXTENSION_WASM"];
const available =
  TRACE_PATH !== undefined &&
  WASM_PATH !== undefined &&
  existsSync(TRACE_PATH) &&
  existsSync(WASM_PATH);

const traceBytes = available ? readFileSync(TRACE_PATH) : null;
const wasmBytes = available ? readFileSync(WASM_PATH) : null;
const compiled =
  wasmBytes === null ? null : await WebAssembly.compile(arrayBuffer(wasmBytes));
const referenceTrace =
  traceBytes === null ? null : await parseTraceBuffer(arrayBuffer(traceBytes));

interface ResourceEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface Usage {
  readonly timestampNs: number;
  readonly userCpuNs: number;
  readonly systemCpuNs: number;
  readonly voluntary: number;
  readonly involuntary: number;
}

interface CpuInterval {
  readonly startNs: number;
  readonly endNs: number;
  readonly cpuDeltaNs: number;
  readonly cores: number;
}

interface ContextInterval {
  readonly delta: number;
}

interface ResourceOutput {
  readonly cpu: readonly CpuInterval[];
  readonly voluntary: readonly ContextInterval[];
  readonly involuntary: readonly ContextInterval[];
}

interface ExecutionMetrics {
  batches: number;
  rows: number;
  maxBatchRows: number;
  outputBytes: number;
  guestMemoryBytes: number;
}

interface WasmExecution {
  readonly tables: ExtensionTableStore | null;
  readonly metrics: ExecutionMetrics;
}

interface Summary {
  readonly rows: readonly [number, number];
  readonly bounds: readonly [number, number];
  readonly cpuDeltaNs: number;
  readonly cpuCores: readonly [number, number];
  readonly voluntaryDelta: readonly [number, number];
  readonly involuntaryDelta: readonly [number, number];
}

function usage(event: ResourceEvent): Usage {
  return {
    timestampNs: event.timestamp,
    userCpuNs: Number(event.fields["user_cpu_ns"]),
    systemCpuNs: Number(event.fields["system_cpu_ns"]),
    voluntary: Number(event.fields["voluntary_context_switches"]),
    involuntary: Number(event.fields["involuntary_context_switches"]),
  };
}

function deriveWithFor(events: readonly ResourceEvent[]): ResourceOutput {
  const cpu: CpuInterval[] = [];
  const voluntary: ContextInterval[] = [];
  const involuntary: ContextInterval[] = [];
  let previous: Usage | null = null;
  for (const event of events) {
    if (event.name !== RESOURCE_EVENT) continue;
    const current = usage(event);
    if (previous !== null) {
      const wallDeltaNs = current.timestampNs - previous.timestampNs;
      const userDeltaNs = current.userCpuNs - previous.userCpuNs;
      const systemDeltaNs = current.systemCpuNs - previous.systemCpuNs;
      if (
        wallDeltaNs > 0 &&
        userDeltaNs >= 0 &&
        systemDeltaNs >= 0
      ) {
        const cpuDeltaNs = userDeltaNs + systemDeltaNs;
        cpu.push({
          startNs: previous.timestampNs,
          endNs: current.timestampNs,
          cpuDeltaNs,
          cores: cpuDeltaNs / wallDeltaNs,
        });
        voluntary.push({
          delta: current.voluntary - previous.voluntary,
        });
        involuntary.push({
          delta: current.involuntary - previous.involuntary,
        });
      }
    }
    previous = current;
  }
  return { cpu, voluntary, involuntary };
}

function deriveWithArrayMethods(
  events: readonly ResourceEvent[],
): ResourceOutput {
  const samples = events
    .filter(({ name }) => name === RESOURCE_EVENT)
    .map(usage);
  const pairs = samples.slice(1).map((current, index) => {
    const previous = samples[index]!;
    return {
      previous,
      current,
      wallDeltaNs: current.timestampNs - previous.timestampNs,
      userDeltaNs: current.userCpuNs - previous.userCpuNs,
      systemDeltaNs: current.systemCpuNs - previous.systemCpuNs,
    };
  });
  const valid = pairs.filter(
    ({ wallDeltaNs, userDeltaNs, systemDeltaNs }) =>
      wallDeltaNs > 0 && userDeltaNs >= 0 && systemDeltaNs >= 0,
  );
  return {
    cpu: valid.map(
      ({ previous, current, wallDeltaNs, userDeltaNs, systemDeltaNs }) => {
        const cpuDeltaNs = userDeltaNs + systemDeltaNs;
        return {
          startNs: previous.timestampNs,
          endNs: current.timestampNs,
          cpuDeltaNs,
          cores: cpuDeltaNs / wallDeltaNs,
        };
      },
    ),
    voluntary: valid.map(({ previous, current }) => ({
      delta: current.voluntary - previous.voluntary,
    })),
    involuntary: valid.map(({ previous, current }) => ({
      delta: current.involuntary - previous.involuntary,
    })),
  };
}

async function executeWasm(options: {
  readonly transport: boolean;
  readonly store: boolean;
}): Promise<WasmExecution> {
  if (compiled === null || traceBytes === null) {
    throw new Error("viewer-extension benchmark inputs are missing");
  }
  const prepared = await prepareCompiledExtension(compiled);
  const runtime = prepared.runtime as WasmExtensionRuntime;
  const tables = options.store
    ? new ExtensionTableStore(prepared.manifest)
    : null;
  const metrics: ExecutionMetrics = {
    batches: 0,
    rows: 0,
    maxBatchRows: 0,
    outputBytes: 0,
    guestMemoryBytes: 0,
  };
  const accept = (batch: RecordBatch): void => {
    metrics.batches++;
    metrics.rows += batch.rows;
    metrics.maxBatchRows = Math.max(metrics.maxBatchRows, batch.rows);
    metrics.outputBytes += batchBytes(batch);
    const delivered = options.transport
      ? structuredClone(batch, { transfer: batchTransferables(batch) })
      : batch;
    tables?.append(delivered);
  };

  for (let offset = 0; offset < traceBytes.length; offset += CHUNK_BYTES) {
    const source = traceBytes.subarray(offset, offset + CHUNK_BYTES);
    let input: Uint8Array = source;
    if (options.transport) {
      const copied = arrayBuffer(source);
      input = new Uint8Array(
        structuredClone(copied, { transfer: [copied] }),
      );
    }
    for (const batch of runtime.push(input)) accept(batch);
  }
  for (const batch of runtime.finish()) accept(batch);
  metrics.guestMemoryBytes = runtime.memoryBytes;
  return { tables, metrics };
}

async function deriveEndToEndJs(): Promise<ResourceOutput> {
  if (traceBytes === null) throw new Error("benchmark trace is missing");
  const trace = await parseTraceBuffer(arrayBuffer(traceBytes));
  return deriveWithFor(trace.customEvents as ResourceEvent[]);
}

function summarizeJs(output: ResourceOutput): Summary {
  const firstCpu = output.cpu[0]!;
  const lastCpu = output.cpu.at(-1)!;
  return {
    rows: [output.cpu.length, output.voluntary.length],
    bounds: [firstCpu.startNs, lastCpu.endNs],
    cpuDeltaNs: output.cpu.reduce(
      (sum, interval) => sum + interval.cpuDeltaNs,
      0,
    ),
    cpuCores: [firstCpu.cores, lastCpu.cores],
    voluntaryDelta: [
      output.voluntary[0]!.delta,
      output.voluntary.at(-1)!.delta,
    ],
    involuntaryDelta: [
      output.involuntary[0]!.delta,
      output.involuntary.at(-1)!.delta,
    ],
  };
}

function summarizeWasm(tables: ExtensionTableStore): Summary {
  const cpu = tables.table("cpu_intervals");
  const context = tables.table("context_switches");
  if (
    numberAt(context, 0, "start_ns") !== numberAt(cpu, 0, "start_ns") ||
    !(numberAt(context, 0, "end_ns") > numberAt(context, 0, "start_ns"))
  ) {
    throw new Error("first context-switch delta must cover its sample interval");
  }
  return {
    rows: [cpu.rowCount, context.rowCount],
    bounds: [
      numberAt(cpu, 0, "start_ns"),
      numberAt(cpu, cpu.rowCount - 1, "end_ns"),
    ],
    cpuDeltaNs: sumColumn(cpu, "cpu_ns"),
    cpuCores: [
      numberAt(cpu, 0, "cores"),
      numberAt(cpu, cpu.rowCount - 1, "cores"),
    ],
    voluntaryDelta: [
      numberAt(context, 0, "voluntary_delta"),
      numberAt(context, context.rowCount - 1, "voluntary_delta"),
    ],
    involuntaryDelta: [
      numberAt(context, 0, "involuntary_delta"),
      numberAt(context, context.rowCount - 1, "involuntary_delta"),
    ],
  };
}

function numberAt(table: TableStore, row: number, column: string): number {
  const value = table.value(row, column);
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${table.schema.name}.${column}[${row}] is not numeric`);
  }
  return Number(value);
}

function sumColumn(table: TableStore, column: string): number {
  let sum = 0;
  table.forEachRow((row) => {
    sum += numberAt(table, row, column);
  });
  return sum;
}

function batchBytes(batch: RecordBatch): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const column of batch.columns) {
    if (column.type === "utf8") {
      buffers.add(column.offsets.buffer);
      buffers.add(column.data.buffer);
    } else {
      buffers.add(column.values.buffer);
    }
    if (column.validity !== null) buffers.add(column.validity.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

let sink: unknown;

if (referenceTrace !== null) {
  const events = referenceTrace.customEvents as ResourceEvent[];
  const direct = deriveWithFor(events);
  const functional = deriveWithArrayMethods(events);
  const wasm = await executeWasm({ transport: true, store: true });
  const expected = JSON.stringify(summarizeJs(direct));
  if (
    JSON.stringify(summarizeJs(functional)) !== expected ||
    wasm.tables === null ||
    JSON.stringify(summarizeWasm(wasm.tables)) !== expected
  ) {
    throw new Error("viewer-extension benchmark implementations disagree");
  }
  if (wasm.metrics.maxBatchRows > 1_024) {
    throw new Error("reference extension retained more than one output batch");
  }
  if (
    traceBytes!.byteLength >= CHUNK_BYTES * 4 &&
    wasm.metrics.guestMemoryBytes >= traceBytes!.byteLength
  ) {
    throw new Error("guest linear memory grew with the complete trace");
  }
  console.info(
    [
      `viewer-extension benchmark: ${events.length.toLocaleString()} events`,
      `${mib(traceBytes!.byteLength)} trace`,
      `${(wasmBytes!.byteLength / 1024).toFixed(1)} KiB module`,
      `${wasm.metrics.batches.toLocaleString()} incremental batches`,
      `${mib(wasm.metrics.outputBytes)} host output`,
      `${mib(wasm.metrics.guestMemoryBytes)} guest linear memory`,
    ].join(", "),
  );
}

describe.skipIf(!available)("viewer extension over a large D9TF trace", () => {
  const events = referenceTrace!.customEvents as ResourceEvent[];
  const options = { time: 1_500 };

  bench("JS for loop (already parsed events)", () => {
    sink = deriveWithFor(events);
  }, options);

  bench("JS filter/map (already parsed events)", () => {
    sink = deriveWithArrayMethods(events);
  }, options);

  bench("JS parse D9TF + for loop", async () => {
    sink = await deriveEndToEndJs();
  }, options);

  bench("WASM precompiled + validated batches", async () => {
    sink = await executeWasm({ transport: false, store: false });
  }, options);

  bench("WASM + transferable transport + host store", async () => {
    sink = await executeWasm({ transport: true, store: true });
  }, options);
});
