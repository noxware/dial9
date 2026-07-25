import {
  ExtensionCoordinator,
  type ExtensionLoadResult,
  type ExtensionModuleSource,
  type PublishedExtension,
} from "./coordinator.js";
import {
  ExtensionPanel,
  type PanelViewport,
  type PresentedSwatch,
  type PresentedValue,
} from "./panel.js";

export interface LegacyExtensionHooks {
  readonly requestRender: () => void;
  readonly setPointerTime: (timestamp: number | null) => void;
}

export interface LegacyExtensionRenderState {
  readonly start: number;
  readonly end: number;
  readonly labelWidth: number;
  readonly scrollbarWidth: number;
}

export interface LegacyTraceExtensionLoad {
  feed(chunk: Uint8Array): void;
  finish(rawTrace: ArrayBuffer): Promise<readonly ExtensionLoadResult[]>;
  abort(): void;
}

export type WasmDropResult = "pending" | "loaded";

interface MountedPanel {
  readonly model: ExtensionPanel;
  readonly section: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly swatches: HTMLSpanElement;
  readonly readout: HTMLSpanElement;
  pointerX: number | null;
  viewport?: PanelViewport;
  presentationSignature?: string;
}

const REPLAY_CHUNK_BYTES = 1024 * 1024;

function appendPresentedValues(
  container: HTMLElement,
  values: readonly PresentedValue[],
): void {
  container.replaceChildren();
  values.forEach((item, index) => {
    if (index !== 0) container.append(" · ");
    const label = document.createElement("span");
    label.className = "dial9-extension-value-label";
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "dial9-extension-value";
    value.textContent = item.value;
    container.append(label, " ", value);
  });
}

function swatchElement(item: PresentedSwatch): HTMLSpanElement {
  const entry = document.createElement("span");
  entry.className = "dial9-extension-swatch";
  const sample = document.createElement("span");
  sample.className = `dial9-extension-swatch-sample is-${item.sample}`;
  sample.style.setProperty("--dial9-extension-color", item.color);
  if (item.line_width !== undefined) {
    sample.style.setProperty(
      "--dial9-extension-line-width",
      `${item.line_width}px`,
    );
  }
  if (item.dash !== undefined) {
    sample.classList.add("is-dashed");
  }
  const text = document.createElement("span");
  text.textContent =
    item.value === undefined ? item.label : `${item.label} (${item.value})`;
  entry.append(sample, text);
  return entry;
}

