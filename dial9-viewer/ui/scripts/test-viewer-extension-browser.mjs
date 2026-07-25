import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const UI_ROOT = resolve(import.meta.dirname, "..");
const REPOSITORY = resolve(UI_ROOT, "../..");
const SYSTEM_CHROMIUM = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function browserExecutable() {
  const configured = process.env["DIAL9_CHROMIUM_EXECUTABLE"];
  if (configured !== undefined) {
    if (!existsSync(configured)) {
      throw new Error(`DIAL9_CHROMIUM_EXECUTABLE does not exist: ${configured}`);
    }
    return configured;
  }
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return undefined;
  const system = SYSTEM_CHROMIUM.find(existsSync);
  if (system !== undefined) return system;
  throw new Error(
    "No Chromium executable found. Run `npx playwright install chromium` " +
      "or set DIAL9_CHROMIUM_EXECUTABLE.",
  );
}

async function dropFile(page, path, name) {
  const base64 = readFileSync(path).toString("base64");
  await page.evaluate(
    ({ contents, fileName }) => {
      const binary = atob(contents);
      const bytes = Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], fileName, { type: "application/wasm" }),
      );
      document.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    { contents: base64, fileName: name },
  );
}

function buildFixture(directory) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--format-version", "1"],
      { cwd: REPOSITORY, encoding: "utf8" },
    ),
  );
  execFileSync(
    "cargo",
    [
      "build",
      "-p",
      "dial9-viewer-extension-demo",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
    { cwd: REPOSITORY, stdio: "inherit" },
  );
  const wasm = join(
    metadata.target_directory,
    "wasm32-unknown-unknown",
    "release",
    "dial9_viewer_extension_demo.wasm",
  );
  const trace = join(directory, "viewer-extension-demo.trace");
  execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "dial9-viewer-extension-demo",
      "--features",
      "trace-fixture",
      "--bin",
      "make_trace",
      "--",
      wasm,
      trace,
      "80",
    ],
    { cwd: REPOSITORY, stdio: "inherit" },
  );
  return { trace, wasm };
}

async function main() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "dial9-viewer-extension-browser-"),
  );
  let browser;
  let server;
  try {
    const { trace, wasm } = buildFixture(temporaryDirectory);
    server = await createServer({
      root: UI_ROOT,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert(
      typeof address === "object" && address !== null,
      "Vite did not expose its listening address",
    );

    const executablePath = browserExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${address.port}/viewer.html?ui=legacy`);
    await page.locator("#file-input").setInputFiles(trace);

    const panels = page.locator(".dial9-extension-panel");
    await panels.first().waitFor({ state: "visible", timeout: 20_000 });
    assert((await panels.count()) === 4, "expected four extension panels");
    assert(
      (await page.locator(".dial9-extension-error-panel").count()) === 0,
      "extension mounted an error panel",
    );
    assert(
      await page.locator("#cpu-panel").isVisible(),
      "the built-in CPU panel disappeared",
    );
    assert(
      (await page.locator("#queue-chart").count()) === 1,
      "the built-in queue panel disappeared",
    );

    const titles = await page
      .locator(".dial9-extension-title")
      .allTextContents();
    assert(
      JSON.stringify(titles) ===
        JSON.stringify([
          "CPU Usage · WASM",
          "Context Switch Rate · Steps",
          "Context Switch Rate · Lines",
          "A Completely Reasonable Dinosaur",
        ]),
      `unexpected extension panel titles: ${JSON.stringify(titles)}`,
    );
    const canvasSizes = await page
      .locator(".dial9-extension-panel canvas")
      .evaluateAll((canvases) =>
        canvases.map((canvas) => ({
          width: canvas.width,
          height: canvas.height,
        })),
      );
    assert(
      canvasSizes.every(({ width, height }) => width > 0 && height > 0),
      `extension canvas was not rendered: ${JSON.stringify(canvasSizes)}`,
    );
    const cpuReadout = await panels
      .nth(0)
      .locator(".dial9-extension-readout")
      .textContent();
    assert(
      cpuReadout?.includes("avg") === true && cpuReadout.includes("max"),
      `CPU readout is incomplete: ${cpuReadout}`,
    );
    const builtInCpuReadout = await page.locator("#cpu-panel-info").textContent();
    const readoutValues = (value) =>
      value?.match(/-?\d+(?:\.\d+)?%?/g) ?? [];
    assert(
      JSON.stringify(readoutValues(cpuReadout)) ===
        JSON.stringify(readoutValues(builtInCpuReadout)),
      `CPU readout parity failed: ${cpuReadout} !== ${builtInCpuReadout}`,
    );
    assert(
      (await panels.nth(0).locator(".dial9-extension-swatch").textContent())
        ?.includes("available parallelism") === true,
      "CPU capacity swatch is missing",
    );

    const dinoCanvas = panels.nth(3).locator("canvas");
    const dinoBox = await dinoCanvas.boundingBox();
    assert(dinoBox !== null, "dinosaur canvas has no layout box");
    const dinoPoint = async (x, y) => {
      const drawWidth = dinoBox.width - 100;
      const chartHeight = dinoBox.height - 28;
      await page.mouse.move(
        dinoBox.x + 100 + (x / 100) * drawWidth,
        dinoBox.y + 20 + (1 - y / 10) * chartHeight,
      );
    };
    await dinoPoint(14, 3.5);
    await page.waitForFunction(
      () => document.querySelector("#tooltip")?.textContent?.includes("💩"),
    );
    await dinoPoint(62.5, 8.1);
    await page.waitForFunction(
      () => document.querySelector("#tooltip")?.textContent?.includes("❤️"),
    );
    await page.mouse.move(10, 10);

    await dropFile(page, wasm, "dropped-after-trace.wasm");
    await page.waitForFunction(
      () => document.querySelectorAll(".dial9-extension-panel").length === 8,
    );
    assert(
      (await page.locator(".dial9-extension-error-panel").count()) === 0,
      "a module dropped after the trace failed",
    );

    const pendingPage = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await pendingPage.goto(
      `http://127.0.0.1:${address.port}/viewer.html?ui=legacy`,
    );
    await pendingPage.locator("#file-input").setInputFiles(wasm);
    await pendingPage.waitForFunction(
      () =>
        document
          .querySelector("#toast-container")
          ?.textContent?.includes("will run with the next trace") === true,
    );
    await pendingPage.locator("#file-input").setInputFiles(trace);
    await pendingPage.waitForFunction(
      () => document.querySelectorAll(".dial9-extension-panel").length === 8,
    );
    assert(
      (await pendingPage.locator(".dial9-extension-error-panel").count()) === 0,
      "a module dropped before the trace failed",
    );
    await pendingPage.close();

    const screenshot = process.env["DIAL9_VIEWER_EXTENSION_SCREENSHOT"];
    if (screenshot !== undefined) {
      await panels.nth(3).scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot });
      console.log(`viewer extension browser check passed; screenshot: ${screenshot}`);
    } else {
      console.log("viewer extension browser check passed");
    }
  } finally {
    await browser?.close();
    await server?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
