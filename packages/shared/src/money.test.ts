import { describe, expect, it } from "vitest";
import { formatINR, MoneyError, prorate, rupeesToPaise, sumPaise } from "./money.js";

describe("money", () => {
  it("parses rupee strings into integer paise", () => {
    expect(rupeesToPaise("999")).toBe(99900);
    expect(rupeesToPaise("₹4,500")).toBe(450000);
    expect(rupeesToPaise("1,250.5")).toBe(125050);
    expect(rupeesToPaise("0.07")).toBe(7);
  });
  it("rejects invalid or over-precise input", () => {
    expect(() => rupeesToPaise("12.345")).toThrow(MoneyError);
    expect(() => rupeesToPaise("abc")).toThrow(MoneyError);
    expect(() => rupeesToPaise("")).toThrow(MoneyError);
  });
  it("formats with Indian digit grouping", () => {
    expect(formatINR(99900)).toBe("₹999");
    expect(formatINR(3385000)).toBe("₹33,850");
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatINR(-38400)).toBe("-₹384");
    expect(formatINR(500000, { showPaise: "always" })).toBe("₹5,000.00");
  });
  it("prorates deterministically with half-up rounding", () => {
    // ₹5,000 × 2 absent / 26 working days = ₹384.615… → ₹384.62
    expect(prorate(500000, 2, 26)).toBe(38462);
    expect(prorate(100, 1, 3)).toBe(33);
    expect(prorate(100, 2, 3)).toBe(67);
    expect(() => prorate(100, 1, 0)).toThrow(MoneyError);
  });
  it("never produces float drift in sums", () => {
    expect(sumPaise([10, 20])).toBe(30); // 0.1 + 0.2 in rupees
    expect(() => sumPaise([1.5])).toThrow(MoneyError);
  });
});
