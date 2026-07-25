import { batchTransferables } from "../columnar.js";
import {
  loadExtensionModule,
  type ExtensionGuest,
} from "../module.js";
import type {
  ExtensionWorkerBody,
  ExtensionWorkerPost,
  ExtensionWorkerRequest,
} from "./protocol.js";

export type ExtensionGuestLoader = (
  wasm: BufferSource,
) => Promise<ExtensionGuest>;

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

export function createExtensionWorkerBody(
  post: ExtensionWorkerPost,
  load: ExtensionGuestLoader = loadExtensionModule,
): ExtensionWorkerBody {
  let guest: ExtensionGuest | undefined;
  let initialized = false;
  let finished = false;
  let aborted = false;
  let failed = false;
  let queue = Promise.resolve();

  function postBatches(batches: ReturnType<ExtensionGuest["push"]>): void {
    for (const batch of batches) {
      post({ kind: "batch", batch }, batchTransferables(batch));
    }
  }

  async function dispatch(message: ExtensionWorkerRequest): Promise<void> {
    if (aborted || failed) return;
    switch (message.kind) {
      case "abort":
        return;
      case "init": {
        if (initialized) throw new Error("extension worker is already initialized");
        initialized = true;
        const loaded = await load(message.wasm);
        if (aborted) return;
        guest = loaded;
        post({
          kind: "ready",
          instance_id: message.instance_id,
          file_name: message.file_name,
          manifest: loaded.manifest,
        });
        return;
      }
      case "push":
        if (guest === undefined) {
          throw new Error("extension worker received input before init");
        }
        if (finished) throw new Error("extension worker received input after finish");
        postBatches(guest.push(new Uint8Array(message.chunk)));
        return;
      case "finish":
        if (guest === undefined) {
          throw new Error("extension worker received finish before init");
        }
        if (finished) throw new Error("extension worker received finish twice");
        finished = true;
        postBatches(guest.finish());
        post({ kind: "complete" });
        return;
    }
  }

  return {
    handle(message: ExtensionWorkerRequest): void {
      if (message.kind === "abort") {
        aborted = true;
        return;
      }
      queue = queue
        .then(() => dispatch(message))
        .catch((error: unknown) => {
          if (aborted || failed) return;
          failed = true;
          post({ kind: "error", ...errorDetails(error) });
        });
    },
  };
}
