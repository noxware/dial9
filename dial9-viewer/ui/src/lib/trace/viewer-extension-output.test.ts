import { describe, expect, it } from "vitest";
import {
  VIEW_OUTPUT_LIMITS,
  ViewerExtensionOutputError,
  decodeViewerExtensionOutput,
} from "./viewer-extension-output.js";

type TestColumn =
  | { name: string; kind: 1; values: readonly number[] }
  | { name: string; kind: 5; values: readonly number[] }
  | { name: string; kind: 6; values: readonly string[] };

function appendU16(bytes: number[], value: number): void {
  bytes.push(value & 0xff, value >>> 8);
}

function appendU32(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

function appendString16(bytes: number[], value: string): void {
  const encoded = new TextEncoder().encode(value);
  appendU16(bytes, encoded.length);
  bytes.push(...encoded);
}

function align(bytes: number[], width: number): void {
  while (bytes.length % width !== 0) bytes.push(0);
}

function columnBytes(column: TestColumn): Uint8Array {
  if (column.kind === 1) {
    const result = new Uint8Array(column.values.length * 8);
    const view = new DataView(result.buffer);
    column.values.forEach((value, index) => view.setFloat64(index * 8, value, true));
    return result;
  }
  if (column.kind === 5) return Uint8Array.from(column.values);
  const strings = column.values.map((value) => new TextEncoder().encode(value));
  const byteLength = strings.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array((strings.length + 1) * 4 + byteLength);
  const view = new DataView(result.buffer);
  let offset = 0;
  strings.forEach((value, index) => {
    view.setUint32(index * 4, offset, true);
    result.set(value, (strings.length + 1) * 4 + offset);
    offset += value.length;
  });
  view.setUint32(strings.length * 4, offset, true);
  return result;
}

function output(
  manifest: unknown,
  tables: readonly {
    name: string;
    rows: number;
    columns: readonly TestColumn[];
  }[],
): ArrayBuffer {
  const bytes: number[] = [0x44, 0x39, 0x56, 0x4f, 1, 0, 0, 0];
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  appendU32(bytes, manifestBytes.length);
  appendU32(bytes, tables.length);
  bytes.push(...manifestBytes);
  for (const table of tables) {
    appendString16(bytes, table.name);
    appendU32(bytes, table.rows);
    appendU16(bytes, table.columns.length);
    for (const column of table.columns) {
      appendString16(bytes, column.name);
      bytes.push(column.kind, 0, 0, 0);
      const data = columnBytes(column);
      appendU32(bytes, data.length);
      align(bytes, column.kind === 1 ? 8 : column.kind === 6 ? 4 : 1);
      bytes.push(...data);
    }
  }
  return Uint8Array.from(bytes).buffer;
}

const VALID_MANIFEST = {
  version: 1,
  panels: [
    {
      id: "cpu",
      title: "CPU",
      height: 100,
      scales: [{ id: "y", includeZero: true }],
      components: [
        {
          id: "usage",
          kind: "interval-area",
          input: "cpu",
          scale: "y",
          startColumn: "start",
          endColumn: "end",
          valueColumn: "cores",
          color: "#4fc3f7",
        },
        {
          id: "tip",
          kind: "tooltip",
          target: "usage",
          strategy: { kind: "interval" },
          rows: [{ label: "CPU", field: "cores" }],
        },
        {
          id: "legend",
          kind: "legend",
          atCursor: [
            {
              input: "cpu",
              xColumn: "end",
              valueColumn: "cores",
              label: "Cores",
            },
          ],
        },
      ],
    },
  ],
};

describe("viewer-extension output boundary", () => {
  it("decodes a valid manifest and zero-copy numeric columns", () => {
    const bundle = decodeViewerExtensionOutput(
      output(VALID_MANIFEST, [
        {
          name: "cpu",
          rows: 2,
          columns: [
            { name: "start", kind: 1, values: [0, 10] },
            { name: "end", kind: 1, values: [10, 20] },
            { name: "cores", kind: 1, values: [0.5, 1.5] },
          ],
        },
      ]),
    );
    expect(bundle.panels[0]?.id).toBe("cpu");
    expect([...bundle.tables["cpu"]!.columns["cores"]!]).toEqual([0.5, 1.5]);
    expect(Object.getPrototypeOf(bundle.tables)).toBeNull();
    expect(Object.getPrototypeOf(bundle.tables["cpu"]!.columns)).toBeNull();
  });

  it("does not give prototype names special behavior", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    manifest.panels[0]!.components[0]!.input = "__proto__";
    manifest.panels[0]!.components[2]!.atCursor![0]!.input = "__proto__";
    const bundle = decodeViewerExtensionOutput(
      output(manifest, [
        {
          name: "__proto__",
          rows: 1,
          columns: [
            { name: "start", kind: 1, values: [0] },
            { name: "end", kind: 1, values: [1] },
            { name: "cores", kind: 1, values: [1] },
          ],
        },
      ]),
    );
    expect(bundle.tables["__proto__"]?.length).toBe(1);
  });

  it("rejects references that would otherwise fail during rendering", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    manifest.panels[0]!.components[1]!.target = "missing";
    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [1] },
            ],
          },
        ]),
      ),
    ).toThrow(/targets unknown drawing/);
  });

  it("rejects truncated column payloads", () => {
    const bytes = output(VALID_MANIFEST, [
      {
        name: "cpu",
        rows: 1,
        columns: [
          { name: "start", kind: 1, values: [0] },
          { name: "end", kind: 1, values: [1] },
          { name: "cores", kind: 1, values: [1] },
        ],
      },
    ]);
    expect(() => decodeViewerExtensionOutput(bytes.slice(0, -1))).toThrow(
      ViewerExtensionOutputError,
    );
  });

  it("rejects non-finite manifest numbers", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    manifest.panels[0]!.height = Number.POSITIVE_INFINITY;
    // JSON itself normalizes Infinity to null; either way the boundary must
    // reject it rather than letting it reach canvas sizing.
    expect(() => decodeViewerExtensionOutput(output(manifest, []))).toThrow(
      /height must be a finite number/,
    );
  });

  it("rejects unsorted time columns before binary-search rendering", () => {
    expect(() =>
      decodeViewerExtensionOutput(
        output(VALID_MANIFEST, [
          {
            name: "cpu",
            rows: 2,
            columns: [
              { name: "start", kind: 1, values: [10, 0] },
              { name: "end", kind: 1, values: [10, 20] },
              { name: "cores", kind: 1, values: [1, 2] },
            ],
          },
        ]),
      ),
    ).toThrow(/must be sorted ascending/);
  });

  it("accepts an unsorted polyline with gaps and no sampling contract", () => {
    const manifest = {
      version: 1,
      panels: [{
        id: "dino",
        title: "Dino",
        height: 100,
        x: { kind: "linear", min: 0, max: 10 },
        scales: [{ id: "y", min: 0, max: 10 }],
        components: [{
          id: "outline",
          kind: "polyline",
          input: "points",
          scale: "y",
          xColumn: "x",
          valueColumn: "y",
          gapColumn: "gap",
          color: "#00ff66",
        }, {
          id: "outline-tip",
          kind: "tooltip",
          target: "outline",
          strategy: { kind: "nearest-point", radius: 8 },
          rows: [{ label: "Y", field: "y" }],
        }],
      }],
    };
    const bundle = decodeViewerExtensionOutput(
      output(manifest, [{
        name: "points",
        rows: 4,
        columns: [
          { name: "x", kind: 1, values: [1, 8, 8, 2] },
          { name: "y", kind: 1, values: [2, 6, 4, 2] },
          { name: "gap", kind: 5, values: [0, 0, 1, 0] },
        ],
      }]),
    );

    expect(bundle.panels[0]?.components[0]).toEqual({
      id: "outline",
      kind: "polyline",
      input: "points",
      scale: "y",
      xColumn: "x",
      valueColumn: "y",
      gapColumn: "gap",
      color: "#00ff66",
    });
  });

  it.each(["line", "step-line"])(
    "keeps the sorted x contract for %s",
    (kind) => {
      const manifest = {
        version: 1,
        panels: [{
          id: "series",
          title: "Series",
          height: 100,
          scales: [{ id: "y" }],
          components: [{
            id: "series",
            kind,
            input: "points",
            scale: "y",
            xColumn: "x",
            valueColumn: "y",
            color: "#fff",
            sampling: "none",
          }],
        }],
      };

      expect(() =>
        decodeViewerExtensionOutput(
          output(manifest, [{
            name: "points",
            rows: 2,
            columns: [
              { name: "x", kind: 1, values: [2, 1] },
              { name: "y", kind: 1, values: [1, 2] },
            ],
          }]),
        ),
      ).toThrow(/must be sorted ascending/);
    },
  );

  it("bounds every polyline by the unsampled-row limit", () => {
    const rows = VIEW_OUTPUT_LIMITS.unsampledRows + 1;
    const values = new Array<number>(rows).fill(0);
    const manifest = {
      version: 1,
      panels: [{
        id: "large",
        title: "Large",
        height: 100,
        scales: [{ id: "y" }],
        components: [{
          id: "outline",
          kind: "polyline",
          input: "points",
          scale: "y",
          xColumn: "x",
          valueColumn: "y",
          color: "#fff",
        }],
      }],
    };

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [{
          name: "points",
          rows,
          columns: [
            { name: "x", kind: 5, values },
            { name: "y", kind: 5, values },
          ],
        }]),
      ),
    ).toThrow(
      `has ${rows} unsampled rows; limit is ${VIEW_OUTPUT_LIMITS.unsampledRows}`,
    );
  });

  it("rejects non-finite drawing columns", () => {
    expect(() =>
      decodeViewerExtensionOutput(
        output(VALID_MANIFEST, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [Number.NaN] },
            ],
          },
        ]),
      ),
    ).toThrow(/non-finite value/);
  });

  it("bounds every decoded UTF-8 cell", () => {
    expect(() =>
      decodeViewerExtensionOutput(
        output(
          { version: 1, panels: [] },
          [
            {
              name: "strings",
              rows: 1,
              columns: [
                {
                  name: "value",
                  kind: 6,
                  values: ["x".repeat(VIEW_OUTPUT_LIMITS.stringBytes + 1)],
                },
              ],
            },
          ],
        ),
      ),
    ).toThrow(/exceeds .* UTF-8 bytes/);
  });

  it("counts repeated tooltip and legend UTF-8 references", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    const components = manifest.panels[0]!.components;
    components[1]!.rows = [
      { label: "First", field: "message" },
      { label: "Again", field: "message" },
    ];
    components[2]!.atCursor = [
      {
        input: "cpu",
        xColumn: "end",
        valueColumn: "message",
        label: "Again",
      },
    ];

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [1] },
              {
                name: "message",
                kind: 6,
                values: ["x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 2)],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/UTF-8 bytes for presentation/);
  });

  it("counts manifest strings and the rendered background color", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    const chunk = "x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 4);
    const components = manifest.panels[0]!.components;
    manifest.panels[0]!.title = chunk;
    components[0]!.color = chunk;
    components[1]!.rows![0]!.label = chunk;
    components[2]!.atCursor![0]!.label = chunk;
    components.push({
      id: "background",
      kind: "background",
      input: "background",
      colorColumn: "color",
    });

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [1] },
            ],
          },
          {
            name: "background",
            rows: 1,
            columns: [{ name: "color", kind: 6, values: ["x"] }],
          },
        ]),
      ),
    ).toThrow(/UTF-8 bytes for presentation/);
  });

  it("bounds aggregate UTF-8 referenced by text components", () => {
    const manifest = {
      version: 1,
      panels: [{
        id: "labels",
        title: "Labels",
        height: 100,
        x: { kind: "linear", min: 0, max: 1 },
        scales: [{ id: "y", min: 0, max: 1 }],
        components: [{
          id: "labels",
          kind: "text",
          input: "labels",
          scale: "y",
          xColumn: "x",
          valueColumn: "y",
          textColumn: "text",
        }],
      }],
    };

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [{
          name: "labels",
          rows: 2,
          columns: [
            { name: "x", kind: 1, values: [0, 1] },
            { name: "y", kind: 1, values: [0, 1] },
            {
              name: "text",
              kind: 6,
              values: [
                "x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 2),
                "x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 2 + 1),
              ],
            },
          ],
        }]),
      ),
    ).toThrow(/UTF-8 bytes for presentation/);
  });

  it("does not charge unreferenced UTF-8 columns to the presentation budget", () => {
    expect(() =>
      decodeViewerExtensionOutput(
        output(
          { version: 1, panels: [] },
          [{
            name: "strings",
            rows: 2,
            columns: [{
              name: "value",
              kind: 6,
              values: [
                "x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 2 + 1),
                "x".repeat(VIEW_OUTPUT_LIMITS.presentedUtf8Bytes / 2 + 1),
              ],
            }],
          }],
        ),
      ),
    ).not.toThrow();
  });

  it("bounds nearest-point hit radii", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    manifest.panels[0]!.components[1]!.strategy = {
      kind: "nearest-point",
      radius: 129,
    };

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [1] },
            ],
          },
        ]),
      ),
    ).toThrow(/strategy.radius must be between 0 and 128/);
  });

  it("bounds tooltip and legend items across the whole bundle", () => {
    const manifest = structuredClone(VALID_MANIFEST);
    const items = Array.from(
      { length: VIEW_OUTPUT_LIMITS.displayItems },
      (_, index) => ({ label: `item-${index}` }),
    );
    manifest.panels[0]!.components[2]!.items = items;

    expect(() =>
      decodeViewerExtensionOutput(
        output(manifest, [
          {
            name: "cpu",
            rows: 1,
            columns: [
              { name: "start", kind: 1, values: [0] },
              { name: "end", kind: 1, values: [1] },
              { name: "cores", kind: 1, values: [1] },
            ],
          },
        ]),
      ),
    ).toThrow(/tooltip and legend items/);
  });
});
