import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtensionStore } from "./columnar.js";
import { loadExtensionModule } from "./module.js";
import { ExtensionPanel } from "./panel.js";

const RUN = process.env["DIAL9_RUN_VIEWER_EXTENSION_DEMO"] === "1";
const REPOSITORY = resolve(process.cwd(), "../..");

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe.runIf(RUN)("compiled viewer extension demo", () => {
  let temporaryDirectory: string;
  let store: ExtensionStore;

  beforeAll(async () => {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--no-deps", "--format-version", "1"],
        { cwd: REPOSITORY, encoding: "utf8" },
      ),
    ) as { target_directory: string };
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
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), "dial9-viewer-extension-demo-"),
    );
    const trace = join(temporaryDirectory, "demo.trace");
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

    const guest = await loadExtensionModule(arrayBuffer(readFileSync(wasm)));
    const bytes = readFileSync(trace);
    const batches = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 997) {
      batches.push(
        ...guest.push(
          bytes.subarray(offset, Math.min(bytes.byteLength, offset + 997)),
        ),
      );
    }
    batches.push(...guest.finish());
    store = new ExtensionStore(guest.manifest);
    for (const batch of batches) store.append(batch);
  }, 60_000);

  afterAll(() => {
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("loads all tables and panels through the production ABI", () => {
    expect(store.manifest.panels.map((panel) => panel.title)).toEqual([
      "CPU Usage · WASM",
      "Context Switch Rate · Steps",
      "Context Switch Rate · Lines",
      "A Completely Reasonable Dinosaur",
    ]);
    expect(store.table("cpu_intervals").rowCount).toBe(78);
    expect(store.table("context_intervals").rowCount).toBe(79);
    expect(store.table("dino_body").rowCount).toBe(23);
    expect(store.table("dino_flames").rowCount).toBe(6);
    expect(store.table("settings").cell("capacity", 0)).toBe(11);
  });

  it("preserves independent counter gaps and lazy UTF-8 messages", () => {
    const context = store.table("context_intervals");
    const voluntaryGap = [...context.rows()].find(
      (row) => context.cell("voluntary_rate", row) === null,
    );
    expect(voluntaryGap).toBeDefined();
    expect(context.cell("involuntary_rate", voluntaryGap!)).not.toBeNull();

    const body = store.table("dino_body");
    expect(body.cell("message", 0)).toBe("💩");
    expect(body.cell("message", 2)).toBeNull();
    expect(body.cell("message", 5)).toBe("❤️");
  });

  it("feeds CPU and dinosaur outputs into presentation components", () => {
    const cpu = new ExtensionPanel(
      "demo",
      store.manifest,
      store,
      store.manifest.panels[0]!,
      0,
    );
    expect(
      cpu.tooltip({
        instance_id: "demo",
        panel_index: 0,
        table: "cpu_intervals",
        row: 0,
        channels: {
          start: "start_ns",
          end: "end_ns",
          y: "cores",
        },
      }).map((item) => item.label),
    ).toEqual(["Window", "CPU time", "Cores", "Total CPU"]);
    expect(
      cpu.presentation(
        {
          start: 1_000_000_000,
          end: 20_750_000_000,
          width: 1_000,
          height: 92,
          labelWidth: 100,
        },
        null,
      ).readout.map((item) => item.label),
    ).toEqual(["avg", "avg", "max"]);

    const dino = new ExtensionPanel(
      "demo",
      store.manifest,
      store,
      store.manifest.panels[3]!,
      3,
    );
    expect(
      dino.tooltip({
        instance_id: "demo",
        panel_index: 3,
        table: "dino_body",
        row: 0,
        channels: { x: "x", y: "y" },
      }),
    ).toEqual([{ label: "Dino says", value: "💩" }]);
  });
});
