import { describe, expect, it } from "vitest";
import {
  ExtensionCoordinator,
  type ExtensionLoadResult,
} from "./coordinator.js";
import type { ColumnarBatch } from "./columnar.js";
import type { ExtensionManifest } from "./manifest.js";
import type {
  ExtensionWorkerPort,
  ExtensionWorkerRequest,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

function embedded(name: string, data: readonly number[]): number[] {
  const encoded = [...new TextEncoder().encode(name)];
  return [
    7,
    encoded.length & 0xff,
    encoded.length >>> 8,
    data.length & 0xff,
    (data.length >>> 8) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 24) & 0xff,
    ...encoded,
    ...data,
  ];
}

function trace(files: readonly (readonly [string, readonly number[]])[]) {
  return new Uint8Array([
    0x54, 0x52, 0x43, 0, 2,
    ...files.flatMap(([name, data]) => embedded(name, data)),
    5, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

const MANIFEST: ExtensionManifest = {
  version: 1,
  tables: [
    {
      name: "values",
      columns: [{ name: "value", type: "u8", nullable: false }],
    },
  ],
  panels: [],
};

function batch(value: number): ColumnarBatch {
  return {
    table_id: 0,
    rows: 1,
    columns: [
      { type: "u8", values: new Uint8Array([value]).buffer },
    ],
  };
}

class FakePort implements ExtensionWorkerPort {
  readonly requests: ExtensionWorkerRequest[] = [];
  readonly transfers: (readonly ArrayBuffer[] | undefined)[] = [];
  terminated = false;
  #onMessage: ((message: ExtensionWorkerResponse) => void) | undefined;
  #onError: ((error: unknown) => void) | undefined;

  postMessage(
    message: ExtensionWorkerRequest,
    transfer?: readonly ArrayBuffer[],
  ): void {
    this.requests.push(message);
    this.transfers.push(transfer);
  }

  onMessage(callback: (message: ExtensionWorkerResponse) => void): void {
    this.#onMessage = callback;
  }

  onError(callback: (error: unknown) => void): void {
    this.#onError = callback;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: ExtensionWorkerResponse): void {
    this.#onMessage?.(message);
  }

  crash(error: unknown): void {
    this.#onError?.(error);
  }
}

function ready(port: FakePort, manifest = MANIFEST): void {
  const init = port.requests[0];
  if (init?.kind !== "init") throw new Error("test invariant");
  port.emit({
    kind: "ready",
    instance_id: init.instance_id,
    file_name: init.file_name,
    manifest,
  });
}

describe("extension stream coordinator", () => {
  it("starts at preamble close, replays the prefix, and never waits to fan out", async () => {
    const ports: FakePort[] = [];
    const source = trace([
      ["cpu.wasm", [1, 2, 3]],
      ["readme.txt", [4]],
    ]);
    const cut = 12;
    const coordinator = new ExtensionCoordinator({
      workerFactory: () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
    });

    coordinator.feed(source.subarray(0, cut));
    expect(ports).toHaveLength(0);
    coordinator.feed(source.subarray(cut));
    expect(ports).toHaveLength(1);
    const port = ports[0]!;
    expect(port.requests.map((request) => request.kind)).toEqual([
      "init",
      "push",
      "push",
    ]);
    expect(port.transfers.every((transfer) => transfer?.length === 1)).toBe(
      true,
    );
    const init = port.requests[0]!;
    expect(init.kind).toBe("init");
    if (init.kind !== "init") throw new Error("test invariant");
    expect([...new Uint8Array(init.wasm)]).toEqual([1, 2, 3]);

    coordinator.feed(new Uint8Array([9, 10]));
    expect(port.requests.at(-1)?.kind).toBe("push");
    ready(port);
    port.emit({ kind: "batch", batch: batch(7) });
    const done = coordinator.finish();
    expect(port.requests.at(-1)).toEqual({ kind: "finish" });
    port.emit({ kind: "complete" });

    const results = await done;
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("test invariant");
    expect(result.store.table("values").cell("value", 0)).toBe(7);
    expect(port.terminated).toBe(true);
  });

  it("keeps duplicate table names and failures isolated by instance", async () => {
    const ports: FakePort[] = [];
    const coordinator = new ExtensionCoordinator({
      workerFactory: () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
    });
    coordinator.feed(
      trace([
        ["first.wasm", [1]],
        ["second.WASM", [2]],
      ]),
    );
    expect(ports).toHaveLength(2);
    ready(ports[0]!);
    ready(ports[1]!);
    ports[0]!.emit({ kind: "batch", batch: batch(11) });
    ports[1]!.emit({
      kind: "error",
      name: "RuntimeError",
      message: "trap",
    });

    const done = coordinator.finish();
    ports[0]!.emit({ kind: "complete" });
    const results = await done;
    expect(results.map((result) => result.status)).toEqual([
      "complete",
      "error",
    ]);
    expect(
      (results[0] as Extract<ExtensionLoadResult, { status: "complete" }>).store
        .table("values")
        .cell("value", 0),
    ).toBe(11);
    expect(ports[1]!.terminated).toBe(true);
  });

  it("starts explicit local modules immediately and can skip discovery", async () => {
    const port = new FakePort();
    const coordinator = new ExtensionCoordinator({
      workerFactory: () => port,
      discoverEmbedded: false,
      modules: [{ name: "dropped.wasm", data: new Uint8Array([4, 5]) }],
    });
    expect(port.requests[0]?.kind).toBe("init");
    coordinator.feed(new Uint8Array([1, 2, 3]));
    expect(port.requests[1]?.kind).toBe("push");
    ready(port);
    const done = coordinator.finish();
    port.emit({ kind: "complete" });
    expect((await done)[0]?.status).toBe("complete");
  });

  it("discards partial stores when one Worker crashes", async () => {
    const port = new FakePort();
    const coordinator = new ExtensionCoordinator({
      workerFactory: () => port,
      modules: [{ name: "local.wasm", data: new Uint8Array([1]) }],
      discoverEmbedded: false,
    });
    ready(port);
    port.emit({ kind: "batch", batch: batch(99) });
    port.crash(new Error("worker crashed"));
    const results = await coordinator.finish();
    expect(results).toEqual([
      expect.objectContaining({
        status: "error",
        error: "worker crashed",
      }),
    ]);
  });

  it("aborts every active Worker without publishing", () => {
    const port = new FakePort();
    const coordinator = new ExtensionCoordinator({
      workerFactory: () => port,
      modules: [{ name: "local.wasm", data: new Uint8Array([1]) }],
      discoverEmbedded: false,
    });
    coordinator.abort();
    expect(port.requests.at(-1)).toEqual({ kind: "abort" });
    expect(port.terminated).toBe(true);
    expect(coordinator.instances[0]?.status).toBe("aborted");
    expect(() => coordinator.feed(new Uint8Array())).toThrow(
      "cannot receive more input",
    );
  });
});
