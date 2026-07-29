import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "playwright/test";

const wasmPath = process.env.DIAL9_EXTENSION_WASM ??
  path.resolve(
    process.cwd(),
    process.env.CARGO_TARGET_DIR ?? "../../target",
    "wasm32-unknown-unknown/viewer-extension/viewer_extension_demo.wasm",
  );

test("loads an extension before a trace and publishes it after the trace completes", async ({
  page,
}) => {
  await page.goto("/new/viewer.html?ui=new");
  await dropWasm(page);

  await expect(page.locator(".d9-toast-item")).toContainText(
    "waiting or processing",
  );
  await page.locator(".d9-load-demo").click();
  await expectExtensionPanels(page);
});

test("renders the reference panels and their independent tooltips", async ({
  page,
}) => {
  await loadDemo(page);
  await dropWasm(page);
  await expectExtensionPanels(page);

  const cpuPanel = extensionPanel(page, "WASM · CPU Usage");
  const extensionCpuReadout = (
    await cpuPanel.locator(".d9-extension-readout").innerText()
  ).trim();
  const nativeCpuReadout = await page
    .locator('[data-track-canvas="cpu"]')
    .getAttribute("data-cpu-readout");
  expect(nativeCpuReadout).not.toBeNull();
  expect(extensionCpuReadout.replace(/ cores$/, "")).toBe(nativeCpuReadout);
  await expect(cpuPanel.locator(".d9-extension-legend")).toHaveText(
    /^available parallelism \([\d,.]+ cores\)$/,
  );
  await expect(page.locator('[data-track-id="cpu"]')).toBeVisible();

  const cpuTooltip = await hoverUntilTooltip(page, cpuPanel, 0.95);
  expect(cpuTooltip).toContain("CPU time:");
  expect(cpuTooltip).toContain("Cores:");
  expect(cpuTooltip).toContain("Total CPU:");

  const contextSwitches = extensionPanel(
    page,
    "WASM · Context Switches (Intervals)",
  );
  const contextTooltip = await hoverUntilTooltip(
    page,
    contextSwitches,
    0.75,
    "Involuntary:",
  );
  expect(contextTooltip).toMatch(/^Involuntary: .* switches\nTime: \+\d/);

  const cumulative = extensionPanel(
    page,
    "WASM · Context Switches (Cumulative)",
  );
  await expect(cumulative.locator(".d9-extension-legend-item")).toHaveText([
    "Voluntary",
    "Involuntary",
    "warning (8,000 switches)",
    "critical (10,000 switches)",
  ]);
  await expect(cumulative.locator(".d9-extension-readout")).toHaveText(
    /^max [\d,]+ switches$/,
  );

  const dinosaur = extensionPanel(
    page,
    "WASM · Extremely Scientific Dinosaur",
  );
  await hoverLinearPoint(page, dinosaur, 14, 3.5);
  await expect(visibleTooltip(page)).toHaveText("Dino says: 💩");
  await hoverLinearPoint(page, dinosaur, 62.5, 8.1);
  await expect(visibleTooltip(page)).toHaveText("Dino says: ❤️");
  await hoverLinearPoint(page, dinosaur, 81, 8.05);
  await expect(visibleTooltip(page)).toHaveText("Science: 🔥");
});

test("creates and closes a counter view from a custom-event field", async ({
  page,
}) => {
  await loadDemo(page);

  const eventChip = page
    .locator(".d9-events-legend")
    .getByRole("button", {
      name: "ProcessResourceUsageEvent",
      exact: true,
    });
  await expect(eventChip).toBeVisible();
  await eventChip.click();
  await expect(eventChip).toHaveAttribute("aria-pressed", "true");

  const canvas = page.locator(".d9-events-canvas");
  const markerX = await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    if (context === null) throw new Error("custom-event canvas has no context");
    const y = Math.floor(element.height / 2);
    const pixels = context.getImageData(0, y, element.width, 1).data;
    for (let x = 0; x < element.width; x++) {
      const offset = x * 4;
      const r = pixels[offset]!;
      const g = pixels[offset + 1]!;
      const b = pixels[offset + 2]!;
      if (r !== 26 || g !== 26 || b !== 46) {
        return (x / element.width) * element.clientWidth;
      }
    }
    throw new Error("custom-event canvas has no visible marker");
  });
  const canvasBox = await boundingBox(canvas);
  await page.mouse.click(
    canvasBox.x + markerX,
    canvasBox.y + canvasBox.height / 2,
  );

  const graph = page.locator(
    '.d9-kv-graph[aria-label="Graph user_cpu_ns"]',
  );
  await expect(graph).toBeVisible();
  const eventName = (
    await page.locator(".d9-event-title").innerText()
  ).trim();
  await graph.click();

  const dialog = page.locator(".d9-field-view-dialog");
  await expect(dialog).toBeVisible();
  const dialogBox = await boundingBox(dialog);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("expected a fixed test viewport");
  expect(
    Math.abs(dialogBox.x + dialogBox.width / 2 - viewport.width / 2),
  ).toBeLessThan(2);
  expect(
    Math.abs(dialogBox.y + dialogBox.height / 2 - viewport.height / 2),
  ).toBeLessThan(2);
  await dialog.locator("select").selectOption("counter");
  await dialog.getByRole("button", { name: "Create" }).click();

  const panel = extensionPanel(
    page,
    `${eventName} · user_cpu_ns · Counter`,
  );
  await expect(panel).toBeVisible();
  const readout = panel.locator(".d9-extension-readout");
  await expect(readout).not.toContainText("/s");
  await expect(readout).not.toContainText("min");
  await panel.getByRole("button", { name: /^Close / }).click();
  await expect(panel).toHaveCount(0);
});

