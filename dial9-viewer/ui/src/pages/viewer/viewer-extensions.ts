import type { CustomTraceEvent } from "../../lib/trace/index.js";
import { LABEL_W } from "../../lib/canvas/index.js";
import { lanesScrollbarWidth } from "../../lib/canvas/track-layout.js";
import {
  createTooltip,
  tooltipRowsTemplate,
} from "../../components/overlay/tooltip.js";
import type { ViewerStore } from "../../store/store.js";
import {
  fieldViewNumber,
  materializeFieldView,
  type FieldViewInterpretation,
} from "../../lib/viewer-extensions/field-view.js";
import {
  ViewerExtensionManager,
  type ViewerExtensionSnapshot,
} from "../../lib/viewer-extensions/manager.js";
import {
  SemanticPanelRenderer,
  type PanelViewport,
  type SemanticPanelSource,
  type SemanticPanelTooltip,
} from "../../lib/viewer-extensions/panel-renderer.js";
import type { PanelManifest } from "../../lib/viewer-extensions/types.js";
import { deriveAxisInputs, fmtAxisTick } from "./axis.js";

export interface ViewerExtensionStatus {
  show(message: string, error: boolean): void;
  hide(): void;
}

export interface ViewerExtensionsController {
  loadFile(file: File): Promise<void>;
  canGraphField(value: unknown): boolean;
  openFieldView(event: CustomTraceEvent, field: string): void;
  processTraceBuffer(
    buffer: ArrayBuffer | Uint8Array,
    replacing: boolean,
  ): void;
  dispose(): void;
}

interface LocalFieldPanel {
  readonly id: string;
  readonly source: SemanticPanelSource;
  readonly panel: PanelManifest;
}

/**
 * Mount the viewer-extension lifecycle into the new viewer's dynamic track
 * host. The manager owns untrusted WASM workers and immutable table stores;
 * this controller owns only viewer presentation and local field views.
 */
