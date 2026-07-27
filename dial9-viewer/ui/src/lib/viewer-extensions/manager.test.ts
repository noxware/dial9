import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { ViewerExtensionManager } from "./manager.js";
import type {
  ExtensionWorkerPort,
  ExtensionWorkerRequest,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

const manifest = parseManifest(
  JSON.stringify({
    version: 1,
    tables: [{ name: "data", columns: [{ name: "value", type: "f64" }] }],
    panels: [],
  }),
);

class FakeWorker implements ExtensionWorkerPort {
  readonly requests: ExtensionWorkerRequest[] = [];
  terminated = false;
  #message: ((message: ExtensionWorkerResponse) => void) | null = null;
  #error: ((error: unknown) => void) | null = null;

  postMessage(message: ExtensionWorkerRequest): void {
    this.requests.push(message);
  }

  onMessage(callback: (message: ExtensionWorkerResponse) => void): void {
    this.#message = callback;
  }

  onError(callback: (error: unknown) => void): void {
    this.#error = callback;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: ExtensionWorkerResponse): void {
    this.#message!(message);
  }

  fail(error: unknown): void {
    this.#error!(error);
  }
}

describe("viewer extension manager", () => {
  it("keeps a pre-trace module pending and publishes tables only after complete", () => {
    const workers: FakeWorker[] = [];
    const manager = new ViewerExtensionManager({
      worker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const identity = manager.loadModule("cpu.wasm", new ArrayBuffer(8));
    expect(manager.snapshot().pending).toBe(1);
    expect(workers[0]!.requests.map((request) => request.kind)).toEqual(["start"]);

    manager.processTraceBuffer(new Uint8Array([1, 2, 3]).buffer, false);
    expect(workers[0]!.requests.map((request) => request.kind)).toEqual([
      "start",
      "input",
      "finish",
    ]);

    workers[0]!.emit({
      kind: "ready",
      id: identity.id,
      name: identity.name,
      manifest,
    });
    workers[0]!.emit({
      kind: "batch",
      batch: {
        table: 0,
        rows: 1,
        columns: [
          {
            type: "f64",
            values: new Float64Array([4.5]),
            validity: null,
            rows: 1,
          },
        ],
      },
    });
    expect(manager.snapshot().extensions).toHaveLength(0);

    workers[0]!.emit({ kind: "complete" });
    const loaded = manager.snapshot().extensions[0]!;
    expect(loaded.identity).toEqual(identity);
    expect(loaded.tables.table("data").value(0, "value")).toBe(4.5);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("scopes equal table names per instance", () => {
    const workers: FakeWorker[] = [];
    const manager = new ViewerExtensionManager({
      worker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = manager.loadModule("one.wasm", new ArrayBuffer(1));
    const second = manager.loadModule("two.wasm", new ArrayBuffer(1));
    manager.processTraceBuffer(new Uint8Array([1]).buffer, false);

    for (const [index, identity] of [first, second].entries()) {
      workers[index]!.emit({
        kind: "ready",
        id: identity.id,
        name: identity.name,
        manifest,
      });
      workers[index]!.emit({
        kind: "batch",
        batch: {
          table: 0,
          rows: 1,
          columns: [
            {
              type: "f64",
              values: new Float64Array([index + 1]),
              validity: null,
              rows: 1,
            },
          ],
        },
      });
      workers[index]!.emit({ kind: "complete" });
    }
    expect(
      manager
        .snapshot()
        .extensions.map((extension) => extension.tables.table("data").value(0, 0)),
    ).toEqual([1, 2]);
  });

  it("drops prior instances when a logical trace is replaced", () => {
    const worker = new FakeWorker();
    const manager = new ViewerExtensionManager({ worker: () => worker });
    manager.loadModule("one.wasm", new ArrayBuffer(1));
    manager.processTraceBuffer(new Uint8Array([1]).buffer, false);
    manager.beginTrace(true);
    expect(worker.terminated).toBe(true);
    expect(manager.snapshot()).toMatchObject({
      extensions: [],
      failures: [],
      pending: 0,
    });
  });
});
