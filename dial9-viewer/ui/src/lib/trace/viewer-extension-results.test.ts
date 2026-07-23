import { describe, expect, it } from "vitest";
import type { ViewerExtension } from "../../types/trace.js";
import { integrateViewerExtensionOutputs } from "./viewer-extension-results.js";

function emptyOutput(panelId?: string): ArrayBuffer {
  const manifest = {
    version: 1,
    panels:
      panelId === undefined
        ? []
        : [{ id: panelId, title: panelId, height: 20, components: [] }],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = new Uint8Array(16 + manifestBytes.byteLength);
  bytes.set([0x44, 0x39, 0x56, 0x4f, 1, 0, 0, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, manifestBytes.byteLength, true);
  view.setUint32(12, 0, true);
  bytes.set(manifestBytes, 16);
  return bytes.buffer;
}

describe("viewer-extension result integration", () => {
  it("replaces a successful rebuild by name and appends a new extension", () => {
    const existing: ViewerExtension[] = [
      {
        name: "demo",
        bundle: { panels: [], tables: Object.create(null) },
      },
    ];
    const result = integrateViewerExtensionOutputs(existing, [
      { name: "demo", buffer: emptyOutput("replacement") },
      { name: "other", buffer: emptyOutput("other") },
    ]);

    expect(result.extensions.map(({ name }) => name)).toEqual(["demo", "other"]);
    expect(result.extensions[0]?.bundle.panels[0]?.id).toBe("replacement");
    expect(result.acceptedNames).toEqual(["demo", "other"]);
  });

  it("keeps the last valid output when a rebuild is malformed", () => {
    const existing: ViewerExtension[] = [
      {
        name: "demo",
        bundle: { panels: [], tables: Object.create(null) },
      },
    ];
    const result = integrateViewerExtensionOutputs(existing, [
      { name: "demo", buffer: new ArrayBuffer(4) },
    ]);

    expect(result.extensions[0]).toBe(existing[0]);
    expect(result.acceptedNames).toEqual([]);
    expect(result.warnings[0]).toMatch(/^demo: Invalid viewer-extension output:/);
  });
});
