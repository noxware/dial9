import type { ViewerStore } from "../../store/store.js";
import type { StoreState } from "../../types/state.js";

/**
 * Subscribe `store` so the viewport fits each newly loaded trace (keyed on
 * trace identity, so a later pan/zoom is not clobbered). Returns the
 * unsubscribe function.
 */
export function initViewportFromTrace(store: ViewerStore): () => void {
  let lastTrace: StoreState["trace"]["trace"] | null = null;
  return store.subscribe(["trace"], (state) => {
    const trace = state.trace.trace;
    if (trace === null || trace === lastTrace) return;
    lastTrace = trace;
    // minTs/maxTs intentionally retain the parser's historical Tokio-event
    // semantics. Extension-only traces still have all-event record bounds.
    const minTs = trace.minTs ?? trace.recordMinTs;
    const maxTs = trace.maxTs ?? trace.recordMaxTs;
    if (minTs === null || maxTs === null) return;
    store.update("viewport", {
      viewStart: minTs,
      viewEnd: maxTs,
      minTs,
      maxTs,
    });
  });
}
