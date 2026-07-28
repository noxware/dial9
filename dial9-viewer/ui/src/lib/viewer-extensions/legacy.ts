import "./legacy.css";

import type { CustomTraceEvent } from "../../types/trace.js";
import {
  fieldViewNumber,
  materializeFieldView,
  type FieldViewInterpretation,
} from "./field-view.js";
import {
  ViewerExtensionManager,
  type ViewerExtensionSnapshot,
} from "./manager.js";
import {
  SemanticPanelRenderer,
  type PanelViewport,
  type SemanticPanelSource,
} from "./panel-renderer.js";
import type { PanelManifest } from "./types.js";

export interface LegacyViewerExtensionApi {
  loadFile(file: File): Promise<void>;
  canGraphField(value: unknown): boolean;
  openFieldView(
    event: CustomTraceEvent,
    field: string,
    events: readonly CustomTraceEvent[],
  ): void;
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

interface LocalFieldPanel {
  readonly id: string;
  readonly source: SemanticPanelSource;
  readonly panel: PanelManifest;
}

class LegacyViewerExtensions implements LegacyViewerExtensionApi {
  readonly #manager: ViewerExtensionManager;
  readonly #status: HTMLDivElement;
  readonly #fieldViewDialog: FieldViewDialog;
  #renderers: SemanticPanelRenderer[] = [];
  #failurePanels: HTMLElement[] = [];
  #fieldPanels: LocalFieldPanel[] = [];
  #viewport: PanelViewport | null = null;
  #mountedSignature = "";
  #nextFieldPanelId = 1;

  constructor() {
    this.#status = document.createElement("div");
    this.#status.className = "d9-extension-status";
    this.#status.setAttribute("role", "status");
    document.body.append(this.#status);
    this.#manager = new ViewerExtensionManager({
      onChange: (snapshot) => this.#synchronize(snapshot),
    });
    this.#fieldViewDialog = new FieldViewDialog((request) => {
      const materialized = materializeFieldView(request.events, {
        eventName: request.event.name,
        field: request.field,
        ...(request.event.units?.[request.field] === undefined
          ? {}
          : { unit: request.event.units[request.field] }),
        interpretation: request.interpretation,
      });
      const id = `field-view-${this.#nextFieldPanelId++}`;
      this.#fieldPanels.push({
        id,
        source: {
          identity: { id, name: id },
          tables: materialized.tables,
        },
        panel: materialized.panel,
      });
      this.#synchronize(this.#manager.snapshot());
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

  canGraphField(value: unknown): boolean {
    return fieldViewNumber(value) !== null;
  }

  openFieldView(
    event: CustomTraceEvent,
    field: string,
    events: readonly CustomTraceEvent[],
  ): void {
    if (!this.canGraphField(event.fields[field])) {
      throw new Error(`${event.name}.${field} is not a finite numeric field`);
    }
    this.#fieldViewDialog.open({ event, field, events });
  }

  processTraceBuffer(buffer: ArrayBuffer | Uint8Array, replacing: boolean): void {
    if (replacing) {
      this.#fieldPanels = [];
      this.#fieldViewDialog.close();
    }
    this.#manager.processTraceBuffer(buffer, replacing);
  }

  beginTrace(replacing: boolean): void {
    if (replacing) {
      this.#fieldPanels = [];
      this.#fieldViewDialog.close();
    }
    this.#manager.beginTrace(replacing);
  }

  pushTraceChunk(chunk: Uint8Array): void {
    this.#manager.pushTraceChunk(chunk);
  }

  finishTrace(buffer: ArrayBuffer): void {
    this.#manager.finishTrace(buffer);
  }

  cancelTrace(): void {
    this.#fieldPanels = [];
    this.#fieldViewDialog.close();
    this.#manager.clear();
  }

  reset(): void {
    this.#fieldPanels = [];
    this.#fieldViewDialog.close();
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
      fieldPanels: this.#fieldPanels.map((panel) => panel.id),
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
    for (const fieldPanel of this.#fieldPanels) {
      const renderer = new SemanticPanelRenderer(
        fieldPanel.source,
        fieldPanel.panel,
        0,
        tooltip,
        {
          onClose: () => this.#removeFieldPanel(fieldPanel.id),
          persistCollapse: false,
        },
      );
      insertionPoint.before(renderer.element);
      this.#renderers.push(renderer);
      renderer.render(this.#viewport);
    }
    for (const failure of snapshot.failures) {
      const panel = failurePanel(failure.identity.name, failure.message);
      insertionPoint.before(panel);
      this.#failurePanels.push(panel);
    }
  }

  #removeFieldPanel(id: string): void {
    const next = this.#fieldPanels.filter((panel) => panel.id !== id);
    if (next.length === this.#fieldPanels.length) return;
    this.#fieldPanels = next;
    this.#synchronize(this.#manager.snapshot());
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

interface PendingFieldView {
  readonly event: CustomTraceEvent;
  readonly field: string;
  readonly events: readonly CustomTraceEvent[];
}

interface FieldViewSubmission extends PendingFieldView {
  readonly interpretation: FieldViewInterpretation;
}

class FieldViewDialog {
  readonly #dialog: HTMLDialogElement;
  readonly #title: HTMLHeadingElement;
  readonly #select: HTMLSelectElement;
  readonly #error: HTMLDivElement;
  readonly #submit: (request: FieldViewSubmission) => void;
  #pending: PendingFieldView | null = null;

  constructor(submit: (request: FieldViewSubmission) => void) {
    this.#submit = submit;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "d9-field-view-dialog";
    this.#dialog.setAttribute("aria-labelledby", "d9-field-view-title");

    const form = document.createElement("form");
    form.method = "dialog";

    this.#title = document.createElement("h2");
    this.#title.id = "d9-field-view-title";
    this.#title.textContent = "Create view";

    const label = document.createElement("label");
    label.textContent = "Interpret as";
    this.#select = document.createElement("select");
    this.#select.name = "interpretation";
    for (const [value, text] of [
      ["intervals", "Intervals"],
      ["points", "Points"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.#select.append(option);
    }
    label.append(this.#select);

    this.#error = document.createElement("div");
    this.#error.className = "d9-field-view-error";
    this.#error.setAttribute("role", "alert");
    this.#error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "d9-field-view-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const create = document.createElement("button");
    create.type = "submit";
    create.className = "is-primary";
    create.textContent = "Create";
    actions.append(cancel, create);

    form.append(this.#title, label, this.#error, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#pending === null) return;
      try {
        this.#submit({
          ...this.#pending,
          interpretation: this.#select.value as FieldViewInterpretation,
        });
        this.close();
      } catch (error) {
        this.#error.textContent = message(error);
        this.#error.hidden = false;
      }
    });
    this.#dialog.addEventListener("click", (event) => {
      if (event.target === this.#dialog) this.close();
    });
    this.#dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.stopPropagation();
    });
    this.#dialog.addEventListener("close", () => {
      this.#pending = null;
      this.#error.hidden = true;
      this.#error.textContent = "";
    });
    this.#dialog.append(form);
    document.body.append(this.#dialog);
  }

  open(request: PendingFieldView): void {
    this.#pending = request;
    this.#title.textContent = `${request.event.name} · ${request.field}`;
    this.#select.value = "intervals";
    this.#error.hidden = true;
    this.#error.textContent = "";
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#select.focus();
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close();
    else this.#pending = null;
  }
}

window.Dial9ViewerExtensions = new LegacyViewerExtensions();
