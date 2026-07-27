import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest.js";
import { createExtensionWorkerBody } from "./body.js";
import type { ExtensionWorkerResponse } from "./protocol.js";

const manifest = parseManifest(
  JSON.stringify({
    version: 1,
    tables: [{ name: "data", columns: [{ name: "value", type: "u8" }] }],
    panels: [],
  }),
);

describe("extension worker body", () => {
  it("serializes messages queued while the module compiles", async () => {
    const responses: ExtensionWorkerResponse[] = [];
    const order: string[] = [];
    let resolvePrepare!: (value: {
      manifest: typeof manifest;
      runtime: { push: () => never[]; finish: () => never[] };
    }) => void;
    const prepared = new Promise<Parameters<typeof resolvePrepare>[0]>((resolve) => {
      resolvePrepare = resolve;
    });
    const body = createExtensionWorkerBody((message) => responses.push(message), {
      prepare: () => prepared,
    });

    body.handle({
      kind: "start",
      id: "one",
      name: "one.wasm",
      module: new ArrayBuffer(0),
    });
    body.handle({ kind: "input", bytes: new Uint8Array([1]).buffer });
    body.handle({ kind: "finish" });
    resolvePrepare({
      manifest,
      runtime: {
        push: () => {
          order.push("push");
          return [];
        },
        finish: () => {
          order.push("finish");
          return [];
        },
      },
    });

    await vi.waitFor(() => expect(responses.at(-1)?.kind).toBe("complete"));
    expect(responses.map((message) => message.kind)).toEqual(["ready", "complete"]);
    expect(order).toEqual(["push", "finish"]);
  });

  it("contains a guest trap to this worker session", async () => {
    const responses: ExtensionWorkerResponse[] = [];
    const body = createExtensionWorkerBody((message) => responses.push(message), {
      prepare: async () => ({
        manifest,
        runtime: {
          push: () => {
            throw new WebAssembly.RuntimeError("unreachable");
          },
          finish: () => [],
        },
      }),
    });
    body.handle({
      kind: "start",
      id: "one",
      name: "one.wasm",
      module: new ArrayBuffer(0),
    });
    body.handle({ kind: "input", bytes: new ArrayBuffer(1) });
    body.handle({ kind: "finish" });

    await vi.waitFor(() => expect(responses.at(-1)?.kind).toBe("error"));
    expect(responses.at(-1)).toMatchObject({
      kind: "error",
      name: "RuntimeError",
      message: "unreachable",
    });
    expect(responses.some((message) => message.kind === "complete")).toBe(false);
  });
});
