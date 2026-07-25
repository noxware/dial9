import { describe, expect, it } from "vitest";
import {
  ExtensionModuleError,
  loadExtensionModule,
} from "./module.js";

const MANIFEST = JSON.stringify({
  version: 1,
  tables: [],
  panels: [],
});

function u32(value: number): number[] {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    result.push(byte);
  } while (value !== 0);
  return result;
}

function bytes(value: string): number[] {
  const encoded = [...new TextEncoder().encode(value)];
  return [...u32(encoded.length), ...encoded];
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function customSection(name: string, payload: string): number[] {
  return section(0, [
    ...bytes(name),
    ...new TextEncoder().encode(payload),
  ]);
}

function wasm(options: {
  manifests?: readonly string[];
  importFunction?: boolean;
  negativeReservePointer?: boolean;
  reservePointer?: number;
  trapPush?: boolean;
} = {}): Uint8Array<ArrayBuffer> {
  const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  const types = section(1, [
    2,
    0x60, 0, 1, 0x7f,
    0x60, 1, 0x7f, 1, 0x7f,
  ]);
  if (options.importFunction === true) {
    const imports = section(2, [
      1,
      ...bytes("evil"),
      ...bytes("fetch"),
      0,
      0,
    ]);
    return new Uint8Array([
      ...header,
      ...types,
      ...imports,
      ...(options.manifests ?? [MANIFEST]).flatMap((manifest) =>
        customSection("dial9.viewer.manifest", manifest),
      ),
    ]);
  }

  const functionTypes = [0, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const functions = section(3, [functionTypes.length, ...functionTypes]);
  const memory = section(5, [1, 0, 1]);
  const exportNames = [
    "dial9_abi_version",
    "dial9_input_reserve",
    "dial9_push",
    "dial9_finish",
    "dial9_output_next",
    "dial9_output_descriptor_ptr",
    "dial9_output_descriptor_len",
    "dial9_output_ack",
    "dial9_error_ptr",
    "dial9_error_len",
  ];
  const exports = section(7, [
    exportNames.length + 1,
    ...bytes("memory"), 2, 0,
    ...exportNames.flatMap((name, index) => [...bytes(name), 0, index]),
  ]);
  const returns = [
    1,
    options.reservePointer ?? 1024,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const bodies = returns.flatMap((value, index) => {
    let instructions = [0, 0x41, ...u32(value), 0x0b];
    if (options.trapPush === true && index === 2) {
      instructions = [0, 0x00, 0x0b];
    } else if (options.negativeReservePointer === true && index === 1) {
      instructions = [0, 0x41, 0x7f, 0x0b];
    }
    return [...u32(instructions.length), ...instructions];
  });
  const code = section(10, [returns.length, ...bodies]);
  return new Uint8Array([
    ...header,
    ...types,
    ...functions,
    ...memory,
    ...exports,
    ...code,
    ...(options.manifests ?? [MANIFEST]).flatMap((manifest) =>
      customSection("dial9.viewer.manifest", manifest),
    ),
  ]);
}

describe("extension WebAssembly module", () => {
  it("loads a zero-import module and drives the numeric ABI", async () => {
    const guest = await loadExtensionModule(wasm());
    expect(guest.manifest).toEqual({
      version: 1,
      tables: [],
      panels: [],
    });
    expect(guest.linearMemoryByteLength).toBe(65_536);
    expect(guest.push(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(guest.finish()).toEqual([]);
    expect(() => guest.finish()).toThrow("finish may only be called once");
  });

  it("rejects any import before instantiating the module", async () => {
    await expect(
      loadExtensionModule(wasm({ importFunction: true })),
    ).rejects.toThrow("declares 1 import");
  });

  it("requires exactly one manifest custom section", async () => {
    await expect(
      loadExtensionModule(wasm({ manifests: [] })),
    ).rejects.toThrow("found 0");
    await expect(
      loadExtensionModule(wasm({ manifests: [MANIFEST, MANIFEST] })),
    ).rejects.toThrow("found 2");
  });

  it("validates manifest JSON before instantiation", async () => {
    await expect(
      loadExtensionModule(wasm({ manifests: ["{"] })),
    ).rejects.toThrow("JSON parse failed");
  });

  it("validates the reserved input range", async () => {
    const guest = await loadExtensionModule(
      wasm({ reservePointer: 65_535 }),
    );
    expect(() => guest.push(new Uint8Array([1, 2]))).toThrow(
      "input range is outside WebAssembly memory",
    );

    const highPointer = await loadExtensionModule(
      wasm({ negativeReservePointer: true }),
    );
    expect(() => highPointer.push(new Uint8Array([1]))).toThrow(
      "input range is outside WebAssembly memory",
    );
  });

  it("contains a guest execution trap inside its instance", async () => {
    const guest = await loadExtensionModule(wasm({ trapPush: true }));
    expect(() => guest.push(new Uint8Array())).toThrow(
      WebAssembly.RuntimeError,
    );
  });

  it("reports compilation errors as module errors", async () => {
    await expect(
      loadExtensionModule(new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(ExtensionModuleError);
  });
});
