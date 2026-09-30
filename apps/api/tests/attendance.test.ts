import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, auditLogs, householdMembers } from "../src/db/schema.js";
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

async function createHousehelp(c: TestContext, cookie: string, householdId: string, name = "Sunita") {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("attendance — today marking", () => {
  it("lists an active househelp with no mark and scheduledToday false when no schedule is set", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe("2026-09-29");
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0]).toMatchObject({ name: "Sunita", scheduledToday: false, status: null, note: null });
  });

  it("marks scheduled-today househelps first", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const scheduled = await createHousehelp(ctx, owner.cookie, h.id, "Scheduled Today");
    const notScheduled = await createHousehelp(ctx, owner.cookie, h.id, "Not Scheduled");
    // 2026-09-29 is a Tuesday (isoWeekday 2).
    await ctx.request.put(`/api/households/${h.id}/househelps/${scheduled.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [2] });
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries.map((e: { name: string }) => e.name)).toEqual(["Scheduled Today", "Not Scheduled"]);
    expect(res.body.data.entries[0]).toMatchObject({ scheduledToday: true });
    expect(res.body.data.entries[1]).toMatchObject({ scheduledToday: false });
    void notScheduled;
  });

  it("excludes archived househelps from today's list", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const gone = await createHousehelp(ctx, owner.cookie, h.id, "Gone");
    await ctx.request.post(`/api/households/${h.id}/househelps/${gone.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it("marks present, then flips to absent, upserting the same row", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ date: "2026-09-29", status: "PRESENT", note: null });
    const second = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "ABSENT", note: "called in sick" });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ date: "2026-09-29", status: "ABSENT", note: "called in sick" });
    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects marking a future date", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-30", status: "PRESENT" });
    expect(res.status).toBe(400);
  });

  it("does not audit a same-day mark", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(0);
  });

  it("MEMBER can mark today but not correct yesterday, and it is audited when an ADMIN does", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const today = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(today.status).toBe(200);
    const correction = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-28", status: "ABSENT" });
    expect(correction.status).toBe(403);
    const ownerCorrection = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-28", status: "ABSENT" });
    expect(ownerCorrection.status).toBe(200);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ newValue: { status: "ABSENT", note: null } });
  });

  it("VIEWER can view today's attendance but not mark it", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    expect((await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", viewer.cookie)).status).toBe(200);
    const res = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", viewer.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(res.status).toBe(403);
  });

  it("clears a mark back to not-marked, and clearing an already-unmarked day is a harmless no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    const clear = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(clear.status).toBe(200);
    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(0);
    const again = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(again.status).toBe(200);
  });

  it("a member of household A cannot mark attendance for household B's househelp", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id);
    const res = await ctx.request.put(`/api/households/${a.id}/attendance/${bobsHelp.id}`).set(csrf).set("cookie", alice.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(res.status).toBe(404);
  });
});
