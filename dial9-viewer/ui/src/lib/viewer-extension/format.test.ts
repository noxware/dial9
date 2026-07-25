import { describe, expect, it } from "vitest";
import { formatExtensionValue } from "./format.js";

describe("extension value formatting", () => {
  it("limits decimal precision independently from labels and units", () => {
    expect(formatExtensionValue(0.481234, undefined, 2)).toBe("0.48");
    expect(formatExtensionValue(0.4, "cores", 2)).toBe("0.4 cores");
    expect(formatExtensionValue(4.444, "%", 1)).toBe("4.4%");
  });

  it("leaves values raw when no precision or unit is requested", () => {
    expect(formatExtensionValue(0.481234)).toBe("0.481234");
    expect(formatExtensionValue(42n, undefined, 2)).toBe("42");
    expect(formatExtensionValue("tail")).toBe("tail");
  });
});
