import { describe, expect, it } from "vitest";
import { formatExtensionValue } from "./format.js";

describe("extension value formatting", () => {
  it("leaves unitless values raw and formats explicit units", () => {
    expect(formatExtensionValue(0.481234)).toBe("0.481234");
    expect(formatExtensionValue(0.4, "cores")).toBe("0.4 cores");
    expect(formatExtensionValue(4.444, "%")).toBe("4.4%");
  });

  it("keeps strings and exact integers intact", () => {
    expect(formatExtensionValue(42n)).toBe("42");
    expect(formatExtensionValue("tail")).toBe("tail");
  });
});
