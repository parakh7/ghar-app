import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, billCategories, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

describe("bill categories", () => {
  it("lists the fourteen seeded default bill categories in order", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(["Electricity", "Internet", "Mobile", "Gas", "Water", "Society maintenance", "Rent", "Insurance", "Credit card", "Subscriptions", "Newspaper", "School fees", "Property tax", "Other"]);
  });

  it("creates a bill category with name and optional icon at the end of the order", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Utilities", icon: "💡" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Utilities", icon: "💡", sortOrder: 14, isActive: true });
  });

  it("creates a bill category without icon", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Donations" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Donations", icon: null, sortOrder: 14, isActive: true });
  });

  it("creates bill categories at incrementing sort orders", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res1 = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Utilities" });
    const res2 = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Donations" });
    expect(res1.body.data.sortOrder).toBe(14);
    expect(res2.body.data.sortOrder).toBe(15);
  });

  it("rejects a duplicate active bill category name (case-insensitive)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "rent" });
    expect(res.status).toBe(409);
  });

  it("lets a name be reused after the original is soft-deleted", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [rent] = await ctx.db.select().from(billCategories).where(and(eq(billCategories.householdId, h.id), eq(billCategories.name, "Rent")));
    await ctx.request.delete(`/api/households/${h.id}/bill-categories/${rent!.id}`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Rent" });
    expect(res.status).toBe(201);
  });

  it("updates name, icon, and active state, and audits old/new values", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Custom Utilities", icon: "💡" });
    const categoryId = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bill-categories/${categoryId}`).set(csrf).set("cookie", owner.cookie).send({ name: "Power", icon: "⚡", isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Power", icon: "⚡", isActive: false });
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill_category.updated")));
    expect(log).toMatchObject({ oldValue: { name: "Custom Utilities", icon: "💡", isActive: true }, newValue: { name: "Power", icon: "⚡", isActive: false } });
  });

  it("rejects an update with no fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Custom Utilities" });
    const categoryId = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bill-categories/${categoryId}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(res.status).toBe(400);
  });

  it("updates icon to null", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Custom Utilities", icon: "💡" });
    const categoryId = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bill-categories/${categoryId}`).set(csrf).set("cookie", owner.cookie).send({ icon: null });
    expect(res.status).toBe(200);
    expect(res.body.data.icon).toBeNull();
  });

  it("soft-deletes a bill category", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Custom Utilities" });
    const categoryId = createRes.body.data.id;
    const res = await ctx.request.delete(`/api/households/${h.id}/bill-categories/${categoryId}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    const [deletedRow] = await ctx.db.select().from(billCategories).where(eq(billCategories.id, categoryId));
    expect(deletedRow.deletedAt).not.toBeNull();
  });

  it("moves a bill category up and down, swapping with its neighbor", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const all = await ctx.db.select().from(billCategories).where(eq(billCategories.householdId, h.id)).orderBy(billCategories.sortOrder);
    const [internet] = [all[1]!]; // Internet is index 1; will swap with Mobile at index 2
    await ctx.request.post(`/api/households/${h.id}/bill-categories/${internet.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "down" });
    const listRes = await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", owner.cookie);
    expect(listRes.body.data[1].name).toBe("Mobile");
    expect(listRes.body.data[2].name).toBe("Internet");
  });

  it("moving the first bill category up is a no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [first] = await ctx.db.select().from(billCategories).where(eq(billCategories.householdId, h.id)).orderBy(billCategories.sortOrder);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories/${first!.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    expect(res.status).toBe(200);
    const list = await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", owner.cookie);
    expect(list.body.data[0].name).toBe("Electricity");
  });

  it("moving the last bill category down is a no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const all = await ctx.db.select().from(billCategories).where(eq(billCategories.householdId, h.id)).orderBy(billCategories.sortOrder);
    const last = all[all.length - 1]!;
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories/${last.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "down" });
    expect(res.status).toBe(200);
    const list = await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", owner.cookie);
    expect(list.body.data[list.body.data.length - 1].name).toBe(last.name);
  });

  it("moves a bill category across a gap left by a soft-deleted category using index adjacency", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const all = await ctx.db.select().from(billCategories).where(eq(billCategories.householdId, h.id)).orderBy(billCategories.sortOrder);
    const mobile = all.find((c) => c.name === "Mobile")!; // sortOrder 2 — deleting it leaves a gap
    const gas = all.find((c) => c.name === "Gas")!; // sortOrder 3 — sits right after the gap
    await ctx.request.delete(`/api/households/${h.id}/bill-categories/${mobile.id}`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories/${gas.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    expect(res.status).toBe(200);
    const list = await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", owner.cookie);
    const names = list.body.data.map((c: { name: string }) => c.name);
    expect(names).toEqual(["Electricity", "Gas", "Internet", "Water", "Society maintenance", "Rent", "Insurance", "Credit card", "Subscriptions", "Newspaper", "School fees", "Property tax", "Other"]);
  });

  it("VIEWER can list bill categories but not manage them", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    expect((await ctx.request.get(`/api/households/${h.id}/bill-categories`).set("cookie", viewer.cookie)).status).toBe(200);
    const res = await ctx.request.post(`/api/households/${h.id}/bill-categories`).set(csrf).set("cookie", viewer.cookie).send({ name: "New" });
    expect(res.status).toBe(403);
  });

  it("a member of household A cannot manage bill categories of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/bill-categories`).set(csrf).set("cookie", alice.cookie).send({ name: "X" });
    expect(res.status).toBe(404);
  });
});