export function mountViewerExtensions(
  host: HTMLElement,
  trackColumn: HTMLElement,
  store: ViewerStore,
  status: ViewerExtensionStatus,
): ViewerExtensionsController {
  host.style.setProperty("--d9-label-w", `${LABEL_W}px`);
  let renderers: SemanticPanelRenderer[] = [];
  let failurePanels: HTMLElement[] = [];
  let fieldPanels: LocalFieldPanel[] = [];
  let mountedSignature = "";
  let nextFieldPanelId = 1;
  let frame = 0;
  let scheduledSnapshot: ViewerExtensionSnapshot | null = null;
  let disposed = false;

  const tooltipHandle = createTooltip(host.ownerDocument);
  const tooltip: SemanticPanelTooltip = {
    show(rows, cursor): void {
      tooltipHandle.show(
        tooltipRowsTemplate(
          rows.map((row) => [
            { label: row.label, value: row.value },
          ]),
        ),
        cursor,
      );
    },
    hide(): void {
      tooltipHandle.hide();
    },
  };

  const manager = new ViewerExtensionManager({
    onChange: (snapshot) => scheduleSynchronize(snapshot),
  });
  const dialog = new FieldViewDialog(host.ownerDocument, (request) => {
    const unit = request.event.units?.[request.field];
    const materialized = materializeFieldView(request.events, {
      eventName: request.event.name,
      field: request.field,
      ...(unit === undefined ? {} : { unit }),
      interpretation: request.interpretation,
    });
    const id = `field-view-${nextFieldPanelId++}`;
    fieldPanels.push({
      id,
      source: {
        identity: { id, name: id },
        tables: materialized.tables,
      },
      panel: materialized.panel,
    });
    synchronize(manager.snapshot());
  });

  const unsubscribe = store.subscribe(
    ["trace", "viewport", "uiPrefs"],
    () => scheduleSynchronize(manager.snapshot()),
  );

  function scheduleSynchronize(snapshot: ViewerExtensionSnapshot): void {
    if (disposed) return;
    scheduledSnapshot = snapshot;
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const latest = scheduledSnapshot;
      scheduledSnapshot = null;
      if (latest !== null) synchronize(latest);
    });
  }

  function synchronize(snapshot: ViewerExtensionSnapshot): void {
    if (disposed) return;
    const signature = JSON.stringify({
      extensions: snapshot.extensions.map((extension) => extension.identity.id),
      failures: snapshot.failures.map((failure) => [
        failure.identity.id,
        failure.message,
      ]),
      fieldPanels: fieldPanels.map((panel) => panel.id),
    });
    if (signature !== mountedSignature) {
      mountedSignature = signature;
      mountPanels(snapshot);
    }
    renderPanels();

    const failure = snapshot.failures.at(-1);
    if (failure !== undefined) {
      status.show(`${failure.identity.name}: ${failure.message}`, true);
    } else if (snapshot.pending > 0) {
      status.show(
        `${snapshot.pending} viewer extension${snapshot.pending === 1 ? "" : "s"} waiting or processing…`,
        false,
      );
    } else {
      status.hide();
    }
  }

  function mountPanels(snapshot: ViewerExtensionSnapshot): void {
    for (const renderer of renderers) renderer.destroy();
    renderers = [];
    for (const panel of failurePanels) panel.remove();
    failurePanels = [];

    for (const extension of snapshot.extensions) {
      for (const [panelIndex, panel] of extension.manifest.panels.entries()) {
        const renderer = new SemanticPanelRenderer(
          extension,
          panel,
          panelIndex,
          tooltip,
        );
        host.append(renderer.element);
        renderers.push(renderer);
      }
    }
    for (const fieldPanel of fieldPanels) {
      const renderer = new SemanticPanelRenderer(
        fieldPanel.source,
        fieldPanel.panel,
        0,
        tooltip,
        {
          onClose: () => removeFieldPanel(fieldPanel.id),
          persistCollapse: false,
        },
      );
      host.append(renderer.element);
      renderers.push(renderer);
    }
    for (const failure of snapshot.failures) {
      const panel = failurePanel(
        host.ownerDocument,
        failure.identity.name,
        failure.message,
      );
      host.append(panel);
      failurePanels.push(panel);
    }
  }

  function renderPanels(): void {
    const state = store.getState();
    const trace = state.trace.trace;
    const viewport: PanelViewport | null =
      trace === null
        ? null
        : {
            start: state.viewport.viewStart,
            end: state.viewport.viewEnd,
            labelWidth: LABEL_W,
            scrollbarWidth: lanesScrollbarWidth(trackColumn),
            formatTimestamp: (timestamp) =>
              fmtAxisTick(deriveAxisInputs(store.getState()), timestamp, false),
          };
    for (const renderer of renderers) renderer.render(viewport);
  }

  function removeFieldPanel(id: string): void {
    const next = fieldPanels.filter((panel) => panel.id !== id);
    if (next.length === fieldPanels.length) return;
    fieldPanels = next;
    synchronize(manager.snapshot());
  }

  return {
    async loadFile(file): Promise<void> {
      if (!file.name.toLowerCase().endsWith(".wasm")) {
        throw new Error("viewer extensions must be .wasm files");
      }
      status.show(`Loading viewer extension ${file.name}…`, false);
      try {
        manager.loadModule(file.name, await file.arrayBuffer());
      } catch (error) {
        synchronize(manager.snapshot());
        throw error;
      }
    },
    canGraphField(value): boolean {
      return fieldViewNumber(value) !== null;
    },
    openFieldView(event, field): void {
      const events = store.getState().trace.trace?.customEvents;
      if (events === undefined) {
        throw new Error("load a trace before creating a field view");
      }
      if (fieldViewNumber(event.fields?.[field]) === null) {
        throw new Error(`${event.name}.${field} is not a finite numeric field`);
      }
      dialog.open({ event, field, events });
    },
    processTraceBuffer(buffer, replacing): void {
      if (replacing) {
        fieldPanels = [];
        dialog.close();
      }
      manager.processTraceBuffer(buffer, replacing);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      unsubscribe();
      manager.clear();
      for (const renderer of renderers) renderer.destroy();
      for (const panel of failurePanels) panel.remove();
      dialog.dispose();
      tooltipHandle.dispose();
      host.replaceChildren();
      status.hide();
    },
  };
}

function failurePanel(
  document: Document,
  name: string,
  error: string,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "d9-extension-panel is-error";
  const label = document.createElement("div");
  label.className = "d9-extension-label";
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

  constructor(
    document: Document,
    submit: (request: FieldViewSubmission) => void,
  ) {
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
      ["gauge", "Gauge"],
      ["counter", "Counter"],
      ["up-down-counter", "Up/down counter"],
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
    this.#select.value = "gauge";
    this.#error.hidden = true;
    this.#error.textContent = "";
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#select.focus();
  }

  close(): void {
    if (this.#dialog.open) this.#dialog.close();
    else this.#pending = null;
  }

  dispose(): void {
    this.close();
    this.#dialog.remove();
  }
}
