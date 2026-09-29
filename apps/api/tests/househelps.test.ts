import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, householdMembers, househelpCategories } from "../src/db/schema.js";
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

describe("categories", () => {
  it("lists the ten seeded default categories in order", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(["Cleaning", "Cooking", "Utensils", "Dusting", "Laundry", "Ironing", "Driver", "Gardening", "Babysitting", "Other"]);
  });

  it("creates a category at the end of the order", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Pet care" });
    expect(res.status).toBe(201);
    expect(res.body.data.sortOrder).toBe(10);
  });

  it("rejects a duplicate active category name (case-insensitive)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/categories`).set(csrf).set("cookie", owner.cookie).send({ name: "cleaning" });
    expect(res.status).toBe(409);
  });

  it("lets a name be reused after the original is soft-deleted", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [cleaning] = await ctx.db.select().from(househelpCategories).where(and(eq(househelpCategories.householdId, h.id), eq(househelpCategories.name, "Cleaning")));
    await ctx.request.delete(`/api/households/${h.id}/categories/${cleaning!.id}`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/categories`).set(csrf).set("cookie", owner.cookie).send({ name: "Cleaning" });
    expect(res.status).toBe(201);
  });

  it("updates name and active state, and audits old/new values", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [driver] = await ctx.db.select().from(househelpCategories).where(and(eq(househelpCategories.householdId, h.id), eq(househelpCategories.name, "Driver")));
    const res = await ctx.request.patch(`/api/households/${h.id}/categories/${driver!.id}`).set(csrf).set("cookie", owner.cookie).send({ name: "Chauffeur", isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Chauffeur", isActive: false });
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "category.updated")));
    expect(log).toMatchObject({ oldValue: { name: "Driver", isActive: true }, newValue: { name: "Chauffeur", isActive: false } });
  });

  it("rejects an update with no fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [any] = await ctx.db.select().from(househelpCategories).where(eq(househelpCategories.householdId, h.id));
    const res = await ctx.request.patch(`/api/households/${h.id}/categories/${any!.id}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(res.status).toBe(400);
  });

  it("moves a category up and down, swapping with its neighbor", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const all = await ctx.db.select().from(househelpCategories).where(eq(househelpCategories.householdId, h.id)).orderBy(househelpCategories.sortOrder);
    const [cooking, cleaning] = [all[1]!, all[0]!]; // Cooking is index 1, Cleaning is index 0
    await ctx.request.post(`/api/households/${h.id}/categories/${cooking.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    const res = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    expect(res.body.data[0].name).toBe("Cooking");
    expect(res.body.data[1].name).toBe("Cleaning");
    void cleaning;
  });

  it("moving the first category up is a no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [first] = await ctx.db.select().from(househelpCategories).where(eq(househelpCategories.householdId, h.id)).orderBy(househelpCategories.sortOrder);
    const res = await ctx.request.post(`/api/households/${h.id}/categories/${first!.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    expect(res.status).toBe(200);
    const list = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    expect(list.body.data[0].name).toBe("Cleaning");
  });

  it("VIEWER can list categories but not manage them", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    expect((await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", viewer.cookie)).status).toBe(200);
    const res = await ctx.request.post(`/api/households/${h.id}/categories`).set(csrf).set("cookie", viewer.cookie).send({ name: "New" });
    expect(res.status).toBe(403);
  });

  it("a member of household A cannot manage categories of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/categories`).set(csrf).set("cookie", alice.cookie).send({ name: "X" });
    expect(res.status).toBe(404);
  });
});
