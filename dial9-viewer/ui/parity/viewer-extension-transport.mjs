// Browser transport benchmark for viewer extensions.
//
// The compute benchmark measures copies across the JS/WebAssembly boundary.
// This probe measures the remaining browser topology with a real
// DedicatedWorker:
//
//   main fanout copy + main-to-Worker transferable + acknowledgement
//   Worker-to-main transferable + ExtensionStore.append
//
// Output buffer sizes and message grouping are captured from the compiled
// extension for each input profile before its timed run. Setup, WASM execution,
// and allocation of transferable output buffers are deliberately outside the
// measured windows.

import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { createServer } from "vite";

const PROFILES = Object.freeze([
  { label: "streaming (~16 KiB)", chunkBytes: 16 * 1024 },
  { label: "buffered/replay (256 KiB)", chunkBytes: 256 * 1024 },
]);
const RUNS = 3;
const PAGE_PATH = "/__viewer-extension-transport";
const WASM_PATH = "/__viewer-extension-transport/extension.wasm";

function configuredFile(name, required) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw new Error(`${name} does not exist: ${resolved}`);
  }
  return resolved;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[sorted.length >>> 1];
}

function ms(value) {
  return `${value.toFixed(2)} ms`;
}

function mib(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function kib(value) {
  return `${(value / 1024).toFixed(0)} KiB`;
}

function rate(bytes, elapsedMs) {
  return `${(bytes / 1024 / 1024 / (elapsedMs / 1_000)).toFixed(2)} MiB/s`;
}

function fixturePlugin(files) {
  const routes = new Map([
    [WASM_PATH, files.wasm],
    ...files.traces.map((trace) => [trace.url, trace.file]),
  ]);
  return {
    name: "dial9:viewer-extension-transport-fixtures",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === PAGE_PATH) {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            "<!doctype html><meta charset=utf-8><title>viewer extension transport benchmark</title>",
          );
          return;
        }
        const file = routes.get(pathname);
        if (file === undefined) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", String(statSync(file).size));
        response.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(response);
      });
    },
  };
}

