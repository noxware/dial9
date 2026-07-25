import { describe, expect, it } from "vitest";
import {
  copyOutputBatch,
  ExtensionAbiError,
  readGuestError,
  validateExtensionExports,
} from "./abi.js";
import type { ExtensionManifest } from "./manifest.js";

const MANIFEST: ExtensionManifest = {
  version: 1,
  tables: [
    {
      name: "rows",
      columns: [
        { name: "time", type: "u64", nullable: false },
        { name: "label", type: "utf8", nullable: true },
        { name: "value", type: "f64", nullable: false },
      ],
    },
  ],
  panels: [],
};

const DESCRIPTOR = 64;
const TIME_VALUES = 512;
const UTF8_BYTES = 528;
const UTF8_OFFSETS = 536;
const UTF8_VALIDITY = 548;
const FLOAT_VALUES = 552;

function fixture(): {
  readonly memory: WebAssembly.Memory;
  readonly descriptorLength: number;
} {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  view.setBigUint64(TIME_VALUES, 10n, true);
  view.setBigUint64(TIME_VALUES + 8, 20n, true);

  const text = new TextEncoder().encode("a💩");
  new Uint8Array(memory.buffer, UTF8_BYTES, text.length).set(text);
  view.setUint32(UTF8_OFFSETS, 0, true);
  view.setUint32(UTF8_OFFSETS + 4, 1, true);
  view.setUint32(UTF8_OFFSETS + 8, text.length, true);
  view.setUint8(UTF8_VALIDITY, 0b01);

  view.setFloat64(FLOAT_VALUES, 1.25, true);
  view.setFloat64(FLOAT_VALUES + 8, 2.5, true);

  const words = [
    1, 0, 2, 3,
    3, 0, TIME_VALUES, 16, 0, 0, 0, 0,
    6, 1, UTF8_BYTES, text.length, UTF8_OFFSETS, 12, UTF8_VALIDITY, 1,
    1, 0, FLOAT_VALUES, 16, 0, 0, 0, 0,
  ];
  words.forEach((word, index) =>
    view.setUint32(DESCRIPTOR + index * 4, word, true),
  );
  return { memory, descriptorLength: words.length * 4 };
}

