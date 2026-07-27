import { ExtensionTableStore } from "./tables.js";
import type {
  ExtensionIdentity,
  ViewerExtensionManifest,
} from "./types.js";
import type {
  ExtensionWorkerFactory,
  ExtensionWorkerPort,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

const INPUT_CHUNK_BYTES = 1024 * 1024;

export interface LoadedExtension {
  readonly identity: ExtensionIdentity;
  readonly manifest: ViewerExtensionManifest;
  readonly tables: ExtensionTableStore;
}

export interface ExtensionFailure {
  readonly identity: ExtensionIdentity;
  readonly message: string;
}

export interface ViewerExtensionSnapshot {
  readonly extensions: readonly LoadedExtension[];
  readonly failures: readonly ExtensionFailure[];
  readonly pending: number;
}

export interface ViewerExtensionManagerOptions {
  readonly worker?: ExtensionWorkerFactory;
  readonly onChange?: (snapshot: ViewerExtensionSnapshot) => void;
}

export class ViewerExtensionManager {
  readonly #workerFactory: ExtensionWorkerFactory;
  readonly #onChange: ((snapshot: ViewerExtensionSnapshot) => void) | undefined;
  readonly #sessions = new Map<string, ExtensionSession>();
  #nextId = 1;
  #traceBuffer: ArrayBuffer | null = null;
  #loadingTrace = false;

  constructor(options: ViewerExtensionManagerOptions = {}) {
    this.#workerFactory = options.worker ?? defaultWorkerFactory;
    this.#onChange = options.onChange;
  }

  snapshot(): ViewerExtensionSnapshot {
    const extensions: LoadedExtension[] = [];
    const failures: ExtensionFailure[] = [];
    let pending = 0;
    for (const session of this.#sessions.values()) {
      if (session.result !== null) extensions.push(session.result);
      else if (session.failure !== null) failures.push(session.failure);
      else pending += 1;
    }
    return Object.freeze({
      extensions: Object.freeze(extensions),
      failures: Object.freeze(failures),
      pending,
    });
  }

  /**
   * Start a new logical trace. Existing instances belong to the previous
   * trace and are removed; instances loaded before the first trace stay
   * pending and receive this input.
   */
  beginTrace(replacing: boolean): void {
    if (replacing) this.#disposeSessions();
    this.#traceBuffer = null;
    this.#loadingTrace = true;
    this.#notify();
  }

  pushTraceChunk(chunk: Uint8Array): void {
    if (!this.#loadingTrace) throw new Error("viewer extension trace input was not started");
    for (const session of this.#sessions.values()) session.push(chunk);
  }

  finishTrace(buffer: ArrayBuffer): void {
    if (!this.#loadingTrace) throw new Error("viewer extension trace input was not started");
    this.#traceBuffer = buffer;
    this.#loadingTrace = false;
    for (const session of this.#sessions.values()) session.finish();
  }

  processTraceBuffer(buffer: ArrayBuffer | Uint8Array, replacing: boolean): void {
    this.beginTrace(replacing);
    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += INPUT_CHUNK_BYTES) {
      this.pushTraceChunk(bytes.subarray(offset, offset + INPUT_CHUNK_BYTES));
    }
    const retained =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : bytes.slice().buffer;
    this.finishTrace(retained);
  }

  loadModule(name: string, module: ArrayBuffer): ExtensionIdentity {
    const identity = Object.freeze({
      id: `extension-${this.#nextId++}`,
      name,
    });
    const session = new ExtensionSession(
      identity,
      module,
      this.#workerFactory(),
      () => this.#notify(),
    );
    this.#sessions.set(identity.id, session);
    if (this.#traceBuffer !== null) {
      const bytes = new Uint8Array(this.#traceBuffer);
      for (let offset = 0; offset < bytes.byteLength; offset += INPUT_CHUNK_BYTES) {
        session.push(bytes.subarray(offset, offset + INPUT_CHUNK_BYTES));
      }
      session.finish();
    }
    this.#notify();
    return identity;
  }

  clear(): void {
    this.#disposeSessions();
    this.#traceBuffer = null;
    this.#loadingTrace = false;
    this.#notify();
  }

  #disposeSessions(): void {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
  }

  #notify(): void {
    this.#onChange?.(this.snapshot());
  }
}

class ExtensionSession {
  readonly identity: ExtensionIdentity;
  readonly #worker: ExtensionWorkerPort;
  readonly #onChange: () => void;
  #manifest: ViewerExtensionManifest | null = null;
  #staging: ExtensionTableStore | null = null;
  #result: LoadedExtension | null = null;
  #failure: ExtensionFailure | null = null;
  #finishedInput = false;
  #disposed = false;

  constructor(
    identity: ExtensionIdentity,
    module: ArrayBuffer,
    worker: ExtensionWorkerPort,
    onChange: () => void,
  ) {
    this.identity = identity;
    this.#worker = worker;
    this.#onChange = onChange;
    worker.onMessage((message) => this.#message(message));
    worker.onError((error) => this.#fail(error));
    worker.postMessage(
      { kind: "start", id: identity.id, name: identity.name, module },
      [module],
    );
  }

  get result(): LoadedExtension | null {
    return this.#result;
  }

  get failure(): ExtensionFailure | null {
    return this.#failure;
  }

  push(chunk: Uint8Array): void {
    if (this.#disposed || this.#failure !== null || this.#finishedInput) return;
    const copy = chunk.slice().buffer;
    this.#worker.postMessage({ kind: "input", bytes: copy }, [copy]);
  }

  finish(): void {
    if (this.#disposed || this.#failure !== null || this.#finishedInput) return;
    this.#finishedInput = true;
    this.#worker.postMessage({ kind: "finish" });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.terminate();
  }

  #message(message: ExtensionWorkerResponse): void {
    if (this.#disposed || this.#failure !== null) return;
    switch (message.kind) {
      case "ready":
        this.#manifest = message.manifest;
        this.#staging = new ExtensionTableStore(message.manifest);
        this.#onChange();
        return;
      case "batch":
        if (this.#staging === null) {
          this.#fail(new Error("WASM extension emitted output before its manifest"));
          return;
        }
        try {
          this.#staging.append(message.batch);
        } catch (error) {
          this.#fail(error);
        }
        return;
      case "complete":
        if (this.#manifest === null || this.#staging === null) {
          this.#fail(new Error("WASM extension completed before its manifest"));
          return;
        }
        this.#result = Object.freeze({
          identity: this.identity,
          manifest: this.#manifest,
          tables: this.#staging,
        });
        this.#worker.terminate();
        this.#onChange();
        return;
      case "error":
        this.#fail(new Error(`${message.name}: ${message.message}`));
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed || this.#failure !== null) return;
    this.#failure = Object.freeze({
      identity: this.identity,
      message: error instanceof Error ? error.message : String(error),
    });
    this.#staging = null;
    this.#worker.terminate();
    this.#onChange();
  }
}

export function defaultWorkerFactory(): ExtensionWorkerPort {
  const worker = new Worker(new URL("./worker/extension-worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    postMessage(message, transfer = []): void {
      worker.postMessage(message, transfer);
    },
    onMessage(callback): void {
      worker.onmessage = (event: MessageEvent<ExtensionWorkerResponse>) => callback(event.data);
    },
    onError(callback): void {
      worker.onerror = callback;
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
