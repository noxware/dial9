import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(
  fileURLToPath(new URL("./runtime.ts", import.meta.url)),
  "utf8",
);
const viewerSource = readFileSync(
  fileURLToPath(new URL("../../../viewer.html", import.meta.url)),
  "utf8",
);

describe("legacy panel tooltip ownership", () => {
  it("bypasses lane hover before it can hide a component tooltip", () => {
    expect(runtimeSource).toContain('root.dataset.d9TooltipOwner = "";');

    const handler = viewerSource.indexOf(
      '.getElementById("main-area")\n                .addEventListener("mousemove"',
    );
    const ownerGuard = viewerSource.indexOf(
      'e.target.closest("[data-d9-tooltip-owner]")',
      handler,
    );
    const laneHover = viewerSource.indexOf(
      "const rect = lanesContainer.getBoundingClientRect();",
      handler,
    );
    expect(handler).toBeGreaterThanOrEqual(0);
    expect(ownerGuard).toBeGreaterThan(handler);
    expect(laneHover).toBeGreaterThan(ownerGuard);
  });
});
