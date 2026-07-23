import type {
  ViewerExtensionOutputBuffer,
  ViewerExtensionWorkerFactory,
  ViewerExtensionWorkerPort,
  ViewerExtensionWorkerResponse,
} from "./protocol.js";

const INITIALIZE_TIMEOUT_MS = 10_000;
const CHUNK_TIMEOUT_MS = 5_000;
const FINISH_TIMEOUT_MS = 10_000;

export interface ViewerExtensionStreamResult {
  readonly outputs: readonly ViewerExtensionOutputBuffer[];
  readonly warnings: readonly string[];
  readonly extensionNames: readonly string[];
}

export interface ViewerExtensionByteSource {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly result: Promise<ViewerExtensionStreamResult>;
  abort(): void;
}

export interface ViewerExtensionByteSourceOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly worker?: ViewerExtensionWorkerFactory;
  readonly initializeTimeoutMs?: number;
  readonly chunkTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
}

export class ViewerExtensionWorkerError extends Error {
  constructor(message: string, name = "ViewerExtensionWorkerError") {
    super(message);
    this.name = name;
  }
}

export function defaultViewerExtensionWorkerFactory(): ViewerExtensionWorkerPort {
  const worker = new Worker(
    new URL("./viewer-extension-worker.ts", import.meta.url),
    { type: "module" },
  );
  return {
    postMessage(message): void {
      worker.postMessage(message);
    },
    onMessage(fn): void {
      worker.onmessage = (event: MessageEvent<ViewerExtensionWorkerResponse>) =>
        fn(event.data);
    },
    onError(fn): void {
      worker.onerror = fn;
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A deferred may be rejected during teardown before its phase starts.
  // Mark it handled without changing what an eventual await observes.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Open a pull-driven decompressed byte source. One worker owns network,
 * decompression, validation and guest execution; the main thread receives
 * each raw chunk by transfer and remains the sole owner of ParsedTrace.
 */
export function createViewerExtensionByteSource(
  urls: readonly string[],
  options: ViewerExtensionByteSourceOptions = {},
): ViewerExtensionByteSource {
  let port: ViewerExtensionWorkerPort;
  try {
    port = (options.worker ?? defaultViewerExtensionWorkerFactory)();
  } catch (error) {
    const value = error as { message?: unknown; name?: unknown } | null;
    throw new ViewerExtensionWorkerError(
      typeof value?.message === "string" ? value.message : String(error),
      typeof value?.name === "string" ? value.name : undefined,
    );
  }
  const ready = deferred<void>();
  const result = deferred<ViewerExtensionStreamResult>();
  let next = deferred<ViewerExtensionWorkerResponse>();
  let settled = false;
  let extensionNames: readonly string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let terminalError: Error | null = null;

  // Avoid an unhandled rejection for callers that only consume `chunks`.
  result.promise.catch(() => {});

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const timeout = (milliseconds: number, phase: string): void => {
    clearTimer();
    timer = setTimeout(() => {
      fail(new ViewerExtensionWorkerError(`viewer-extension ${phase} timed out`));
    }, milliseconds);
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    port.terminate();
    const normalized =
      error instanceof Error
        ? error
        : new ViewerExtensionWorkerError(String(error));
    terminalError = normalized;
    ready.reject(normalized);
    next.reject(normalized);
    result.reject(normalized);
  };

  port.onError((error) => {
    const value = error as { message?: unknown; name?: unknown } | null;
    fail(
      error instanceof ViewerExtensionWorkerError
        ? error
        : new ViewerExtensionWorkerError(
            typeof value?.message === "string" ? value.message : String(error),
            typeof value?.name === "string" ? value.name : undefined,
          ),
    );
  });
  port.onMessage((message) => {
    if (settled) return;
    if (message.kind === "error") {
      clearTimer();
      fail(new ViewerExtensionWorkerError(message.message, message.name));
      return;
    }
    if (message.kind === "initializing") {
      timeout(
        options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
        "initialization",
      );
      return;
    }
    if (message.kind === "ready") {
      clearTimer();
      extensionNames = message.extensions;
      ready.resolve();
      return;
    }
    if (message.kind === "executing") {
      timeout(options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS, "chunk execution");
      return;
    }
    if (message.kind === "guest-ready") {
      clearTimer();
      return;
    }
    if (message.kind === "finishing") {
      timeout(options.finishTimeoutMs ?? FINISH_TIMEOUT_MS, "finish");
      return;
    }
    next.resolve(message);
  });

  const start: {
    kind: "start";
    urls: readonly string[];
    headers?: Readonly<Record<string, string>>;
  } = {
    kind: "start",
    urls,
  };
  if (options.headers !== undefined) start.headers = options.headers;
  port.postMessage(start);

  const chunks: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        await ready.promise;
        for (;;) {
          if (terminalError !== null) throw terminalError;
          next = deferred<ViewerExtensionWorkerResponse>();
          port.postMessage({ kind: "next" });
          const message = await next.promise;
          if (message.kind === "chunk") {
            if (terminalError !== null) throw terminalError;
            yield new Uint8Array(
              message.buffer,
              message.byteOffset,
              message.byteLength,
            );
            continue;
          }
          if (message.kind !== "done") {
            throw new ViewerExtensionWorkerError(
              `unexpected worker message ${message.kind}`,
            );
          }
          clearTimer();
          settled = true;
          port.terminate();
          result.resolve({
            outputs: message.outputs,
            warnings: message.warnings,
            extensionNames,
          });
          return;
        }
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        if (!settled) {
          fail(
            new ViewerExtensionWorkerError(
              "viewer-extension byte stream was closed before completion",
            ),
          );
        }
      }
    },
  };

  return {
    chunks,
    result: result.promise,
    abort(): void {
      fail(new DOMException("viewer-extension byte source aborted", "AbortError"));
    },
  };
}
