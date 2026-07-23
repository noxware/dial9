import type { ViewerStore } from "../../store/store.js";
import type { ParsedTrace } from "../../types/trace.js";
import { DEFAULT_EXTENSION_WASM_POLICY_LIMITS } from "../../lib/trace/extension-wasm-policy.js";
import { integrateViewerExtensionOutputs } from "../../lib/trace/viewer-extension-results.js";
import {
  runLocalViewerExtensions,
  type LocalViewerExtensionRun,
} from "../../lib/trace/viewer-extension-worker/local.js";
import {
  MAX_VIEWER_EXTENSION_COUNT,
  type ViewerExtensionWorkerFactory,
} from "../../lib/trace/viewer-extension-worker/protocol.js";
import type { ViewerExtensionFile } from "./load-controller.js";

export interface DroppedViewerExtensionResult {
  readonly names: readonly string[];
  readonly warnings: readonly string[];
}

export interface DroppedViewerExtensionLoad {
  readonly done: Promise<DroppedViewerExtensionResult>;
  abort(): void;
}

export interface DroppedViewerExtensionOptions {
  readonly worker?: ViewerExtensionWorkerFactory;
}

export function isViewerExtensionFile(file: { readonly name: string }): boolean {
  return /\.wasm$/iu.test(file.name);
}

function moduleName(fileName: string): string {
  return fileName.replace(/\.wasm$/iu, "");
}

function abortError(): DOMException {
  return new DOMException("viewer-extension load aborted", "AbortError");
}

function updatedTrace(
  trace: ParsedTrace,
  viewerExtensions: ParsedTrace["viewerExtensions"],
): ParsedTrace {
  return Object.assign(
    Object.create(Object.getPrototypeOf(trace) as object | null),
    trace,
    { viewerExtensions },
  ) as ParsedTrace;
}

/**
 * Compile dropped modules in the disposable extension worker, stream the
 * retained trace through them, then atomically replace outputs sharing the
 * same filename-derived extension name.
 */
export function loadDroppedViewerExtensions(
  store: ViewerStore,
  traceBuffer: ArrayBuffer,
  files: readonly ViewerExtensionFile[],
  options: DroppedViewerExtensionOptions = {},
): DroppedViewerExtensionLoad {
  const baseTrace = store.getState().trace.trace;
  let child: LocalViewerExtensionRun | null = null;
  let aborted = false;

  const done = (async (): Promise<DroppedViewerExtensionResult> => {
    if (baseTrace === null) throw new Error("load a trace before adding an extension");
    if (files.length === 0) throw new Error("no viewer-extension module was dropped");
    if (files.length > MAX_VIEWER_EXTENSION_COUNT) {
      throw new Error(
        `viewer-extension count exceeds ${MAX_VIEWER_EXTENSION_COUNT}`,
      );
    }

    const names = new Set<string>();
    const modules = await Promise.all(
      files.map(async (file) => {
        if (!isViewerExtensionFile(file)) {
          throw new Error(`${JSON.stringify(file.name)} is not a .wasm file`);
        }
        const name = moduleName(file.name);
        if (name.length === 0) throw new Error("viewer-extension name is empty");
        if (names.has(name)) {
          throw new Error(`duplicate viewer-extension name ${JSON.stringify(name)}`);
        }
        names.add(name);
        if (file.size > DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxModuleBytes) {
          throw new Error(
            `${file.name} is ${file.size} bytes; limit is ` +
              `${DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxModuleBytes}`,
          );
        }
        return { name, buffer: await file.arrayBuffer() };
      }),
    );
    if (aborted) throw abortError();

    child = runLocalViewerExtensions(traceBuffer, modules, {
      ...(options.worker === undefined ? {} : { worker: options.worker }),
    });
    const result = await child.done;
    if (aborted) throw abortError();
    if (store.getState().trace.trace !== baseTrace) throw abortError();

    const integrated = integrateViewerExtensionOutputs(
      baseTrace.viewerExtensions ?? [],
      result.outputs,
      result.warnings,
    );
    if (integrated.acceptedNames.length === 0) {
      throw new Error(
        integrated.warnings.join("; ") ||
          "viewer extension produced no valid output",
      );
    }

    store.update("trace", {
      trace: updatedTrace(baseTrace, integrated.extensions),
    });
    for (const warning of integrated.warnings) {
      console.warn(`[dial9 viewer extension] ${warning}`);
    }
    return {
      names: integrated.acceptedNames,
      warnings: integrated.warnings,
    };
  })();
  done.catch(() => {});

  return {
    done,
    abort(): void {
      if (aborted) return;
      aborted = true;
      child?.abort();
    },
  };
}
