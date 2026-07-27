import "./legacy.css";

import {
  ViewerExtensionManager,
  type ViewerExtensionSnapshot,
} from "./manager.js";
import {
  SemanticPanelRenderer,
  type PanelViewport,
} from "./panel-renderer.js";

export interface LegacyViewerExtensionApi {
  loadFile(file: File): Promise<void>;
  processTraceBuffer(buffer: ArrayBuffer | Uint8Array, replacing: boolean): void;
  beginTrace(replacing: boolean): void;
  pushTraceChunk(chunk: Uint8Array): void;
  finishTrace(buffer: ArrayBuffer): void;
  cancelTrace(): void;
  reset(): void;
  render(viewport: PanelViewport): void;
}

declare global {
  interface Window {
    Dial9ViewerExtensions?: LegacyViewerExtensionApi;
  }
}

class LegacyViewerExtensions implements LegacyViewerExtensionApi {
  readonly #manager: ViewerExtensionManager;
  readonly #status: HTMLDivElement;
  #renderers: SemanticPanelRenderer[] = [];
  #failurePanels: HTMLElement[] = [];
  #viewport: PanelViewport | null = null;
  #mountedSignature = "";

  constructor() {
    this.#status = document.createElement("div");
    this.#status.className = "d9-extension-status";
    this.#status.setAttribute("role", "status");
    document.body.append(this.#status);
    this.#manager = new ViewerExtensionManager({
      onChange: (snapshot) => this.#synchronize(snapshot),
    });
  }

  async loadFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith(".wasm")) {
      throw new Error("viewer extensions must be .wasm files");
    }
    this.#showStatus(`Loading viewer extension ${file.name}…`, false);
    try {
      this.#manager.loadModule(file.name, await file.arrayBuffer());
    } catch (error) {
      this.#showStatus(message(error), true);
      throw error;
    }
  }

  processTraceBuffer(buffer: ArrayBuffer | Uint8Array, replacing: boolean): void {
    this.#manager.processTraceBuffer(buffer, replacing);
  }

  beginTrace(replacing: boolean): void {
    this.#manager.beginTrace(replacing);
  }

  pushTraceChunk(chunk: Uint8Array): void {
    this.#manager.pushTraceChunk(chunk);
  }

  finishTrace(buffer: ArrayBuffer): void {
    this.#manager.finishTrace(buffer);
  }

  cancelTrace(): void {
    this.#manager.clear();
  }

  reset(): void {
    this.#manager.clear();
    this.#showStatus("", false);
  }

  render(viewport: PanelViewport): void {
    this.#viewport = viewport;
    for (const renderer of this.#renderers) renderer.render(viewport);
  }

  #synchronize(snapshot: ViewerExtensionSnapshot): void {
    const signature = JSON.stringify({
      extensions: snapshot.extensions.map((extension) => extension.identity.id),
      failures: snapshot.failures.map((failure) => [
        failure.identity.id,
        failure.message,
      ]),
    });
    if (signature !== this.#mountedSignature) {
      this.#mountedSignature = signature;
      this.#mountPanels(snapshot);
    }

    if (snapshot.failures.length > 0) {
      const failure = snapshot.failures[snapshot.failures.length - 1]!;
      this.#showStatus(`${failure.identity.name}: ${failure.message}`, true);
    } else if (snapshot.pending > 0) {
      this.#showStatus(
        `${snapshot.pending} viewer extension${snapshot.pending === 1 ? "" : "s"} waiting or processing…`,
        false,
      );
    } else {
      this.#showStatus("", false);
    }
    window.dispatchEvent(new CustomEvent("dial9-viewer-extensions-change"));
  }

  #mountPanels(snapshot: ViewerExtensionSnapshot): void {
    for (const renderer of this.#renderers) renderer.destroy();
    this.#renderers = [];
    for (const panel of this.#failurePanels) panel.remove();
    this.#failurePanels = [];

    const insertionPoint = document.getElementById("task-detail");
    const tooltip = document.getElementById("tooltip");
    if (insertionPoint === null || tooltip === null) return;

    for (const extension of snapshot.extensions) {
      for (const [panelIndex, panel] of extension.manifest.panels.entries()) {
        const renderer = new SemanticPanelRenderer(
          extension,
          panel,
          panelIndex,
          tooltip,
        );
        insertionPoint.before(renderer.element);
        this.#renderers.push(renderer);
        renderer.render(this.#viewport);
      }
    }
    for (const failure of snapshot.failures) {
      const panel = failurePanel(failure.identity.name, failure.message);
      insertionPoint.before(panel);
      this.#failurePanels.push(panel);
    }
  }

  #showStatus(text: string, error: boolean): void {
    this.#status.textContent = text;
    this.#status.classList.toggle("is-visible", text.length > 0);
    this.#status.classList.toggle("is-error", error);
  }
}

function failurePanel(name: string, error: string): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "d9-extension-panel";
  const label = document.createElement("div");
  label.className = "chart-label";
  label.textContent = `WASM extension · ${name}`;
  const message = document.createElement("div");
  message.className = "d9-extension-error";
  message.textContent = error;
  panel.append(label, message);
  return panel;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

window.Dial9ViewerExtensions = new LegacyViewerExtensions();
