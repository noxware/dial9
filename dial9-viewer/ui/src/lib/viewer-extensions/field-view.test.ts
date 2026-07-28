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
  it("materializes ordered points and preserves invalid values as gaps", () => {
    const view = materializeFieldView(
      [
        event("Queue", 10, 1),
        event("Other", 15, 99),
        event("Queue", 20, null),
        event("Queue", 25, "2"),
        event("Queue", 30, 3),
      ],
      {
        eventName: "Queue",
        field: "depth",
        unit: "items",
        interpretation: "points",
      },
    );

    expect(view.panel.title).toBe("Queue · depth · Points");
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

  it("materializes values over consecutive intervals", () => {
    const view = materializeFieldView(
      [
        event("Queue", 10, 1),
        event("Queue", 20, 2),
        event("Queue", 30, 3),
      ],
      {
        eventName: "Queue",
        field: "depth",
        interpretation: "intervals",
      },
    );

    expect(view.panel.title).toBe("Queue · depth · Intervals");
    expect(view.panel.components.map((component) => component.name)).toEqual([
      "interval-area/v1",
      "interval-line/v1",
      "tooltip/v1",
      "readout/v1",
    ]);
    const table = view.tables.table("field_values");
    expect(table.rowCount).toBe(2);
    expect([0, 1].map((row) => table.value(row, "start"))).toEqual([10, 20]);
    expect([0, 1].map((row) => table.value(row, "end"))).toEqual([20, 30]);
    expect([0, 1].map((row) => table.value(row, "value"))).toEqual([1, 2]);
  });

  it("rejects an interval view without a usable interval", () => {
    expect(() =>
      materializeFieldView([event("Queue", 10, 1)], {
        eventName: "Queue",
        field: "depth",
        interpretation: "intervals",
      }),
    ).toThrow(/two events at increasing timestamps/);
  });
});
