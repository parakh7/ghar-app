import { describe, expect, it } from "vitest";
import { addDays, dateInZone, daysBetween, hourInZone, isValidTimeZone } from "./time.js";

describe("time", () => {
  it("computes the household-local date regardless of server timezone", () => {
    // 20:00 UTC on 29 Sep = 01:30 IST on 30 Sep
    const instant = new Date("2026-09-29T20:00:00Z");
    expect(dateInZone(instant, "Asia/Kolkata")).toBe("2026-09-30");
    expect(dateInZone(instant, "UTC")).toBe("2026-09-29");
    expect(hourInZone(instant, "Asia/Kolkata")).toBe(1);
  });
  it("does date arithmetic across month boundaries", () => {
    expect(addDays("2026-09-29", 3)).toBe("2026-10-02");
    expect(daysBetween("2026-10-05", "2026-10-02")).toBe(-3);
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
  });
  it("validates IANA zones", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
