import { ExtensionStore } from "./columnar.js";
import type { ExtensionManifest } from "./manifest.js";
import type {
  ExtensionWorkerFactory,
  ExtensionWorkerPort,
  ExtensionWorkerResponse,
} from "./worker/protocol.js";

export interface ExtensionModuleSource {
  readonly fileName: string;
  readonly wasm: Uint8Array;
}

export interface CompletedExtension {
  readonly status: "complete";
  readonly instanceId: string;
  readonly fileName: string;
  readonly manifest: ExtensionManifest;
  readonly store: ExtensionStore;
}

export interface FailedExtension {
  readonly status: "error";
  readonly instanceId: string;
  readonly fileName: string;
  readonly error: Error;
}

export interface AbortedExtension {
  readonly status: "aborted";
  readonly instanceId: string;
  readonly fileName: string;
}

export type ExtensionRunResult =
  | CompletedExtension
  | FailedExtension
  | AbortedExtension;

export interface ExtensionCoordinatorOptions {
  readonly workerFactory?: ExtensionWorkerFactory;
  readonly createInstanceId?: () => string;
  readonly onResult?: (result: ExtensionRunResult) => void;
}

interface ExtensionRun {
  readonly instanceId: string;
  readonly fileName: string;
  readonly worker: ExtensionWorkerPort;
  manifest: ExtensionManifest | undefined;
  store: ExtensionStore | undefined;
  result?: ExtensionRunResult;
  finishSent: boolean;
}

let nextInstanceId = 1;

function defaultInstanceId(): string {
  return `extension-${nextInstanceId++}`;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createBrowserExtensionWorker(): ExtensionWorkerPort {
  const worker = new Worker(
    new URL("./worker/extension-worker.ts", import.meta.url),
    { type: "module" },
  );
  return {
    postMessage(message, transfer): void {
      worker.postMessage(message, transfer === undefined ? [] : [...transfer]);
    },
    onMessage(callback): void {
      worker.addEventListener("message", (event: MessageEvent) => {
        callback(event.data as ExtensionWorkerResponse);
      });
    },
    onError(callback): void {
      worker.addEventListener("error", (event: ErrorEvent) => {
        callback(event.error ?? new Error(event.message));
      });
      worker.addEventListener("messageerror", () => {
        callback(new Error("Could not deserialize extension worker message"));
      });
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

export class ExtensionCoordinator {
  readonly #runs: ExtensionRun[];
  readonly #onResult: ((result: ExtensionRunResult) => void) | undefined;
  readonly #results: Promise<readonly ExtensionRunResult[]>;
  #resolveResults!: (results: readonly ExtensionRunResult[]) => void;
  #inputFinished = false;
  #aborted = false;

  constructor(
    sources: readonly ExtensionModuleSource[],
    options: ExtensionCoordinatorOptions = {},
  ) {
    const workerFactory =
      options.workerFactory ?? createBrowserExtensionWorker;
    const createInstanceId = options.createInstanceId ?? defaultInstanceId;
    this.#onResult = options.onResult;
    this.#results = new Promise((resolve) => {
      this.#resolveResults = resolve;
    });
    this.#runs = [];
    for (const source of sources) {
      const run: ExtensionRun = {
        instanceId: createInstanceId(),
        fileName: source.fileName,
        worker: workerFactory(),
        manifest: undefined,
        store: undefined,
        finishSent: false,
      };
      this.#runs.push(run);
      run.worker.onMessage((message) => {
        this.#handleMessage(run, message);
      });
      run.worker.onError((error) => {
        this.#fail(run, asError(error));
      });
      const wasm = copyBuffer(source.wasm);
      try {
        run.worker.postMessage(
          {
            kind: "init",
            instance_id: run.instanceId,
            file_name: run.fileName,
            wasm,
          },
          [wasm],
        );
      } catch (error) {
        this.#fail(run, asError(error));
      }
    }
    this.#settleIfComplete();
  }

  feed(chunk: Uint8Array): void {
    if (this.#inputFinished) {
      throw new Error("Cannot feed an extension coordinator after finish");
    }
    if (this.#aborted) return;
    for (const run of this.#runs) {
      if (run.result !== undefined) continue;
      const copy = copyBuffer(chunk);
      try {
        run.worker.postMessage({ kind: "push", chunk: copy }, [copy]);
      } catch (error) {
        this.#fail(run, asError(error));
      }
    }
  }

  finish(): Promise<readonly ExtensionRunResult[]> {
    if (!this.#inputFinished) {
      this.#inputFinished = true;
      if (!this.#aborted) {
        for (const run of this.#runs) {
          if (run.result === undefined) {
            run.finishSent = true;
            try {
              run.worker.postMessage({ kind: "finish" });
            } catch (error) {
              this.#fail(run, asError(error));
            }
          }
        }
      }
      this.#settleIfComplete();
    }
    return this.#results;
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#inputFinished = true;
    for (const run of this.#runs) {
      if (run.result !== undefined) continue;
      try {
        run.worker.postMessage({ kind: "abort" });
      } catch {
        // terminate below is the authoritative cancellation.
      }
      this.#complete(run, {
        status: "aborted",
        instanceId: run.instanceId,
        fileName: run.fileName,
      });
    }
    this.#settleIfComplete();
  }

  #handleMessage(run: ExtensionRun, message: ExtensionWorkerResponse): void {
    if (run.result !== undefined || this.#aborted) return;
    try {
      switch (message.kind) {
        case "ready":
          if (
            message.instance_id !== run.instanceId ||
            message.file_name !== run.fileName
          ) {
            throw new Error("Extension worker identity does not match its run");
          }
          if (run.store !== undefined) {
            throw new Error("Extension worker sent ready twice");
          }
          run.manifest = message.manifest;
          run.store = new ExtensionStore(message.manifest);
          return;
        case "batch":
          if (run.store === undefined) {
            throw new Error("Extension worker sent a batch before ready");
          }
          run.store.append(message.batch);
          return;
        case "complete":
          if (run.store === undefined || run.manifest === undefined) {
            throw new Error("Extension worker completed before ready");
          }
          if (!run.finishSent) {
            throw new Error("Extension worker completed before finish");
          }
          this.#complete(run, {
            status: "complete",
            instanceId: run.instanceId,
            fileName: run.fileName,
            manifest: run.manifest,
            store: run.store,
          });
          return;
        case "error":
          this.#fail(run, new Error(`${message.name}: ${message.message}`));
          return;
      }
    } catch (error) {
      this.#fail(run, asError(error));
    }
  }

  #fail(run: ExtensionRun, error: Error): void {
    if (run.result !== undefined) return;
    run.manifest = undefined;
    run.store = undefined;
    this.#complete(run, {
      status: "error",
      instanceId: run.instanceId,
      fileName: run.fileName,
      error,
    });
  }

  #complete(run: ExtensionRun, result: ExtensionRunResult): void {
    if (run.result !== undefined) return;
    run.result = result;
    run.worker.terminate();
    this.#onResult?.(result);
    this.#settleIfComplete();
  }

  #settleIfComplete(): void {
    if (
      !this.#inputFinished ||
      this.#runs.some((run) => run.result === undefined)
    ) {
      return;
    }
    this.#resolveResults(this.#runs.map((run) => run.result!));
  }
}
