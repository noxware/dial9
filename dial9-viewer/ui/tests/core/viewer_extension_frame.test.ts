import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { TraceDecoder } = require("../../decode.js") as {
  TraceDecoder: new (bytes: Uint8Array) => {
    decodeHeader(): boolean;
    decodeAll(): unknown[];
    enableStreaming(): void;
    setBuffer(bytes: Uint8Array): void;
    snapshot(): unknown;
    restore(snapshot: unknown): void;
    rewindToStart(): void;
    nextFrame(): unknown | null;
    needMoreBytes: boolean;
    incompleteViewerExtension: boolean;
    position: number;
  };
};
const { parseTraceStream } = require("../../trace_parser.js") as {
  parseTraceStream: (
    chunks: AsyncIterable<Uint8Array>,
  ) => Promise<unknown>;
};

const MAX_MODULE_BYTES = 2 * 1024 * 1024;

function extensionTrace(
  wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0),
  declaredWasmLength = wasm.length,
): Uint8Array {
  const name = new TextEncoder().encode("demo");
  const bytes = new Uint8Array(5 + 1 + 2 + 4 + name.length + wasm.length);
  bytes.set([0x54, 0x52, 0x43, 0, 1], 0);
  const view = new DataView(bytes.buffer);
  let offset = 5;
  view.setUint8(offset++, 0x07);
  view.setUint16(offset, name.length, true);
  offset += 2;
  view.setUint32(offset, declaredWasmLength, true);
  offset += 4;
  bytes.set(name, offset);
  offset += name.length;
  bytes.set(wasm, offset);
  return bytes;
}

function chunksOf(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
      }
    },
  };
}

describe("viewer extension trace frame", () => {
  it("stays aligned without retaining its wasm payload", () => {
    const decoder = new TraceDecoder(extensionTrace());
    expect(decoder.decodeHeader()).toBe(true);
    expect(decoder.decodeAll()).toEqual([
      { type: "viewer_extension", name: "demo", wasmLength: 8 },
    ]);
  });

  it("treats every split inside the frame as an incomplete streaming tail", () => {
    const bytes = extensionTrace();
    for (let split = 6; split < bytes.length; split++) {
      const decoder = new TraceDecoder(bytes.subarray(0, split));
      expect(decoder.decodeHeader()).toBe(true);
      decoder.enableStreaming();
      const snapshot = decoder.snapshot();
      expect(decoder.nextFrame(), `split ${split}`).toBeNull();
      expect(decoder.needMoreBytes, `split ${split}`).toBe(true);
      expect(decoder.incompleteViewerExtension, `split ${split}`).toBe(true);
      decoder.restore(snapshot);
      decoder.setBuffer(bytes);
      expect(decoder.nextFrame(), `split ${split}`).toEqual({
        type: "viewer_extension",
        name: "demo",
        wasmLength: 8,
      });
    }
  });

  it("rejects an oversized module immediately after its frame header", () => {
    const decoder = new TraceDecoder(
      extensionTrace(new Uint8Array(0), MAX_MODULE_BYTES + 1),
    );
    expect(decoder.decodeHeader()).toBe(true);
    expect(() => decoder.decodeAll()).toThrow(
      `Viewer extension module is ${MAX_MODULE_BYTES + 1} bytes; limit is ${MAX_MODULE_BYTES}`,
    );
  });

  it("rejects a truncated module in whole-buffer and streaming decoders", async () => {
    const complete = extensionTrace();
    const bytes = complete.subarray(0, complete.length - 1);
    const decoder = new TraceDecoder(bytes);
    expect(decoder.decodeHeader()).toBe(true);
    expect(() => decoder.decodeAll()).toThrow("Truncated viewer extension");
    await expect(parseTraceStream(chunksOf(bytes, 3))).rejects.toThrow(
      "Truncated viewer extension",
    );
  });

  it("keeps legacy truncated tails lenient", async () => {
    const bytes = Uint8Array.of(
      0x54, 0x52, 0x43, 0, 1,
      0x05, 0, 0, 0,
    );
    const decoder = new TraceDecoder(bytes);
    expect(decoder.decodeHeader()).toBe(true);
    expect(decoder.decodeAll()).toEqual([]);
    await expect(parseTraceStream(chunksOf(bytes, 2))).resolves.toBeDefined();
  });
});
