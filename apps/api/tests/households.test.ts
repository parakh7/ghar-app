import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  attendanceRecords, auditLogs, billCategories, householdMembers, households, househelpCategories, househelps,
  notificationPreferences, reminderRules,
} from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; role: string; permissions: string[]; timezone: string };
}

async function addMember(householdId: string, userId: string, role: "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE" });
}

describe("creating a household", () => {
  it("makes the creator OWNER with full permissions and IST as default timezone", async () => {
    const u = await signupUser(ctx);
    const h = await createHousehold(ctx, u.cookie);
    expect(h.role).toBe("OWNER");
    expect(h.timezone).toBe("Asia/Kolkata");
    expect(h.permissions).toContain("household.delete");
  });

  it("seeds editable, household-specific defaults in one transaction", async () => {
    const u = await signupUser(ctx);
    const h = await createHousehold(ctx, u.cookie);
    const cats = await ctx.db.select().from(househelpCategories).where(eq(househelpCategories.householdId, h.id));
    expect(cats.map((c) => c.name)).toEqual(["Cleaning", "Cooking", "Utensils", "Dusting", "Laundry", "Ironing", "Driver", "Gardening", "Babysitting", "Other"]);
    expect((await ctx.db.select().from(billCategories).where(eq(billCategories.householdId, h.id))).length).toBeGreaterThan(10);
    const rules = await ctx.db.select().from(reminderRules).where(eq(reminderRules.householdId, h.id));
    expect(rules.find((r) => r.targetType === "BILL")?.offsetsDays).toEqual([7, 3, 1, 0]);
    const prefs = await ctx.db.select().from(notificationPreferences).where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, u.id)));
    expect(prefs).toHaveLength(5);
  });

  it("writes an audit log entry", async () => {
    const u = await signupUser(ctx);
    const h = await createHousehold(ctx, u.cookie);
    const [log] = await ctx.db.select().from(auditLogs).where(eq(auditLogs.householdId, h.id));
    expect(log).toMatchObject({ action: "household.created", actorUserId: u.id, entityId: h.id });
  });

  it("validates the timezone", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/households").set(csrf).set("cookie", u.cookie).send({ name: "Home", timezone: "Mars/Base" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.timezone).toBeDefined();
  });

  it("supports one user in multiple households", async () => {
    const u = await signupUser(ctx);
    await createHousehold(ctx, u.cookie, "Mumbai Home");
    await createHousehold(ctx, u.cookie, "Pune Home");
    await createHousehold(ctx, u.cookie, "Parents' Home");
    const me = await ctx.request.get("/api/auth/me").set("cookie", u.cookie);
    expect(me.body.data.households.map((h: { name: string }) => h.name)).toEqual(["Mumbai Home", "Pune Home", "Parents' Home"]);
  });
});

describe("TEST 9 — household isolation", () => {
  it("a member of Household A cannot read, list or modify Household B", async () => {
    const alice = await signupUser(ctx, { name: "Alice" });
    const bob = await signupUser(ctx, { name: "Bob" });
    const a = await createHousehold(ctx, alice.cookie, "Household A");
    const b = await createHousehold(ctx, bob.cookie, "Household B");

    const read = await ctx.request.get(`/api/households/${b.id}`).set("cookie", alice.cookie);
    expect(read.status).toBe(404); // not 403: existence is not revealed
    expect(read.body.error.code).toBe("HOUSEHOLD_NOT_FOUND");

    const write = await ctx.request.patch(`/api/households/${b.id}`).set(csrf).set("cookie", alice.cookie).send({ name: "Pwned" });
    expect(write.status).toBe(404);
    const [bRow] = await ctx.db.select().from(households).where(eq(households.id, b.id));
    expect(bRow!.name).toBe("Household B");

    const list = await ctx.request.get("/api/households").set("cookie", alice.cookie);
    expect(list.body.data.map((h: { id: string }) => h.id)).toEqual([a.id]);
  });

  it("returns the same 404 for a household that does not exist and for malformed ids", async () => {
    const u = await signupUser(ctx);
    const missing = await ctx.request.get("/api/households/00000000-0000-4000-8000-000000000000").set("cookie", u.cookie);
    const malformed = await ctx.request.get("/api/households/'; drop table users;--").set("cookie", u.cookie);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(missing.body).toEqual(malformed.body);
  });

  it("removed members lose access immediately", async () => {
    const owner = await signupUser(ctx);
    const helper = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, helper.id, "MEMBER");
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", helper.cookie)).status).toBe(200);
    await ctx.db.update(householdMembers).set({ status: "REMOVED" }).where(eq(householdMembers.userId, helper.id));
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", helper.cookie)).status).toBe(404);
  });

  it("the database itself rejects rows that link across households", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const [sunita] = await ctx.db.insert(househelps).values({ householdId: a.id, name: "Sunita" }).returning();
    // Attendance claiming Household B but pointing at Household A's househelp:
    await expect(
      ctx.db.insert(attendanceRecords).values({ householdId: b.id, househelpId: sunita!.id, date: "2026-09-29", status: "PRESENT" }),
    ).rejects.toThrow();
  });

  it("requires authentication", async () => {
    const res = await ctx.request.get("/api/households");
    expect(res.status).toBe(401);
  });
});

describe("roles & permissions", () => {
  it("VIEWER can read but not change the household", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const get = await ctx.request.get(`/api/households/${h.id}`).set("cookie", viewer.cookie);
    expect(get.status).toBe(200);
    expect(get.body.data.role).toBe("VIEWER");
    expect(get.body.data.permissions.every((p: string) => p.endsWith(".view"))).toBe(true);
    const patch = await ctx.request.patch(`/api/households/${h.id}`).set(csrf).set("cookie", viewer.cookie).send({ name: "Nope" });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe("FORBIDDEN");
  });

  it("ADMIN can update the household and the change is audited with old and new values", async () => {
    const owner = await signupUser(ctx);
    const admin = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, admin.id, "ADMIN");
    const res = await ctx.request.patch(`/api/households/${h.id}`).set(csrf).set("cookie", admin.cookie).send({ name: "Shah Parivar" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Shah Parivar");
    expect(res.body.data.timezone).toBe("Asia/Kolkata"); // untouched by a partial update
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "household.updated")));
    expect(logs[0]).toMatchObject({ actorUserId: admin.id, oldValue: { name: "Shah Family" }, newValue: { name: "Shah Parivar" } });
  });

  it("honours per-household permission overrides", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    expect((await ctx.request.patch(`/api/households/${h.id}`).set(csrf).set("cookie", member.cookie).send({ name: "X" })).status).toBe(403);
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { grant: ["household.manage"] } } }).where(eq(households.id, h.id));
    expect((await ctx.request.patch(`/api/households/${h.id}`).set(csrf).set("cookie", member.cookie).send({ name: "X" })).status).toBe(200);
  });
});