test("resolves overlaid line hits in reverse drawing order", async ({ page }) => {
  await page.goto("/new/viewer.html?ui=new");
  await page.evaluate(async () => {
    const load = (specifier: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
    const [
      { parseManifest },
      { ExtensionTableStore },
      { SemanticPanelRenderer },
      { createTooltip, tooltipRowsTemplate },
    ] = await Promise.all([
      load("/src/lib/viewer-extensions/manifest.ts"),
      load("/src/lib/viewer-extensions/tables.ts"),
      load("/src/lib/viewer-extensions/panel-renderer.ts"),
      load("/src/components/overlay/tooltip.ts"),
    ]);
    const manifest = (
      parseManifest as (source: string) => {
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
    const handle = (
      createTooltip as () => {
        show(content: unknown, cursor: MouseEvent): void;
        hide(): void;
      }
    )();
    const tooltip = {
      show(
        rows: readonly { label: string; value: string }[],
        cursor: MouseEvent,
      ): void {
        const content = (
          tooltipRowsTemplate as (
            rows: readonly {
              label?: string;
              value?: string;
            }[][],
          ) => unknown
        )(rows.map((row) => [{ label: row.label, value: row.value }]));
        handle.show(content, cursor);
      },
      hide(): void {
        handle.hide();
      },
    };
    const renderer = new (
      SemanticPanelRenderer as new (
        extension: unknown,
        panel: unknown,
        index: number,
        tooltip: unknown,
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
      tooltip,
    );
    document.querySelector<HTMLElement>(".d9-load-layer")?.remove();
    document
      .querySelector<HTMLElement>(".d9-extension-tracks")!
      .append(renderer.element);
    renderer.render({
      start: 0,
      end: 2,
      labelWidth: 100,
      scrollbarWidth: 0,
    });
  });

  const panel = page.locator('[data-panel-key="e2e-z-0"]');
  const box = await boundingBox(panel.locator("canvas"));
  const drawWidth = box.width - 100;

  await page.mouse.move(box.x + 100 + drawWidth * 0.25, box.y + 20);
  await expect(visibleTooltip(page)).toHaveText("Line: 2");
  await expect(panel.locator(".d9-extension-readout")).toHaveText("Line 2");

  await page.mouse.move(box.x + 100 + drawWidth * 0.75, box.y + 52);
  await expect(visibleTooltip(page)).toHaveText("Step: 1");
  await expect(panel.locator(".d9-extension-readout")).toHaveText("Step 1");
});

async function loadDemo(page: Page): Promise<void> {
  await page.goto(
    "/new/viewer.html?ui=new&trace=%2Fdemo-trace.bin",
  );
  await expect(page.locator(".d9-tracks")).toBeVisible();
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
  ).toHaveCount(4);
}

function extensionPanel(page: Page, title: string) {
  return page
    .locator(".d9-extension-panel")
    .filter({ has: page.locator(".d9-extension-title", { hasText: title }) });
}

function visibleTooltip(page: Page) {
  return page.locator(".d9-tooltip:visible");
}

async function hoverUntilTooltip(
  page: Page,
  panel: ReturnType<Page["locator"]>,
  xFraction: number,
  prefix?: string,
): Promise<string> {
  await panel.scrollIntoViewIfNeeded();
  const box = await boundingBox(panel.locator("canvas"));
  const clientX = box.x + 100 + (box.width - 100) * xFraction;
  for (let y = 20; y <= 84; y += 2) {
    await page.mouse.move(clientX, box.y + y);
    const tooltip = visibleTooltip(page);
    if (!(await tooltip.isVisible())) continue;
    const text = (await tooltip.innerText()).trim();
    if (prefix === undefined || text.startsWith(prefix)) return text;
  }
  throw new Error(`expected a panel tooltip${prefix ? ` starting with ${prefix}` : ""}`);
}

async function hoverLinearPoint(
  page: Page,
  panel: ReturnType<Page["locator"]>,
  x: number,
  y: number,
): Promise<void> {
  await panel.scrollIntoViewIfNeeded();
  const box = await boundingBox(panel.locator("canvas"));
  const clientX = box.x + 100 + (x / 100) * (box.width - 100);
  const clientY = box.y + 84 - (y / 10) * (84 - 20);
  await page.mouse.move(clientX, clientY);
}

async function boundingBox(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("expected element to have a bounding box");
  return box;
}
