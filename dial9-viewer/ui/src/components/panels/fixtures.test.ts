import { describe, expect, it } from "vitest";
import { cpuPanel } from "./fixtures.js";
import type {
  HorizontalRuleComponent,
  ReadoutComponent,
  SwatchComponent,
  TooltipComponent,
} from "./model.js";

describe("CPU component fixture", () => {
  const panel = cpuPanel({
    capacity: 4,
    intervals: [
      {
        start: 0,
        end: 10,
        wallDeltaNs: 10,
        cpuDeltaNs: 5,
        cores: 0.5,
        totalPercent: 12.5,
      },
    ],
  })!;

  it("composes the reference CPU graph and presentation components", () => {
    expect(panel.components.map((component) => component.name)).toEqual([
      "horizontal-rule/v1",
      "interval-area/v1",
      "interval-line/v1",
      "tooltip/v1",
      "swatch/v1",
      "readout/v1",
    ]);
  });

  it("keeps cores unitless in the tooltip but labels the capacity swatch", () => {
    const tooltip = panel.components.find(
      (component): component is TooltipComponent => component.name === "tooltip/v1",
    )!;
    expect(tooltip.items.find((item) => item.label === "Cores")?.unit).toBeUndefined();
    const swatch = panel.components.find(
      (component): component is SwatchComponent => component.name === "swatch/v1",
    )!;
    expect(swatch).toMatchObject({
      label: "available parallelism",
      value: 4,
      unit: "cores",
    });
  });

  it("defines the same three right-side CPU readouts as the reference", () => {
    const readout = panel.components.find(
      (component): component is ReadoutComponent => component.name === "readout/v1",
    )!;
    expect(readout.items.map(({ label, unit }) => [label, unit])).toEqual([
      ["avg", "cores"],
      ["avg", "%"],
      ["max", "cores"],
    ]);
  });

  it("keeps a static component shape when capacity is unavailable", () => {
    const withoutCapacity = cpuPanel({
      capacity: null,
      intervals: [{
        start: 0,
        end: 10,
        wallDeltaNs: 10,
        cpuDeltaNs: 5,
        cores: 0.5,
      }],
    })!;
    expect(withoutCapacity.components.map((component) => component.name)).toEqual(
      panel.components.map((component) => component.name),
    );

    const rule = withoutCapacity.components.find(
      (component): component is HorizontalRuleComponent =>
        component.name === "horizontal-rule/v1",
    )!;
    const swatch = withoutCapacity.components.find(
      (component): component is SwatchComponent => component.name === "swatch/v1",
    )!;
    const tooltip = withoutCapacity.components.find(
      (component): component is TooltipComponent => component.name === "tooltip/v1",
    )!;
    const readout = withoutCapacity.components.find(
      (component): component is ReadoutComponent => component.name === "readout/v1",
    )!;

    expect(rule.value).toBeNull();
    expect(swatch.value).toBeNull();
    expect(tooltip.items.find((item) => item.label === "Total CPU")?.values.get(0))
      .toBeNull();
    expect(readout.items.find((item) => item.unit === "%")?.values.get(0)).toBeNull();
  });
});
