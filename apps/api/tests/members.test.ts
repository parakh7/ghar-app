import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, householdMembers } from "../src/db/schema.js";
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

describe("listing and managing members", () => {
  it("lists active members but not removed ones", async () => {
    const owner = await signupUser(ctx);
    const removed = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, removed.id, "MEMBER");
    await ctx.db.update(householdMembers).set({ status: "REMOVED" }).where(eq(householdMembers.userId, removed.id));
    const res = await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { email: string }) => m.email)).toEqual([owner.email]);
  });

  it("VIEWER can view members but not change roles", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    expect((await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", viewer.cookie)).status).toBe(200);
    const patch = await ctx.request.patch(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", viewer.cookie).send({ role: "MEMBER" });
    expect(patch.status).toBe(403);
  });

  it("OWNER can change a member's role and it is audited with old and new values", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.patch(`/api/households/${h.id}/members/${member.id}`).set(csrf).set("cookie", owner.cookie).send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("ADMIN");
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "member.updated")));
    expect(log).toMatchObject({ actorUserId: owner.id, entityId: member.id, oldValue: { role: "MEMBER" }, newValue: { role: "ADMIN" } });
  });

  it("cannot demote the last owner", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.patch(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", owner.cookie).send({ role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("cannot remove the last owner", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("can remove an owner once a second owner exists", async () => {
    const owner = await signupUser(ctx);
    const second = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, second.id, "OWNER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", second.cookie);
    expect(res.status).toBe(200);
  });

  it("OWNER can remove a member, who then loses access", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${member.id}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", member.cookie)).status).toBe(404);
  });

  it("a member can leave voluntarily", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/me`).set(csrf).set("cookie", member.cookie);
    expect(res.status).toBe(200);
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", member.cookie)).status).toBe(404);
  });

  it("the last owner cannot leave", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.delete(`/api/households/${h.id}/members/me`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("a member of household A cannot list or manage members of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    expect((await ctx.request.get(`/api/households/${b.id}/members`).set("cookie", alice.cookie)).status).toBe(404);
  });
});
