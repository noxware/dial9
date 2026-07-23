import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTENSION_WASM_POLICY_LIMITS,
  REQUIRED_EXTENSION_FUNCTION_EXPORTS,
  validateExtensionWasm,
} from "./extension-wasm-policy.js";

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const;
const textEncoder = new TextEncoder();

interface ExportEntry {
  readonly name: string;
  readonly kind: number;
  readonly index: number;
}

interface ModuleOptions {
  readonly memoryPayload?: readonly number[] | null;
  readonly functionTypeIndices?: readonly number[];
  readonly exports?: readonly ExportEntry[];
  readonly codeBodies?: readonly (readonly number[])[];
  readonly extraBeforeCode?: readonly (readonly number[])[];
  readonly extraAfterCode?: readonly (readonly number[])[];
}

describe("validateExtensionWasm", () => {
  it("accepts the exact self-contained ABI and returns bounded metadata", () => {
    const module = validModule({
      extraBeforeCode: [
        customSection("dial9-test", [1, 2, 3]),
        section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]),
      ],
      extraAfterCode: [
        section(11, [1, 0, 0x41, 0, 0x0b, 1, 42]),
      ],
    });

    const result = validateExtensionWasm(module);

    expect(result).toEqual({
      ok: true,
      metadata: {
        byteLength: module.byteLength,
        memory: { initialPages: 1, maximumPages: 16 },
        table: null,
        typeCount: 2,
        functionCount: 8,
        globalCount: 1,
        dataSegmentCount: 1,
        elementSegmentCount: 0,
        codeBytes: 32,
        customSectionCount: 1,
      },
    });
  });

  it("applies the byte limit before parsing", () => {
    const module = validModule();
    expectCode(
      validateExtensionWasm(module, { maxModuleBytes: module.byteLength - 1 }),
      "too-large"
    );
    expect(DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxModuleBytes).toBe(2 * 1024 * 1024);
  });

  it.each([
    ["bad magic", new Uint8Array([1, 2, 3, 4, 1, 0, 0, 0])],
    [
      "component-model version",
      new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]),
    ],
    ["truncated header", new Uint8Array([0, 0x61])],
  ])("rejects %s as a non-core module", (_label, module) => {
    expectCode(validateExtensionWasm(module), "invalid-header");
  });

  it("rejects non-canonical and overflowing structural LEB128", () => {
    expectCode(
      validateExtensionWasm(bytes([...HEADER, 1, 0x80, 0x00])),
      "malformed"
    );
    expectCode(
      validateExtensionWasm(bytes([...HEADER, 1, 0xff, 0xff, 0xff, 0xff, 0x10])),
      "malformed"
    );
  });

  it("rejects malformed instruction bodies through the WebAssembly engine", () => {
    const bodies = defaultBodies();
    bodies[0] = [0, 0xff, 0x0b];
    expectCode(
      validateExtensionWasm(validModule({ codeBodies: bodies })),
      "invalid-module"
    );
  });

  it("rejects every import, including otherwise valid function imports", () => {
    const importPayload = [
      1,
      ...name("env"),
      ...name("capability"),
      0, // function import
      0, // type index
    ];
    expectCode(
      validateExtensionWasm(
        moduleFromSections([
          typeSection(),
          section(2, importPayload),
          functionSection(defaultFunctionTypeIndices()),
          memorySection(),
          exportSection(defaultExports()),
          codeSection(defaultBodies()),
        ])
      ),
      "imports-forbidden"
    );
  });

  it("rejects start functions", () => {
    expectCode(
      validateExtensionWasm(
        validModule({ extraBeforeCode: [section(8, [0])] })
      ),
      "start-forbidden"
    );
  });

  it("accepts rustc's bounded internal table and two immutable linker globals", () => {
    const exports = [
      ...defaultExports(),
      { name: "__data_end", kind: 3, index: 0 },
      { name: "__heap_base", kind: 3, index: 1 },
    ];
    const module = moduleFromSections([
      typeSection(),
      functionSection(defaultFunctionTypeIndices()),
      section(4, [1, 0x70, 1, 71, 71]),
      memorySection(),
      section(6, [
        2,
        0x7f,
        0,
        0x41,
        1,
        0x0b,
        0x7f,
        0,
        0x41,
        2,
        0x0b,
      ]),
      exportSection(exports),
      codeSection(defaultBodies()),
    ]);

    const result = validateExtensionWasm(module);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.table).toEqual({
        initialElements: 71,
        maximumElements: 71,
      });
      expect(result.metadata.globalCount).toBe(2);
    }
  });

  it.each([
    ["multiple", [2, 0x70, 1, 1, 1, 0x70, 1, 1, 1]],
    ["externref", [1, 0x6f, 1, 1, 1]],
    ["unbounded", [1, 0x70, 0, 1]],
    ["minimum over maximum", [1, 0x70, 1, 2, 1]],
  ] as const)("rejects a %s table", (_label, tablePayload) => {
    expectCode(
      validateExtensionWasm(
        moduleFromSections([
          typeSection(),
          functionSection(defaultFunctionTypeIndices()),
          section(4, tablePayload),
          memorySection(),
          exportSection(defaultExports()),
          codeSection(defaultBodies()),
        ])
      ),
      "invalid-table"
    );
  });

  it("caps the optional internal table", () => {
    expectCode(
      validateExtensionWasm(
        moduleFromSections([
          typeSection(),
          functionSection(defaultFunctionTypeIndices()),
          section(4, [1, 0x70, 1, 2, 3]),
          memorySection(),
          exportSection(defaultExports()),
          codeSection(defaultBodies()),
        ]),
        { maxTableElements: 2 }
      ),
      "invalid-table"
    );
    expect(DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxTableElements).toBe(4096);
  });

  it.each([
    ["missing", null],
    ["two memories", [2, 1, 1, 2, 1, 1, 2]],
    ["no explicit maximum", [1, 0, 1]],
    ["shared", [1, 3, 1, 2]],
    ["memory64", [1, 5, 1, 2]],
    ["minimum over maximum", [1, 1, 3, 2]],
  ] as const)("rejects %s memory", (_label, memoryPayload) => {
    expectCode(
      validateExtensionWasm(validModule({ memoryPayload })),
      "invalid-memory"
    );
  });

  it("rejects memory above the configured page cap", () => {
    expectCode(
      validateExtensionWasm(validModule(), { maxMemoryPages: 15 }),
      "invalid-memory"
    );
    expect(DEFAULT_EXTENSION_WASM_POLICY_LIMITS.maxMemoryPages).toBe(1024);
  });

  it("requires exactly the named ABI exports and no others", () => {
    const missingMemory = defaultExports().map((entry) =>
      entry.name === "memory" ? { ...entry, name: "not_memory" } : entry
    );
    expectCode(
      validateExtensionWasm(validModule({ exports: missingMemory })),
      "invalid-export"
    );

    expectCode(
      validateExtensionWasm(
        validModule({
          exports: [
            ...defaultExports(),
            { name: "surprise", kind: 0, index: 0 },
          ],
        })
      ),
      "invalid-export"
    );

    const wrongKind = defaultExports().map((entry) =>
      entry.name === "dial9_finish" ? { ...entry, kind: 3 } : entry
    );
    expectCode(
      validateExtensionWasm(validModule({ exports: wrongKind })),
      "invalid-export"
    );
  });

  it("only permits immutable i32 linker-global exports with valid indices", () => {
    const exportedDataEnd = [
      ...defaultExports(),
      { name: "__data_end", kind: 3, index: 0 },
    ];

    for (const global of [
      [1, 0x7f, 1, 0x41, 0, 0x0b], // mutable i32
      [1, 0x7e, 0, 0x42, 0, 0x0b], // immutable i64
    ]) {
      expectCode(
        validateExtensionWasm(
          validModule({
            exports: exportedDataEnd,
            extraBeforeCode: [section(6, global)],
          })
        ),
        "invalid-export"
      );
    }

    expectCode(
      validateExtensionWasm(
        validModule({
          exports: [
            ...defaultExports(),
            { name: "__data_end", kind: 3, index: 1 },
          ],
          extraBeforeCode: [
            section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]),
          ],
        })
      ),
      "invalid-export"
    );
  });

  it("rejects missing, out-of-range, or aliased ABI functions", () => {
    const missing = defaultExports().filter(
      ({ name }) => name !== "dial9_finish"
    );
    expectCode(
      validateExtensionWasm(validModule({ exports: missing })),
      "invalid-export"
    );

    const outOfRange = defaultExports().map((entry) =>
      entry.name === "dial9_finish" ? { ...entry, index: 8 } : entry
    );
    expectCode(
      validateExtensionWasm(validModule({ exports: outOfRange })),
      "invalid-export"
    );

    const aliased = defaultExports().map((entry) =>
      entry.name === "dial9_push" ? { ...entry, index: 1 } : entry
    );
    expectCode(
      validateExtensionWasm(validModule({ exports: aliased })),
      "invalid-export"
    );
  });

  it("checks every ABI function signature before compilation", () => {
    const wrongAbiVersion = defaultFunctionTypeIndices();
    wrongAbiVersion[0] = 1;
    expectCode(
      validateExtensionWasm(
        validModule({ functionTypeIndices: wrongAbiVersion })
      ),
      "invalid-abi"
    );
  });

  it("requires function and code counts to agree", () => {
    expectCode(
      validateExtensionWasm(
        validModule({ codeBodies: defaultBodies().slice(0, 7) })
      ),
      "invalid-abi"
    );
  });

  it("rejects duplicate, out-of-order, unknown, and excessive sections", () => {
    expectCode(
      validateExtensionWasm(
        moduleFromSections([
          typeSection(),
          functionSection(defaultFunctionTypeIndices()),
          memorySection(),
          memorySection(),
          exportSection(defaultExports()),
          codeSection(defaultBodies()),
        ])
      ),
      "duplicate-section"
    );
    expectCode(
      validateExtensionWasm(
        moduleFromSections([
          memorySection(),
          typeSection(),
          functionSection(defaultFunctionTypeIndices()),
          exportSection(defaultExports()),
          codeSection(defaultBodies()),
        ])
      ),
      "section-order"
    );
    expectCode(
      validateExtensionWasm(
        moduleFromSections([section(13, [])])
      ),
      "unsupported-section"
    );
    expectCode(
      validateExtensionWasm(validModule(), { maxSections: 4 }),
      "limit-exceeded"
    );
  });

  it("caps declared functions, globals, data segments, and element segments", () => {
    expectCode(
      validateExtensionWasm(validModule(), { maxFunctions: 7 }),
      "limit-exceeded"
    );
    expectCode(
      validateExtensionWasm(
        validModule({ extraBeforeCode: [section(6, [2])] }),
        { maxGlobals: 1 }
      ),
      "limit-exceeded"
    );
    expectCode(
      validateExtensionWasm(
        validModule({ extraAfterCode: [section(11, [2])] }),
        { maxDataSegments: 1 }
      ),
      "limit-exceeded"
    );
    expectCode(
      validateExtensionWasm(
        validModule({ extraBeforeCode: [section(9, [2])] }),
        { maxElementSegments: 1 }
      ),
      "limit-exceeded"
    );
  });

  it("rejects invalid policy limits without touching WebAssembly", () => {
    expectCode(
      validateExtensionWasm(validModule(), { maxFunctions: -1 }),
      "malformed"
    );
  });
});

