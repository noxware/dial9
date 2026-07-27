import { LegacyViewerExtensionAdapter } from "./lib/viewer-extension/legacy-adapter.js";

declare global {
  interface Window {
    dial9ViewerExtensionsReady: Promise<LegacyViewerExtensionAdapter>;
    __resolveDial9ViewerExtensions?: (
      adapter: LegacyViewerExtensionAdapter,
    ) => void;
  }
}

const adapter = new LegacyViewerExtensionAdapter();
const resolve = window.__resolveDial9ViewerExtensions;
if (resolve === undefined) {
  window.dial9ViewerExtensionsReady = Promise.resolve(adapter);
} else {
  resolve(adapter);
  delete window.__resolveDial9ViewerExtensions;
}
