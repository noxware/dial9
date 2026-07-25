import {
  LegacyViewerExtensionAdapter,
  type LegacyExtensionHooks,
  type LegacyExtensionRenderState,
  type LegacyTraceExtensionLoad,
  type WasmDropResult,
} from "../../lib/viewer-extension/legacy-adapter.js";

export interface LegacyViewerExtensionsGlobal {
  configure(hooks: LegacyExtensionHooks): void;
  beginTrace(): LegacyTraceExtensionLoad;
  normalizeAndFeed(
    input: ArrayBuffer,
    load: LegacyTraceExtensionLoad,
  ): Promise<ArrayBuffer>;
  loadWasm(file: File): Promise<WasmDropResult>;
  render(state: LegacyExtensionRenderState): void;
  reset(): void;
}

declare global {
  interface Window {
    Dial9ViewerExtensions?: LegacyViewerExtensionsGlobal;
    Dial9ViewerExtensionsReady?: Promise<LegacyViewerExtensionsGlobal | null>;
    __resolveDial9ViewerExtensions?: (
      adapter: LegacyViewerExtensionsGlobal | null,
    ) => void;
  }
}

const adapter = new LegacyViewerExtensionAdapter();
window.Dial9ViewerExtensions = adapter;
window.__resolveDial9ViewerExtensions?.(adapter);