async function runInPage(page, traceUrl, chunkBytes) {
  return page.evaluate(
    async ({ chunkBytes, traceUrl: inputUrl, wasmUrl }) => {
      const [
        { loadExtensionModule },
        { ExtensionStore, batchTransferables },
      ] = await Promise.all([
        import("/src/lib/viewer-extension/module.ts"),
        import("/src/lib/viewer-extension/columnar.ts"),
      ]);
      const [wasmResponse, traceResponse] = await Promise.all([
        fetch(wasmUrl),
        fetch(inputUrl),
      ]);
      if (!wasmResponse.ok || !traceResponse.ok) {
        throw new Error(
          `fixture fetch failed: wasm=${wasmResponse.status}, trace=${traceResponse.status}`,
        );
      }
      const wasm = new Uint8Array(await wasmResponse.arrayBuffer());
      const trace = new Uint8Array(await traceResponse.arrayBuffer());

      const shapeOf = (batch) => ({
        table_id: batch.table_id,
        rows: batch.rows,
        columns: batch.columns.map((column) =>
          column.type === "utf8"
            ? {
                type: column.type,
                bytes: column.bytes.byteLength,
                offsets: column.offsets.byteLength,
                validity: column.validity?.byteLength ?? null,
              }
            : {
                type: column.type,
                values: column.values.byteLength,
                validity: column.validity?.byteLength ?? null,
              },
        ),
      });
      const shapeBytes = (shape) =>
        shape.columns.reduce(
          (total, column) =>
            total +
            ("values" in column ? column.values : column.bytes + column.offsets) +
            (column.validity ?? 0),
          0,
        );
      const shapeBuffers = (shape) =>
        shape.columns.reduce(
          (total, column) =>
            total +
            ("values" in column ? 1 : 2) +
            (column.validity === null ? 0 : 1),
          0,
        );

      // Capture production batch grouping and buffer sizes. The resulting
      // buffers are not retained and this work is outside every timed phase.
      const guest = await loadExtensionModule(wasm);
      const shapes = [];
      for (let offset = 0; offset < trace.byteLength; offset += chunkBytes) {
        const end = Math.min(trace.byteLength, offset + chunkBytes);
        for (const batch of guest.push(trace.subarray(offset, end))) {
          shapes.push(shapeOf(batch));
        }
      }
      for (const batch of guest.finish()) shapes.push(shapeOf(batch));

      const expectedOutputBytes = shapes.reduce(
        (total, shape) => total + shapeBytes(shape),
        0,
      );
      const expectedOutputBuffers = shapes.reduce(
        (total, shape) => total + shapeBuffers(shape),
        0,
      );
      const expectedRows = guest.manifest.tables.map((_, tableId) =>
        shapes
          .filter((shape) => shape.table_id === tableId)
          .reduce((total, shape) => total + shape.rows, 0),
      );

      const workerSource = `
        let output = [];

        function makeColumn(column) {
          const validity =
            column.validity === null
              ? {}
              : { validity: new ArrayBuffer(column.validity) };
          return "values" in column
            ? {
                type: column.type,
                values: new ArrayBuffer(column.values),
                ...validity,
              }
            : {
                type: "utf8",
                bytes: new ArrayBuffer(column.bytes),
                offsets: new ArrayBuffer(column.offsets),
                ...validity,
              };
        }

        function transferables(batch) {
          const result = [];
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

        self.onmessage = (event) => {
          const message = event.data;
          if (message.kind === "input") {
            self.__inputBytes = (self.__inputBytes ?? 0) + message.buffer.byteLength;
            self.__inputMessages = (self.__inputMessages ?? 0) + 1;
          } else if (message.kind === "input-end") {
            self.postMessage({
              kind: "input-done",
              bytes: self.__inputBytes ?? 0,
              messages: self.__inputMessages ?? 0,
            });
            self.__inputBytes = 0;
            self.__inputMessages = 0;
          } else if (message.kind === "prepare-output") {
            output = message.shapes.map((shape) => ({
              table_id: shape.table_id,
              rows: shape.rows,
              columns: shape.columns.map(makeColumn),
            }));
            self.postMessage({ kind: "output-ready" });
          } else if (message.kind === "start-output") {
            for (const batch of output) {
              self.postMessage(
                { kind: "output-batch", batch },
                transferables(batch),
              );
            }
            output = [];
            self.postMessage({ kind: "output-done" });
          } else if (message.kind === "ping") {
            self.postMessage({ kind: "ready" });
          }
        };
      `;
      const workerUrl = URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" }),
      );
      const worker = new Worker(workerUrl);
      const nextMessage = (kind) =>
        new Promise((resolve, reject) => {
          const onMessage = (event) => {
            if (event.data?.kind !== kind) return;
            cleanup();
            resolve(event.data);
          };
          const onError = (event) => {
            cleanup();
            reject(event.error ?? new Error(event.message));
          };
          const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
        });

      try {
        const ready = nextMessage("ready");
        worker.postMessage({ kind: "ping" });
        await ready;

        // Exact production fanout: allocate and copy one module-owned chunk,
        // transfer it immediately, then await the final Worker acknowledgement.
        const fanoutDone = nextMessage("input-done");
        const fanoutStart = performance.now();
        for (let offset = 0; offset < trace.byteLength; offset += chunkBytes) {
          const end = Math.min(trace.byteLength, offset + chunkBytes);
          const copy = new Uint8Array(end - offset);
          copy.set(trace.subarray(offset, end));
          worker.postMessage(
            { kind: "input", buffer: copy.buffer },
            [copy.buffer],
          );
        }
        worker.postMessage({ kind: "input-end" });
        const fanoutResult = await fanoutDone;
        const fanoutCopyTransferAckMs = performance.now() - fanoutStart;

        // Control: buffers are prepared outside timing, so this measures only
        // transferable enqueue, delivery, and the final acknowledgement.
        const chunks = [];
        for (let offset = 0; offset < trace.byteLength; offset += chunkBytes) {
          const end = Math.min(trace.byteLength, offset + chunkBytes);
          const copy = new Uint8Array(end - offset);
          copy.set(trace.subarray(offset, end));
          chunks.push(copy.buffer);
        }
        const preparedDone = nextMessage("input-done");
        const preparedStart = performance.now();
        for (const buffer of chunks) {
          worker.postMessage({ kind: "input", buffer }, [buffer]);
        }
        worker.postMessage({ kind: "input-end" });
        const preparedResult = await preparedDone;
        const preparedTransferAckMs = performance.now() - preparedStart;

        // Allocation is explicitly outside the output transport window.
        const outputReady = nextMessage("output-ready");
        worker.postMessage({ kind: "prepare-output", shapes });
        await outputReady;

        const store = new ExtensionStore(guest.manifest);
        let outputBytes = 0;
        let outputBuffers = 0;
        let outputBatches = 0;
        const outputDone = new Promise((resolve, reject) => {
          const onMessage = (event) => {
            const message = event.data;
            if (message?.kind === "output-batch") {
              store.append(message.batch);
              outputBatches += 1;
              const buffers = batchTransferables(message.batch);
              outputBytes += buffers.reduce(
                (total, buffer) => total + buffer.byteLength,
                0,
              );
              outputBuffers += buffers.length;
            } else if (message?.kind === "output-done") {
              cleanup();
              resolve();
            }
          };
          const onError = (event) => {
            cleanup();
            reject(event.error ?? new Error(event.message));
          };
          const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
        });
        const outputStart = performance.now();
        worker.postMessage({ kind: "start-output" });
        await outputDone;
        const outputTransferStoreMs = performance.now() - outputStart;

        const actualRows = guest.manifest.tables.map(
          (table) => store.table(table.name).rowCount,
        );
        const expectedInputMessages = Math.ceil(
          trace.byteLength / chunkBytes,
        );
        if (
          fanoutResult.bytes !== trace.byteLength ||
          fanoutResult.messages !== expectedInputMessages ||
          preparedResult.bytes !== trace.byteLength ||
          preparedResult.messages !== expectedInputMessages ||
          outputBytes !== expectedOutputBytes ||
          outputBuffers !== expectedOutputBuffers ||
          outputBatches !== shapes.length ||
          actualRows.some((rows, index) => rows !== expectedRows[index])
        ) {
          throw new Error(
            "transport probe byte, message, or row accounting mismatch",
          );
        }

        return {
          inputBytes: trace.byteLength,
          inputMessages: fanoutResult.messages,
          chunkBytes,
          outputBytes,
          outputBuffers,
          outputBatches,
          fanoutCopyTransferAckMs,
          preparedTransferAckMs,
          outputTransferStoreMs,
        };
      } finally {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      }
    },
    { chunkBytes, traceUrl, wasmUrl: WASM_PATH },
  );
}

