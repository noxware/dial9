import { describe, expect, it } from "vitest";
import {
  ManifestError,
  manifestFromModule,
  parseManifest,
} from "./manifest.js";

function cpuManifest(): Record<string, unknown> {
  return {
    version: 1,
    tables: [
      {
        name: "cpu",
        columns: [
          { name: "start", type: "u64" },
          { name: "end", type: "u64" },
          { name: "cores", type: "f64", nullable: true },
          { name: "label", type: "utf8" },
        ],
      },
    ],
    panels: [
      {
        title: "CPU",
        components: [
          {
            name: "interval-area/v1",
            table: "cpu",
            start: "start",
            end: "end",
            y: "cores",
            color: {
              column: "cores",
              stops: [
                { value: 0, color: "#4fc3f7" },
                { value: 1, color: "#ff7361" },
              ],
            },
          },
          {
            name: "tooltip/v1",
            table: "cpu",
            items: [{ label: "Cores", column: "cores" }],
          },
          {
            name: "swatch/v1",
            label: "Last",
            color: "#4fc3f7",
            shape: "line",
            value: { table: "cpu", column: "cores", select: "last", unit: "%" },
          },
        ],
      },
    ],
  };
}

describe("viewer extension manifest", () => {
  it("normalizes semantic defaults and validates table references", () => {
    const manifest = parseManifest(JSON.stringify(cpuManifest()));
    expect(manifest.panels[0]!.x_axis).toEqual({ kind: "time" });
    expect(manifest.panels[0]!.y_scales).toEqual([
      { name: "default", include_zero: true },
    ]);
    expect(manifest.tables[0]!.columns[0]!.nullable).toBe(false);
    expect(Object.isFrozen(manifest.panels[0]!.components)).toBe(true);
  });

  it("rejects Canvas-like physical settings on known components", () => {
    const raw = cpuManifest();
    const panel = (raw.panels as Array<Record<string, unknown>>)[0]!;
    const area = (panel.components as Array<Record<string, unknown>>)[0]!;
    area.line_width = 4;
    expect(() => parseManifest(JSON.stringify(raw))).toThrowError(
      /unknown property line_width/,
    );
  });

  it("retains an unknown component version for an in-panel compatibility error", () => {
    const raw = cpuManifest();
    const panel = (raw.panels as Array<Record<string, unknown>>)[0]!;
    panel.components = [{ name: "heatmap/v9", future_option: { value: 1 } }];
    const manifest = parseManifest(JSON.stringify(raw));
    expect(manifest.panels[0]!.components[0]).toEqual({
      name: "heatmap/v9",
      future_option: { value: 1 },
    });
  });

  it("extracts exactly one UTF-8 custom section", () => {
    const json = JSON.stringify(cpuManifest());
    const module = new WebAssembly.Module(wasmWithCustomSection("dial9.viewer.manifest", json));
    expect(manifestFromModule(module).panels[0]!.title).toBe("CPU");
  });

  it("rejects a missing manifest section", () => {
    const module = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(() => manifestFromModule(module)).toThrowError(ManifestError);
  });
});

function wasmWithCustomSection(name: string, contents: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const contentsBytes = encoder.encode(contents);
  const payload = [
    ...uleb(nameBytes.length),
    ...nameBytes,
    ...contentsBytes,
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...uleb(payload.length),
    ...payload,
  ]);
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}
