import { describe, expect, it } from "vitest";
import {
  ExtensionManifestError,
  parseExtensionManifestBytes,
  parseExtensionManifestJson,
} from "./manifest.js";

const CPU_MANIFEST = {
  version: 1,
  tables: [
    {
      name: "cpu_intervals",
      columns: [
        { name: "start_ns", type: "u64" },
        { name: "end_ns", type: "u64" },
        { name: "cpu_ns", type: "u64" },
        { name: "cores", type: "f64", nullable: true },
        { name: "percent", type: "f64", nullable: true },
      ],
    },
    {
      name: "settings",
      columns: [{ name: "capacity", type: "u32" }],
    },
  ],
  panels: [
    {
      title: "CPU Usage",
      x_axis: { type: "time" },
      scales: [
        {
          name: "usage",
          domain: {
            mode: "visible",
            include: [0, { table: "settings", column: "capacity" }],
          },
        },
      ],
      components: [
        {
          name: "interval-area/v1",
          table: "cpu_intervals",
          start: "start_ns",
          end: "end_ns",
          y: "cores",
          scale: "usage",
          color: {
            column: "percent",
            stops: [
              { at: 0, color: "#4fc3f7" },
              { at: 100, color: "#ef4444" },
            ],
          },
        },
        {
          name: "interval-line/v1",
          table: "cpu_intervals",
          start: "start_ns",
          end: "end_ns",
          y: "cores",
          scale: "usage",
          color: "#4fc3f7",
        },
        {
          name: "horizontal-rule/v1",
          y: { table: "settings", column: "capacity" },
          scale: "usage",
          color: "#8b7355",
        },
        {
          name: "swatch/v1",
          label: "available parallelism",
          color: "#8b7355",
          sample: "rule",
          value: {
            table: "settings",
            column: "capacity",
          },
        },
        {
          name: "tooltip/v1",
          table: "cpu_intervals",
          match: {
            start: "start_ns",
            end: "end_ns",
            y: "cores",
          },
          items: [
            { label: "CPU time", column: "cpu_ns", unit: "ns" },
            { label: "Cores", column: "cores" },
          ],
        },
        {
          name: "readout/v1",
          table: "cpu_intervals",
          items: [
            {
              label: "avg",
              column: "cores",
              reduce: {
                name: "time_weighted_mean",
                start: "start_ns",
                end: "end_ns",
              },
            },
            {
              label: "max",
              column: "cores",
              reduce: "max",
            },
          ],
        },
      ],
    },
  ],
};

