// End-to-end verification for a real viewer-extension WASM module in the
// legacy viewer. The server is intentionally external to this script:
//
//   npm run build
//   npx vite preview --host 127.0.0.1 --port 4173
//   node parity/viewer-extension.mjs \
//     --wasm /path/to/dial9_viewer_extension_demo.wasm
//
// The two legs use independent browser contexts and exercise actual DOM file
// drops: module-before-trace and module-after-trace.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs, usage } from "./lib/cli.mjs";
import { launchBrowser, VIEWPORT } from "./lib/browser.mjs";

const DEMO_TRACE = fileURLToPath(
  new URL("../public/demo-trace.bin", import.meta.url),
);
const EXPECTED_TITLES = [
  "WASM · CPU Usage",
  "WASM · Context Switch Rate",
  "WASM · Context Switches (Cumulative)",
  "WASM · Extremely Scientific Dinosaur",
];
const TIMEOUT_MS = 60_000;
const DPR = 2;

const SPEC = {
  url: {
    default: "http://127.0.0.1:4173/viewer.html",
    help: "legacy viewer URL served by an already-running Vite server",
  },
  wasm: {
    required: true,
    help: "compiled viewer-extension WASM module",
  },
  trace: {
    default: DEMO_TRACE,
    help: "raw or gzip-compressed D9TF trace",
  },
  screenshot: {
    help: "PNG base path; writes separate -before and -after captures",
  },
};

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function mimeType(filePath) {
  return filePath.toLowerCase().endsWith(".wasm")
    ? "application/wasm"
    : "application/octet-stream";
}

