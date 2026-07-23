import { describe, expect, it } from "vitest";
import type { ParsedTrace } from "../../types/trace.js";
import type {
  ViewerExtensionWorkerPort,
  ViewerExtensionWorkerResponse,
} from "../../lib/trace/viewer-extension-worker/protocol.js";
import { createViewerStore } from "./store.js";
import {
  isViewerExtensionFile,
  loadDroppedViewerExtensions,
} from "./viewer-extension-drop.js";

function output(panelId: string): ArrayBuffer {
  const manifest = {
    version: 1,
    panels: [{ id: panelId, title: panelId, height: 20, components: [] }],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = new Uint8Array(16 + manifestBytes.byteLength);
  bytes.set([0x44, 0x39, 0x56, 0x4f, 1, 0, 0, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, manifestBytes.byteLength, true);
  view.setUint32(12, 0, true);
  bytes.set(manifestBytes, 16);
  return bytes.buffer;
}

function workerFor(panelId: string): ViewerExtensionWorkerPort {
  let onMessage: (message: ViewerExtensionWorkerResponse) => void = () => {};
  let name = "";
  return {
    postMessage(message): void {
      queueMicrotask(() => {
        if (message.kind === "start-local") {
          name = message.modules[0]!.name;
          onMessage({ kind: "initializing" });
          onMessage({ kind: "ready", extensions: [name], warnings: [] });
        } else if (message.kind === "local-chunk") {
          onMessage({ kind: "executing" });
          onMessage({ kind: "guest-ready" });
        } else if (message.kind === "local-finish") {
          onMessage({ kind: "finishing" });
          onMessage({
            kind: "done",
            outputs: [{ name, buffer: output(panelId) }],
            warnings: [],
          });
        }
      });
    },
    onMessage(fn): void {
      onMessage = fn;
    },
    onError(): void {},
    terminate(): void {},
  };
}

function wasmFile(name = "demo.wasm"): Blob & { readonly name: string } {
  return Object.assign(
    new Blob([Uint8Array.of(0, 0x61, 0x73, 0x6d)]),
    { name },
  );
}

describe("dropped viewer extensions", () => {
  it("recognizes the extension suffix case-insensitively", () => {
    expect(isViewerExtensionFile({ name: "demo.wasm" })).toBe(true);
    expect(isViewerExtensionFile({ name: "DEMO.WASM" })).toBe(true);
    expect(isViewerExtensionFile({ name: "trace.bin" })).toBe(false);
  });

  it("adds panels and atomically replaces a rebuild with the same file name", async () => {
    const store = createViewerStore({ scheduler: () => {} });
    store.update("trace", { trace: {} as ParsedTrace });
    const trace = Uint8Array.of(0x54, 0x52, 0x43, 0, 1).buffer;

    const first = loadDroppedViewerExtensions(store, trace, [wasmFile()], {
      worker: () => workerFor("first"),
    });
    await expect(first.done).resolves.toMatchObject({ names: ["demo"] });
    expect(
      store.getState().trace.trace?.viewerExtensions?.[0]?.bundle.panels[0]?.id,
    ).toBe("first");

    const second = loadDroppedViewerExtensions(store, trace, [wasmFile()], {
      worker: () => workerFor("replacement"),
    });
    await expect(second.done).resolves.toMatchObject({ names: ["demo"] });
    expect(store.getState().trace.trace?.viewerExtensions).toHaveLength(1);
    expect(
      store.getState().trace.trace?.viewerExtensions?.[0]?.bundle.panels[0]?.id,
    ).toBe("replacement");
  });
});
