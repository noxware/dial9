import { prepareExtension, batchTransferables } from "./wasm-runtime.js";
import type {
  ExtensionWorkerRequest,
  WorkerPost,
} from "./protocol.js";

export interface ExtensionWorkerBody {
  handle(message: ExtensionWorkerRequest): void;
}

export interface ExtensionWorkerBodyDependencies {
  readonly prepare?: typeof prepareExtension;
}

export function createExtensionWorkerBody(
  post: WorkerPost,
  dependencies: ExtensionWorkerBodyDependencies = {},
): ExtensionWorkerBody {
  const prepare = dependencies.prepare ?? prepareExtension;
  let chain = Promise.resolve();
  let started = false;
  let finished = false;
  let failed = false;
  let runtime: Awaited<ReturnType<typeof prepareExtension>>["runtime"] | null = null;

  const report = (error: unknown): void => {
    if (failed) return;
    failed = true;
    const value = error as { name?: unknown; message?: unknown } | null;
    post({
      kind: "error",
      name: typeof value?.name === "string" ? value.name : "Error",
      message: typeof value?.message === "string" ? value.message : String(error),
    });
  };

  const dispatch = async (message: ExtensionWorkerRequest): Promise<void> => {
    if (failed) return;
    if (message.kind === "start") {
      if (started) throw new Error("WASM extension worker was already started");
      started = true;
      const prepared = await prepare(message.module);
      runtime = prepared.runtime;
      post({
        kind: "ready",
        id: message.id,
        name: message.name,
        manifest: prepared.manifest,
      });
      return;
    }
    if (!started || runtime === null) throw new Error("WASM extension worker is not ready");
    if (finished) throw new Error("WASM extension worker already finished");

    if (message.kind === "input") {
      publish(runtime.push(new Uint8Array(message.bytes)));
      return;
    }
    finished = true;
    publish(runtime.finish());
    post({ kind: "complete" });
  };

  const publish = (batches: ReturnType<NonNullable<typeof runtime>["push"]>): void => {
    for (const batch of batches) {
      post({ kind: "batch", batch }, batchTransferables(batch));
    }
  };

  return {
    handle(message): void {
      chain = chain.then(() => dispatch(message)).catch(report);
    },
  };
}
