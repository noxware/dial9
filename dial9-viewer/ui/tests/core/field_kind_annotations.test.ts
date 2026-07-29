import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseTrace } = require("../../trace_parser.js") as {
  parseTrace(buffer: Buffer): Promise<{
    customEvents: Array<{
      fields: Record<string, unknown>;
      units: Record<string, string> | null;
      kinds: Record<string, string> | null;
    }>;
  }>;
};

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function annotation(key: string, value: string): Buffer {
  const keyBytes = text(key);
  const valueBytes = text(value);
  return Buffer.concat([
    u16(0),
    u16(keyBytes.length),
    keyBytes,
    u32(valueBytes.length),
    valueBytes,
  ]);
}

function trace(withAnnotations: boolean): Buffer {
  const name = text("ChartableEvent");
  const field = text("value");
  const schema = Buffer.concat([
    Buffer.from([0x01]),
    u16(1),
    u16(name.length),
    name,
    Buffer.from([1]),
    u16(1),
    u16(field.length),
    field,
    Buffer.from([0x09]), // Varint
  ]);
  const annotations = withAnnotations
    ? Buffer.concat([
        Buffer.from([0x06, 0x01]),
        u16(2),
        annotation("unit", "bytes"),
        annotation("kind", "counter"),
      ])
    : Buffer.alloc(0);
  const event = Buffer.concat([
    Buffer.from([0x02]),
    u16(1),
    Buffer.from([1, 0, 0]), // timestamp delta
    Buffer.from([5]), // Varint value
  ]);
  return Buffer.concat([
    Buffer.from([0x54, 0x52, 0x43, 0x00, 0x01]),
    schema,
    annotations,
    event,
  ]);
}

describe("field kind schema annotations", () => {
  it("propagates unit and kind to custom events", async () => {
    const parsed = await parseTrace(trace(true));

    expect(parsed.customEvents).toHaveLength(1);
    expect(parsed.customEvents[0]).toMatchObject({
      fields: { value: "5" },
      units: { value: "bytes" },
      kinds: { value: "counter" },
    });
  });

  it("keeps traces without annotations compatible", async () => {
    const parsed = await parseTrace(trace(false));

    expect(parsed.customEvents[0]?.units).toBeNull();
    expect(parsed.customEvents[0]?.kinds).toBeNull();
  });
});
