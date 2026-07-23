import { describe, expect, it } from "vitest";
import { createViewerExtensionWorkerBody } from "./body.js";
import type {
  ViewerExtensionWorkerFactory,
  ViewerExtensionWorkerPort,
  ViewerExtensionWorkerResponse,
} from "./protocol.js";
import {
  ViewerExtensionWorkerError,
  createViewerExtensionByteSource,
} from "./source.js";

function inProcessWorker(chunks: readonly Uint8Array[]): {
  readonly factory: ViewerExtensionWorkerFactory;
  terminated(): boolean;
} {
  let terminated = false;
  let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
  const body = createViewerExtensionWorkerBody(
    (message) => queueMicrotask(() => receive(message)),
    {
      async openStream() {
        let index = 0;
        return {
          async next() {
            const value = chunks[index++];
            return value === undefined
              ? { done: true, value: undefined }
              : { done: false, value };
          },
        };
      },
    },
  );
  const port: ViewerExtensionWorkerPort = {
    postMessage(message): void {
      queueMicrotask(() => body.handle(message));
    },
    onMessage(fn): void {
      receive = fn;
    },
    onError(): void {},
    terminate(): void {
      terminated = true;
    },
  };
  return {
    factory: () => port,
    terminated: () => terminated,
  };
}

describe("viewer-extension pull source", () => {
  it("applies one-chunk backpressure and resolves extension metadata at EOF", async () => {
    const traceChunks = [
      Uint8Array.of(0x54, 0x52, 0x43, 0, 1),
      Uint8Array.of(0x05, 0, 0, 0),
    ];
    const worker = inProcessWorker(traceChunks);
    const source = createViewerExtensionByteSource(["/trace"], {
      worker: worker.factory,
    });
    const received: number[][] = [];
    for await (const chunk of source.chunks) received.push([...chunk]);

    expect(received).toEqual(traceChunks.map((chunk) => [...chunk]));
    expect(await source.result).toEqual({
      extensionNames: [],
      outputs: [],
      warnings: [],
    });
    expect(worker.terminated()).toBe(true);
  });

  it("terminates a worker that stalls during guest initialization", async () => {
    let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
    let terminated = false;
    const source = createViewerExtensionByteSource(["/trace"], {
      initializeTimeoutMs: 10,
      worker: () => ({
        postMessage(message): void {
          if (message.kind === "start") {
            queueMicrotask(() => receive({ kind: "initializing" }));
          }
        },
        onMessage(fn): void {
          receive = fn;
        },
        onError(): void {},
        terminate(): void {
          terminated = true;
        },
      }),
    });

    await expect(async () => {
      for await (const _chunk of source.chunks) {
        // No chunks are expected.
      }
    }).rejects.toBeInstanceOf(ViewerExtensionWorkerError);
    await expect(source.result).rejects.toThrow(/initialization timed out/);
    expect(terminated).toBe(true);
  });

  it("terminates a worker that stalls inside a guest chunk call", async () => {
    let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
    let terminated = false;
    const source = createViewerExtensionByteSource(["/trace"], {
      chunkTimeoutMs: 10,
      worker: () => ({
        postMessage(message): void {
          if (message.kind === "start") {
            queueMicrotask(() =>
              receive({ kind: "ready", extensions: [], warnings: [] }),
            );
          } else {
            queueMicrotask(() => receive({ kind: "executing" }));
          }
        },
        onMessage(fn): void {
          receive = fn;
        },
        onError(): void {},
        terminate(): void {
          terminated = true;
        },
      }),
    });

    await expect(async () => {
      for await (const _chunk of source.chunks) {
        // No chunks are expected.
      }
    }).rejects.toThrow(/chunk execution timed out/);
    await expect(source.result).rejects.toThrow(/chunk execution timed out/);
    expect(terminated).toBe(true);
  });

  it("fails after an already-delivered chunk when its guest call stalls", async () => {
    let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
    let terminated = false;
    let pulls = 0;
    const source = createViewerExtensionByteSource(["/trace"], {
      chunkTimeoutMs: 10,
      worker: () => ({
        postMessage(message): void {
          if (message.kind === "start") {
            queueMicrotask(() =>
              receive({ kind: "ready", extensions: ["guest"], warnings: [] }),
            );
          } else if (pulls++ === 0) {
            queueMicrotask(() => {
              const bytes = Uint8Array.of(1, 2, 3);
              receive({ kind: "executing" });
              receive({
                kind: "chunk",
                buffer: bytes.buffer,
                byteOffset: 0,
                byteLength: bytes.byteLength,
              });
            });
          }
        },
        onMessage(fn): void {
          receive = fn;
        },
        onError(): void {},
        terminate(): void {
          terminated = true;
        },
      }),
    });
    const chunks: number[][] = [];

    await expect(async () => {
      for await (const chunk of source.chunks) {
        chunks.push([...chunk]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }).rejects.toThrow(/chunk execution timed out/);
    await expect(source.result).rejects.toThrow(/chunk execution timed out/);
    expect(chunks).toEqual([[1, 2, 3]]);
    expect(terminated).toBe(true);
  });

  it("does not charge source I/O time to the guest execution deadline", async () => {
    let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
    let pull = 0;
    const source = createViewerExtensionByteSource(["/trace"], {
      chunkTimeoutMs: 5,
      worker: () => ({
        postMessage(message): void {
          if (message.kind === "start") {
            queueMicrotask(() =>
              receive({ kind: "ready", extensions: [], warnings: [] }),
            );
          } else if (pull++ === 0) {
            setTimeout(() => {
              const bytes = Uint8Array.of(1, 2, 3);
              receive({
                kind: "chunk",
                buffer: bytes.buffer,
                byteOffset: 0,
                byteLength: bytes.byteLength,
              });
            }, 20);
          } else {
            queueMicrotask(() => {
              receive({ kind: "finishing" });
              receive({ kind: "done", outputs: [], warnings: [] });
            });
          }
        },
        onMessage(fn): void {
          receive = fn;
        },
        onError(): void {},
        terminate(): void {},
      }),
    });

    const chunks: number[][] = [];
    for await (const chunk of source.chunks) chunks.push([...chunk]);
    expect(chunks).toEqual([[1, 2, 3]]);
  });

  it("uses the finish deadline after the worker reaches EOF", async () => {
    let receive: (message: ViewerExtensionWorkerResponse) => void = () => {};
    let terminated = false;
    const source = createViewerExtensionByteSource(["/trace"], {
      chunkTimeoutMs: 100,
      finishTimeoutMs: 10,
      worker: () => ({
        postMessage(message): void {
          if (message.kind === "start") {
            queueMicrotask(() =>
              receive({ kind: "ready", extensions: [], warnings: [] }),
            );
          } else {
            queueMicrotask(() => receive({ kind: "finishing" }));
          }
        },
        onMessage(fn): void {
          receive = fn;
        },
        onError(): void {},
        terminate(): void {
          terminated = true;
        },
      }),
    });

    await expect(async () => {
      for await (const _chunk of source.chunks) {
        // No chunks are expected.
      }
    }).rejects.toThrow(/finish timed out/);
    await expect(source.result).rejects.toThrow(/finish timed out/);
    expect(terminated).toBe(true);
  });
});