function validModule(options: ModuleOptions = {}): Uint8Array {
  const functionTypeIndices =
    options.functionTypeIndices ?? defaultFunctionTypeIndices();
  const exports = options.exports ?? defaultExports();
  const codeBodies = options.codeBodies ?? defaultBodies();
  const memoryPayload =
    options.memoryPayload === undefined
      ? [1, 1, 1, 16]
      : options.memoryPayload;

  return moduleFromSections([
    typeSection(),
    functionSection(functionTypeIndices),
    ...(memoryPayload === null ? [] : [section(5, memoryPayload)]),
    ...(options.extraBeforeCode ?? []),
    exportSection(exports),
    codeSection(codeBodies),
    ...(options.extraAfterCode ?? []),
  ]);
}

function typeSection(): number[] {
  return section(1, [
    2,
    0x60,
    0,
    1,
    0x7f, // () -> i32
    0x60,
    1,
    0x7f,
    1,
    0x7f, // (i32) -> i32
  ]);
}

function functionSection(typeIndices: readonly number[]): number[] {
  return section(3, [...u32(typeIndices.length), ...typeIndices]);
}

function memorySection(): number[] {
  return section(5, [1, 1, 1, 16]);
}

function exportSection(exports: readonly ExportEntry[]): number[] {
  return section(7, [
    ...u32(exports.length),
    ...exports.flatMap(({ name: exportName, kind, index }) => [
      ...name(exportName),
      kind,
      ...u32(index),
    ]),
  ]);
}

