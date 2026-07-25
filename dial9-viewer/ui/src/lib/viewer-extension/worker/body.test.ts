import { describe, expect, it, vi } from "vitest";
import type { ColumnarBatch } from "../columnar.js";
import type { ExtensionGuest } from "../module.js";
import type { ExtensionManifest } from "../manifest.js";
import { createExtensionWorkerBody } from "./body.js";
import type {
  ExtensionWorkerResponse,
  ExtensionWorkerPost,
} from "./protocol.js";

const MANIFEST: ExtensionManifest = {
  version: 1,
  tables: [
    {
      name: "values",
      columns: [{ name: "value", type: "u8", nullable: false }],
    },
  ],
  panels: [],
};

function batch(value: number): ColumnarBatch {
  return {
    table_id: 0,
    rows: 1,
    columns: [
      { type: "u8", values: new Uint8Array([value]).buffer },
    ],
  };
}

function recorder(): {
  readonly messages: ExtensionWorkerResponse[];
  readonly transfers: readonly (readonly ArrayBuffer[] | undefined)[];
  readonly post: ExtensionWorkerPost;
} {
  const messages: ExtensionWorkerResponse[] = [];
  const transfers: (readonly ArrayBuffer[] | undefined)[] = [];
  return {
    messages,
    transfers,
    post(message, transfer): void {
      messages.push(message);
      transfers.push(transfer);
    },
  };
}

describe("extension worker body", () => {
  it("serializes init, pushes, output transfer, and finish", async () => {
    const calls: string[] = [];
    const guest: ExtensionGuest = {
      manifest: MANIFEST,
      linearMemoryByteLength: 65_536,
      push(chunk) {
        calls.push(`push:${[...chunk].join(",")}`);
        return [batch(chunk[0]!)];
      },
      finish() {
        calls.push("finish");
        return [batch(9)];
      },
    };
    let resolveGuest: ((guest: ExtensionGuest) => void) | undefined;
    const loaded = new Promise<ExtensionGuest>((resolve) => {
      resolveGuest = resolve;
    });
    const output = recorder();
    const body = createExtensionWorkerBody(output.post, () => loaded);

    body.handle({
      kind: "init",
      instance_id: "instance-1",
      file_name: "fixture.wasm",
      wasm: new ArrayBuffer(0),
    });
    body.handle({
      kind: "push",
      chunk: new Uint8Array([7, 8]).buffer,
    });
    body.handle({ kind: "finish" });
    expect(calls).toEqual([]);

    resolveGuest!(guest);
    await vi.waitFor(() => {
      expect(output.messages.at(-1)).toEqual({ kind: "complete" });
    });
    expect(calls).toEqual(["push:7,8", "finish"]);
    expect(output.messages.map((message) => message.kind)).toEqual([
      "ready",
      "batch",
      "batch",
      "complete",
    ]);
    expect(output.messages[0]).toMatchObject({
      instance_id: "instance-1",
      file_name: "fixture.wasm",
      manifest: MANIFEST,
    });
    expect(output.transfers[1]).toHaveLength(1);
    expect(output.transfers[2]).toHaveLength(1);
  });

  it("turns a guest failure into one terminal error", async () => {
    const output = recorder();
    const body = createExtensionWorkerBody(output.post, async () => ({
      manifest: MANIFEST,
      linearMemoryByteLength: 65_536,
      push() {
        throw new TypeError("bad guest");
      },
      finish() {
        throw new Error("must not run");
      },
    }));
    body.handle({
      kind: "init",
      instance_id: "i",
      file_name: "bad.wasm",
      wasm: new ArrayBuffer(0),
    });
    body.handle({ kind: "push", chunk: new ArrayBuffer(0) });
    body.handle({ kind: "finish" });

    await vi.waitFor(() => {
      expect(output.messages.at(-1)).toEqual({
        kind: "error",
        name: "TypeError",
        message: "bad guest",
      });
    });
    expect(output.messages.map((message) => message.kind)).toEqual([
      "ready",
      "error",
    ]);
  });

  it("silently stops queued work after abort", async () => {
    let resolveGuest: ((guest: ExtensionGuest) => void) | undefined;
    const loaded = new Promise<ExtensionGuest>((resolve) => {
      resolveGuest = resolve;
    });
    const output = recorder();
    const body = createExtensionWorkerBody(output.post, () => loaded);
    const guest: ExtensionGuest = {
      manifest: MANIFEST,
      linearMemoryByteLength: 65_536,
      push: vi.fn(() => []),
      finish: vi.fn(() => []),
    };
    body.handle({
      kind: "init",
      instance_id: "i",
      file_name: "stopped.wasm",
      wasm: new ArrayBuffer(0),
    });
    body.handle({ kind: "push", chunk: new ArrayBuffer(0) });
    body.handle({ kind: "abort" });
    resolveGuest!(guest);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(output.messages).toEqual([]);
    expect(guest.push).not.toHaveBeenCalled();
  });

  it("rejects protocol ordering errors", async () => {
    const output = recorder();
    const body = createExtensionWorkerBody(output.post);
    body.handle({ kind: "push", chunk: new ArrayBuffer(0) });
    await vi.waitFor(() => {
      expect(output.messages[0]).toMatchObject({
        kind: "error",
        message: "extension worker received input before init",
      });
    });
  });
});
