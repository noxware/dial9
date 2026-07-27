import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProcessCpuUsageSeries } from "../trace/analysis.js";
import {
  normalizeTraceBuffer,
  parseTraceBuffer,
} from "../trace/load.js";
import { ExtensionStore } from "./columnar.js";
import { loadExtensionModule } from "./module.js";

const wasmPath = process.env["DIAL9_EXTENSION_WASM"];
const hasCompiledExtension =
  wasmPath !== undefined && existsSync(wasmPath);

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

describe.skipIf(!hasCompiledExtension)(
  "compiled reference viewer extension",
  () => {
    it("matches every legacy CPU interval in the demo trace", async () => {
      const storedBytes = Uint8Array.from(
        readFileSync(
          fileURLToPath(
            new URL("../../../public/demo-trace.bin", import.meta.url),
          ),
        ),
      );
      const normalized = await normalizeTraceBuffer(storedBytes);
      const traceBytes = Uint8Array.from(
        normalized instanceof Uint8Array
          ? normalized
          : new Uint8Array(normalized),
      );
      const trace = await parseTraceBuffer(exactBuffer(traceBytes));
      const capacity =
        trace.segmentMetadata?.get("process.available_parallelism") ?? null;
      const expected = buildProcessCpuUsageSeries(
        trace.customEvents,
        capacity,
      );

      const guest = await loadExtensionModule(
        Uint8Array.from(readFileSync(wasmPath!)),
      );
      const store = new ExtensionStore(guest.manifest);
      const chunkBytes = 256 * 1024;
      for (
        let offset = 0;
        offset < traceBytes.byteLength;
        offset += chunkBytes
      ) {
        const batches = guest.push(
          traceBytes.subarray(
            offset,
            Math.min(traceBytes.byteLength, offset + chunkBytes),
          ),
        );
        for (const batch of batches) store.append(batch);
      }
      for (const batch of guest.finish()) store.append(batch);

      const actual = store.table("cpu_intervals");
      expect(actual.rowCount).toBe(expected.intervals.length);
      for (const [row, interval] of expected.intervals.entries()) {
        expect(actual.cell("start_ns", row)).toBe(BigInt(interval.start));
        expect(actual.cell("end_ns", row)).toBe(BigInt(interval.end));
        expect(actual.cell("window_ns", row)).toBe(
          BigInt(interval.wallDeltaNs),
        );
        expect(actual.cell("cpu_ns", row)).toBe(
          BigInt(interval.cpuDeltaNs),
        );
        expect(actual.cell("cores", row)).toBeCloseTo(interval.cores, 12);
        expect(actual.cell("percent", row)).toBeCloseTo(
          interval.totalPercent!,
          12,
        );
      }

      expect(store.table("settings").cell("capacity", 0)).toBe(
        expected.availableParallelism,
      );
    });
  },
);