describe("extension manifest", () => {
  it("normalizes and validates the CPU component graph", () => {
    const manifest = parseExtensionManifestJson(JSON.stringify(CPU_MANIFEST));

    expect(manifest.tables[0]).toMatchObject({
      name: "cpu_intervals",
      columns: [
        { name: "start_ns", type: "u64", nullable: false },
        { name: "end_ns", type: "u64", nullable: false },
        { name: "cpu_ns", type: "u64", nullable: false },
        { name: "cores", type: "f64", nullable: true },
        { name: "percent", type: "f64", nullable: true },
      ],
    });
    expect(manifest).toMatchObject({
      version: 1,
      panels: [
        {
          title: "CPU Usage",
          x_axis: { type: "time" },
          scales: [
            {
              name: "usage",
              domain: {
                mode: "visible",
                include: [
                  0,
                  { table: "settings", column: "capacity" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(manifest.panels[0]?.components).toHaveLength(6);
    expect(manifest.panels[0]?.components[0]).toMatchObject({
      name: "interval-area/v1",
    });
    expect(manifest.panels[0]?.components[4]).toMatchObject({
      name: "tooltip/v1",
      items: [
        { label: "CPU time", column: "cpu_ns", unit: "ns" },
        { label: "Cores", column: "cores" },
      ],
    });
  });

  it("rejects physical layout and canvas styling", () => {
    const source = structuredClone(CPU_MANIFEST) as Record<string, unknown>;
    const panel = (source["panels"] as Record<string, unknown>[])[0]!;
    panel["height"] = 400;
    expect(() => parseExtensionManifestJson(JSON.stringify(source))).toThrow(
      "height is viewer-owned presentation",
    );

    delete panel["height"];
    const component = (panel["components"] as Record<string, unknown>[])[0]!;
    component["line_width"] = 20;
    expect(() => parseExtensionManifestJson(JSON.stringify(source))).toThrow(
      "line_width is viewer-owned presentation",
    );
  });

  it("requires background scalar colors to come from UTF-8 columns", () => {
    expect(() =>
      parseExtensionManifestJson(
        JSON.stringify({
          version: 1,
          tables: [
            {
              name: "settings",
              columns: [{ name: "color", type: "u32" }],
            },
          ],
          panels: [
            {
              title: "Background",
              components: [
                {
                  name: "background/v1",
                  color: { table: "settings", column: "color" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow("color.column must reference a UTF-8 column");
  });

  it("keeps unknown versioned components as panel-local errors", () => {
    const manifest = parseExtensionManifestJson(
      JSON.stringify({
        version: 1,
        tables: [],
        panels: [
          {
            title: "Future",
            components: [{ name: "heatmap/v2", arbitrary: "ignored" }],
          },
        ],
      }),
    );

    expect(manifest.panels[0]?.components).toEqual([
      { name: "heatmap/v2", unsupported: true },
    ]);
  });

  it.each([
    [
      "duplicate tables",
      {
        version: 1,
        tables: [
          { name: "t", columns: [{ name: "x", type: "u8" }] },
          { name: "t", columns: [{ name: "x", type: "u8" }] },
        ],
        panels: [],
      },
      "duplicates table t",
    ],
    [
      "unknown columns",
      {
        version: 1,
        tables: [
          { name: "t", columns: [{ name: "x", type: "f64" }] },
        ],
        panels: [
          {
            title: "Broken",
            scales: [
              { name: "y", domain: { mode: "visible" } },
            ],
            components: [
              {
                name: "line/v1",
                table: "t",
                x: "missing",
                y: "x",
                scale: "y",
                color: "red",
              },
            ],
          },
        ],
      },
      "unknown column t.missing",
    ],
    [
      "non-numeric geometry",
      {
        version: 1,
        tables: [
          {
            name: "t",
            columns: [
              { name: "x", type: "u64" },
              { name: "label", type: "utf8" },
            ],
          },
        ],
        panels: [
          {
            title: "Broken",
            scales: [
              { name: "y", domain: { mode: "visible" } },
            ],
            components: [
              {
                name: "line/v1",
                table: "t",
                x: "x",
                y: "label",
                scale: "y",
                color: "red",
              },
            ],
          },
        ],
      },
      "must reference a numeric column",
    ],
    [
      "unknown scales",
      {
        version: 1,
        tables: [
          {
            name: "t",
            columns: [
              { name: "x", type: "u64" },
              { name: "y", type: "f64" },
            ],
          },
        ],
        panels: [
          {
            title: "Broken",
            components: [
              {
                name: "line/v1",
                table: "t",
                x: "x",
                y: "y",
                scale: "missing",
                color: "red",
              },
            ],
          },
        ],
      },
      "unknown scale missing",
    ],
    [
      "bad reducers",
      {
        version: 1,
        tables: [
          { name: "t", columns: [{ name: "x", type: "f64" }] },
        ],
        panels: [
          {
            title: "Broken",
            components: [
              {
                name: "readout/v1",
                table: "t",
                items: [
                  { label: "x", column: "x", reduce: "median" },
                ],
              },
            ],
          },
        ],
      },
      "reduce is unsupported",
    ],
  ])("rejects $0", (_name, source, expected) => {
    expect(() => parseExtensionManifestJson(JSON.stringify(source))).toThrow(
      expected,
    );
  });

  it("rejects malformed JSON and malformed UTF-8 with stable errors", () => {
    expect(() => parseExtensionManifestJson("{")).toThrow(
      ExtensionManifestError,
    );
    expect(() =>
      parseExtensionManifestBytes(new Uint8Array([0xc3, 0x28])),
    ).toThrow("custom section is not valid UTF-8");
  });
});
