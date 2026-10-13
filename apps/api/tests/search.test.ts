import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checklistTasks, households, householdMembers, househelps } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(householdId: string, name: string) {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

async function createBill(h: { id: string }, cookie: string, name: string, provider?: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name, frequency: "ONE_TIME", firstDueDate: "2026-09-29", amountPaise: 50000, ...(provider ? { provider } : {}) });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string; provider: string | null };
}

async function createChecklistTask(householdId: string, name: string) {
  const [row] = await ctx.db.insert(checklistTasks).values({ householdId, name, frequency: "DAILY" }).returning();
  return row!;
}

async function addMember(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  // listMembers()'s toMemberDTO non-null-asserts joinedAt (real ACTIVE rows always have it stamped
  // via the invite/add flow) — must set it here too, or any route touching listMembers 500s.
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE", joinedAt: ctx.clock.now(), ...overrides });
}

async function search(h: { id: string }, cookie: string, q: string) {
  return ctx.request.get(`/api/households/${h.id}/search?q=${encodeURIComponent(q)}`).set("cookie", cookie);
}

describe("GET /search", () => {
  it("matches househelps by name, case-insensitively and by substring", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const sunita = await createHousehelp(h.id, "Sunita Devi");
    await createHousehelp(h.id, "Geeta");

    const res = await search(h, owner.cookie, "suNIT");
    expect(res.status).toBe(200);
    expect(res.body.data.househelps).toEqual([{ id: sunita.id, name: "Sunita Devi" }]);
  });

  it("matches bills by name or provider", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const electricity = await createBill(h, owner.cookie, "Electricity", "BESCOM");
    await createBill(h, owner.cookie, "Internet", "Airtel");

    const byName = await search(h, owner.cookie, "electric");
    expect(byName.body.data.bills.map((b: { id: string }) => b.id)).toEqual([electricity.id]);

    const byProvider = await search(h, owner.cookie, "bescom");
    expect(byProvider.body.data.bills.map((b: { id: string }) => b.id)).toEqual([electricity.id]);
  });

  it("matches checklist tasks by name", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createChecklistTask(h.id, "Wash dishes");
    await createChecklistTask(h.id, "Sweep floor");

    const res = await search(h, owner.cookie, "dish");
    expect(res.body.data.checklistTasks).toEqual([{ id: task.id, name: "Wash dishes" }]);
  });

  it("matches members by name, display name, or email", async () => {
    const owner = await signupUser(ctx, { name: "Parakh Shah" });
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx, { name: "Priya Shah" });
    await addMember(h.id, other.id, { displayName: "Mother" });

    const byName = await search(h, owner.cookie, "priya");
    expect(byName.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);

    const byDisplayName = await search(h, owner.cookie, "mother");
    expect(byDisplayName.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);

    const byEmail = await search(h, owner.cookie, other.email.slice(0, 6));
    expect(byEmail.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);
  });

  it("returns empty arrays, not omitted sections, for an empty query", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createHousehelp(h.id, "Sunita");

    const res = await search(h, owner.cookie, "");
    expect(res.body.data).toEqual({ househelps: [], bills: [], checklistTasks: [], members: [] });
  });

  it("omits a section when the caller lacks its permission", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id);
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["members.view"] } } }).where(eq(households.id, h.id));

    const res = await search(h, member.cookie, "a");
    expect(res.body.data).not.toHaveProperty("members");
    expect(res.body.data).toHaveProperty("househelps");
    expect(res.body.data).toHaveProperty("bills");
    expect(res.body.data).toHaveProperty("checklistTasks");
  });

  it("caps results at 10 per section", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    for (let i = 0; i < 11; i++) await createHousehelp(h.id, `Helper ${i}`);

    const res = await search(h, owner.cookie, "helper");
    expect(res.body.data.househelps).toHaveLength(10);
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createHousehelp(hA.id, "Sunita");

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await search(hB, ownerB.cookie, "sunita");
    expect(res.body.data.househelps).toEqual([]);
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await search(h, stranger.cookie, "a");
    expect(res.status).toBe(404);
  });
});
