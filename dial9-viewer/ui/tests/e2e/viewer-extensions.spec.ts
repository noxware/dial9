import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "playwright/test";

const wasmPath =
  process.env.DIAL9_EXTENSION_WASM ??
  path.resolve(
    process.cwd(),
    "../../target/wasm32-unknown-unknown/viewer-extension/viewer_extension_demo.wasm",
  );

test("loads an extension before a trace and publishes it after the trace completes", async ({
  page,
}) => {
  await page.goto("/viewer.html?ui=legacy");
  await waitForRuntime(page);
  await dropWasm(page);

  await expect(page.locator(".d9-extension-status")).toContainText(
    "waiting or processing",
  );
  await page.locator("#load-demo").click();
  await expectExtensionPanels(page);
});

test("recreates CPU and keeps the dinosaur fully interactive", async ({
  page,
}) => {
  await page.goto("/viewer.html?ui=legacy&trace=demo-trace.bin");
  await expect(page.locator("#cpu-panel")).toBeVisible();
  await waitForRuntime(page);
  await dropWasm(page);
  await expectExtensionPanels(page);

  const cpuPanel = extensionPanel(page, "WASM · CPU Usage");
  await expect(cpuPanel.locator(".d9-extension-readout")).toHaveText(
    "avg 0.48 cores · avg 4.4% · max 1.52 cores",
  );
  await expect(cpuPanel.locator(".d9-extension-legend")).toHaveText(
    "available parallelism (11 cores)",
  );
  await expect(page.locator("#cpu-panel-info")).toHaveText(
    "avg 0.48 cores · avg 4.4% · max 1.52",
  );

  await page.locator("#cpu-panel-label").click();
  const originalTooltip = await hoverCpuInterval(
    page,
    page.locator("#cpu-panel-canvas"),
  );
  const extensionTooltip = await hoverCpuInterval(
    page,
    cpuPanel.locator("canvas"),
  );
  expect(extensionTooltip).toBe(originalTooltip);

  const contextSwitches = extensionPanel(
    page,
    "WASM · Context Switch Rate",
  );
  const contextTooltip = await hoverContextSwitchTail(page, contextSwitches);
  expect(contextTooltip).toMatch(/^Involuntary: .* switches\/s\nTime: \+\d/);

  const dinosaur = extensionPanel(
    page,
    "WASM · Extremely Scientific Dinosaur",
  );
  await hoverLinearPoint(page, dinosaur, 14, 3.5);
  await expect(page.locator("#tooltip")).toHaveText("Dino says: 💩");
  await hoverLinearPoint(page, dinosaur, 62.5, 8.1);
  await expect(page.locator("#tooltip")).toHaveText("Dino says: ❤️");
  await hoverLinearPoint(page, dinosaur, 81, 8.05);
  await expect(page.locator("#tooltip")).toHaveText("Science: 🔥");
});

