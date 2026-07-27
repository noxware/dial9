import {
  ExtensionCoordinator,
  type ExtensionCoordinatorOptions,
  type ExtensionModuleSource,
  type ExtensionRunResult,
} from "./coordinator.js";
import {
  ExtensionPanel,
  type PanelPresentation,
  type PanelViewport,
  type PresentedValue,
} from "./panel.js";

const DEFAULT_REPLAY_CHUNK_BYTES = 256 * 1024;

export interface LegacyViewerExtensionHost {
  /** New extension panels are inserted immediately before this element. */
  readonly panelAnchor: HTMLElement;
  /** The legacy viewer's shared tooltip element. */
  readonly tooltip: HTMLElement;
  /** Position the already-populated tooltip in viewport coordinates. */
  placeTooltip(clientX: number, clientY: number): void;
  /** Schedule the legacy viewer's normal render pass. */
  requestRender(): void;
  /** Keep the legacy viewer's shared time cursor in sync with time panels. */
  setTimePointer(timestamp: number | null): void;
  /** Test/custom-host seam; defaults to the owning window's DPR. */
  devicePixelRatio?(): number;
}

export interface LegacyViewerExtensionRender {
  readonly start: number;
  readonly end: number;
  readonly labelWidth: number;
  readonly rightInset?: number;
}

