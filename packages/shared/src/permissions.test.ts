import { describe, expect, it } from "vitest";
import { hasPermission, PERMISSIONS, resolvePermissions } from "./permissions.js";

describe("permissions", () => {
  it("OWNER has everything", () => {
    expect(resolvePermissions("OWNER").size).toBe(PERMISSIONS.length);
  });
  it("VIEWER is read-only", () => {
    for (const p of resolvePermissions("VIEWER")) expect(p.endsWith(".view")).toBe(true);
    expect(hasPermission("VIEWER", "attendance.mark")).toBe(false);
  });
  it("MEMBER can mark attendance, complete tasks and record payments but not manage bills", () => {
    expect(hasPermission("MEMBER", "attendance.mark")).toBe(true);
    expect(hasPermission("MEMBER", "checklists.complete")).toBe(true);
    expect(hasPermission("MEMBER", "payments.record")).toBe(true);
    expect(hasPermission("MEMBER", "bills.manage")).toBe(false);
  });
  it("ADMIN cannot manage members or delete the household", () => {
    expect(hasPermission("ADMIN", "bills.manage")).toBe(true);
    expect(hasPermission("ADMIN", "members.manage")).toBe(false);
    expect(hasPermission("ADMIN", "household.delete")).toBe(false);
  });
  it("checklists.editHistory is restricted like attendance.editHistory", () => {
    expect(hasPermission("MEMBER", "checklists.editHistory")).toBe(false);
    expect(hasPermission("ADMIN", "checklists.editHistory")).toBe(true);
    expect(hasPermission("OWNER", "checklists.editHistory")).toBe(true);
  });
  it("applies per-household overrides but never to OWNER", () => {
    const o = { MEMBER: { grant: ["bills.manage" as const], revoke: ["salaries.pay" as const] }, OWNER: { revoke: ["household.view" as const] } };
    expect(hasPermission("MEMBER", "bills.manage", o)).toBe(true);
    expect(hasPermission("MEMBER", "salaries.pay", o)).toBe(false);
    expect(hasPermission("OWNER", "household.view", o)).toBe(true);
  });
});
