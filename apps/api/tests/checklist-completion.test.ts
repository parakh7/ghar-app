import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checklistCompletions, householdMembers } from "../src/db/schema.js";
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

async function createTask(c: TestContext, cookie: string, householdId: string, body: Record<string, unknown> = { name: "Sweep floors", frequency: "DAILY" }) {
  const res = await c.request.post(`/api/households/${householdId}/checklist-tasks`).set(csrf).set("cookie", cookie).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("checklist completion — today marking", () => {
  it("lists a due task with no completion yet and status null", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createTask(ctx, owner.cookie, h.id, { name: "Sweep floors", frequency: "DAILY" });
    const res = await ctx.request.get(`/api/households/${h.id}/checklist/today`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe("2026-09-29");
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0]).toMatchObject({ name: "Sweep floors", status: null, note: null });
  });

  it("excludes a task that isn't due today, via the frequency predicate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    // 2026-09-29 is a Tuesday (isoWeekday 2); this task is only due on Fridays (5).
    await createTask(ctx, owner.cookie, h.id, { name: "Water plants", frequency: "WEEKLY", weekdays: [5] });
    const res = await ctx.request.get(`/api/households/${h.id}/checklist/today`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it("excludes archived and inactive tasks from today's list", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const gone = await createTask(ctx, owner.cookie, h.id, { name: "Gone", frequency: "DAILY" });
    await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${gone.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/checklist/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it("marks completed, then flips to skipped, upserting the same row", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ date: "2026-09-29", status: "COMPLETED", note: null });
    const second = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "SKIPPED", note: "no time today" });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ date: "2026-09-29", status: "SKIPPED", note: "no time today" });
    const rows = await ctx.db.select().from(checklistCompletions).where(eq(checklistCompletions.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.househelpId).toBeNull();
  });

  it("reflects a mark in today's list", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    const res = await ctx.request.get(`/api/households/${h.id}/checklist/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries[0]).toMatchObject({ taskId: task.id, status: "COMPLETED" });
  });

  it("rejects marking a future date", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const res = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-30", status: "COMPLETED" });
    expect(res.status).toBe(400);
  });

  it("does not audit a same-day mark", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "checklist.completionCorrected")));
    expect(logs).toHaveLength(0);
  });

  it("MEMBER can mark today but not correct yesterday, and it is audited when an OWNER does", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const task = await createTask(ctx, owner.cookie, h.id);
    const today = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    expect(today.status).toBe(200);
    const correction = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-28", status: "SKIPPED" });
    expect(correction.status).toBe(403);
    const ownerCorrection = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-28", status: "SKIPPED" });
    expect(ownerCorrection.status).toBe(200);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "checklist.completionCorrected")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ newValue: { status: "SKIPPED", note: null } });
  });

  it("VIEWER can view today's checklist but not mark it", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const task = await createTask(ctx, owner.cookie, h.id);
    expect((await ctx.request.get(`/api/households/${h.id}/checklist/today`).set("cookie", viewer.cookie)).status).toBe(200);
    const res = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", viewer.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    expect(res.status).toBe(403);
  });

  it("clears a mark back to not-marked, and clearing an already-unmarked day is a harmless no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    const clear = await ctx.request.delete(`/api/households/${h.id}/checklist/${task.id}/completion?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(clear.status).toBe(200);
    const rows = await ctx.db.select().from(checklistCompletions).where(eq(checklistCompletions.taskId, task.id));
    expect(rows).toHaveLength(0);
    const again = await ctx.request.delete(`/api/households/${h.id}/checklist/${task.id}/completion?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(again.status).toBe(200);
  });

  it("rejects clearing a future date and requires editHistory for a past date", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const task = await createTask(ctx, owner.cookie, h.id);
    const future = await ctx.request.delete(`/api/households/${h.id}/checklist/${task.id}/completion?date=2026-09-30`).set(csrf).set("cookie", owner.cookie);
    expect(future.status).toBe(400);
    const memberPast = await ctx.request.delete(`/api/households/${h.id}/checklist/${task.id}/completion?date=2026-09-28`).set(csrf).set("cookie", member.cookie);
    expect(memberPast.status).toBe(403);
    const ownerPast = await ctx.request.delete(`/api/households/${h.id}/checklist/${task.id}/completion?date=2026-09-28`).set(csrf).set("cookie", owner.cookie);
    expect(ownerPast.status).toBe(200);
  });

  it("rejects a malformed date query param on the today endpoint", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/checklist/today?date=not-a-date`).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("a member of household A cannot mark a checklist completion for household B's task", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsTask = await createTask(ctx, bob.cookie, b.id);
    const res = await ctx.request.put(`/api/households/${a.id}/checklist/${bobsTask.id}/completion`).set(csrf).set("cookie", alice.cookie).send({ date: "2026-09-29", status: "COMPLETED" });
    expect(res.status).toBe(404);
  });
});
