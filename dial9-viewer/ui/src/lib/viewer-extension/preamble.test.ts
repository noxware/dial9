import { describe, expect, it } from "vitest";
import {
  ExtensionPreambleError,
  FirstPreambleScanner,
} from "./preamble.js";

function embedded(name: string, data: readonly number[]): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const length = data.length;
  return [
    0x07,
    nameBytes.length & 0xff,
    nameBytes.length >>> 8,
    length & 0xff,
    (length >>> 8) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 24) & 0xff,
    ...nameBytes,
    ...data,
  ];
}

const PREAMBLE = new Uint8Array([
  0x54, 0x52, 0x43, 0, 2,
  ...embedded("cpu.wasm", [0, 0x61, 0x73, 0x6d]),
  ...embedded("notes.txt", [1, 2, 3]),
  0x05, 0, 0, 0, 0, 0, 0, 0, 0,
]);

function scan(chunks: readonly Uint8Array[]) {
  const scanner = new FirstPreambleScanner();
  let files;
  for (const chunk of chunks) files = scanner.push(chunk) ?? files;
  files ??= scanner.finish();
  return { scanner, files };
}

describe("first attachment preamble scanner", () => {
  it("finds attachments at every two-chunk split boundary", () => {
    for (let cut = 0; cut <= PREAMBLE.length; cut += 1) {
      const { scanner, files } = scan([
        PREAMBLE.subarray(0, cut),
        PREAMBLE.subarray(cut),
      ]);
      expect(scanner.closed, `cut ${cut}`).toBe(true);
      expect(
        files.map((file) => [file.name, [...file.data]]),
        `cut ${cut}`,
      ).toEqual([
        ["cpu.wasm", [0, 0x61, 0x73, 0x6d]],
        ["notes.txt", [1, 2, 3]],
      ]);
    }
  });

  it("handles one-byte chunks without accumulating copies", () => {
    const { files } = scan(
      [...PREAMBLE].map((byte) => new Uint8Array([byte])),
    );
    expect(files.map((file) => file.name)).toEqual(["cpu.wasm", "notes.txt"]);
  });

  it("closes a header-only or attachment-only trace at finish", () => {
    expect(
      scan([new Uint8Array([0x54, 0x52, 0x43, 0, 2])]).files,
    ).toEqual([]);
    const attachmentOnly = new Uint8Array([
      0x54, 0x52, 0x43, 0, 2,
      ...embedded("x.wasm", [1]),
    ]);
    expect(scan([attachmentOnly]).files[0]?.name).toBe("x.wasm");
  });

  it("rejects malformed headers, names, and truncated files", () => {
    expect(() =>
      scan([new Uint8Array([1, 2, 3, 4, 5])]),
    ).toThrow("missing D9TF header");
    expect(() =>
      scan([new Uint8Array([0x54, 0x52])]),
    ).toThrow("truncated D9TF header");

    const emptyName = new Uint8Array([
      0x54, 0x52, 0x43, 0, 2,
      ...embedded("", [1]),
    ]);
    expect(() => scan([emptyName])).toThrow("name is empty");

    const invalidName = new Uint8Array([
      0x54, 0x52, 0x43, 0, 2,
      0x07, 1, 0, 0, 0, 0, 0, 0xff,
    ]);
    expect(() => scan([invalidName])).toThrow("not valid UTF-8");

    const truncated = PREAMBLE.subarray(0, 15);
    expect(() => scan([truncated])).toThrow(ExtensionPreambleError);
  });
});
