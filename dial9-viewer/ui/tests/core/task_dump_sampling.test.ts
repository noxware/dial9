import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { TaskDump } from "../../src/types/trace_parser";

const require = createRequire(import.meta.url);
const { parseTrace } = require("../../trace_parser.js") as {
  parseTrace: (bytes: Buffer) => Promise<{ taskDumps: Map<number, TaskDump[]> }>;
};
const { spanForDump } = require("../../../tests/telemetry_test_app/check_local.js");

// A minimal self-describing v1 stream. Keeping the old schema here prevents
// demo regeneration from silently removing backwards-compatibility coverage.
function dumpTrace(probability?: number): Buffer {
  const u16 = (value: number) => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(value);
    return bytes;
  };
  const name = (value: string) => Buffer.concat([u16(value.length), Buffer.from(value)]);
  const field = (value: string, tag: number) => Buffer.concat([name(value), Buffer.from([tag])]);
  const fields = [field("task_id", 9), field("callchain", 8)];
  if (probability !== undefined) fields.push(field("inclusion_probability", 2));
  const stack = Buffer.alloc(12);
  stack.writeUInt32LE(1);
  stack.writeBigUInt64LE(0x1234n, 4);
  const probabilityBytes = Buffer.alloc(probability === undefined ? 0 : 8);
  if (probability !== undefined) probabilityBytes.writeDoubleLE(probability);
  return Buffer.concat([
    Buffer.from([0x54, 0x52, 0x43, 0, 1]),
    Buffer.from([1]), u16(1), name("TaskDumpEvent"), Buffer.from([1]),
    u16(fields.length), ...fields,
    // Event type 1, timestamp delta 42ns, task 17, one stack frame.
    Buffer.from([2, 1, 0, 42, 0, 0, 17]), stack, probabilityBytes,
  ]);
}

describe("task-dump sampling trace contract", () => {
  it("loads old dumps without inventing a selection probability", async () => {
    const trace = await parseTrace(dumpTrace());
    expect(trace.taskDumps.get(17)).toEqual([
      { timestamp: 42, callchain: ["0x1234"], inclusionProbability: undefined },
    ]);
  });

  it.each([1, 0.125, 1e-12])("retains the exact probability %s", async (probability) => {
    const trace = await parseTrace(dumpTrace(probability));
    expect(trace.taskDumps.get(17)?.[0]?.inclusionProbability).toBe(probability);
  });

  it("handles old and new schemas across segment rotation", async () => {
    const trace = await parseTrace(Buffer.concat([dumpTrace(), dumpTrace(0.25)]));
    expect(trace.taskDumps.get(17)?.map((dump) => dump.inclusionProbability))
      .toEqual([undefined, 0.25]);
  });
});

describe("fixture dump–span association", () => {
  const polls = new Map([[17, [{ start: 10, end: 100, workerId: 2 }]]]);
  const span = (spanName: string, taskId: number, depth: number, start: number, end: number) => ({
    spanName, taskId, depth, start,
    segments: [{ start, end, workerId: 2 }],
  });
  const spans = [span("outer", 17, 0, 20, 90), span("inner", 17, 1, 40, 70)];

  it("finds the innermost active span without interpreting symbol names", () => {
    expect(spanForDump(17, 50, polls, spans)?.spanName).toBe("inner");
    expect(spanForDump(17, 30, polls, spans)?.spanName).toBe("outer");
  });

  it("rejects poll-start timestamps that precede SpanEnter", () => {
    expect(spanForDump(17, 10, polls, spans)).toBeNull();
  });

  it("rejects timestamps outside the task's poll and spans from another task", () => {
    expect(spanForDump(17, 110, polls, spans)).toBeNull();
    expect(spanForDump(18, 50, polls, spans)).toBeNull();
    expect(spanForDump(17, 50, polls, [span("wrong-task", 18, 2, 20, 90)])).toBeNull();
  });
});