async function assertReadableFile(filePath, label) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    throw new Error(`${label} is not readable at ${resolved}: ${error.message}`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} must be a non-empty file: ${resolved}`);
  }
  return resolved;
}

async function assertViewerReady(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `no viewer at ${url}: ${error.message}\n` +
        "start the Vite server before running this script",
    );
  }
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
  }
}

async function dropFile(page, filePath) {
  const bytes = await fs.readFile(filePath);
  const dataTransfer = await page.evaluateHandle(
    ({ base64, name, type }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type }));
      return transfer;
    },
    {
      base64: bytes.toString("base64"),
      name: path.basename(filePath),
      type: mimeType(filePath),
    },
  );
  try {
    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await page.dispatchEvent("body", "dragover", { dataTransfer });
    await page.dispatchEvent("body", "drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function waitForLegacyTrace(page) {
  await page.locator("#viewer").waitFor({
    state: "visible",
    timeout: TIMEOUT_MS,
  });
  await page.locator("#cpu-panel").waitFor({
    state: "visible",
    timeout: TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => /\d[\d,]* events/.test(
      document.querySelector("#toolbar .tb-info")?.textContent ?? "",
    ),
    undefined,
    { timeout: TIMEOUT_MS },
  );
}

async function waitForExtensionPanels(page) {
  await page.waitForFunction(
    (titles) => {
      const panels = [...document.querySelectorAll(".viewer-extension-panel")];
      return (
        panels.length === titles.length &&
        panels.every((panel, index) =>
          panel.querySelector(".viewer-extension-title")?.textContent ===
          titles[index]
        ) &&
        panels.every((panel) => {
          const canvas = panel.querySelector("canvas");
          return canvas !== null && canvas.width > 0 && canvas.height > 0;
        })
      );
    },
    EXPECTED_TITLES,
    { timeout: TIMEOUT_MS },
  );
}

async function expandLegacyCpuPanel(page) {
  const panel = page.locator("#cpu-panel");
  if (await panel.evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#cpu-panel-label").click();
  }
  await page.waitForFunction(
    () => {
      const panel = document.querySelector("#cpu-panel");
      const canvas = document.querySelector("#cpu-panel-canvas");
      return (
        panel !== null &&
        !panel.classList.contains("is-collapsed") &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    undefined,
    { timeout: TIMEOUT_MS },
  );
}

async function inspectPanels(page) {
  return page.evaluate((expectedTitles) => {
    const extensionPanels = [
      ...document.querySelectorAll(".viewer-extension-panel"),
    ];
    const parent = document.querySelector("#task-detail")?.parentElement;
    const siblings = parent === null || parent === undefined
      ? []
      : [...parent.children];
    const cpuIndex = siblings.indexOf(document.querySelector("#cpu-panel"));
    const taskIndex = siblings.indexOf(document.querySelector("#task-detail"));
    const extensionIndices = extensionPanels.map((panel) =>
      siblings.indexOf(panel)
    );
    const dpr = window.devicePixelRatio;

    const canvases = [
      {
        title: "legacy CPU Usage",
        canvas: document.querySelector("#cpu-panel-canvas"),
      },
      ...extensionPanels.map((panel) => ({
        title:
          panel.querySelector(".viewer-extension-title")?.textContent ?? "",
        canvas: panel.querySelector(".viewer-extension-canvas"),
      })),
    ].map(({ title, canvas }) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { title, missing: true };
      }
      const rect = canvas.getBoundingClientRect();
      return {
        title,
        missing: false,
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        expectedBackingWidth: Math.round(rect.width * dpr),
        expectedBackingHeight: Math.round(rect.height * dpr),
      };
    });

    return {
      titles: extensionPanels.map(
        (panel) =>
          panel.querySelector(".viewer-extension-title")?.textContent ?? "",
      ),
      errors: extensionPanels.map(
        (panel) =>
          panel.querySelector(".viewer-extension-error")?.textContent ?? "",
      ).filter(Boolean),
      cpuTitle: document.querySelector("#cpu-panel-label")?.textContent?.trim(),
      cpuIndex,
      taskIndex,
      extensionIndices,
      dpr,
      canvases,
      presentations: extensionPanels.map((panel) => ({
        title:
          panel.querySelector(".viewer-extension-title")?.textContent ?? "",
        swatches:
          panel.querySelector(".viewer-extension-swatches")?.textContent
            ?.replace(/\s+/g, " ")
            .trim() ?? "",
        readout:
          panel.querySelector(".viewer-extension-readout")?.textContent
            ?.replace(/\s+/g, " ")
            .trim() ?? "",
      })),
      expectedTitles,
    };
  }, EXPECTED_TITLES);
}

function assertPanelStructure(observation) {
  assert.deepEqual(observation.titles, EXPECTED_TITLES);
  assert.equal(observation.cpuTitle, "CPU Usage");
  assert.deepEqual(observation.errors, []);
  assert.equal(observation.dpr, DPR);
  assert.ok(observation.cpuIndex >= 0, "legacy CPU panel is outside the panel stack");
  assert.ok(observation.taskIndex >= 0, "task-detail is outside the panel stack");
  assert.deepEqual(
    observation.extensionIndices,
    observation.extensionIndices.toSorted((left, right) => left - right),
    "extension panels are not in manifest order",
  );
  assert.ok(
    observation.extensionIndices.every(
      (index) =>
        index > observation.cpuIndex && index < observation.taskIndex,
    ),
    "extension panels must be after legacy CPU and before task-detail",
  );

  for (const canvas of observation.canvases) {
    assert.equal(canvas.missing, false, `${canvas.title} canvas is missing`);
    assert.ok(canvas.cssWidth > 0, `${canvas.title} has no CSS width`);
    assert.ok(canvas.cssHeight > 0, `${canvas.title} has no CSS height`);
    assert.equal(
      canvas.backingWidth,
      canvas.expectedBackingWidth,
      `${canvas.title} backing width does not honor DPR`,
    );
    assert.equal(
      canvas.backingHeight,
      canvas.expectedBackingHeight,
      `${canvas.title} backing height does not honor DPR`,
    );
  }

  const byTitle = new Map(
    observation.presentations.map((presentation) => [
      presentation.title,
      presentation,
    ]),
  );
  assert.match(
    byTitle.get(EXPECTED_TITLES[0]).swatches,
    /available parallelism/i,
  );
  assert.match(byTitle.get(EXPECTED_TITLES[0]).readout, /\bavg\b/i);
  assert.match(byTitle.get(EXPECTED_TITLES[0]).readout, /\bmax\b/i);
  for (const title of EXPECTED_TITLES.slice(1, 3)) {
    assert.match(byTitle.get(title).swatches, /Voluntary/);
    assert.match(byTitle.get(title).swatches, /Involuntary/);
  }
  assert.match(byTitle.get(EXPECTED_TITLES[3]).swatches, /Dinosaur/);
  assert.match(byTitle.get(EXPECTED_TITLES[3]).swatches, /Flames/);
}

async function inspectCanvasColors(page) {
  return page.evaluate((titles) => {
    const targets = {
      "legacy CPU Usage": ["#4fc3f7"],
      [titles[0]]: ["#ffcf99", "#4fc3f7"],
      [titles[1]]: ["#81c784", "#ffb74d"],
      [titles[2]]: ["#81c784", "#ffb74d"],
      [titles[3]]: ["#66d17a", "#ff7043"],
    };
    const parseHex = (hex) => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const panels = new Map(
      [...document.querySelectorAll(".viewer-extension-panel")].map((panel) => [
        panel.querySelector(".viewer-extension-title")?.textContent ?? "",
        panel.querySelector("canvas"),
      ]),
    );
    panels.set(
      "legacy CPU Usage",
      document.querySelector("#cpu-panel-canvas"),
    );

    return [...Object.entries(targets)].map(([title, colors]) => {
      const canvas = panels.get(title);
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { title, counts: colors.map(() => 0) };
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return { title, counts: colors.map(() => 0) };
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = colors.map(parseHex);
      const counts = rgb.map(() => 0);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let target = 0; target < rgb.length; target += 1) {
          const [red, green, blue] = rgb[target];
          const distance =
            Math.abs(pixels[offset] - red) +
            Math.abs(pixels[offset + 1] - green) +
            Math.abs(pixels[offset + 2] - blue);
          if (distance <= 48 && pixels[offset + 3] > 0) counts[target] += 1;
        }
      }
      return { title, colors, counts };
    });
  }, EXPECTED_TITLES);
}

function assertCanvasContent(observations) {
  for (const observation of observations) {
    observation.counts.forEach((count, index) => {
      assert.ok(
        count > 0,
        `${observation.title} has no visible ${observation.colors[index]} pixels`,
      );
    });
  }
}

async function tooltipText(page) {
  return page.locator("#tooltip").evaluate((tooltip) => {
    const style = getComputedStyle(tooltip);
    return style.display === "none"
      ? ""
      : tooltip.textContent?.replace(/\s+/g, " ").trim() ?? "";
  });
}

async function moveToLinearDatum(page, panelTitle, x, y) {
  const point = await page.evaluate(
    ({ panelTitle, x, y }) => {
      const panel = [...document.querySelectorAll(".viewer-extension-panel")]
        .find(
          (candidate) =>
            candidate.querySelector(".viewer-extension-title")?.textContent ===
            panelTitle,
        );
      const canvas = panel?.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      const lanes = document.querySelector("#lanes-container");
      const rightInset = lanes instanceof HTMLElement
        ? lanes.offsetWidth - lanes.clientWidth
        : 0;
      const labelWidth = 100;
      const drawWidth = rect.width - labelWidth - rightInset;
      const chartTop = 20;
      const chartHeight = rect.height - 28;
      return {
        x: rect.left + labelWidth + (x / 100) * drawWidth,
        y: rect.top + chartTop + (1 - y / 10) * chartHeight,
      };
    },
    { panelTitle, x, y },
  );
  assert.notEqual(point, null, `cannot locate ${panelTitle}`);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(20);
  return tooltipText(page);
}

async function assertDinosaurTooltips(page) {
  const title = EXPECTED_TITLES[3];
  const cases = [
    { part: "tail", x: 10, y: 3, expected: "💩" },
    { part: "head", x: 66, y: 8.4, expected: "❤️" },
    { part: "flame", x: 84, y: 8.5, expected: "🔥" },
  ];
  for (const item of cases) {
    const text = await moveToLinearDatum(page, title, item.x, item.y);
    assert.match(
      text,
      new RegExp(item.expected, "u"),
      `dinosaur ${item.part} tooltip was not reached; got ${JSON.stringify(text)}`,
    );
  }
}

async function assertCpuTooltip(page) {
  const panel = page.locator(".viewer-extension-panel", {
    hasText: EXPECTED_TITLES[0],
  });
  const canvas = panel.locator("canvas");
  const bounds = await canvas.boundingBox();
  assert.notEqual(bounds, null, "CPU extension canvas has no bounding box");
  const lanesInset = await page.locator("#lanes-container").evaluate(
    (lanes) => lanes.offsetWidth - lanes.clientWidth,
  );
  const drawWidth = bounds.width - 100 - lanesInset;
  const yCandidates = [bounds.height - 10, bounds.height - 12, bounds.height - 15];
  for (const y of yCandidates) {
    for (let step = 1; step < 80; step += 1) {
      await page.mouse.move(
        bounds.x + 100 + (drawWidth * step) / 80,
        bounds.y + y,
      );
      await page.waitForTimeout(4);
      const text = await tooltipText(page);
      if (text.includes("CPU time")) {
        assert.match(text, /Window/);
        assert.match(text, /Cores/);
        return;
      }
    }
  }
  throw new Error("no real CPU interval produced a tooltip through hit testing");
}

function screenshotPath(base, leg) {
  const resolved = path.resolve(base);
  const extension = path.extname(resolved);
  return extension.length === 0
    ? `${resolved}-${leg}.png`
    : `${resolved.slice(0, -extension.length)}-${leg}${extension}`;
}

async function captureScreenshot(page, base, leg) {
  const output = screenshotPath(base, leg);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  return output;
}

async function runLeg(browser, options, order) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  const browserErrors = [];
  const dialogs = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });
  page.on("dialog", async (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });

  let screenshot;
  try {
    await page.goto(options.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.dial9ViewerExtensionsReady instanceof Promise,
      undefined,
      { timeout: TIMEOUT_MS },
    );

    if (order === "before") {
      await dropFile(page, options.wasm);
      await page.waitForFunction(
        () =>
          document.querySelector("#viewer-extension-load-status")
            ?.textContent?.includes("queued") ?? false,
        undefined,
        { timeout: TIMEOUT_MS },
      );
      await dropFile(page, options.trace);
      await waitForLegacyTrace(page);
      await waitForExtensionPanels(page);
    } else {
      await dropFile(page, options.trace);
      await waitForLegacyTrace(page);
      assert.equal(
        await page.locator(".viewer-extension-panel").count(),
        0,
        "extension panels appeared before the post-trace module drop",
      );
      await dropFile(page, options.wasm);
      await waitForExtensionPanels(page);
    }

    await expandLegacyCpuPanel(page);
    await page.waitForTimeout(50);
    const structure = await inspectPanels(page);
    assertPanelStructure(structure);
    assertCanvasContent(await inspectCanvasColors(page));
    await assertCpuTooltip(page);
    await assertDinosaurTooltips(page);
    await page.waitForTimeout(50);

    assert.deepEqual(dialogs, [], `unexpected browser dialogs: ${dialogs.join("; ")}`);
    assert.deepEqual(
      browserErrors,
      [],
      `browser errors:\n${browserErrors.join("\n")}`,
    );
    if (options.screenshot !== undefined) {
      screenshot = await captureScreenshot(page, options.screenshot, order);
    }
    return { structure, screenshot };
  } finally {
    await context.close();
  }
}

async function main() {
  let opts;
  try {
    ({ opts } = parseArgs(process.argv.slice(2), SPEC));
  } catch (error) {
    console.error(error.message);
    console.error(usage("parity/viewer-extension.mjs", SPEC));
    process.exit(2);
  }

  opts.wasm = await assertReadableFile(opts.wasm, "WASM module");
  opts.trace = await assertReadableFile(opts.trace, "trace");
  await assertViewerReady(opts.url);

  const browser = await launchBrowser();
  const results = [];
  try {
    for (const order of ["before", "after"]) {
      try {
        const details = await runLeg(browser, opts, order);
        results.push({ order, pass: true, ...details });
      } catch (error) {
        results.push({ order, pass: false, error: errorMessage(error) });
      }
    }
  } finally {
    await browser.close();
  }

  let failed = 0;
  for (const result of results) {
    console.log(`${result.pass ? "PASS" : "FAIL"}  wasm-${result.order}-trace`);
    if (result.screenshot !== undefined) {
      console.log(`      screenshot: ${result.screenshot}`);
    }
    if (!result.pass) {
      failed += 1;
      console.log(
        result.error
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n"),
      );
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
