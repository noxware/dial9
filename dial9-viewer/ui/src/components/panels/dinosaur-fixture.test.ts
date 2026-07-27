import { describe, expect, it } from "vitest";
import { dinosaurPanel } from "./dinosaur-fixture.js";
import type {
  PolylineComponent,
  TooltipComponent,
} from "./model.js";

describe("dinosaur component fixture", () => {
  const panel = dinosaurPanel(1_000, 2_000);
  const lines = panel.components.filter(
    (component): component is PolylineComponent => component.name === "polyline/v1",
  );
  const tooltips = panel.components.filter(
    (component): component is TooltipComponent => component.name === "tooltip/v1",
  );

  it("preserves the closed, backwards dinosaur path and separate flame path", () => {
    expect(lines).toHaveLength(2);
    expect(lines[0]!.data.length).toBe(23);
    expect(lines[0]!.data.x.get(0)).toBe(lines[0]!.data.x.get(22));
    expect(lines[0]!.data.x.get(8)).toBeGreaterThan(lines[0]!.data.x.get(9)!);
    expect(lines[1]!.data.length).toBe(6);
  });

  it("keeps tail, head and flame tooltip payloads independent", () => {
    expect(tooltips).toHaveLength(2);
    expect(tooltips[0]!.items[0]!.values.get(0)).toBe("💩");
    expect(tooltips[0]!.items[0]!.values.get(5)).toBe("❤️");
    expect(tooltips[1]!.items[0]!.values.get(0)).toBe("🔥");
  });
});
