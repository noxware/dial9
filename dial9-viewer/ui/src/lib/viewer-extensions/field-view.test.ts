import { describe, expect, it } from "vitest";
import type { CustomTraceEvent } from "../../types/trace.js";
import { materializeFieldView } from "./field-view.js";

function event(
  name: string,
  timestamp: number,
  value: unknown,
): CustomTraceEvent {
  return {
    name,
    timestamp,
    fields: { depth: value } as CustomTraceEvent["fields"],
    units: { depth: "items" },
  };
}

describe("interactive custom-event field views", () => {
  it("materializes gauges as ordered points and preserves gaps", () => {
    const view = materializeFieldView(
      [
        event("Queue", 30, 3),
        event("Other", 15, 99),
        event("Queue", 10, 1),
        event("Queue", 25, "2"),
        event("Queue", 20, null),
      ],
      {
        eventName: "Queue",
        field: "depth",
        unit: "items",
        interpretation: "gauge",
      },
    );

    expect(view.panel.title).toBe("Queue · depth · Gauge");
    expect(view.panel.components.map((component) => component.name)).toEqual([
      "line/v1",
      "tooltip/v1",
      "readout/v1",
    ]);
    const table = view.tables.table("field_values");
    expect(table.rowCount).toBe(4);
    expect([0, 1, 2, 3].map((row) => table.value(row, "timestamp"))).toEqual([
      10, 20, 25, 30,
    ]);
    expect([0, 1, 2, 3].map((row) => table.value(row, "value"))).toEqual([
      1,
      null,
      2,
      3,
    ]);
  });

  it("materializes monotonic counter deltas as intervals", () => {
    const view = materializeFieldView(
      [
        event("Queue", 2_000_000_000, 500_000_000),
        event("Queue", 0, 100_000_000),
        event("Queue", 3_000_000_000, 900_000_000),
        event("Queue", 1_000_000_000, 600_000_000),
      ],
      {
        eventName: "Queue",
        field: "depth",
        unit: "ns",
        interpretation: "counter",
      },
    );

    expect(view.panel.title).toBe("Queue · depth · Counter");
    expect(view.panel.components.map((component) => component.name)).toEqual([
      "interval-area/v1",
      "interval-line/v1",
      "tooltip/v1",
      "readout/v1",
    ]);
    const table = view.tables.table("field_values");
    expect(table.rowCount).toBe(3);
    expect([0, 1, 2].map((row) => table.value(row, "start"))).toEqual([
      0,
      1_000_000_000,
      2_000_000_000,
    ]);
    expect([0, 1, 2].map((row) => table.value(row, "end"))).toEqual([
      1_000_000_000,
      2_000_000_000,
      3_000_000_000,
    ]);
    expect([0, 1, 2].map((row) => table.value(row, "value"))).toEqual([
      500_000_000,
      null,
      400_000_000,
    ]);
  });

  it("allows negative up/down counter deltas", () => {
    const view = materializeFieldView(
      [
        event("Queue", 0, 10),
        event("Queue", 1_000_000_000, 5),
        event("Queue", 2_000_000_000, 15),
      ],
      {
        eventName: "Queue",
        field: "depth",
        interpretation: "up-down-counter",
      },
    );

    expect(view.panel.title).toBe("Queue · depth · Up/down counter");
    const table = view.tables.table("field_values");
    expect([0, 1].map((row) => table.value(row, "value"))).toEqual([-5, 10]);
  });

  it("rejects a counter without a usable interval", () => {
    expect(() =>
      materializeFieldView([event("Queue", 10, 1)], {
        eventName: "Queue",
        field: "depth",
        interpretation: "counter",
      }),
    ).toThrow(/two events at increasing timestamps/);
  });
});
