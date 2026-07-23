// End-to-end CPU/context-switch derivation over a real D9TF event stream.
//
// Build the demo module and generate a large trace first:
//   cargo build --target wasm32-unknown-unknown --profile viewer-extension \
//     -p dial9-viewer-extension-demo --lib
//   cargo run -p dial9-viewer-extension-demo --features trace-fixture \
//     --bin make_trace -- <demo.wasm> /tmp/viewer-extension-bench.bin 250000
//   DIAL9_EXTENSION_WASM=<demo.wasm> \
//   DIAL9_EXTENSION_TRACE=/tmp/viewer-extension-bench.bin \
//     npx vitest bench --run src/lib/trace/viewer-extension.bench.ts
//
// WebAssembly compilation and the reference JS parse happen at module load,
// outside every measured function. Instantiation, guest execution, input/output
// copies, and output validation remain measured because the viewer pays them.

import { existsSync, readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { parseTrace } from "../../../trace_parser.js";
import { validateExtensionWasm } from "./extension-wasm-policy.js";
import { decodeViewerExtensionOutput } from "./viewer-extension-output.js";
import type { ViewBundle } from "../custom-views/types.js";

const RESOURCE_EVENT = "ProcessResourceUsageEvent";
const CHUNK_BYTES = 256 * 1024;
const TRACE_PATH = process.env["DIAL9_EXTENSION_TRACE"];
const WASM_PATH = process.env["DIAL9_EXTENSION_WASM"];
const available =
  TRACE_PATH !== undefined &&
  WASM_PATH !== undefined &&
  existsSync(TRACE_PATH) &&
  existsSync(WASM_PATH);

const traceBytes = available ? readFileSync(TRACE_PATH) : null;
const wasmBytes = available ? readFileSync(WASM_PATH) : null;
const policy = wasmBytes === null ? null : validateExtensionWasm(wasmBytes);
if (policy !== null && !policy.ok) {
  throw new Error(
    `viewer-extension benchmark module violates the viewer policy: ${policy.error.message}`,
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const referenceTrace =
  traceBytes === null ? null : await parseTrace(arrayBuffer(traceBytes));
const compiled =
  wasmBytes === null ? null : await WebAssembly.compile(wasmBytes);

interface ResourceEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly fields: Readonly<Record<string, string>>;
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
  readonly wallDeltaNs: number;
  readonly cpuDeltaNs: number;
  readonly cores: number;
}

interface ContextInterval {
  readonly startNs: number;
  readonly endNs: number;
  readonly delta: number;
  readonly rate: number;
}

interface ResourceOutput {
  readonly cpu: readonly CpuInterval[];
  readonly voluntary: readonly ContextInterval[];
  readonly involuntary: readonly ContextInterval[];
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

function cpuInterval(
  previous: Usage,
  current: Usage,
  wallDeltaNs: number,
): CpuInterval | null {
  const userDelta = current.userCpuNs - previous.userCpuNs;
  const systemDelta = current.systemCpuNs - previous.systemCpuNs;
  const cpuDeltaNs = userDelta + systemDelta;
  return userDelta < 0 || systemDelta < 0
    ? null
    : {
        startNs: previous.timestampNs,
        endNs: current.timestampNs,
        wallDeltaNs,
        cpuDeltaNs,
        cores: cpuDeltaNs / wallDeltaNs,
      };
}

function contextInterval(
  previous: Usage,
  current: Usage,
  wallDeltaNs: number,
  field: "voluntary" | "involuntary",
): ContextInterval | null {
  const delta = current[field] - previous[field];
  return delta < 0
    ? null
    : {
        startNs: previous.timestampNs,
        endNs: current.timestampNs,
        delta,
        rate: delta / (wallDeltaNs / 1_000_000_000),
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
      if (wallDeltaNs > 0) {
        const cpuValue = cpuInterval(previous, current, wallDeltaNs);
        if (cpuValue !== null) cpu.push(cpuValue);
        const voluntaryValue = contextInterval(
          previous,
          current,
          wallDeltaNs,
          "voluntary",
        );
        if (voluntaryValue !== null) voluntary.push(voluntaryValue);
        const involuntaryValue = contextInterval(
          previous,
          current,
          wallDeltaNs,
          "involuntary",
        );
        if (involuntaryValue !== null) involuntary.push(involuntaryValue);
      }
    }
    previous = current;
  }
  return { cpu, voluntary, involuntary };
}

function present<T>(value: T | null): value is T {
  return value !== null;
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
    };
  });
  return {
    cpu: pairs
      .map(({ previous, current, wallDeltaNs }) =>
        wallDeltaNs > 0
          ? cpuInterval(previous, current, wallDeltaNs)
          : null,
      )
      .filter(present),
    voluntary: pairs
      .map(({ previous, current, wallDeltaNs }) =>
        wallDeltaNs > 0
          ? contextInterval(previous, current, wallDeltaNs, "voluntary")
          : null,
      )
      .filter(present),
    involuntary: pairs
      .map(({ previous, current, wallDeltaNs }) =>
        wallDeltaNs > 0
          ? contextInterval(previous, current, wallDeltaNs, "involuntary")
          : null,
      )
      .filter(present),
  };
}

