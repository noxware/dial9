import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import {
  ExtensionStore,
  batchTransferables,
  type ColumnarBatch,
} from "./columnar.js";
import { loadExtensionModule } from "./module.js";

const RUN = process.env["DIAL9_RUN_VIEWER_EXTENSION_BENCHMARK"] === "1";
const DEFAULT_SAMPLES = 250_000;
const CHUNK_BYTES = 256 * 1024;
const REPOSITORY = resolve(process.cwd(), "../..");

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function configuredSamples(): number {
  const source =
    process.env["DIAL9_VIEWER_EXTENSION_BENCH_SAMPLES"] ??
    String(DEFAULT_SAMPLES);
  const samples = Number(source);
  if (!Number.isSafeInteger(samples) || samples < 2) {
    throw new Error(
      "DIAL9_VIEWER_EXTENSION_BENCH_SAMPLES must be an integer of at least 2",
    );
  }
  return samples;
}

function outputByteLength(batches: readonly ColumnarBatch[]): number {
  let bytes = 0;
  for (const batch of batches) {
    for (const buffer of batchTransferables(batch)) {
      bytes += buffer.byteLength;
    }
  }
  return bytes;
}

function milliseconds(start: number, end: number): number {
  return Number((end - start).toFixed(3));
}

describe.runIf(RUN)("viewer extension production-path benchmark", () => {
  let temporaryDirectory: string | undefined;

  afterAll(() => {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("measures a generated large D9TF trace without policy thresholds", async () => {
    const samples = configuredSamples();
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--no-deps", "--format-version", "1"],
        { cwd: REPOSITORY, encoding: "utf8" },
      ),
    ) as { target_directory: string };
    execFileSync(
      "cargo",
      [
        "build",
        "-p",
        "dial9-viewer-extension-demo",
        "--target",
        "wasm32-unknown-unknown",
        "--release",
      ],
      { cwd: REPOSITORY, stdio: "inherit" },
    );
    const wasmPath = join(
      metadata.target_directory,
      "wasm32-unknown-unknown",
      "release",
      "dial9_viewer_extension_demo.wasm",
    );
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), "dial9-viewer-extension-benchmark-"),
    );
    const tracePath = join(temporaryDirectory, "benchmark.trace");
    execFileSync(
      "cargo",
      [
        "run",
        "-p",
        "dial9-viewer-extension-demo",
        "--features",
        "trace-fixture",
        "--bin",
        "make_trace",
        "--",
        wasmPath,
        tracePath,
        String(samples),
      ],
      { cwd: REPOSITORY, stdio: "inherit" },
    );

    const wasm = readFileSync(wasmPath);
    const trace = readFileSync(tracePath);

    const loadStart = performance.now();
    const guest = await loadExtensionModule(arrayBuffer(wasm));
    const loadEnd = performance.now();
    const initialGuestMemory = guest.linearMemoryByteLength;

    const batches: ColumnarBatch[] = [];
    const processingStart = performance.now();
    for (let offset = 0; offset < trace.byteLength; offset += CHUNK_BYTES) {
      batches.push(
        ...guest.push(
          trace.subarray(
            offset,
            Math.min(trace.byteLength, offset + CHUNK_BYTES),
          ),
        ),
      );
    }
    batches.push(...guest.finish());
    const processingEnd = performance.now();
    const peakGuestMemory = guest.linearMemoryByteLength;
    const hostColumnBytes = outputByteLength(batches);

    const transferStart = performance.now();
    const received = batches.map((batch) =>
      structuredClone(batch, { transfer: batchTransferables(batch) }),
    );
    const transferEnd = performance.now();

    const store = new ExtensionStore(guest.manifest);
    const storeStart = performance.now();
    for (const batch of received) store.append(batch);
    const storeEnd = performance.now();

    const expectedCpuRows =
      samples - 1 - (samples > 30 ? 1 : 0);
    expect(store.table("cpu_intervals").rowCount).toBe(expectedCpuRows);
    expect(store.table("context_intervals").rowCount).toBe(samples - 1);
    expect(store.table("settings").rowCount).toBe(1);
    expect(store.table("dino_body").rowCount).toBe(23);
    expect(store.table("dino_flames").rowCount).toBe(6);

    const processingMs = processingEnd - processingStart;
    const result = {
      samples,
      trace_bytes: trace.byteLength,
      wasm_bytes: wasm.byteLength,
      chunk_bytes: CHUNK_BYTES,
      output_batches: received.length,
      output_rows: received.reduce((sum, batch) => sum + batch.rows, 0),
      module_compile_manifest_instantiate_ms: milliseconds(loadStart, loadEnd),
      decode_compute_guest_host_copy_ms: milliseconds(
        processingStart,
        processingEnd,
      ),
      transferable_clone_ms: milliseconds(transferStart, transferEnd),
      store_append_ms: milliseconds(storeStart, storeEnd),
      processing_events_per_second: Math.round(
        samples / (processingMs / 1_000),
      ),
      guest_linear_memory_initial_bytes: initialGuestMemory,
      guest_linear_memory_peak_bytes: peakGuestMemory,
      host_column_buffers_bytes: hostColumnBytes,
    };
    console.info(
      `VIEWER_EXTENSION_BENCHMARK ${JSON.stringify(result)}`,
    );
  }, 180_000);
});