describe("extension output ABI", () => {
  it("validates and copies typed column buffers out of guest memory", () => {
    const { memory, descriptorLength } = fixture();
    const batch = copyOutputBatch(
      memory,
      DESCRIPTOR,
      descriptorLength,
      MANIFEST,
    );

    expect(batch.table_id).toBe(0);
    expect(batch.rows).toBe(2);
    const time = batch.columns[0]!;
    if (time.type !== "u64") throw new Error("test invariant");
    expect([...new BigUint64Array(time.values)]).toEqual([10n, 20n]);
    const utf8 = batch.columns[1]!;
    expect(utf8.type).toBe("utf8");
    if (utf8.type !== "utf8") throw new Error("test invariant");
    expect(new TextDecoder().decode(utf8.bytes)).toBe("a💩");
    expect([...new Uint32Array(utf8.offsets)]).toEqual([0, 1, 5]);
    expect([...new Uint8Array(utf8.validity!)]).toEqual([1]);

    new Uint8Array(memory.buffer).fill(0);
    expect([...new BigUint64Array(time.values)]).toEqual([10n, 20n]);
  });

  it.each([
    ["unknown table", 1, 1, "unknown table ID"],
    ["wrong descriptor version", 0, 9, "descriptor version"],
    ["wrong column kind", 4, 4, "has type u32"],
    ["unknown flags", 13, 2, "unknown flags"],
    ["out-of-bounds values", 6, 0xffff_fff8, "outside WebAssembly memory"],
    ["wrong value length", 7, 8, "value bytes"],
    ["unexpected auxiliary", 8, 4, "auxiliary buffer must be empty"],
  ])("rejects %s", (_name, word, value, message) => {
    const { memory, descriptorLength } = fixture();
    new DataView(memory.buffer).setUint32(DESCRIPTOR + word * 4, value, true);
    expect(() =>
      copyOutputBatch(memory, DESCRIPTOR, descriptorLength, MANIFEST),
    ).toThrow(message);
  });

  it("rejects invalid UTF-8 and offsets that split a code point", () => {
    const invalid = fixture();
    new Uint8Array(invalid.memory.buffer)[UTF8_BYTES] = 0xff;
    expect(() =>
      copyOutputBatch(
        invalid.memory,
        DESCRIPTOR,
        invalid.descriptorLength,
        MANIFEST,
      ),
    ).toThrow("not valid UTF-8");

    const split = fixture();
    new DataView(split.memory.buffer).setUint32(
      UTF8_OFFSETS + 4,
      2,
      true,
    );
    expect(() =>
      copyOutputBatch(
        split.memory,
        DESCRIPTOR,
        split.descriptorLength,
        MANIFEST,
      ),
    ).toThrow("splits a UTF-8 code point");
  });

  it("rejects validity on non-nullable columns", () => {
    const { memory, descriptorLength } = fixture();
    const view = new DataView(memory.buffer);
    view.setUint32(DESCRIPTOR + 5 * 4, 1, true);
    view.setUint32(DESCRIPTOR + 10 * 4, UTF8_VALIDITY, true);
    view.setUint32(DESCRIPTOR + 11 * 4, 1, true);
    expect(() =>
      copyOutputBatch(memory, DESCRIPTOR, descriptorLength, MANIFEST),
    ).toThrow("non-nullable");
  });

  it("rejects malformed descriptor ranges before reading them", () => {
    const { memory, descriptorLength } = fixture();
    expect(() =>
      copyOutputBatch(memory, 65, descriptorLength, MANIFEST),
    ).toThrow("not 4-byte aligned");
    expect(() =>
      copyOutputBatch(memory, 65_500, descriptorLength, MANIFEST),
    ).toThrow("outside WebAssembly memory");
    expect(() =>
      copyOutputBatch(memory, DESCRIPTOR, descriptorLength - 4, MANIFEST),
    ).toThrow("expected");
  });

  it("validates the required exports and ABI version", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const fn = () => 0;
    const exports = {
      memory,
      dial9_abi_version: () => 1,
      dial9_input_reserve: fn,
      dial9_push: fn,
      dial9_finish: fn,
      dial9_output_next: fn,
      dial9_output_descriptor_ptr: fn,
      dial9_output_descriptor_len: fn,
      dial9_output_ack: fn,
      dial9_error_ptr: fn,
      dial9_error_len: fn,
    };
    expect(validateExtensionExports(exports).memory).toBe(memory);
    expect(() =>
      validateExtensionExports({ ...exports, dial9_abi_version: () => 2 }),
    ).toThrow("ABI version must be 1");
    expect(() =>
      validateExtensionExports({ ...exports, dial9_finish: 1 }),
    ).toThrow(ExtensionAbiError);
    expect(() =>
      validateExtensionExports({
        ...exports,
        memory: new WebAssembly.Memory({
          initial: 1,
          maximum: 1,
          shared: true,
        }),
      }),
    ).toThrow("shared WebAssembly memory is unsupported");
  });

  it("validates the guest error buffer before decoding it", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const fn = () => 0;
    const exports = {
      memory,
      dial9_abi_version: () => 1,
      dial9_input_reserve: fn,
      dial9_push: fn,
      dial9_finish: fn,
      dial9_output_next: fn,
      dial9_output_descriptor_ptr: fn,
      dial9_output_descriptor_len: fn,
      dial9_output_ack: fn,
      dial9_error_ptr: () => 65_535,
      dial9_error_len: () => 2,
    };
    expect(() => readGuestError(exports)).toThrow(
      "error range is outside WebAssembly memory",
    );

    new Uint8Array(memory.buffer)[32] = 0xff;
    expect(() =>
      readGuestError({
        ...exports,
        dial9_error_ptr: () => 32,
        dial9_error_len: () => 1,
      }),
    ).toThrow("guest error buffer is not valid UTF-8");
  });
});
