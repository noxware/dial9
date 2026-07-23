import { describe, expect, it, vi } from "vitest";
import { runLocalViewerExtensions } from "./local.js";
import type {
  ViewerExtensionWorkerPort,
  ViewerExtensionWorkerRequest,
  ViewerExtensionWorkerResponse,
} from "./protocol.js";

interface FakeWorker {
  readonly port: ViewerExtensionWorkerPort;
  readonly requests: ViewerExtensionWorkerRequest[];
  readonly transfers: readonly ArrayBuffer[][];
  readonly chunkLengths: number[];
  terminated: boolean;
}

function fakeWorker(output = new ArrayBuffer(0)): FakeWorker {
  let onMessage: (message: ViewerExtensionWorkerResponse) => void = () => {};
  const requests: ViewerExtensionWorkerRequest[] = [];
  const transfers: readonly ArrayBuffer[][] = [];
  const chunkLengths: number[] = [];
  const worker: FakeWorker = {
    requests,
    transfers,
    chunkLengths,
    terminated: false,
    port: {
      postMessage(message, transfer = []): void {
        requests.push(message);
        transfers.push([...transfer]);
        queueMicrotask(() => {
          if (message.kind === "start-local") {
            onMessage({ kind: "initializing" });
            onMessage({
              kind: "ready",
              extensions: message.modules.map(({ name }) => name),
              warnings: [],
            });
          } else if (message.kind === "local-chunk") {
            chunkLengths.push(message.byteLength);
            onMessage({ kind: "executing" });
            onMessage({ kind: "guest-ready" });
          } else if (message.kind === "local-finish") {
            onMessage({ kind: "finishing" });
            onMessage({
              kind: "done",
              outputs: [{ name: "demo", buffer: output }],
              warnings: [],
            });
          }
        });
      },
      onMessage(fn): void {
        onMessage = fn;
      },
      onError(): void {},
      terminate(): void {
        worker.terminated = true;
      },
    },
  };
  return worker;
}

describe("local viewer-extension runner", () => {
  it("streams a retained trace through one transferred 1 MiB chunk at a time", async () => {
    const trace = new ArrayBuffer(2 * 1024 * 1024 + 17);
    const bytes = new Uint8Array(trace);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;
    const module = Uint8Array.of(0, 0x61, 0x73, 0x6d).buffer;
    const fake = fakeWorker(Uint8Array.of(1, 2, 3).buffer);

    const run = runLocalViewerExtensions(
      trace,
      [{ name: "demo", buffer: module }],
      { worker: () => fake.port },
    );
    const result = await run.done;

    expect(fake.chunkLengths).toEqual([1024 * 1024, 1024 * 1024, 17]);
    expect(fake.transfers.filter((items) => items.length === 1)).toHaveLength(4);
    expect(bytes[0]).toBe(7);
    expect(bytes[bytes.length - 1]).toBe(9);
    expect(result).toMatchObject({
      extensionNames: ["demo"],
      outputs: [{ name: "demo" }],
      warnings: [],
    });
    expect(fake.terminated).toBe(true);
  });

  it("terminates a guest that does not acknowledge a chunk", async () => {
    vi.useFakeTimers();
    try {
      let onMessage: (message: ViewerExtensionWorkerResponse) => void = () => {};
      let terminated = false;
      const port: ViewerExtensionWorkerPort = {
        postMessage(message): void {
          if (message.kind === "start-local") {
            queueMicrotask(() => {
              onMessage({ kind: "initializing" });
              onMessage({
                kind: "ready",
                extensions: ["demo"],
                warnings: [],
              });
            });
          }
        },
        onMessage(fn): void {
          onMessage = fn;
        },
        onError(): void {},
        terminate(): void {
          terminated = true;
        },
      };
      const run = runLocalViewerExtensions(
        new ArrayBuffer(1),
        [{ name: "demo", buffer: new ArrayBuffer(8) }],
        { worker: () => port, chunkTimeoutMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(11);

      await expect(run.done).rejects.toThrow("chunk execution timed out");
      expect(terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not copy an embedded extension preamble into a dropped guest", async () => {
    const name = new TextEncoder().encode("embedded");
    const embedded = new Uint8Array(200_000);
    const tail = Uint8Array.of(0x05, 1, 0, 0, 0, 0, 0, 0, 0);
    const trace = new Uint8Array(5 + 7 + name.length + embedded.length + tail.length);
    trace.set([0x54, 0x52, 0x43, 0, 1]);
    const view = new DataView(trace.buffer);
    let offset = 5;
    view.setUint8(offset, 0x07);
    view.setUint16(offset + 1, name.length, true);
    view.setUint32(offset + 3, embedded.length, true);
    offset += 7;
    trace.set(name, offset);
    offset += name.length;
    trace.set(embedded, offset);
    offset += embedded.length;
    trace.set(tail, offset);
    const fake = fakeWorker();

    const run = runLocalViewerExtensions(
      trace.buffer,
      [{ name: "local", buffer: new ArrayBuffer(8) }],
      { worker: () => fake.port },
    );
    await run.done;

    expect(fake.chunkLengths).toEqual([5, tail.length]);
  });
});
