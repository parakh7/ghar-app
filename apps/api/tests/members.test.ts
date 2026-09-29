import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, householdInvites, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, DAY, signupUser, tokenFromLink, truncateAll, type TestContext } from "./helpers.js";

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

describe("invites", () => {
  it("creates an invite, emails a link, and the invitee accepts it", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "helper@example.com", role: "MEMBER" });
    expect(create.status).toBe(201);
    const invitee = await signupUser(ctx, { email: "helper@example.com" });
    const email = ctx.email.last("household-invite");
    expect(email?.to).toBe("helper@example.com");
    const token = tokenFromLink(email!.text);
    const accept = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(accept.status).toBe(200);
    expect(accept.body.data.id).toBe(h.id);
    const list = await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", owner.cookie);
    expect(list.body.data.find((m: { email: string }) => m.email === "helper@example.com").role).toBe("MEMBER");
  });

  it("lets an existing account accept an invite for an email it already owns", async () => {
    const owner = await signupUser(ctx);
    const invitee = await signupUser(ctx, { email: "existing@example.com" });
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "existing@example.com", role: "VIEWER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const accept = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(accept.status).toBe(200);
  });

  it("rejects acceptance by a signed-in user whose email does not match the invite", async () => {
    const owner = await signupUser(ctx);
    const stranger = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "someone@example.com", role: "MEMBER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", stranger.cookie).send({ token });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("someone@example.com");
  });

  it("rejects an expired invite", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "late@example.com", role: "MEMBER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    ctx.clock.advance(8 * DAY);
    const invitee = await signupUser(ctx, { email: "late@example.com" });
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects a revoked invite", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "gone@example.com", role: "MEMBER" });
    const [invite] = await ctx.db.select().from(householdInvites).where(eq(householdInvites.email, "gone@example.com"));
    await ctx.request.delete(`/api/households/${h.id}/invites/${invite!.id}`).set(csrf).set("cookie", owner.cookie);
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const invitee = await signupUser(ctx, { email: "gone@example.com" });
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(res.status).toBe(400);
  });

  it("resending an invite issues a new token that invalidates the old one", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "resend@example.com", role: "MEMBER" });
    const [invite] = await ctx.db.select().from(householdInvites).where(eq(householdInvites.email, "resend@example.com"));
    const oldToken = tokenFromLink(ctx.email.last("household-invite")!.text);
    await ctx.request.post(`/api/households/${h.id}/invites/${invite!.id}/resend`).set(csrf).set("cookie", owner.cookie);
    const newToken = tokenFromLink(ctx.email.last("household-invite")!.text);
    const invitee = await signupUser(ctx, { email: "resend@example.com" });
    const oldAttempt = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token: oldToken });
    expect(oldAttempt.status).toBe(400);
    const newAttempt = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token: newToken });
    expect(newAttempt.status).toBe(200);
  });

  it("rejects inviting an email that is already an active member", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx, { email: "already@example.com" });
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "already@example.com", role: "MEMBER" });
    expect(res.status).toBe(409);
  });

  it("MEMBER cannot create invites", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", member.cookie).send({ email: "x@example.com", role: "MEMBER" });
    expect(res.status).toBe(403);
  });

  it("returns the generic invalid-token error for an unknown token (no enumeration)", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", u.cookie).send({ token: "not-a-real-token-not-a-real-token" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("requires authentication to accept an invite", async () => {
    const res = await ctx.request.post("/api/invites/accept").set(csrf).send({ token: "whatever-whatever-whatever12" });
    expect(res.status).toBe(401);
  });

  it("a member of household A cannot manage invites of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/invites`).set(csrf).set("cookie", alice.cookie).send({ email: "x@example.com", role: "MEMBER" });
    expect(res.status).toBe(404);
  });
});
