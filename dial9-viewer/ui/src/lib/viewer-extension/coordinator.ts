import { ExtensionStore, type ColumnarBatch } from "./columnar.js";
import {
  FirstPreambleScanner,
  type ScannedEmbeddedFile,
} from "./preamble.js";
import type { ExtensionManifest } from "./manifest.js";
import type {
  ExtensionWorkerFactory,
  ExtensionWorkerPort,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

export interface ExtensionModuleSource {
  readonly name: string;
  readonly data: Uint8Array;
}

export type ExtensionInstanceStatus =
  | "loading"
  | "ready"
  | "complete"
  | "error"
  | "aborted";

export interface ExtensionInstanceSnapshot {
  readonly instance_id: string;
  readonly file_name: string;
  readonly status: ExtensionInstanceStatus;
  readonly error?: string;
}

export interface PublishedExtension {
  readonly status: "complete";
  readonly instance_id: string;
  readonly file_name: string;
  readonly manifest: ExtensionManifest;
  readonly store: ExtensionStore;
}

export interface FailedExtension {
  readonly status: "error";
  readonly instance_id: string;
  readonly file_name: string;
  readonly error: string;
}

export interface AbortedExtension {
  readonly status: "aborted";
  readonly instance_id: string;
  readonly file_name: string;
}

export type ExtensionLoadResult =
  | PublishedExtension
  | FailedExtension
  | AbortedExtension;

export interface ExtensionCoordinatorOptions {
  readonly workerFactory?: ExtensionWorkerFactory;
  /** Explicit modules, such as files dropped before this trace load. */
  readonly modules?: readonly ExtensionModuleSource[];
  /** Defaults to true. False is useful when replaying a trace for a local module. */
  readonly discoverEmbedded?: boolean;
  readonly onStateChange?: (
    instances: readonly ExtensionInstanceSnapshot[],
  ) => void;
}

interface MutableInstance {
  readonly instanceId: string;
  readonly fileName: string;
  readonly port: ExtensionWorkerPort;
  readonly promise: Promise<ExtensionLoadResult>;
  readonly resolve: (result: ExtensionLoadResult) => void;
  status: ExtensionInstanceStatus;
  manifest?: ExtensionManifest;
  store?: ExtensionStore;
  error?: string;
}

let nextInstanceId = 1;

function instanceId(): string {
  const id = nextInstanceId;
  nextInstanceId += 1;
  return `dial9-extension-${id}`;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function takeOwnedBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return copyBuffer(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBrowserExtensionWorker(): ExtensionWorkerPort {
  const worker = new Worker(
    new URL("./worker/extension-worker.ts", import.meta.url),
    { type: "module", name: "dial9-viewer-extension" },
  );
  let messageCallback: ((message: ExtensionWorkerResponse) => void) | undefined;
  let errorCallback: ((error: unknown) => void) | undefined;
  worker.onmessage = (event: MessageEvent): void => {
    messageCallback?.(event.data as ExtensionWorkerResponse);
  };
  worker.onerror = (event: ErrorEvent): void => {
    errorCallback?.(event.error ?? new Error(event.message));
  };
  return {
    postMessage(message, transfer): void {
      worker.postMessage(message, transfer === undefined ? [] : [...transfer]);
    },
    onMessage(callback): void {
      messageCallback = callback;
    },
    onError(callback): void {
      errorCallback = callback;
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

/**
 * Fans one logical decompressed D9TF stream out to independent extension
 * Workers. `feed` only enqueues copies and never waits for guest progress.
 */
export class ExtensionCoordinator {
  readonly #workerFactory: ExtensionWorkerFactory;
  readonly #onStateChange:
    | ((instances: readonly ExtensionInstanceSnapshot[]) => void)
    | undefined;
  readonly #scanner: FirstPreambleScanner | undefined;
  #retainedPrefix: Uint8Array[] = [];
  #instances: MutableInstance[] = [];
  #finished = false;
  #aborted = false;
  #finishPromise: Promise<readonly ExtensionLoadResult[]> | undefined;

  constructor(options: ExtensionCoordinatorOptions = {}) {
    this.#workerFactory =
      options.workerFactory ?? createBrowserExtensionWorker;
    this.#onStateChange = options.onStateChange;
    this.#scanner =
      options.discoverEmbedded === false
        ? undefined
        : new FirstPreambleScanner();
    if (options.modules !== undefined) {
      this.#spawnModules(
        options.modules.map((module) => ({
          name: module.name,
          data: new Uint8Array(module.data),
        })),
      );
    }
  }

  get instances(): readonly ExtensionInstanceSnapshot[] {
    return this.#instances.map((instance) => {
      const snapshot: {
        instance_id: string;
        file_name: string;
        status: ExtensionInstanceStatus;
        error?: string;
      } = {
        instance_id: instance.instanceId,
        file_name: instance.fileName,
        status: instance.status,
      };
      if (instance.error !== undefined) snapshot.error = instance.error;
      return snapshot;
    });
  }

  feed(chunk: Uint8Array): void {
    if (this.#finished || this.#aborted) {
      throw new Error("extension coordinator cannot receive more input");
    }

    const scanner = this.#scanner;
    if (scanner !== undefined && !scanner.closed) {
      this.#retainedPrefix.push(chunk);
      this.#fanout(chunk, this.#instances);
      let discovered: readonly ScannedEmbeddedFile[] | undefined;
      try {
        discovered = scanner.push(chunk);
      } catch (error) {
        this.abort();
        throw error;
      }
      if (discovered !== undefined) {
        const added = this.#spawnEmbedded(discovered);
        this.#replay(this.#retainedPrefix, added);
        this.#retainedPrefix = [];
      }
      return;
    }

    this.#fanout(chunk, this.#instances);
  }

  finish(): Promise<readonly ExtensionLoadResult[]> {
    if (this.#finishPromise !== undefined) return this.#finishPromise;
    if (this.#aborted) return Promise.resolve([]);
    this.#finished = true;

    const scanner = this.#scanner;
    if (scanner !== undefined && !scanner.closed) {
      let discovered: readonly ScannedEmbeddedFile[];
      try {
        discovered = scanner.finish();
      } catch (error) {
        this.abort();
        return Promise.reject(error);
      }
      const added = this.#spawnEmbedded(discovered);
      this.#replay(this.#retainedPrefix, added);
      this.#retainedPrefix = [];
    }

    for (const instance of this.#instances) {
      if (instance.status === "loading" || instance.status === "ready") {
        try {
          instance.port.postMessage({ kind: "finish" });
        } catch (error) {
          this.#fail(instance, errorMessage(error));
        }
      }
    }
    this.#finishPromise = Promise.all(
      this.#instances.map((instance) => instance.promise),
    );
    return this.#finishPromise;
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#finished = true;
    this.#retainedPrefix = [];
    for (const instance of this.#instances) {
      if (
        instance.status === "complete" ||
        instance.status === "error" ||
        instance.status === "aborted"
      ) {
        continue;
      }
      instance.status = "aborted";
      try {
        instance.port.postMessage({ kind: "abort" });
      } catch {
        // Hard termination below is authoritative.
      } finally {
        instance.port.terminate();
      }
      instance.resolve({
        status: "aborted",
        instance_id: instance.instanceId,
        file_name: instance.fileName,
      });
    }
    this.#notify();
  }

  #spawnEmbedded(
    files: readonly ScannedEmbeddedFile[],
  ): readonly MutableInstance[] {
    return this.#spawnModules(
      files.filter((file) => file.name.toLowerCase().endsWith(".wasm")),
    );
  }

  #spawnModules(
    modules: readonly ExtensionModuleSource[],
  ): readonly MutableInstance[] {
    const added: MutableInstance[] = [];
    for (const module of modules) {
      let resolve!: (result: ExtensionLoadResult) => void;
      const promise = new Promise<ExtensionLoadResult>((done) => {
        resolve = done;
      });
      const port = this.#workerFactory();
      const instance: MutableInstance = {
        instanceId: instanceId(),
        fileName: module.name,
        port,
        promise,
        resolve,
        status: "loading",
      };
      this.#instances.push(instance);
      added.push(instance);
      port.onMessage((message) => this.#onMessage(instance, message));
      port.onError((error) => this.#fail(instance, errorMessage(error)));

      const wasm = takeOwnedBuffer(module.data);
      try {
        port.postMessage(
          {
            kind: "init",
            instance_id: instance.instanceId,
            file_name: instance.fileName,
            wasm,
          },
          [wasm],
        );
      } catch (error) {
        this.#fail(instance, errorMessage(error));
      }
    }
    if (added.length !== 0) this.#notify();
    return added;
  }

  #replay(
    chunks: readonly Uint8Array[],
    instances: readonly MutableInstance[],
  ): void {
    for (const chunk of chunks) this.#fanout(chunk, instances);
  }

  #fanout(
    chunk: Uint8Array,
    instances: readonly MutableInstance[],
  ): void {
    for (const instance of instances) {
      if (instance.status !== "loading" && instance.status !== "ready") continue;
      const copy = copyBuffer(chunk);
      try {
        instance.port.postMessage({ kind: "push", chunk: copy }, [copy]);
      } catch (error) {
        this.#fail(instance, errorMessage(error));
      }
    }
  }

  #onMessage(
    instance: MutableInstance,
    message: ExtensionWorkerResponse,
  ): void {
    if (instance.status === "error" || instance.status === "aborted") return;
    try {
      switch (message.kind) {
        case "ready":
          if (instance.status !== "loading") {
            throw new Error("extension Worker sent ready more than once");
          }
          if (
            message.instance_id !== instance.instanceId ||
            message.file_name !== instance.fileName
          ) {
            throw new Error("extension Worker ready identity does not match");
          }
          instance.manifest = message.manifest;
          instance.store = new ExtensionStore(message.manifest);
          instance.status = "ready";
          this.#notify();
          return;
        case "batch":
          if (instance.status !== "ready" || instance.store === undefined) {
            throw new Error("extension Worker sent a batch before ready");
          }
          this.#append(instance.store, message.batch);
          return;
        case "complete":
          if (
            instance.status !== "ready" ||
            instance.manifest === undefined ||
            instance.store === undefined
          ) {
            throw new Error("extension Worker completed before ready");
          }
          instance.status = "complete";
          instance.port.terminate();
          instance.resolve({
            status: "complete",
            instance_id: instance.instanceId,
            file_name: instance.fileName,
            manifest: instance.manifest,
            store: instance.store,
          });
          this.#notify();
          return;
        case "error":
          this.#fail(instance, `${message.name}: ${message.message}`);
          return;
      }
    } catch (error) {
      this.#fail(instance, errorMessage(error));
    }
  }

  #append(store: ExtensionStore, batch: ColumnarBatch): void {
    store.append(batch);
  }

  #fail(instance: MutableInstance, message: string): void {
    if (
      instance.status === "complete" ||
      instance.status === "error" ||
      instance.status === "aborted"
    ) {
      return;
    }
    instance.status = "error";
    instance.error = message;
    instance.port.terminate();
    instance.resolve({
      status: "error",
      instance_id: instance.instanceId,
      file_name: instance.fileName,
      error: message,
    });
    this.#notify();
  }

  #notify(): void {
    this.#onStateChange?.(this.instances);
  }
}