function codeSection(bodies: readonly (readonly number[])[]): number[] {
  return section(10, [
    ...u32(bodies.length),
    ...bodies.flatMap((body) => [...u32(body.length), ...body]),
  ]);
}

function customSection(sectionName: string, payload: readonly number[]): number[] {
  return section(0, [...name(sectionName), ...payload]);
}

function defaultFunctionTypeIndices(): number[] {
  return [0, 1, 1, 0, 0, 0, 0, 0];
}

function defaultBodies(): number[][] {
  return Array.from({ length: 8 }, () => [0, 0x41, 0, 0x0b]);
}

function defaultExports(): ExportEntry[] {
  return [
    { name: "memory", kind: 2, index: 0 },
    ...REQUIRED_EXTENSION_FUNCTION_EXPORTS.map((exportName, index) => ({
      name: exportName,
      kind: 0,
      index,
    })),
  ];
}

function moduleFromSections(sections: readonly (readonly number[])[]): Uint8Array {
  return bytes([...HEADER, ...sections.flat()]);
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function name(value: string): number[] {
  const encoded = [...textEncoder.encode(value)];
  return [...u32(encoded.length), ...encoded];
}

function u32(value: number): number[] {
  const encoded: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    encoded.push(byte);
  } while (remaining !== 0);
  return encoded;
}

function bytes(values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

function expectCode(
  result: ReturnType<typeof validateExtensionWasm>,
  code: string
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