interface ExtensionExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly dial9_input_alloc: (length: number) => number;
  readonly dial9_push: (length: number) => number;
  readonly dial9_finish: () => number;
  readonly dial9_output_ptr: () => number;
  readonly dial9_output_len: () => number;
  readonly dial9_error_ptr: () => number;
  readonly dial9_error_len: () => number;
}

interface ExecutionMetrics {
  memoryBytes: number;
  outputBytes: number;
}

function extensionError(exports: ExtensionExports): Error {
  const pointer = exports.dial9_error_ptr() >>> 0;
  const length = exports.dial9_error_len() >>> 0;
  return new Error(
    new TextDecoder().decode(
      new Uint8Array(exports.memory.buffer, pointer, length),
    ),
  );
}

async function executeWasm(
  copyOutput: boolean,
  metrics?: ExecutionMetrics,
): Promise<ArrayBuffer | number> {
  if (compiled === null || traceBytes === null) {
    throw new Error("viewer-extension benchmark inputs are missing");
  }
  const instance = await WebAssembly.instantiate(compiled, {});
  const exports = instance.exports as unknown as ExtensionExports;
  for (let offset = 0; offset < traceBytes.length; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, traceBytes.length - offset);
    const pointer = exports.dial9_input_alloc(length) >>> 0;
    new Uint8Array(exports.memory.buffer, pointer, length).set(
      traceBytes.subarray(offset, offset + length),
    );
    if (exports.dial9_push(length) !== 0) throw extensionError(exports);
  }
  if (exports.dial9_finish() !== 0) throw extensionError(exports);
  const pointer = exports.dial9_output_ptr() >>> 0;
  const length = exports.dial9_output_len() >>> 0;
  if (metrics !== undefined) {
    metrics.memoryBytes = exports.memory.buffer.byteLength;
    metrics.outputBytes = length;
  }
  if (!copyOutput) return length;
  return new Uint8Array(exports.memory.buffer, pointer, length).slice().buffer;
}

async function deriveEndToEndJs(): Promise<ResourceOutput> {
  if (traceBytes === null) throw new Error("benchmark trace is missing");
  const trace = await parseTrace(arrayBuffer(traceBytes));
  return deriveWithFor(trace.customEvents as ResourceEvent[]);
}

async function deriveEndToEndWasm(
  metrics?: ExecutionMetrics,
): Promise<ViewBundle> {
  const output = await executeWasm(true, metrics);
  if (typeof output === "number") throw new Error("WASM output was not copied");
  return decodeViewerExtensionOutput(output);
}

interface Summary {
  readonly rows: readonly [number, number, number];
  readonly bounds: readonly [number, number, number, number, number, number];
  readonly cpuDeltaNs: number;
  readonly cpuCores: readonly [number, number];
  readonly voluntaryDelta: number;
  readonly voluntaryRate: readonly [number, number];
  readonly involuntaryDelta: number;
  readonly involuntaryRate: readonly [number, number];
}

