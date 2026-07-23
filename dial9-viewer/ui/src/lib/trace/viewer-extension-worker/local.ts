import {
  defaultViewerExtensionWorkerFactory,
  ViewerExtensionWorkerError,
  type ViewerExtensionStreamResult,
} from "./source.js";
import type {
  ViewerExtensionWorkerFactory,
  ViewerExtensionWorkerPort,
  ViewerExtensionWorkerResponse,
} from "./protocol.js";

const CHUNK_BYTES = 1024 * 1024;
const INITIALIZE_TIMEOUT_MS = 10_000;
const CHUNK_TIMEOUT_MS = 5_000;
const FINISH_TIMEOUT_MS = 10_000;
const TRACE_HEADER_BYTES = 5;
const VIEWER_EXTENSION_TAG = 0x07;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function guestByteRanges(trace: ArrayBuffer): readonly ByteRange[] {
  const bytes = new Uint8Array(trace);
  if (
    bytes.byteLength < TRACE_HEADER_BYTES ||
    bytes[0] !== 0x54 ||
    bytes[1] !== 0x52 ||
    bytes[2] !== 0x43 ||
    bytes[3] !== 0
  ) {
    return [{ start: 0, end: bytes.byteLength }];
  }
  const view = new DataView(trace);
  let offset = TRACE_HEADER_BYTES;
  while (bytes[offset] === VIEWER_EXTENSION_TAG) {
    if (offset + 7 > bytes.byteLength) {
      throw new ViewerExtensionWorkerError(
        "truncated viewer-extension preamble in retained trace",
      );
    }
    const nameBytes = view.getUint16(offset + 1, true);
    const moduleBytes = view.getUint32(offset + 3, true);
    const end = offset + 7 + nameBytes + moduleBytes;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new ViewerExtensionWorkerError(
        "truncated viewer-extension preamble in retained trace",
      );
    }
    offset = end;
  }
  return offset === TRACE_HEADER_BYTES
    ? [{ start: 0, end: bytes.byteLength }]
    : [
        { start: 0, end: TRACE_HEADER_BYTES },
        { start: offset, end: bytes.byteLength },
      ];
}

export interface LocalViewerExtensionModule {
  readonly name: string;
  readonly buffer: ArrayBuffer;
}

export interface LocalViewerExtensionRun {
  readonly done: Promise<ViewerExtensionStreamResult>;
  abort(): void;
}

export interface LocalViewerExtensionRunOptions {
  readonly worker?: ViewerExtensionWorkerFactory;
  readonly initializeTimeoutMs?: number;
  readonly chunkTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
}

/**
 * Execute local modules over an already-retained decompressed trace. The trace
 * remains owned by the viewer: at most one bounded slice is copied and
 * transferred to the disposable worker at a time.
 */
export function runLocalViewerExtensions(
  trace: ArrayBuffer,
  modules: readonly LocalViewerExtensionModule[],
  options: LocalViewerExtensionRunOptions = {},
): LocalViewerExtensionRun {
  const ranges = guestByteRanges(trace);
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

  let resolveDone!: (result: ViewerExtensionStreamResult) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<ViewerExtensionStreamResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});

  let settled = false;
  let rangeIndex = 0;
  let offset = ranges[0]?.start ?? 0;
  let extensionNames: readonly string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    port.terminate();
    rejectDone(
      error instanceof Error
        ? error
        : new ViewerExtensionWorkerError(String(error)),
    );
  };

  const armTimeout = (milliseconds: number, phase: string): void => {
    clearTimer();
    timer = setTimeout(() => {
      fail(new ViewerExtensionWorkerError(`viewer-extension ${phase} timed out`));
    }, milliseconds);
  };

  const post = (
    message: Parameters<typeof port.postMessage>[0],
    transfer: readonly ArrayBuffer[] = [],
  ): void => {
    try {
      port.postMessage(message, transfer);
    } catch (error) {
      fail(error);
    }
  };

  const sendNext = (): void => {
    if (settled) return;
    while (
      rangeIndex < ranges.length &&
      offset === ranges[rangeIndex]!.end
    ) {
      rangeIndex += 1;
      offset = ranges[rangeIndex]?.start ?? trace.byteLength;
    }
    if (rangeIndex === ranges.length) {
      armTimeout(
        options.finishTimeoutMs ?? FINISH_TIMEOUT_MS,
        "finish",
      );
      post({ kind: "local-finish" });
      return;
    }
    const end = Math.min(offset + CHUNK_BYTES, ranges[rangeIndex]!.end);
    const buffer = trace.slice(offset, end);
    offset = end;
    armTimeout(
      options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS,
      "chunk execution",
    );
    post(
      {
        kind: "local-chunk",
        buffer,
        byteOffset: 0,
        byteLength: buffer.byteLength,
      },
      [buffer],
    );
  };

  port.onError((error) => {
    const value = error as { message?: unknown; name?: unknown } | null;
    fail(
      error instanceof Error
        ? error
        : new ViewerExtensionWorkerError(
            typeof value?.message === "string" ? value.message : String(error),
            typeof value?.name === "string" ? value.name : undefined,
          ),
    );
  });
  port.onMessage((message: ViewerExtensionWorkerResponse) => {
    if (settled) return;
    switch (message.kind) {
      case "error":
        fail(new ViewerExtensionWorkerError(message.message, message.name));
        return;
      case "initializing":
        armTimeout(
          options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
          "initialization",
        );
        return;
      case "ready":
        clearTimer();
        extensionNames = message.extensions;
        sendNext();
        return;
      case "executing":
        return;
      case "guest-ready":
        clearTimer();
        sendNext();
        return;
      case "finishing":
        armTimeout(
          options.finishTimeoutMs ?? FINISH_TIMEOUT_MS,
          "finish",
        );
        return;
      case "done":
        settled = true;
        clearTimer();
        port.terminate();
        resolveDone({
          outputs: message.outputs,
          warnings: message.warnings,
          extensionNames,
        });
        return;
      case "chunk":
        fail(
          new ViewerExtensionWorkerError(
            "local viewer-extension worker returned a trace chunk",
          ),
        );
    }
  });

  armTimeout(
    options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
    "initialization",
  );
  const transfer = modules.map(({ buffer }) => buffer);
  post(
    {
      kind: "start-local",
      modules: modules.map(({ name, buffer }) => ({ name, buffer })),
    },
    transfer,
  );

  return {
    done,
    abort(): void {
      fail(new DOMException("viewer-extension load aborted", "AbortError"));
    },
  };
}
