import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewerStore } from "./store.js";
import { subscribeInspectorFrames } from "./inspector-updates.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const frames: (() => void)[] = [];
  const store = createViewerStore({ scheduler: (cb) => frames.push(cb) });
  const frame = () => { for (const cb of frames.splice(0)) cb(); };
  store.update("view", { inspectorTab: "task", taskFlamegraphMode: "mixed" });
  frame();
  const render = vi.fn(() => store.getState().viewport.viewStart);
  const pending = vi.fn();
  const dispose = subscribeInspectorFrames(store, render, pending);
  return { store, frame, render, pending, dispose };
}

describe("inspector updates", () => {
  it("coalesces continuous navigation and renders only the final range", () => {
    const { store, frame, render, pending, dispose } = setup();
    for (let start = 1; start <= 60; start++) {
      store.update("viewport", { viewStart: start, viewEnd: start + 10 });
      frame();
      vi.advanceTimersByTime(16);
      expect(render).not.toHaveBeenCalled();
    }
    expect(pending).toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveLastReturnedWith(60);
    dispose();
  });

  it("renders content changes immediately and cancels the pending range", () => {
    const { store, frame, render, dispose } = setup();
    store.update("viewport", { viewStart: 10 });
    frame();
    store.update("selection", { selectedTaskId: 7 });
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(render).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("stops viewport work when switching to CPU-only mode or another tab", () => {
    for (const view of [{ taskFlamegraphMode: "cpu" as const }, { inspectorTab: "poll" as const }]) {
      const { store, frame, render, dispose } = setup();
      store.update("viewport", { viewStart: 10 });
      frame();
      store.update("view", view);
      frame();
      expect(render).toHaveBeenCalledTimes(1);
      store.update("viewport", { viewStart: 20 });
      frame();
      vi.advanceTimersByTime(200);
      expect(render).toHaveBeenCalledTimes(1);
      dispose();
    }
  });

  it("cancels delayed work and unsubscribes on disposal", () => {
    const { store, frame, render, dispose } = setup();
    store.update("viewport", { viewStart: 10 });
    frame();
    dispose();
    store.update("selection", { selectedTaskId: 7 });
    frame();
    vi.advanceTimersByTime(200);
    expect(render).not.toHaveBeenCalled();
  });
});
