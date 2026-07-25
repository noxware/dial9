import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseTrace, parseTraceStream } = require(
  "../../trace_parser.js",
) as {
  parseTrace(
    bytes: Uint8Array,
  ): Promise<{ embeddedFiles: { name: string; data: Uint8Array }[] }>;
  parseTraceStream(
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<{ embeddedFiles: { name: string; data: Uint8Array }[] }>;
};

const encoder = new TextEncoder();

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function embeddedFile(name: string, data: readonly number[]): number[] {
  const nameBytes = [...encoder.encode(name)];
  return [0x07, ...u16(nameBytes.length), ...u32(data.length), ...nameBytes, ...data];
}

function markerSchema(typeId: number): number[] {
  const name = [...encoder.encode(`Marker${typeId}`)];
  return [
    0x01,
    ...u16(typeId),
    ...u16(name.length),
    ...name,
    0x00, // no timestamp
    0x00,
    0x00, // no fields
  ];
}

function tracePart(
  files: readonly { name: string; data: readonly number[] }[],
  typeId: number,
): Uint8Array {
  return new Uint8Array([
    0x54,
    0x52,
    0x43,
    0x00,
    0x01,
    ...files.flatMap((file) => embeddedFile(file.name, file.data)),
    ...markerSchema(typeId),
  ]);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function* splitAt(
  bytes: Uint8Array,
  split: number,
): AsyncGenerator<Uint8Array> {
  yield bytes.slice(0, split);
  yield bytes.slice(split);
}

describe("trace embedded files", () => {
  const bytes = concat(
    tracePart(
      [
        { name: "cpu.wasm", data: [0, 97, 115, 109] },
        { name: "notes.txt", data: [1, 2, 3] },
      ],
      1,
    ),
    tracePart([{ name: "ignored.wasm", data: [9, 9, 9] }], 2),
  );

  it("keeps only the first header's preamble", async () => {
    const parsed = await parseTrace(bytes);
    expect(parsed.embeddedFiles.map((file) => file.name)).toEqual([
      "cpu.wasm",
      "notes.txt",
    ]);
    expect([...parsed.embeddedFiles[0]!.data]).toEqual([0, 97, 115, 109]);
    expect([...parsed.embeddedFiles[1]!.data]).toEqual([1, 2, 3]);
  });

  it("is invariant across every stream split boundary", async () => {
    for (let split = 0; split <= bytes.length; split += 1) {
      const parsed = await parseTraceStream(splitAt(bytes, split));
      expect(
        parsed.embeddedFiles.map((file) => [file.name, [...file.data]]),
        `split ${split}`,
      ).toEqual([
        ["cpu.wasm", [0, 97, 115, 109]],
        ["notes.txt", [1, 2, 3]],
      ]);
    }
  });
});