test("resolves overlaid line hits in reverse drawing order", async ({ page }) => {
  await page.goto("/viewer.html?ui=legacy");
  await page.evaluate(async () => {
    const load = (specifier: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
    const [{ parseManifest }, { ExtensionTableStore }, { SemanticPanelRenderer }] =
      await Promise.all([
        load("/src/lib/viewer-extensions/manifest.ts"),
        load("/src/lib/viewer-extensions/tables.ts"),
        load("/src/lib/viewer-extensions/panel-renderer.ts"),
      ]);
    const manifest = (
      parseManifest as (source: string) => {
        tables: readonly unknown[];
        panels: readonly unknown[];
      }
    )(
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "series",
            columns: [
              { name: "x", type: "f64" },
              { name: "step", type: "f64" },
              { name: "line", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Z-order",
            x_axis: { kind: "linear" },
            components: [
              {
                name: "step-line/v1",
                table: "series",
                x: "x",
                y: "step",
              },
              {
                name: "line/v1",
                table: "series",
                x: "x",
                y: "line",
              },
              {
                name: "tooltip/v1",
                table: "series",
                match: { x: "x", y: "step" },
                items: [{ label: "Step", column: "step" }],
              },
              {
                name: "tooltip/v1",
                table: "series",
                match: { x: "x", y: "line" },
                items: [{ label: "Line", column: "line" }],
              },
              {
                name: "readout/v1",
                table: "series",
                match: { x: "x", y: "step" },
                items: [{ label: "Step", column: "step", sample: "hit" }],
              },
              {
                name: "readout/v1",
                table: "series",
                match: { x: "x", y: "line" },
                items: [{ label: "Line", column: "line", sample: "hit" }],
              },
            ],
          },
        ],
      }),
    );
    const tables = new (
      ExtensionTableStore as new (manifest: unknown) => {
        append(batch: unknown): void;
      }
    )(manifest);
    tables.append({
      table: 0,
      rows: 3,
      columns: [
        {
          type: "f64",
          values: new Float64Array([0, 1, 2]),
          validity: null,
          rows: 3,
        },
        {
          type: "f64",
          values: new Float64Array([1, 2, 1]),
          validity: null,
          rows: 3,
        },
        {
          type: "f64",
          values: new Float64Array([2, 2, 2]),
          validity: null,
          rows: 3,
        },
      ],
    });
    const renderer = new (
      SemanticPanelRenderer as new (
        extension: unknown,
        panel: unknown,
        index: number,
        tooltip: HTMLElement,
      ) => {
        element: HTMLElement;
        render(viewport: unknown): void;
      }
    )(
      {
        identity: { id: "e2e-z", name: "z.wasm" },
        manifest,
        tables,
      },
      manifest.panels[0],
      0,
      document.querySelector<HTMLElement>("#tooltip")!,
    );
    document.querySelector<HTMLElement>("#drop-zone")!.style.display = "none";
    document.body.append(renderer.element);
    renderer.render({
      start: 0,
      end: 2,
      labelWidth: 100,
      scrollbarWidth: 0,
    });
    (globalThis as Record<string, unknown>).__dial9E2eRenderer = renderer;
  });

  const panel = page.locator('[data-panel-key="e2e-z-0"]');
  await panel.scrollIntoViewIfNeeded();
  const box = await boundingBox(panel.locator("canvas"));
  const drawWidth = box.width - 100;

  await page.mouse.move(box.x + 100 + drawWidth * 0.25, box.y + 20);
  await expect(page.locator("#tooltip")).toHaveText("Line: 2");
  await expect(panel.locator(".d9-extension-readout")).toHaveText("Line 2");

  await page.mouse.move(box.x + 100 + drawWidth * 0.75, box.y + 52);
  await expect(page.locator("#tooltip")).toHaveText("Step: 1");
  await expect(panel.locator(".d9-extension-readout")).toHaveText("Step 1");
});

async function waitForRuntime(page: Page): Promise<void> {
  await page.waitForFunction(() => window.Dial9ViewerExtensions !== undefined);
}

async function dropWasm(page: Page): Promise<void> {
  const bytes = (await readFile(wasmPath)).toString("base64");
  await page.evaluate((base64) => {
    const binary = atob(base64);
    const contents = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([contents], "viewer-extension-demo.wasm", {
        type: "application/wasm",
      }),
    );
    document.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, bytes);
}

async function expectExtensionPanels(page: Page): Promise<void> {
  await expect(
    page.locator(".d9-extension-title").filter({ hasText: /^WASM ·/ }),
  ).toHaveCount(3);
}

function extensionPanel(page: Page, title: string) {
  return page
    .locator(".d9-extension-panel")
    .filter({ has: page.locator(".d9-extension-title", { hasText: title }) });
}

async function hoverCpuInterval(
  page: Page,
  canvas: ReturnType<Page["locator"]>,
): Promise<string> {
  const box = await boundingBox(canvas);
  const x = box.x + 162 + (box.width - 162) * 0.95;
  for (const y of [78, 82, 74, 70]) {
    await page.mouse.move(x, box.y + y);
    const tooltip = page.locator("#tooltip");
    if (await tooltip.isVisible()) return (await tooltip.innerText()).trim();
  }
  throw new Error("expected a CPU interval at the sampled X coordinate");
}

async function hoverLinearPoint(
  page: Page,
  panel: ReturnType<Page["locator"]>,
  x: number,
  y: number,
): Promise<void> {
  await panel.scrollIntoViewIfNeeded();
  const box = await boundingBox(panel.locator("canvas"));
  const drawLeft = 100;
  const drawRight = box.width;
  const clientX = box.x + drawLeft + (x / 100) * (drawRight - drawLeft);
  const clientY = box.y + 84 - (y / 10) * (84 - 20);
  await page.mouse.move(clientX, clientY);
}

async function hoverContextSwitchTail(
  page: Page,
  panel: ReturnType<Page["locator"]>,
): Promise<string> {
  await panel.scrollIntoViewIfNeeded();
  const box = await boundingBox(panel.locator("canvas"));
  const clientX = box.x + 100 + (box.width - 100) * 0.98;
  for (const y of [82, 78, 74, 70]) {
    await page.mouse.move(clientX, box.y + y);
    const tooltip = page.locator("#tooltip");
    if (await tooltip.isVisible()) {
      const text = (await tooltip.innerText()).trim();
      if (text.startsWith("Involuntary:")) return text;
    }
  }
  throw new Error("expected the involuntary line to cover the final interval");
}

async function boundingBox(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("expected element to have a bounding box");
  return box;
}