function summarizeJs(output: ResourceOutput): Summary {
  const firstCpu = output.cpu[0]!;
  const lastCpu = output.cpu.at(-1)!;
  const firstVoluntary = output.voluntary[0]!;
  const lastVoluntary = output.voluntary.at(-1)!;
  const firstInvoluntary = output.involuntary[0]!;
  const lastInvoluntary = output.involuntary.at(-1)!;
  return {
    rows: [
      output.cpu.length,
      output.voluntary.length,
      output.involuntary.length,
    ],
    bounds: [
      firstCpu.startNs,
      lastCpu.endNs,
      firstVoluntary.startNs,
      lastVoluntary.endNs,
      firstInvoluntary.startNs,
      lastInvoluntary.endNs,
    ],
    cpuDeltaNs: output.cpu.reduce(
      (sum, interval) => sum + interval.cpuDeltaNs,
      0,
    ),
    cpuCores: [firstCpu.cores, lastCpu.cores],
    voluntaryDelta: output.voluntary.reduce(
      (sum, interval) => sum + interval.delta,
      0,
    ),
    voluntaryRate: [firstVoluntary.rate, lastVoluntary.rate],
    involuntaryDelta: output.involuntary.reduce(
      (sum, interval) => sum + interval.delta,
      0,
    ),
    involuntaryRate: [firstInvoluntary.rate, lastInvoluntary.rate],
  };
}

function summarizeWasm(bundle: ViewBundle): Summary {
  const cpu = bundle.tables["cpu_intervals"]!;
  const voluntary = bundle.tables["voluntary_context_switches"]!;
  const involuntary = bundle.tables["involuntary_context_switches"]!;
  const sum = (values: BigUint64Array): number => {
    let result = 0;
    for (const value of values) result += Number(value);
    return result;
  };
  const f64 = (table: typeof cpu, column: string): Float64Array =>
    table.columns[column] as Float64Array;
  return {
    rows: [cpu.length, voluntary.length, involuntary.length],
    bounds: [
      f64(cpu, "start_ns")[0]!,
      f64(cpu, "end_ns").at(-1)!,
      f64(voluntary, "start_ns")[0]!,
      f64(voluntary, "end_ns").at(-1)!,
      f64(involuntary, "start_ns")[0]!,
      f64(involuntary, "end_ns").at(-1)!,
    ],
    cpuDeltaNs: sum(cpu.columns["cpu_delta_ns"] as BigUint64Array),
    cpuCores: [
      f64(cpu, "cores")[0]!,
      f64(cpu, "cores").at(-1)!,
    ],
    voluntaryDelta: sum(voluntary.columns["delta"] as BigUint64Array),
    voluntaryRate: [
      f64(voluntary, "rate")[0]!,
      f64(voluntary, "rate").at(-1)!,
    ],
    involuntaryDelta: sum(involuntary.columns["delta"] as BigUint64Array),
    involuntaryRate: [
      f64(involuntary, "rate")[0]!,
      f64(involuntary, "rate").at(-1)!,
    ],
  };
}

let sink: unknown;

if (referenceTrace !== null) {
  const events = referenceTrace.customEvents as ResourceEvent[];
  const direct = deriveWithFor(events);
  const functional = deriveWithArrayMethods(events);
  const executionMetrics = { memoryBytes: 0, outputBytes: 0 };
  const wasm = await deriveEndToEndWasm(executionMetrics);
  const expected = summarizeJs(direct);
  if (
    JSON.stringify(summarizeJs(functional)) !== JSON.stringify(expected) ||
    JSON.stringify(summarizeWasm(wasm)) !== JSON.stringify(expected)
  ) {
    throw new Error("viewer-extension benchmark implementations disagree");
  }
  console.info(
    `viewer-extension benchmark: ${events.length.toLocaleString()} events, ` +
      `${(traceBytes!.byteLength / 1024 / 1024).toFixed(2)} MiB, ` +
      `${expected.rows[0].toLocaleString()} intervals/series, ` +
      `${(wasmBytes!.byteLength / 1024).toFixed(1)} KiB module, ` +
      `${(executionMetrics.outputBytes / 1024 / 1024).toFixed(2)} MiB output, ` +
      `${(executionMetrics.memoryBytes / 1024 / 1024).toFixed(2)} MiB peak linear memory`,
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

  bench("WASM precompiled: instantiate + D9TF + encode", async () => {
    sink = await executeWasm(false);
  }, options);

  bench("WASM precompiled + output copy/validation", async () => {
    sink = await deriveEndToEndWasm();
  }, options);
});
