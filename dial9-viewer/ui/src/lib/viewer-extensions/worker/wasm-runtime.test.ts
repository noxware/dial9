import { describe, expect, it } from "vitest";
import { parseManifest } from "../manifest.js";
import {
  WasmExtensionRuntime,
  prepareExtension,
} from "./wasm-runtime.js";

const manifest = parseManifest(
  JSON.stringify({
    version: 1,
    tables: [
      {
        name: "points",
        columns: [
          { name: "time", type: "u64" },
          { name: "value", type: "f64", nullable: true },
        ],
      },
    ],
    panels: [],
  }),
);

describe("WASM extension runtime", () => {
  it("rejects any imported capability before instantiation", async () => {
    const importsOneFunction = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x02, 0x07, 0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00,
    ]);
    await expect(prepareExtension(importsOneFunction)).rejects.toThrow(/imports 1/);
  });

  it("copies and validates a typed batch before acknowledging guest buffers", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    const descriptorPointer = 64;
    const timePointer = 256;
    const valuePointer = 272;
    const validityPointer = 288;
    new BigUint64Array(memory.buffer, timePointer, 2).set([10n, 20n]);
    new Float64Array(memory.buffer, valuePointer, 2).set([1.5, 99]);
    bytes[validityPointer] = 0b0000_0001;

    const descriptor = new DataView(memory.buffer, descriptorPointer, 16 + 2 * 32);
    descriptor.setUint32(0, 0, true);
    descriptor.setUint32(4, 2, true);
    descriptor.setUint32(8, 2, true);
    writeColumn(descriptor, 16, 3, 0, timePointer, 16, 0, 0);
    writeColumn(
      descriptor,
      48,
      1,
      1,
      valuePointer,
      16,
      validityPointer,
      1,
    );

    let acknowledged = false;
    const runtime = new WasmExtensionRuntime(
      {
        memory,
        dial9_input_alloc: () => 512,
        dial9_push: () => 0,
        dial9_finish: () => 0,
        dial9_output_next: () => (acknowledged ? 0 : descriptorPointer),
        dial9_output_descriptor_len: () => 80,
        dial9_output_ack: () => {
          acknowledged = true;
          return 0;
        },
        dial9_error_ptr: () => 0,
        dial9_error_len: () => 0,
        dial9_abi_version: () => 1,
      } as never,
      manifest,
    );
    const [batch] = runtime.push(new Uint8Array([1, 2]));
    expect(acknowledged).toBe(true);
    expect(batch!.columns[0]).toMatchObject({
      type: "u64",
      rows: 2,
      validity: null,
    });
    expect(Array.from((batch!.columns[0] as { values: BigUint64Array }).values)).toEqual([
      10n,
      20n,
    ]);
    expect(batch!.columns[1]!.validity).toEqual(new Uint8Array([1]));
  });

  it("rejects a column pointer outside linear memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptorPointer = 64;
    const descriptor = new DataView(memory.buffer, descriptorPointer, 80);
    descriptor.setUint32(0, 0, true);
    descriptor.setUint32(4, 2, true);
    descriptor.setUint32(8, 2, true);
    writeColumn(descriptor, 16, 3, 0, 0xffff, 16, 0, 0);
    writeColumn(descriptor, 48, 1, 0, 256, 16, 0, 0);
    let current = true;
    const runtime = new WasmExtensionRuntime(
      {
        memory,
        dial9_input_alloc: () => 512,
        dial9_push: () => 0,
        dial9_finish: () => 0,
        dial9_output_next: () => (current ? descriptorPointer : 0),
        dial9_output_descriptor_len: () => 80,
        dial9_output_ack: () => {
          current = false;
          return 0;
        },
        dial9_error_ptr: () => 0,
        dial9_error_len: () => 0,
        dial9_abi_version: () => 1,
      } as never,
      manifest,
    );
    expect(() => runtime.push(new Uint8Array())).toThrow(/outside WebAssembly memory/);
  });
});

function writeColumn(
  descriptor: DataView,
  offset: number,
  kind: number,
  flags: number,
  valuesPointer: number,
  valuesLength: number,
  validityPointer: number,
  validityLength: number,
): void {
  descriptor.setUint32(offset, kind, true);
  descriptor.setUint32(offset + 4, flags, true);
  descriptor.setUint32(offset + 8, valuesPointer, true);
  descriptor.setUint32(offset + 12, valuesLength, true);
  descriptor.setUint32(offset + 16, 0, true);
  descriptor.setUint32(offset + 20, 0, true);
  descriptor.setUint32(offset + 24, validityPointer, true);
  descriptor.setUint32(offset + 28, validityLength, true);
}
