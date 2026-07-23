import type { ViewBundle } from "../custom-views/types.js";
import type { ViewerExtension } from "../../types/trace.js";
import {
  decodeViewerExtensionOutput,
  VIEW_OUTPUT_LIMITS,
} from "./viewer-extension-output.js";
import type { ViewerExtensionOutputBuffer } from "./viewer-extension-worker/protocol.js";
import { MAX_VIEWER_EXTENSION_COUNT } from "./viewer-extension-worker/protocol.js";

export interface ViewerExtensionIntegration {
  readonly extensions: readonly ViewerExtension[];
  readonly acceptedNames: readonly string[];
  readonly warnings: readonly string[];
}

function renderRows(bundle: ViewBundle): number {
  let rows = 0;
  for (const panel of bundle.panels) {
    for (const component of panel.components) {
      if (
        component.kind !== "tooltip" &&
        component.kind !== "legend" &&
        component.kind !== "background"
      ) {
        rows += bundle.tables[component.input]?.length ?? 0;
      }
    }
  }
  return rows;
}

function displayItems(bundle: ViewBundle): number {
  let items = 0;
  for (const panel of bundle.panels) {
    for (const component of panel.components) {
      if (component.kind === "tooltip") {
        items += component.rows.length;
      } else if (component.kind === "legend") {
        items +=
          (component.items?.length ?? 0) +
          (component.atCursor?.length ?? 0);
      }
    }
  }
  return items;
}

function aggregateError(
  extensions: readonly ViewerExtension[],
): string | null {
  if (extensions.length > MAX_VIEWER_EXTENSION_COUNT) {
    return `aggregate extension count exceeds ${MAX_VIEWER_EXTENSION_COUNT}`;
  }
  let panels = 0;
  let panelHeight = 0;
  let rows = 0;
  let items = 0;
  for (const extension of extensions) {
    panels += extension.bundle.panels.length;
    panelHeight += extension.bundle.panels.reduce(
      (sum, panel) => sum + panel.height,
      0,
    );
    rows += renderRows(extension.bundle);
    items += displayItems(extension.bundle);
  }
  if (panels > VIEW_OUTPUT_LIMITS.panels) {
    return `aggregate panel count exceeds ${VIEW_OUTPUT_LIMITS.panels}`;
  }
  if (panelHeight > VIEW_OUTPUT_LIMITS.totalPanelHeight) {
    return (
      "aggregate panel height exceeds " +
      `${VIEW_OUTPUT_LIMITS.totalPanelHeight}px`
    );
  }
  if (rows > VIEW_OUTPUT_LIMITS.renderRows) {
    return (
      "aggregate drawing work exceeds " +
      `${VIEW_OUTPUT_LIMITS.renderRows} source rows`
    );
  }
  if (items > VIEW_OUTPUT_LIMITS.displayItems) {
    return (
      "aggregate tooltip and legend items exceed " +
      `${VIEW_OUTPUT_LIMITS.displayItems}`
    );
  }
  return null;
}

/**
 * Decode untrusted outputs and merge them by extension name. A successful
 * local rebuild replaces its prior result atomically; a rejected rebuild
 * leaves the last valid result visible.
 */
export function integrateViewerExtensionOutputs(
  existing: readonly ViewerExtension[],
  outputs: readonly ViewerExtensionOutputBuffer[],
  initialWarnings: readonly string[] = [],
): ViewerExtensionIntegration {
  let extensions = [...existing];
  const acceptedNames: string[] = [];
  const warnings = [...initialWarnings];
  const outputNames = new Set<string>();

  for (const output of outputs) {
    if (outputNames.has(output.name)) {
      warnings.push(`duplicate viewer-extension output ${JSON.stringify(output.name)}`);
      continue;
    }
    outputNames.add(output.name);
    try {
      const next: ViewerExtension = {
        name: output.name,
        bundle: decodeViewerExtensionOutput(output.buffer),
      };
      const prior = extensions.findIndex(({ name }) => name === output.name);
      const candidate =
        prior < 0
          ? [...extensions, next]
          : extensions.map((extension, index) =>
              index === prior ? next : extension,
            );
      const error = aggregateError(candidate);
      if (error !== null) throw new Error(error);
      extensions = candidate;
      acceptedNames.push(output.name);
    } catch (error) {
      warnings.push(
        `${output.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { extensions, acceptedNames, warnings };
}
