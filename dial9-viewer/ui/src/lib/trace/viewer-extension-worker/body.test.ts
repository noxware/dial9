import { describe, expect, it } from "vitest";
import {
  createViewerExtensionWorkerBody,
  type ViewerExtensionWorkerBodyDeps,
} from "./body.js";
import type {
  ViewerExtensionWorkerResponse,
} from "./protocol.js";

const TRACE_HEADER = Uint8Array.of(0x54, 0x52, 0x43, 0, 1);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function resetFrame(timestamp: number): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes[0] = 0x05;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(timestamp), true);
  return bytes;
}

function extensionTrace(
  module = Uint8Array.of(0, 0x61, 0x73, 0x6d),
  tail = resetFrame(1),
): Uint8Array {
  const name = new TextEncoder().encode("demo");
  const bytes = new Uint8Array(
    TRACE_HEADER.byteLength + 7 + name.length + module.length + tail.byteLength,
  );
  bytes.set(TRACE_HEADER, 0);
  const view = new DataView(bytes.buffer);
  let offset = TRACE_HEADER.byteLength;
  view.setUint8(offset++, 0x07);
  view.setUint16(offset, name.length, true);
  offset += 2;
  view.setUint32(offset, module.length, true);
  offset += 4;
  bytes.set(name, offset);
  offset += name.length;
  bytes.set(module, offset);
  offset += module.length;
  bytes.set(tail, offset);
  return bytes;
}

function strippedTrace(tail = resetFrame(1)): Uint8Array {
  return concat(TRACE_HEADER, tail);
}

function chunksOf(bytes: Uint8Array): Uint8Array[] {
  return [
    bytes.slice(0, 8),
    bytes.slice(8, bytes.length - 2),
    bytes.slice(bytes.length - 2),
  ];
}

function iterator(chunks: readonly Uint8Array[]): AsyncIterator<Uint8Array> {
  let index = 0;
  return {
    async next() {
      const value = chunks[index++];
      return value === undefined
        ? { done: true, value: undefined }
        : { done: false, value };
    },
  };
}

