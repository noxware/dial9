import { describe, expect, it } from "vitest";
import type {
  ExtensionModuleSource,
  ExtensionRunResult,
} from "./coordinator.js";
import {
  LegacyViewerExtensionAdapter,
  type ViewerExtensionFile,
} from "./legacy-adapter.js";

class FakeCoordinator {
  readonly chunks: Uint8Array[] = [];
  finishCount = 0;
  abortCount = 0;

  feed(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  finish(): Promise<readonly ExtensionRunResult[]> {
    this.finishCount += 1;
    return Promise.resolve([]);
  }

  abort(): void {
    this.abortCount += 1;
  }
}

function wasmFile(name = "example.wasm"): ViewerExtensionFile {
  return {
    name,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return Uint8Array.from([0, 97, 115, 109]).buffer;
    },
  };
}

function harness(replayChunkBytes = 4): {
  readonly adapter: LegacyViewerExtensionAdapter;
  readonly coordinators: FakeCoordinator[];
  readonly sources: ExtensionModuleSource[][];
} {
  const coordinators: FakeCoordinator[] = [];
  const sources: ExtensionModuleSource[][] = [];
  return {
    adapter: new LegacyViewerExtensionAdapter({
      replayChunkBytes,
      createCoordinator(batch, options) {
        sources.push([...batch]);
        // Exercise the adapter's deterministic instance-ID allocator.
        for (let index = 0; index < batch.length; index += 1) {
          options.createInstanceId();
        }
        const coordinator = new FakeCoordinator();
        coordinators.push(coordinator);
        return coordinator;
      },
    }),
    coordinators,
    sources,
  };
}

describe("LegacyViewerExtensionAdapter lifecycle", () => {
  it("holds pre-trace modules and streams them with the next logical load", async () => {
    const { adapter, coordinators, sources } = harness();
    await expect(adapter.loadWasm(wasmFile())).resolves.toBe("pending");
    expect(coordinators).toHaveLength(0);

    const generation = adapter.beginTrace();
    adapter.feed(Uint8Array.from([1, 2, 3]), generation);
    adapter.finish(Uint8Array.from([1, 2, 3]), generation);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.[0]?.fileName).toBe("example.wasm");
    expect(coordinators[0]?.chunks).toEqual([Uint8Array.from([1, 2, 3])]);
    expect(coordinators[0]?.finishCount).toBe(1);
  });

  it("replays post-trace modules in bounded chunks", async () => {
    const { adapter, coordinators } = harness(4);
    const generation = adapter.beginTrace();
    adapter.finish(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]), generation);

    await expect(adapter.loadWasm(wasmFile("late.wasm"))).resolves.toBe(
      "running",
    );
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0]?.chunks).toEqual([
      Uint8Array.from([0, 1, 2, 3]),
      Uint8Array.from([4, 5, 6, 7]),
      Uint8Array.from([8]),
    ]);
    expect(coordinators[0]?.finishCount).toBe(1);
  });

  it("replays a module dropped during streaming after the full buffer arrives", async () => {
    const { adapter, coordinators } = harness(3);
    const generation = adapter.beginTrace();
    await expect(adapter.loadWasm(wasmFile())).resolves.toBe("running");
    expect(coordinators).toHaveLength(0);

    adapter.finish(Uint8Array.from([0, 1, 2, 3]), generation);
    expect(coordinators[0]?.chunks).toEqual([
      Uint8Array.from([0, 1, 2]),
      Uint8Array.from([3]),
    ]);
  });

  it("aborts the replaced generation and ignores stale feed and finish calls", async () => {
    const { adapter, coordinators } = harness();
    await adapter.loadWasm(wasmFile("first.wasm"));
    const first = adapter.beginTrace();
    expect(coordinators).toHaveLength(1);

    const second = adapter.beginTrace();
    expect(coordinators[0]?.abortCount).toBe(1);
    adapter.feed(Uint8Array.from([9]), first);
    adapter.finish(Uint8Array.from([9]), first);
    adapter.feed(Uint8Array.from([2]), second);
    adapter.finish(Uint8Array.from([2]), second);

    expect(coordinators[0]?.chunks).toEqual([]);
    expect(coordinators[0]?.finishCount).toBe(0);
  });

  it("rejects retaining compressed bytes", () => {
    const { adapter } = harness();
    const generation = adapter.beginTrace();
    expect(() =>
      adapter.finish(Uint8Array.from([0x1f, 0x8b, 0]), generation),
    ).toThrow("decompressed D9TF");
  });
});
