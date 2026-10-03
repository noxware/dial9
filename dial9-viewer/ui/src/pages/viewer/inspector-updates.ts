import type { ViewerStore } from "../../store/store.js";

/** Keep viewport-driven mixed-profile work out of continuous pan/zoom frames. */
export function subscribeInspectorFrames(
  store: ViewerStore,
  render: () => void,
  markMixedRangePending: () => void,
): () => void {
  const contentSlices = ["trace", "selection", "uiPrefs", "view"] as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
  }
  const unsubscribe = store.subscribe([...contentSlices, "viewport"], (s, changed) => {
    if (contentSlices.some((slice) => changed.has(slice))) {
      cancel();
      render();
    } else if (s.view.inspectorTab === "task" && s.view.taskFlamegraphMode === "mixed") {
      cancel();
      markMixedRangePending();
      timer = setTimeout(() => {
        timer = undefined;
        render();
      }, 150);
    }
  });
  return () => {
    cancel();
    unsubscribe();
  };
}