async function waitFor(
  messages: readonly ViewerExtensionWorkerResponse[],
  kind: ViewerExtensionWorkerResponse["kind"],
): Promise<ViewerExtensionWorkerResponse> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = messages.find((message) => message.kind === kind);
    if (found !== undefined) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${kind}`);
}

function chunkBytes(
  message: Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }>,
): Uint8Array {
  return new Uint8Array(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
}

async function pullToDone(
  body: ReturnType<typeof createViewerExtensionWorkerBody>,
  messages: ViewerExtensionWorkerResponse[],
): Promise<Extract<ViewerExtensionWorkerResponse, { kind: "done" }>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const before = messages.length;
    body.handle({ kind: "next" });
    while (messages.length === before) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const last = messages.at(-1)!;
    if (last.kind === "done") return last;
    if (last.kind === "error") throw new Error(last.message);
  }
  throw new Error("timed out draining viewer-extension worker");
}

function activeExtension(
  name: string,
  onPush: (bytes: Uint8Array) => void,
) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 64 });
  let inputLength = 0;
  return {
    name,
    maximumMemoryPages: 64,
    disabled: false,
    exports: {
      memory,
      dial9_abi_version: () => 1,
      dial9_input_alloc: (length: number) => {
        inputLength = length;
        const missingPages =
          Math.ceil(length / 65_536) - memory.buffer.byteLength / 65_536;
        if (missingPages > 0) memory.grow(missingPages);
        return 0;
      },
      dial9_push: () => {
        onPush(new Uint8Array(memory.buffer, 0, inputLength));
        return 0;
      },
      dial9_finish: () => 0,
      dial9_output_ptr: () => 0,
      dial9_output_len: () => 0,
      dial9_error_ptr: () => 0,
      dial9_error_len: () => 0,
    },
  };
}

describe("viewer-extension worker body", () => {
  it("retains the first bundle for main but strips it from guest input", async () => {
    const trace = extensionTrace();
    const traceChunks = chunksOf(trace);
    const messages: ViewerExtensionWorkerResponse[] = [];
    const pushed: Uint8Array[] = [];
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const output = Uint8Array.of(1, 2, 3);
    let inputLength = 0;
    const deps: ViewerExtensionWorkerBodyDeps = {
      async openStream() {
        return iterator(traceChunks);
      },
      async instantiate(module) {
        expect(module.name).toBe("demo");
        expect([...module.bytes]).toEqual([0, 0x61, 0x73, 0x6d]);
        return {
          name: module.name,
          disabled: false,
          exports: {
            memory,
            dial9_abi_version: () => 1,
            dial9_input_alloc: (length: number) => {
              inputLength = length;
              return 0;
            },
            dial9_push: () => {
              pushed.push(new Uint8Array(memory.buffer, 0, inputLength).slice());
              return 0;
            },
            dial9_finish: () => {
              new Uint8Array(memory.buffer, 100, output.length).set(output);
              return 0;
            },
            dial9_output_ptr: () => 100,
            dial9_output_len: () => output.length,
            dial9_error_ptr: () => 0,
            dial9_error_len: () => 0,
          },
        };
      },
    };
    const body = createViewerExtensionWorkerBody((message) => {
      messages.push(message);
    }, deps);

    body.handle({ kind: "start", urls: ["/trace"] });
    expect(await waitFor(messages, "ready")).toMatchObject({
      extensions: ["demo"],
      warnings: [],
    });

    const done = await pullToDone(body, messages);

    const streamed = messages
      .filter((message): message is Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }> =>
        message.kind === "chunk")
      .flatMap((message) => [...chunkBytes(message)]);
    expect(streamed).toEqual([...trace]);
    expect(pushed.flatMap((chunk) => [...chunk])).toEqual([
      ...strippedTrace(),
    ]);
    expect(done).toMatchObject({
      outputs: [{ name: "demo" }],
      warnings: [],
    });
    if (done.kind === "done") {
      expect([...new Uint8Array(done.outputs[0]!.buffer)]).toEqual([1, 2, 3]);
    }
  });

  it("keeps the base byte stream alive when an embedded module is rejected", async () => {
    const trace = extensionTrace();
    const messages: ViewerExtensionWorkerResponse[] = [];
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async openStream() {
          return iterator([trace]);
        },
        async instantiate() {
          throw new Error("policy rejected module");
        },
      },
    );

    body.handle({ kind: "start", urls: ["/trace"] });
    expect(await waitFor(messages, "ready")).toMatchObject({
      extensions: [],
      warnings: ["demo: policy rejected module"],
    });
    expect(await pullToDone(body, messages)).toMatchObject({
      outputs: [],
      warnings: ["demo: policy rejected module"],
    });
  });

  it("consumes a preamble split at every byte boundary without rescanning", async () => {
    const module = Uint8Array.from({ length: 257 }, (_, index) => index);
    const trace = extensionTrace(module, resetFrame(17));
    const messages: ViewerExtensionWorkerResponse[] = [];
    const pushed: number[] = [];
    let instantiated = 0;
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async openStream() {
          return iterator([...trace].map((byte) => Uint8Array.of(byte)));
        },
        async instantiate(embedded) {
          instantiated += 1;
          expect(embedded.name).toBe("demo");
          expect(embedded.bytes).toEqual(module);
          return activeExtension(embedded.name, (bytes) => {
            pushed.push(...bytes);
          });
        },
      },
    );

    body.handle({ kind: "start", urls: ["/split"] });
    await waitFor(messages, "ready");
    await pullToDone(body, messages);

    expect(instantiated).toBe(1);
    expect(pushed).toEqual([...strippedTrace(resetFrame(17))]);
    const streamed = messages
      .filter((message): message is Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }> =>
        message.kind === "chunk")
      .flatMap((message) => [...chunkBytes(message)]);
    expect(streamed).toEqual([...trace]);
  });

  it("strips identical repeated bundles and accepts an already-empty preamble", async () => {
    const module = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 2, 3);
    const first = extensionTrace(module, resetFrame(11));
    const second = extensionTrace(module, resetFrame(22));
    const third = strippedTrace(resetFrame(33));
    const sources = new Map<string, readonly Uint8Array[]>([
      ["/first", chunksOf(first)],
      ["/second", [...second].map((byte) => Uint8Array.of(byte))],
      ["/third", [third]],
    ]);
    const opened: string[] = [];
    const messages: ViewerExtensionWorkerResponse[] = [];
    const pushed: number[] = [];
    let instantiated = 0;
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async openStream(request) {
          const url = request.urls[0]!;
          opened.push(url);
          return iterator(sources.get(url)!);
        },
        async instantiate(embedded) {
          instantiated += 1;
          return activeExtension(embedded.name, (bytes) => {
            pushed.push(...bytes);
          });
        },
      },
    );

    body.handle({
      kind: "start",
      urls: ["/first", "/second", "/third"],
    });
    await waitFor(messages, "ready");
    const done = await pullToDone(body, messages);

    expect(opened).toEqual(["/first", "/second", "/third"]);
    expect(instantiated).toBe(1);
    expect(done.warnings).toEqual([]);
    const normalized = concat(
      first,
      strippedTrace(resetFrame(22)),
      strippedTrace(resetFrame(33)),
    );
    const streamed = messages
      .filter((message): message is Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }> =>
        message.kind === "chunk")
      .flatMap((message) => [...chunkBytes(message)]);
    expect(streamed).toEqual([...normalized]);
    expect(pushed).toEqual([
      ...concat(
        strippedTrace(resetFrame(11)),
        strippedTrace(resetFrame(22)),
        strippedTrace(resetFrame(33)),
      ),
    ]);
  });

  it("disables partial output when a later source repeats a different bundle", async () => {
    const first = extensionTrace(Uint8Array.of(1, 2, 3), resetFrame(11));
    const second = extensionTrace(Uint8Array.of(1, 2, 4), resetFrame(22));
    const messages: ViewerExtensionWorkerResponse[] = [];
    const pushed: number[] = [];
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async openStream(request) {
          return iterator([
            request.urls[0] === "/first" ? first : second,
          ]);
        },
        async instantiate(embedded) {
          return activeExtension(embedded.name, (bytes) => {
            pushed.push(...bytes);
          });
        },
      },
    );

    body.handle({ kind: "start", urls: ["/first", "/second"] });
    await waitFor(messages, "ready");
    const done = await pullToDone(body, messages);

    expect(done.outputs).toEqual([]);
    expect(done.warnings).toContain(
      "viewer-extension bundle in source 2 does not match source 1",
    );
    // The mismatching source is still available to the trusted base parser,
    // but no partial extension result survives.
    const streamed = messages
      .filter((message): message is Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }> =>
        message.kind === "chunk")
      .flatMap((message) => [...chunkBytes(message)]);
    expect(streamed).toEqual([
      ...concat(first, strippedTrace(resetFrame(22))),
    ]);
    expect(pushed).toEqual([...strippedTrace(resetFrame(11))]);
  });

  it("transfers a large post-preamble suffix as a view of its original chunk", async () => {
    const frameCount = 120_000;
    const tail = new Uint8Array(frameCount * 9);
    const tailView = new DataView(tail.buffer);
    for (let index = 0; index < frameCount; index++) {
      const offset = index * 9;
      tail[offset] = 0x05;
      tailView.setBigUint64(offset + 1, BigInt(index), true);
    }
    const trace = extensionTrace(Uint8Array.of(1, 2, 3), tail);
    const messages: ViewerExtensionWorkerResponse[] = [];
    const guestLengths: number[] = [];
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async openStream() {
          return iterator([trace]);
        },
        async instantiate(embedded) {
          return activeExtension(embedded.name, (bytes) => {
            guestLengths.push(bytes.byteLength);
          });
        },
      },
    );

    body.handle({ kind: "start", urls: ["/large"] });
    await waitFor(messages, "ready");
    await pullToDone(body, messages);

    const chunks = messages.filter(
      (message): message is Extract<ViewerExtensionWorkerResponse, { kind: "chunk" }> =>
        message.kind === "chunk",
    );
    const suffix = chunks.find((message) => message.byteLength === tail.byteLength);
    expect(suffix).toBeDefined();
    expect(suffix!.buffer).toBe(trace.buffer);
    expect(suffix!.byteOffset).toBe(trace.byteLength - tail.byteLength);
    expect(guestLengths).toEqual([TRACE_HEADER.byteLength, tail.byteLength]);
  });

  it("runs supplied local modules over pushed chunks without echoing trace bytes", async () => {
    const messages: ViewerExtensionWorkerResponse[] = [];
    const pushed: number[] = [];
    const body = createViewerExtensionWorkerBody(
      (message) => messages.push(message),
      {
        async instantiate(module) {
          expect(module.name).toBe("local-demo");
          expect([...module.bytes]).toEqual([0, 0x61, 0x73, 0x6d]);
          return activeExtension(module.name, (bytes) => {
            pushed.push(...bytes);
          });
        },
      },
    );
    const moduleBuffer = Uint8Array.of(0, 0x61, 0x73, 0x6d).buffer;

    body.handle({
      kind: "start-local",
      modules: [{ name: "local-demo", buffer: moduleBuffer }],
    });
    expect(await waitFor(messages, "ready")).toMatchObject({
      extensions: ["local-demo"],
      warnings: [],
    });

    for (const bytes of [TRACE_HEADER, resetFrame(9)]) {
      body.handle({
        kind: "local-chunk",
        buffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        byteOffset: 0,
        byteLength: bytes.byteLength,
      });
      expect(messages.at(-1)?.kind).toBe("guest-ready");
    }
    body.handle({ kind: "local-finish" });
    const done = await waitFor(messages, "done");

    expect(pushed).toEqual([...concat(TRACE_HEADER, resetFrame(9))]);
    expect(messages.some(({ kind }) => kind === "chunk")).toBe(false);
    expect(done).toMatchObject({
      outputs: [{ name: "local-demo" }],
      warnings: [],
    });
  });
});