export interface ViewerExtensionFile {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface CoordinatorHandle {
  feed(chunk: Uint8Array): void;
  finish(): Promise<readonly ExtensionRunResult[]>;
  abort(): void;
}

interface CoordinatorFactoryOptions {
  readonly onResult: NonNullable<ExtensionCoordinatorOptions["onResult"]>;
  readonly createInstanceId: NonNullable<
    ExtensionCoordinatorOptions["createInstanceId"]
  >;
}

type CoordinatorFactory = (
  sources: readonly ExtensionModuleSource[],
  options: CoordinatorFactoryOptions,
) => CoordinatorHandle;

interface AdapterOptions {
  readonly replayChunkBytes?: number;
  readonly createCoordinator?: CoordinatorFactory;
}

interface QueuedSource {
  readonly source: ExtensionModuleSource;
  readonly order: number;
}

interface TraceSession {
  readonly generation: number;
  readonly coordinators: Set<CoordinatorHandle>;
  readonly lateSources: QueuedSource[];
  state: "streaming" | "finished";
  retainedBytes?: Uint8Array;
}

interface PanelView {
  readonly order: number;
  readonly panelIndex: number;
  readonly instanceId: string;
  readonly element: HTMLElement;
  canvas: HTMLCanvasElement | undefined;
  readonly swatches: HTMLElement;
  readonly readout: HTMLElement;
  error: HTMLElement | undefined;
  panel: ExtensionPanel | undefined;
  viewport?: PanelViewport;
  pointerValue: number | null;
  collapsed: boolean;
}

interface DeferredResult {
  readonly generation: number;
  readonly order: number;
  readonly result: ExtensionRunResult;
}

function defaultCoordinatorFactory(
  sources: readonly ExtensionModuleSource[],
  options: CoordinatorFactoryOptions,
): CoordinatorHandle {
  return new ExtensionCoordinator(sources, options);
}

function ownedBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function exactView(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Thin lifecycle and DOM adapter between the classic viewer and the generic
 * extension coordinator/panel engine.
 *
 * Trace bytes passed to `feed` and `finish` are the raw, decompressed D9TF
 * stream. `finish` retains the supplied view (without another full-trace copy)
 * so a module dropped after the trace can replay it in bounded messages.
 */
export class LegacyViewerExtensionAdapter {
  readonly #replayChunkBytes: number;
  readonly #createCoordinator: CoordinatorFactory;
  readonly #pendingSources: QueuedSource[] = [];
  readonly #views: PanelView[] = [];
  readonly #deferredResults: DeferredResult[] = [];
  #host: LegacyViewerExtensionHost | undefined;
  #active: TraceSession | undefined;
  #generation = 0;
  #nextSourceOrder = 0;
  #lastRender: LegacyViewerExtensionRender | undefined;
  #tooltipOwner: PanelView | undefined;

  constructor(options: AdapterOptions = {}) {
    const replayChunkBytes =
      options.replayChunkBytes ?? DEFAULT_REPLAY_CHUNK_BYTES;
    if (!Number.isSafeInteger(replayChunkBytes) || replayChunkBytes <= 0) {
      throw new Error("replayChunkBytes must be a positive safe integer");
    }
    this.#replayChunkBytes = replayChunkBytes;
    this.#createCoordinator =
      options.createCoordinator ?? defaultCoordinatorFactory;
  }

  configure(host: LegacyViewerExtensionHost): void {
    if (this.#host !== undefined && this.#host !== host) {
      throw new Error("Legacy viewer extension adapter is already configured");
    }
    if (host.panelAnchor.ownerDocument !== host.tooltip.ownerDocument) {
      throw new Error("Extension panel anchor and tooltip must share a document");
    }
    this.#host = host;
    const deferred = this.#deferredResults.splice(0);
    for (const item of deferred) {
      this.#publish(item.generation, item.order, item.result);
    }
  }

  /**
   * Start a new logical trace load and consume every module dropped while no
   * trace was active. The returned generation should be passed to subsequent
   * calls so stale asynchronous loads cannot feed a replacement trace.
   */
  beginTrace(): number {
    this.#generation += 1;
    this.#cancelActive();
    this.#removeViews();

    const session: TraceSession = {
      generation: this.#generation,
      coordinators: new Set(),
      lateSources: [],
      state: "streaming",
    };
    this.#active = session;

    const pending = this.#pendingSources.splice(0);
    if (pending.length > 0) this.#startCoordinator(session, pending);
    return session.generation;
  }

  feed(chunk: Uint8Array, generation = this.#active?.generation): void {
    const session = this.#matchingStreamingSession(generation);
    if (session === undefined || chunk.byteLength === 0) return;
    for (const coordinator of session.coordinators) {
      coordinator.feed(chunk);
    }
  }

  /**
   * Finish the current logical trace. `bytes` must be the decompressed D9TF
   * bytes retained by the viewer; the adapter aliases them and never transfers
   * their buffer.
   */
  finish(
    bytes: ArrayBuffer | Uint8Array,
    generation = this.#active?.generation,
  ): void {
    const session = this.#matchingStreamingSession(generation);
    if (session === undefined) return;
    const retained = exactView(bytes);
    if (isGzip(retained)) {
      throw new Error("Viewer extensions require decompressed D9TF bytes");
    }

    session.state = "finished";
    session.retainedBytes = retained;
    for (const coordinator of session.coordinators) {
      void coordinator.finish();
    }

    const lateSources = session.lateSources.splice(0);
    if (lateSources.length > 0) {
      this.#startReplay(session, lateSources);
    }
  }

  abortTrace(generation = this.#active?.generation): void {
    if (
      generation === undefined ||
      this.#active?.generation !== generation
    ) {
      return;
    }
    this.#cancelActive();
    this.#removeViews();
  }

  /** Clear active and pending extensions, as when the viewer returns to empty. */
  clear(): void {
    this.#generation += 1;
    this.#cancelActive();
    this.#pendingSources.length = 0;
    this.#deferredResults.length = 0;
    this.#removeViews();
  }

  /**
   * Load one module. With no trace it waits for `beginTrace`; while a trace is
   * loading it is associated with that load and replayed at `finish`; after a
   * trace it immediately replays the retained decompressed bytes.
   */
  async loadWasm(
    file: ViewerExtensionFile,
  ): Promise<"pending" | "running"> {
    const generationAtDrop = this.#active?.generation;
    const source: QueuedSource = {
      source: {
        fileName: file.name,
        wasm: ownedBytes(new Uint8Array(await file.arrayBuffer())),
      },
      order: this.#nextSourceOrder++,
    };
    const session = this.#active;
    if (
      generationAtDrop !== undefined &&
      session?.generation !== generationAtDrop
    ) {
      // The module belonged to a trace which was replaced while File.arrayBuffer
      // was pending. Do not let that stale drop leak into the replacement.
      return "running";
    }
    if (session === undefined) {
      this.#pendingSources.push(source);
      return "pending";
    }
    if (session.state === "streaming") {
      session.lateSources.push(source);
      return "running";
    }
    this.#startReplay(session, [source]);
    return "running";
  }

  /** Render every published panel using viewer-owned dimensions and DPR. */
  render(viewport: LegacyViewerExtensionRender): void {
    this.#lastRender = viewport;
    const host = this.#host;
    if (host === undefined) return;

    for (const view of this.#views) {
      if (
        view.collapsed ||
        view.canvas === undefined ||
        view.panel === undefined
      ) {
        continue;
      }
      const width = view.element.clientWidth;
      const height = view.element.clientHeight;
      if (width <= 0 || height <= 0) continue;

      const dprCandidate =
        host.devicePixelRatio?.() ??
        view.element.ownerDocument.defaultView?.devicePixelRatio ??
        1;
      const dpr =
        Number.isFinite(dprCandidate) && dprCandidate > 0 ? dprCandidate : 1;
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (view.canvas.width !== pixelWidth) view.canvas.width = pixelWidth;
      if (view.canvas.height !== pixelHeight) view.canvas.height = pixelHeight;
      view.canvas.style.width = `${width}px`;
      view.canvas.style.height = `${height}px`;

      const context = view.canvas.getContext("2d");
      if (context === null) continue;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const panelViewport: PanelViewport = {
        start: viewport.start,
        end: viewport.end,
        width,
        height,
        labelWidth: viewport.labelWidth,
        ...(viewport.rightInset === undefined
          ? {}
          : { rightInset: viewport.rightInset }),
      };
      view.viewport = panelViewport;
      try {
        view.panel.render(context, panelViewport);
        this.#renderPresentation(view);
      } catch (error) {
        this.#failView(view, error);
      }
    }
  }

  #matchingStreamingSession(
    generation: number | undefined,
  ): TraceSession | undefined {
    const session = this.#active;
    return generation !== undefined &&
      session?.generation === generation &&
      session.state === "streaming"
      ? session
      : undefined;
  }

  #startReplay(
    session: TraceSession,
    sources: readonly QueuedSource[],
  ): void {
    const bytes = session.retainedBytes;
    if (bytes === undefined) {
      session.lateSources.push(...sources);
      return;
    }
    const coordinator = this.#startCoordinator(session, sources);
    for (let offset = 0; offset < bytes.byteLength; offset += this.#replayChunkBytes) {
      coordinator.feed(
        bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + this.#replayChunkBytes),
        ),
      );
    }
    void coordinator.finish();
  }

  #startCoordinator(
    session: TraceSession,
    sources: readonly QueuedSource[],
  ): CoordinatorHandle {
    const instanceIds = sources.map(
      (source) =>
        `viewer-extension-${session.generation}-${source.order}`,
    );
    const orderByInstance = new Map(
      instanceIds.map((instanceId, index) => [
        instanceId,
        sources[index]!.order,
      ]),
    );
    let instanceIndex = 0;
    const coordinator = this.#createCoordinator(
      sources.map((source) => source.source),
      {
        createInstanceId: () => {
          const instanceId = instanceIds[instanceIndex];
          if (instanceId === undefined) {
            throw new Error("Extension coordinator requested too many IDs");
          }
          instanceIndex += 1;
          return instanceId;
        },
        onResult: (result) => {
          const order = orderByInstance.get(result.instanceId);
          if (order === undefined) return;
          this.#publish(session.generation, order, result);
        },
      },
    );
    session.coordinators.add(coordinator);
    return coordinator;
  }

  #publish(
    generation: number,
    order: number,
    result: ExtensionRunResult,
  ): void {
    if (this.#active?.generation !== generation) return;
    if (result.status === "aborted") return;
    if (this.#host === undefined) {
      this.#deferredResults.push({ generation, order, result });
      return;
    }

    if (result.status === "error") {
      this.#addView(
        this.#createPanelView({
          order,
          panelIndex: 0,
          instanceId: result.instanceId,
          title: result.fileName,
          error: result.error.message,
        }),
      );
      return;
    }

    result.manifest.panels.forEach((spec, panelIndex) => {
      try {
        const panel = new ExtensionPanel(
          result.instanceId,
          result.store,
          spec,
          panelIndex,
        );
        this.#addView(
          this.#createPanelView({
            order,
            panelIndex,
            instanceId: result.instanceId,
            title: spec.title,
            panel,
            ...(panel.error === undefined ? {} : { error: panel.error }),
          }),
        );
      } catch (error) {
        this.#addView(
          this.#createPanelView({
            order,
            panelIndex,
            instanceId: result.instanceId,
            title: spec.title,
            error: asMessage(error),
          }),
        );
      }
    });
  }

  #createPanelView(options: {
    readonly order: number;
    readonly panelIndex: number;
    readonly instanceId: string;
    readonly title: string;
    readonly panel?: ExtensionPanel;
    readonly error?: string;
  }): PanelView {
    const host = this.#host;
    if (host === undefined) {
      throw new Error("Legacy viewer extension adapter is not configured");
    }
    const document = host.panelAnchor.ownerDocument;
    const element = document.createElement("section");
    element.className = "viewer-extension-panel foldable-panel";
    element.dataset["extensionInstance"] = options.instanceId;
    element.dataset["extensionPanel"] = String(options.panelIndex);
    element.dataset["xAxis"] =
      options.panel?.spec.x_axis.type ?? "none";
    element.setAttribute("aria-label", options.title);

    const label = document.createElement("div");
    label.className = "chart-label";
    label.setAttribute("role", "button");
    label.setAttribute("tabindex", "0");
    label.setAttribute("aria-expanded", "true");

    const title = document.createElement("span");
    title.className = "viewer-extension-title";
    title.textContent = options.title;
    const swatches = document.createElement("span");
    swatches.className = "viewer-extension-swatches panel-expanded-label";
    const readout = document.createElement("span");
    readout.className = "viewer-extension-readout panel-expanded-label";
    label.append(title, swatches, readout);
    element.appendChild(label);

    let errorElement: HTMLElement | undefined;
    let canvas: HTMLCanvasElement | undefined;
    if (options.error !== undefined) {
      errorElement = document.createElement("div");
      errorElement.className = "viewer-extension-error";
      errorElement.textContent = options.error;
      element.appendChild(errorElement);
    } else {
      canvas = document.createElement("canvas");
      canvas.className = "viewer-extension-canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", options.title);
      element.appendChild(canvas);
    }

    const view: PanelView = {
      order: options.order,
      panelIndex: options.panelIndex,
      instanceId: options.instanceId,
      element,
      canvas,
      swatches,
      readout,
      error: errorElement,
      panel: options.panel,
      pointerValue: null,
      collapsed: false,
    };

    const toggle = (): void => {
      view.collapsed = !view.collapsed;
      element.classList.toggle("is-collapsed", view.collapsed);
      label.setAttribute("aria-expanded", view.collapsed ? "false" : "true");
      host.requestRender();
    };
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    element.addEventListener("click", () => {
      if (view.collapsed) toggle();
    });

    if (canvas !== undefined && options.panel !== undefined) {
      canvas.addEventListener("mousemove", (event) => {
        try {
          this.#pointerMove(view, event);
        } catch (error) {
          this.#failView(view, error);
        }
      });
      canvas.addEventListener("mouseleave", () => {
        try {
          this.#pointerLeave(view);
        } catch (error) {
          this.#failView(view, error);
        }
      });
    }
    return view;
  }

  #addView(view: PanelView): void {
    const host = this.#host;
    if (host === undefined) return;
    this.#views.push(view);
    this.#views.sort(
      (left, right) =>
        left.order - right.order ||
        left.panelIndex - right.panelIndex,
    );
    for (const candidate of this.#views) {
      host.panelAnchor.before(candidate.element);
    }
    host.requestRender();
  }

  #pointerMove(view: PanelView, event: MouseEvent): void {
    const host = this.#host;
    const panel = view.panel;
    const canvas = view.canvas;
    const viewport = view.viewport;
    if (
      host === undefined ||
      panel === undefined ||
      canvas === undefined ||
      viewport === undefined ||
      view.collapsed ||
      event.buttons !== 0
    ) {
      this.#hideTooltip(view, true);
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * viewport.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * viewport.height;
    view.pointerValue = panel.xValueAt(x, viewport);
    this.#renderPresentation(view);
    host.setTimePointer(
      panel.spec.x_axis.type === "time" ? view.pointerValue : null,
    );

    const hit = panel.hitTest(x, y, viewport);
    const items = hit === undefined ? [] : panel.tooltip(hit);
    if (items.length === 0) {
      this.#hideTooltip(view, true);
      return;
    }
    this.#showTooltip(view, items, event.clientX, event.clientY);
  }

  #pointerLeave(view: PanelView): void {
    view.pointerValue = null;
    this.#renderPresentation(view);
    this.#host?.setTimePointer(null);
    this.#hideTooltip(view);
  }

  #showTooltip(
    view: PanelView,
    items: readonly PresentedValue[],
    clientX: number,
    clientY: number,
  ): void {
    const host = this.#host;
    if (host === undefined) return;
    const document = host.tooltip.ownerDocument;
    const rows = items.map((item) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = `${item.label}:`;
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = item.value;
      row.append(label, document.createTextNode(" "), value);
      return row;
    });
    host.tooltip.replaceChildren(...rows);
    host.tooltip.style.display = "block";
    this.#tooltipOwner = view;
    host.placeTooltip(clientX, clientY);
  }

  #hideTooltip(view?: PanelView, force = false): void {
    if (
      !force &&
      (this.#tooltipOwner === undefined ||
        (view !== undefined && this.#tooltipOwner !== view))
    ) {
      return;
    }
    const tooltip = this.#host?.tooltip;
    if (tooltip !== undefined) tooltip.style.display = "none";
    this.#tooltipOwner = undefined;
  }

  #renderPresentation(view: PanelView): void {
    const panel = view.panel;
    const viewport = view.viewport;
    if (panel === undefined || viewport === undefined) return;
    const presentation = panel.presentation(viewport, view.pointerValue);
    this.#renderSwatches(view, presentation);
    this.#renderReadout(view, presentation);
  }

  #renderSwatches(
    view: PanelView,
    presentation: PanelPresentation,
  ): void {
    const document = view.element.ownerDocument;
    const children = presentation.swatches.map((item) => {
      const container = document.createElement("span");
      container.className = "viewer-extension-swatch-item";
      const swatch = document.createElement("span");
      swatch.className =
        `viewer-extension-swatch is-${item.sample}`;
      swatch.style.color = item.color;
      if (item.sample === "area") {
        swatch.style.backgroundColor = item.color;
        swatch.style.borderColor = item.color;
      } else {
        swatch.style.backgroundColor = item.color;
      }
      const text = document.createElement("span");
      text.textContent =
        item.value === undefined
          ? item.label
          : `${item.label} ${item.value}`;
      container.append(swatch, text);
      return container;
    });
    view.swatches.replaceChildren(...children);
  }

  #renderReadout(
    view: PanelView,
    presentation: PanelPresentation,
  ): void {
    const document = view.element.ownerDocument;
    const children: Node[] = [];
    presentation.readout.forEach((item, index) => {
      if (index > 0) children.push(document.createTextNode(" · "));
      const container = document.createElement("span");
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("span");
      value.textContent = item.value;
      container.append(label, document.createTextNode(" "), value);
      children.push(container);
    });
    view.readout.replaceChildren(...children);
  }

  #failView(view: PanelView, error: unknown): void {
    view.panel = undefined;
    if (view.canvas !== undefined) {
      view.canvas.remove();
      view.canvas = undefined;
    }
    if (view.error === undefined) {
      view.error = view.element.ownerDocument.createElement("div");
      view.error.className = "viewer-extension-error";
      view.element.appendChild(view.error);
    }
    view.error.textContent = asMessage(error);
    view.swatches.replaceChildren();
    view.readout.replaceChildren();
    this.#hideTooltip(view, true);
  }

  #cancelActive(): void {
    const session = this.#active;
    this.#active = undefined;
    if (session === undefined) return;
    for (const coordinator of session.coordinators) coordinator.abort();
    session.coordinators.clear();
    session.lateSources.length = 0;
    delete session.retainedBytes;
  }

  #removeViews(): void {
    this.#hideTooltip();
    for (const view of this.#views) view.element.remove();
    this.#views.length = 0;
    this.#lastRender = undefined;
    this.#host?.setTimePointer(null);
  }
}