function placeTooltip(tooltip: HTMLElement, event: MouseEvent): void {
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = Math.max(
    8,
    Math.min(event.clientX + 12, window.innerWidth - width - 8),
  );
  let top = event.clientY + 16;
  if (top + height > window.innerHeight - 8) {
    top = event.clientY - height - 8;
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function showTooltip(
  tooltip: HTMLElement,
  rows: readonly PresentedValue[],
  event: MouseEvent,
): void {
  if (rows.length === 0) {
    tooltip.style.display = "none";
    return;
  }
  tooltip.replaceChildren();
  rows.forEach((row, index) => {
    if (index !== 0) tooltip.append(document.createElement("br"));
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${row.label}:`;
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = row.value;
    tooltip.append(label, " ", value);
  });
  tooltip.style.display = "block";
  placeTooltip(tooltip, event);
}

function moduleErrorPanel(result: Exclude<ExtensionLoadResult, PublishedExtension>) {
  const section = document.createElement("div");
  section.className = "dial9-extension-panel dial9-extension-error-panel";
  const title = document.createElement("div");
  title.className = "chart-label";
  title.textContent = result.file_name;
  const error = document.createElement("div");
  error.className = "dial9-extension-panel-error";
  error.textContent =
    result.status === "error" ? result.error : "Extension load was aborted";
  section.append(title, error);
  return section;
}

export class LegacyViewerExtensionAdapter {
  #hooks: LegacyExtensionHooks | undefined;
  #pendingModules: ExtensionModuleSource[] = [];
  #activeCoordinator: ExtensionCoordinator | undefined;
  #generation = 0;
  #currentTrace: ArrayBuffer | undefined;
  #results: ExtensionLoadResult[] = [];
  #mounted: MountedPanel[] = [];
  #lastRender: LegacyExtensionRenderState | undefined;

  configure(hooks: LegacyExtensionHooks): void {
    this.#hooks = hooks;
  }

  beginTrace(): LegacyTraceExtensionLoad {
    this.#activeCoordinator?.abort();
    const generation = ++this.#generation;
    const modules = this.#pendingModules;
    this.#pendingModules = [];
    this.#currentTrace = undefined;
    this.#results = [];
    this.#clearPanels();
    const coordinator = new ExtensionCoordinator({ modules });
    this.#activeCoordinator = coordinator;
    let finished = false;
    return {
      feed: (chunk): void => {
        if (finished) throw new Error("extension trace load is already finished");
        coordinator.feed(chunk);
      },
      finish: async (rawTrace): Promise<readonly ExtensionLoadResult[]> => {
        if (finished) throw new Error("extension trace load is already finished");
        finished = true;
        this.#currentTrace = rawTrace;
        const results = await coordinator.finish();
        if (generation !== this.#generation) return results;
        this.#activeCoordinator = undefined;
        this.#results = [...results];
        this.#mountResults();
        this.#hooks?.requestRender();
        return results;
      },
      abort: (): void => {
        finished = true;
        coordinator.abort();
      },
    };
  }

  async normalizeAndFeed(
    input: ArrayBuffer,
    load: LegacyTraceExtensionLoad,
  ): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(input);
    const gzipped =
      bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!gzipped) {
      load.feed(bytes);
      return input;
    }
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Gzip trace extensions require DecompressionStream");
    }
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      load.feed(value);
    }
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return raw.buffer;
  }

  async loadWasm(file: File): Promise<WasmDropResult> {
    const module: ExtensionModuleSource = {
      name: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    };
    const trace = this.#currentTrace;
    if (trace === undefined) {
      this.#pendingModules.push(module);
      return "pending";
    }

    const generation = this.#generation;
    const coordinator = new ExtensionCoordinator({
      discoverEmbedded: false,
      modules: [module],
    });
    const bytes = new Uint8Array(trace);
    for (let offset = 0; offset < bytes.byteLength; offset += REPLAY_CHUNK_BYTES) {
      coordinator.feed(
        bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + REPLAY_CHUNK_BYTES),
        ),
      );
    }
    const results = await coordinator.finish();
    if (generation !== this.#generation) return "loaded";
    this.#results.push(...results);
    this.#mountResults();
    this.#hooks?.requestRender();
    return "loaded";
  }

  render(state: LegacyExtensionRenderState): void {
    this.#lastRender = state;
    for (const panel of this.#mounted) this.#renderPanel(panel, state);
  }

  reset(): void {
    this.#generation += 1;
    this.#activeCoordinator?.abort();
    this.#activeCoordinator = undefined;
    this.#pendingModules = [];
    this.#currentTrace = undefined;
    this.#results = [];
    this.#lastRender = undefined;
    this.#clearPanels();
  }

  #container(): HTMLElement {
    const container = document.getElementById("viewer-extension-panels");
    if (container === null) {
      throw new Error("Missing #viewer-extension-panels");
    }
    return container;
  }

  #clearPanels(): void {
    this.#mounted = [];
    this.#container().replaceChildren();
  }

  #mountResults(): void {
    const container = this.#container();
    this.#mounted = [];
    container.replaceChildren();
    for (const result of this.#results) {
      if (result.status !== "complete") {
        container.append(moduleErrorPanel(result));
        continue;
      }
      result.manifest.panels.forEach((spec, panelIndex) => {
        const model = new ExtensionPanel(
          result.instance_id,
          result.manifest,
          result.store,
          spec,
          panelIndex,
        );
        const section = document.createElement("div");
        section.className = "foldable-panel dial9-extension-panel";
        section.dataset["extensionInstance"] = result.instance_id;
        section.dataset["extensionPanel"] = String(panelIndex);
        section.style.height = `${spec.height ?? 96}px`;

        const label = document.createElement("div");
        label.className = "chart-label";
        const title = document.createElement("span");
        title.className = "dial9-extension-title";
        title.textContent = spec.title;
        const swatches = document.createElement("span");
        swatches.className =
          "dial9-extension-swatches panel-expanded-label";
        label.append(title, swatches);

        const readout = document.createElement("span");
        readout.className =
          "dial9-extension-readout panel-expanded-label";
        const canvas = document.createElement("canvas");
        section.append(label, readout);
        if (model.error !== undefined) {
          const error = document.createElement("div");
          error.className = "dial9-extension-panel-error";
          error.textContent = model.error;
          section.append(error);
        } else {
          section.append(canvas);
        }
        const mounted: MountedPanel = {
          model,
          section,
          canvas,
          swatches,
          readout,
          pointerX: null,
        };
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          section.classList.toggle("is-collapsed");
          this.#hooks?.requestRender();
        });
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          section.classList.toggle("is-collapsed");
          this.#hooks?.requestRender();
        });
        canvas.addEventListener("mousemove", (event) => {
          const viewport = mounted.viewport;
          if (viewport === undefined) return;
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          mounted.pointerX = model.xValueAt(x, viewport);
          this.#hooks?.setPointerTime(
            spec.x_axis.type === "time" ? mounted.pointerX : null,
          );
          const hit = model.hitTest(x, y, viewport);
          canvas.style.cursor = hit === undefined ? "default" : "crosshair";
          const tooltip = document.getElementById("tooltip");
          if (tooltip !== null) {
            showTooltip(
              tooltip,
              hit === undefined ? [] : model.tooltip(hit),
              event,
            );
          }
          this.#updatePresentation(mounted);
        });
        canvas.addEventListener("mouseleave", () => {
          mounted.pointerX = null;
          canvas.style.cursor = "default";
          this.#hooks?.setPointerTime(null);
          const tooltip = document.getElementById("tooltip");
          if (tooltip !== null) tooltip.style.display = "none";
          this.#updatePresentation(mounted);
        });
        this.#mounted.push(mounted);
        container.append(section);
      });
    }
    if (this.#lastRender !== undefined) this.render(this.#lastRender);
  }

  #renderPanel(
    panel: MountedPanel,
    state: LegacyExtensionRenderState,
  ): void {
    const height = panel.model.spec.height ?? 96;
    panel.section.style.height = `${height}px`;
    const viewport: PanelViewport = {
      start: state.start,
      end: state.end,
      width: panel.section.clientWidth,
      height,
      labelWidth: state.labelWidth,
      rightInset: state.scrollbarWidth,
    };
    panel.viewport = viewport;
    this.#updatePresentation(panel);
    if (panel.model.error !== undefined || panel.section.classList.contains("is-collapsed")) {
      return;
    }
    const ratio = devicePixelRatio || 1;
    panel.canvas.width = viewport.width * ratio;
    panel.canvas.height = height * ratio;
    panel.canvas.style.width = `${viewport.width}px`;
    panel.canvas.style.height = `${height}px`;
    const context = panel.canvas.getContext("2d");
    if (context === null) return;
    context.scale(ratio, ratio);
    panel.model.render(context, viewport);
  }

  #updatePresentation(panel: MountedPanel): void {
    const viewport = panel.viewport;
    if (viewport === undefined || panel.model.error !== undefined) return;
    const presentation = panel.model.presentation(viewport, panel.pointerX);
    const signature = JSON.stringify(presentation);
    if (signature === panel.presentationSignature) return;
    panel.presentationSignature = signature;
    panel.swatches.replaceChildren(
      ...presentation.swatches.map(swatchElement),
    );
    appendPresentedValues(panel.readout, presentation.readout);
  }
}
