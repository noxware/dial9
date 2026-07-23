import { describe, expect, it } from "vitest";
import type { ParsedTrace } from "../../lib/trace/load.js";
import type { FrameScheduler } from "../../store/store.js";
import { createViewerStore } from "./store.js";
import { initViewportFromTrace } from "./viewport-init.js";

function harness(): {
  readonly store: ReturnType<typeof createViewerStore>;
  flush(): void;
} {
  const frames: (() => void)[] = [];
  const scheduler: FrameScheduler = (callback) => {
    frames.push(callback);
  };
  const store = createViewerStore({ scheduler });
  initViewportFromTrace(store);
  return {
    store,
    flush() {
      for (const callback of frames.splice(0)) callback();
    },
  };
}

describe("viewport initialization", () => {
  it("falls back to all-record bounds for extension-only traces", () => {
    const { store, flush } = harness();
    store.update("trace", {
      trace: {
        minTs: null,
        maxTs: null,
        recordMinTs: 1_000,
        recordMaxTs: 9_000,
      } as ParsedTrace,
    });
    flush();

    expect(store.getState().viewport).toEqual({
      viewStart: 1_000,
      viewEnd: 9_000,
      minTs: 1_000,
      maxTs: 9_000,
    });
  });

  it("keeps historical event bounds when they exist", () => {
    const { store, flush } = harness();
    store.update("trace", {
      trace: {
        minTs: 2_000,
        maxTs: 8_000,
        recordMinTs: 1_000,
        recordMaxTs: 9_000,
      } as ParsedTrace,
    });
    flush();

    expect(store.getState().viewport).toEqual({
      viewStart: 2_000,
      viewEnd: 8_000,
      minTs: 2_000,
      maxTs: 8_000,
    });
  });
});
