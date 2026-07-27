import { describe, expect, it } from "vitest";
import type { ColumnarBatch } from "./columnar.js";
import {
  ExtensionCoordinator,
  type ExtensionRunResult,
} from "./coordinator.js";
import type { ExtensionManifest } from "./manifest.js";
import type {
  ExtensionWorkerPort,
  ExtensionWorkerRequest,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

const MANIFEST: ExtensionManifest = {
  version: 1,
  tables: [
    {
      name: "values",
      columns: [{ name: "value", type: "u32", nullable: false }],
    },
  ],
  panels: [],
};

const BATCH: ColumnarBatch = {
  table_id: 0,
  rows: 2,
  columns: [
    { type: "u32", values: new Uint32Array([10, 20]).buffer },
  ],
};

class FakeWorker implements ExtensionWorkerPort {
  readonly messages: ExtensionWorkerRequest[] = [];
  readonly transfers: Array<readonly ArrayBuffer[]> = [];
  terminated = false;
  throwOn: ExtensionWorkerRequest["kind"] | undefined;
  #message: ((message: ExtensionWorkerResponse) => void) | undefined;
  #error: ((error: unknown) => void) | undefined;

  postMessage(
    message: ExtensionWorkerRequest,
    transfer: readonly ArrayBuffer[] = [],
  ): void {
    if (message.kind === this.throwOn) {
      throw new Error(`post ${message.kind} failed`);
    }
    this.messages.push(message);
    this.transfers.push(transfer);
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

  respond(message: ExtensionWorkerResponse): void {
    this.#message?.(message);
  }

  crash(error: unknown): void {
    this.#error?.(error);
  }
}

function setup(count = 2): {
  coordinator: ExtensionCoordinator;
  workers: FakeWorker[];
  results: ExtensionRunResult[];
} {
  const workers: FakeWorker[] = [];
  const results: ExtensionRunResult[] = [];
  let nextId = 1;
  const coordinator = new ExtensionCoordinator(
    Array.from({ length: count }, (_, index) => ({
      fileName: `extension-${index}.wasm`,
      wasm: new Uint8Array([index]),
    })),
    {
      createInstanceId: () => `instance-${nextId++}`,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      onResult: (result) => results.push(result),
    },
  );
  return { coordinator, workers, results };
}

describe("ExtensionCoordinator", () => {
  it("fans input out without waiting and transfers independent buffers", () => {
    const { coordinator, workers } = setup();
    const chunk = new Uint8Array([1, 2, 3]);

    coordinator.feed(chunk);
    coordinator.feed(chunk.subarray(1));

    for (const worker of workers) {
      expect(worker.messages.map((message) => message.kind)).toEqual([
        "init",
        "push",
        "push",
      ]);
      expect(worker.transfers.every((transfer) => transfer.length === 1)).toBe(
        true,
      );
    }
    const first = workers[0]!.messages[1];
    const second = workers[1]!.messages[1];
    if (first?.kind !== "push" || second?.kind !== "push") {
      throw new Error("expected push messages");
    }
    expect(first.chunk).not.toBe(second.chunk);
    expect([...new Uint8Array(first.chunk)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(second.chunk)]).toEqual([1, 2, 3]);
  });

  it("publishes isolated stores only after each worker completes", async () => {
    const { coordinator, workers, results } = setup();
    for (let index = 0; index < workers.length; index += 1) {
      workers[index]!.respond({
        kind: "ready",
        instance_id: `instance-${index + 1}`,
        file_name: `extension-${index}.wasm`,
        manifest: MANIFEST,
      });
      workers[index]!.respond({ kind: "batch", batch: BATCH });
    }

    expect(results).toEqual([]);
    const finished = coordinator.finish();
    expect(coordinator.finish()).toBe(finished);
    workers[1]!.respond({ kind: "complete" });
    expect(results).toHaveLength(1);
    workers[0]!.respond({ kind: "complete" });

    const final = await finished;
    expect(final.map((result) => result.status)).toEqual([
      "complete",
      "complete",
    ]);
    const [first, second] = final;
    if (first?.status !== "complete" || second?.status !== "complete") return;
    expect(first.store).not.toBe(second.store);
    expect(first.store.table("values").cell("value", 1)).toBe(20);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("contains worker and host-validation failures to one extension", async () => {
    const { coordinator, workers } = setup();
    workers[0]!.crash(new Error("worker crashed"));
    workers[1]!.respond({
      kind: "ready",
      instance_id: "wrong-instance",
      file_name: "extension-1.wasm",
      manifest: MANIFEST,
    });

    const results = await coordinator.finish();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      status: "error",
      instanceId: "instance-1",
    });
    expect(results[1]).toMatchObject({
      status: "error",
      instanceId: "instance-2",
    });
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("contains synchronous postMessage failures and continues fan-out", async () => {
    const { coordinator, workers } = setup();
    workers[0]!.throwOn = "push";

    coordinator.feed(new Uint8Array([1]));
    workers[1]!.respond({
      kind: "ready",
      instance_id: "instance-2",
      file_name: "extension-1.wasm",
      manifest: MANIFEST,
    });
    const finished = coordinator.finish();
    workers[1]!.respond({ kind: "complete" });

    const results = await finished;
    expect(results[0]).toMatchObject({ status: "error" });
    expect(results[1]).toMatchObject({ status: "complete" });
    expect(workers[1]!.messages.map((message) => message.kind)).toEqual([
      "init",
      "push",
      "finish",
    ]);
  });

  it("aborts every unfinished worker and resolves immediately", async () => {
    const { coordinator, workers } = setup();
    coordinator.abort();

    const results = await coordinator.finish();
    expect(results.map((result) => result.status)).toEqual([
      "aborted",
      "aborted",
    ]);
    expect(
      workers.every(
        (worker) =>
          worker.messages.at(-1)?.kind === "abort" && worker.terminated,
      ),
    ).toBe(true);
    expect(() => coordinator.feed(new Uint8Array())).toThrow(
      "after finish",
    );
  });

  it("completes an empty run without creating a worker", async () => {
    const { coordinator, workers } = setup(0);
    expect(await coordinator.finish()).toEqual([]);
    expect(workers).toEqual([]);
  });
});
