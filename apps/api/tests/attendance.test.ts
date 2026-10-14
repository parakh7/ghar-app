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

  it("a repeated clientMutationId returns the original row without a second audit entry", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "ABSENT", clientMutationId: "11111111-1111-4111-8111-111111111111" });
    expect(first.status).toBe(200);
    const replay = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "PRESENT", clientMutationId: "11111111-1111-4111-8111-111111111111" });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(1);
  });

  it("a different clientMutationId for the same date still upserts normally (last write wins)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "ABSENT", clientMutationId: "22222222-2222-4222-8222-222222222222" });
    const second = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "PRESENT", clientMutationId: "33333333-3333-4333-8333-333333333333" });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("PRESENT");
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

  it("rejects clearing a future date and requires editHistory for a past date", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const future = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-30`).set(csrf).set("cookie", owner.cookie);
    expect(future.status).toBe(400);
    const memberPast = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-28`).set(csrf).set("cookie", member.cookie);
    expect(memberPast.status).toBe(403);
    const ownerPast = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-28`).set(csrf).set("cookie", owner.cookie);
    expect(ownerPast.status).toBe(200);
  });

  it("rejects a malformed date query param on the today endpoint", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today?date=not-a-date`).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
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

describe("attendance — bulk holiday", () => {
  it("marks every active househelp as holiday, overwriting existing marks", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const a = await createHousehelp(ctx, owner.cookie, h.id, "Already Present");
    const b = await createHousehelp(ctx, owner.cookie, h.id, "Unmarked");
    const gone = await createHousehelp(ctx, owner.cookie, h.id, "Archived");
    await ctx.request.post(`/api/households/${h.id}/househelps/${gone.id}/archive`).set(csrf).set("cookie", owner.cookie);
    await ctx.request.put(`/api/households/${h.id}/attendance/${a.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });

    const res = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ date: "2026-09-29", count: 2 });

    const today = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    const byName = Object.fromEntries(today.body.data.entries.map((e: { name: string; status: string | null }) => [e.name, e.status]));
    expect(byName["Already Present"]).toBe("HOLIDAY");
    expect(byName["Unmarked"]).toBe("HOLIDAY");
    expect(byName["Archived"]).toBeUndefined();
    void b;
  });

  it("rejects a future date and requires editHistory for a past date, same as single marks", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    await createHousehelp(ctx, owner.cookie, h.id);
    const future = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-30" });
    expect(future.status).toBe(400);
    const memberPast = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-28" });
    expect(memberPast.status).toBe(403);
    const ownerPast = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-28" });
    expect(ownerPast.status).toBe(200);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.holidayMarked")));
    expect(logs).toHaveLength(1);
  });
});

describe("attendance — monthly calendar", () => {
  it("returns only marked days within the requested month, ordered by date", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    ctx.clock.set("2026-08-15T04:30:00Z");
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-08-15", status: "ABSENT" });
    ctx.clock.set("2026-09-29T04:30:00Z");

    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ date: "2026-09-29", status: "PRESENT", note: null }]);
  });

  it("uses the household's timezone, not UTC, to place a mark on the correct side of a month boundary", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    // 2026-09-30T19:00:00Z is still September in UTC but already 2026-10-01 00:30 in Asia/Kolkata (UTC+5:30).
    ctx.clock.set("2026-09-30T19:00:00Z");
    const mark = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-10-01", status: "PRESENT" });
    expect(mark.status).toBe(200);
    const september = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(september.body.data).toEqual([]);
    const october = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-10`).set("cookie", owner.cookie);
    expect(october.body.data).toEqual([{ date: "2026-10-01", status: "PRESENT", note: null }]);
  });

  it("rejects a malformed month", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-9`).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("still returns a calendar for an archived househelp", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ date: "2026-09-29", status: "PRESENT", note: null }]);
  });

  it("a member of household A cannot read household B's calendar", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id);
    const res = await ctx.request.get(`/api/households/${a.id}/househelps/${bobsHelp.id}/attendance?month=2026-09`).set("cookie", alice.cookie);
    expect(res.status).toBe(404);
  });
});

describe("attendance — mark remaining as present", () => {
  it("marks every unmarked scheduled day up to today as PRESENT, skipping already-marked and off-schedule days", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    // 2026-09-15 (Tue) already PRESENT, 2026-09-16 (Wed) already HOLIDAY — both scheduled weekdays.
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-15", status: "PRESENT" });
    await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-16" });

    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(200);
    // 22 scheduled Mon-Fri weekdays occur in September 2026 by the pinned "today" (the 29th);
    // 2 of those are already recorded (15th, 16th), leaving 20 to mark.
    expect(res.body.data).toEqual({ month: "2026-09", count: 20 });

    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(22);
    const sep15 = rows.find((r) => r.date === "2026-09-15");
    expect(sep15?.status).toBe("PRESENT");
    const sep16 = rows.find((r) => r.date === "2026-09-16");
    expect(sep16?.status).toBe("HOLIDAY");
    const sep1 = rows.find((r) => r.date === "2026-09-01");
    expect(sep1?.status).toBe("PRESENT");
  });

  it("records one summary audit entry for the bulk action", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.remainingMarkedPresent")));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.newValue).toEqual({ month: "2026-09", count: 22 });
  });

  it("is a no-op with count 0 and no audit entry when there's nothing to mark (no schedule set)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ month: "2026-09", count: 0 });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.remainingMarkedPresent")));
    expect(logs).toHaveLength(0);
  });

  it("403s without attendance.mark", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const viewer = await signupUser(ctx);
    await addMember(h.id, viewer.id, "VIEWER");
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", viewer.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(403);
  });

  it("403s without attendance.editHistory when at least one eligible date is in the past", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    const member = await signupUser(ctx);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", member.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(403);
  });

  it("never marks another household's attendance", async () => {
    const ownerA = await signupUser(ctx);
    const a = await createHousehold(ctx, ownerA.cookie, "Household A");
    const helpA = await createHousehelp(ctx, ownerA.cookie, a.id);
    const ownerB = await signupUser(ctx);
    const b = await createHousehold(ctx, ownerB.cookie, "Household B");
    const res = await ctx.request.post(`/api/households/${b.id}/househelps/${helpA.id}/attendance/remaining-present`).set(csrf).set("cookie", ownerB.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(404);
  });
});
