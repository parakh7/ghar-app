import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./guards";

describe("safeReturnPath", () => {
  it("keeps in-app paths", () => {
    expect(safeReturnPath("/more")).toBe("/more");
    expect(safeReturnPath("/bills?tab=overdue")).toBe("/bills?tab=overdue");
  });
  it("rejects anything that could leave the app", () => {
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath(undefined)).toBe("/");
    expect(safeReturnPath(42)).toBe("/");
  });
});