function assertComparable(samples) {
  const first = samples[0];
  for (const sample of samples.slice(1)) {
    for (const key of [
      "inputBytes",
      "inputMessages",
      "chunkBytes",
      "outputBytes",
      "outputBuffers",
      "outputBatches",
    ]) {
      if (sample[key] !== first[key]) {
        throw new Error(`transport samples disagree on ${key}`);
      }
    }
  }
}

function report(traceLabel, profileLabel, samples) {
  assertComparable(samples);
  const first = samples[0];
  const fanoutMs = median(
    samples.map((sample) => sample.fanoutCopyTransferAckMs),
  );
  const preparedMs = median(
    samples.map((sample) => sample.preparedTransferAckMs),
  );
  const outputMs = median(
    samples.map((sample) => sample.outputTransferStoreMs),
  );
  console.info(
    [
      `viewer-extension browser transport [${traceLabel}; ${profileLabel}]`,
      `  input: ${mib(first.inputBytes)}, ${first.inputMessages} messages at ${kib(first.chunkBytes)}`,
      `  output: ${mib(first.outputBytes)}, ${first.outputBatches} batches, ${first.outputBuffers} transferable buffers`,
      `  median (${RUNS} fresh pages): production fanout copy + transfer + ack ${ms(fanoutMs)} (${rate(first.inputBytes, fanoutMs)})`,
      `  median (${RUNS} fresh pages): prepared transfer + ack control ${ms(preparedMs)} (${rate(first.inputBytes, preparedMs)})`,
      `  median (${RUNS} fresh pages): Worker -> main transfer + store ${ms(outputMs)} (${rate(first.outputBytes, outputMs)})`,
      "  WASM execution, ABI copies, and output allocation are excluded",
    ].join("\n"),
  );
}

async function main() {
  const wasm = configuredFile("DIAL9_EXTENSION_WASM", true);
  const trace250k = configuredFile("DIAL9_EXTENSION_TRACE_250K", true);
  const traceLarge = configuredFile("DIAL9_EXTENSION_TRACE_LARGE", false);
  const traces = [
    {
      label: "250k",
      file: trace250k,
      url: "/__viewer-extension-transport/250k.bin",
    },
    ...(traceLarge === null
      ? []
      : [{
          label: "large",
          file: traceLarge,
          url: "/__viewer-extension-transport/large.bin",
        }]),
  ];
  const server = await createServer({
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [fixturePlugin({ wasm, traces })],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    await server.close();
    throw new Error("Vite did not expose a TCP benchmark address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch();
    for (const trace of traces) {
      for (const profile of PROFILES) {
        const samples = [];
        for (let run = 0; run < RUNS; run += 1) {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto(`${origin}${PAGE_PATH}`);
            samples.push(
              await runInPage(page, trace.url, profile.chunkBytes),
            );
          } finally {
            await context.close();
          }
        }
        report(trace.label, profile.label, samples);
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
