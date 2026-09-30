import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checklistAssignments, checklistTasks, householdMembers, househelpCategories, househelps } from "../src/db/schema.js";
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

async function createHousehelp(c: TestContext, cookie: string, householdId: string, name = "Sunita") {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("checklist tasks", () => {
  it("creates a daily task with defaults applied", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Sweep floors", frequency: "DAILY" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Sweep floors", frequency: "DAILY", priority: "NORMAL", isActive: true, weekdays: null, dayOfMonth: null, specificDate: null });
  });

  it("canonicalizes WEEKDAYS to Mon-Fri regardless of input, and rejects a client-supplied weekdays for it", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const ok = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Feed pets", frequency: "WEEKDAYS" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.weekdays).toEqual([1, 2, 3, 4, 5]);
    const rejected = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Feed pets", frequency: "WEEKDAYS", weekdays: [1, 2] });
    expect(rejected.status).toBe(400);
  });

  it("rejects a WEEKLY task with no weekdays, and one with an inapplicable field", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const noWeekdays = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Water plants", frequency: "WEEKLY" });
    expect(noWeekdays.status).toBe(400);
    const wrongField = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Water plants", frequency: "DAILY", dayOfMonth: 5 });
    expect(wrongField.status).toBe(400);
  });

  it("accepts MONTHLY, SPECIFIC_DATE, and CUSTOM with exactly their own config", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const monthly = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Pay rent reminder", frequency: "MONTHLY", dayOfMonth: 5 });
    expect(monthly.status).toBe(201);
    const oneTime = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Deep clean", frequency: "SPECIFIC_DATE", specificDate: "2026-10-15" });
    expect(oneTime.status).toBe(201);
    const custom = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Descale kettle", frequency: "CUSTOM", intervalDays: 14, anchorDate: "2026-09-01" });
    expect(custom.status).toBe(201);
  });

  it("tags a task with a category from the same household, and rejects one from another household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const cats = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    const cleaning = cats.body.data[0];
    const res = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "Sweep floors", frequency: "DAILY", categoryId: cleaning.id });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryId).toBe(cleaning.id);

    const bob = await signupUser(ctx);
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobCats = await ctx.request.get(`/api/households/${b.id}/categories`).set("cookie", bob.cookie);
    const crossHousehold = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", owner.cookie).send({ name: "X", frequency: "DAILY", categoryId: bobCats.body.data[0].id });
    expect(crossHousehold.status).toBe(400);
  });

  it("lists active tasks by sortOrder by default and includes archived on request", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const first = await createTask(ctx, owner.cookie, h.id, { name: "First", frequency: "DAILY" });
    await createTask(ctx, owner.cookie, h.id, { name: "Second", frequency: "DAILY" });
    await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${first.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const defaultList = await ctx.request.get(`/api/households/${h.id}/checklist-tasks`).set("cookie", owner.cookie);
    expect(defaultList.body.data.map((t: { name: string }) => t.name)).toEqual(["Second"]);
    const withArchived = await ctx.request.get(`/api/households/${h.id}/checklist-tasks?includeArchived=true`).set("cookie", owner.cookie);
    expect(withArchived.body.data.map((t: { name: string }) => t.name)).toEqual(["First", "Second"]);
  });

  it("switching frequency on update clears the previous frequency's stale config fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id, { name: "Task", frequency: "MONTHLY", dayOfMonth: 10 });
    const res = await ctx.request.patch(`/api/households/${h.id}/checklist-tasks/${task.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "SPECIFIC_DATE", specificDate: "2026-11-01" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ frequency: "SPECIFIC_DATE", specificDate: "2026-11-01", dayOfMonth: null });
    const [row] = await ctx.db.select().from(checklistTasks).where(eq(checklistTasks.id, task.id));
    expect(row!.dayOfMonth).toBeNull();
  });

  it("rejects an update with no fields, and audits old/new values", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const empty = await ctx.request.patch(`/api/households/${h.id}/checklist-tasks/${task.id}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(empty.status).toBe(400);
    const res = await ctx.request.patch(`/api/households/${h.id}/checklist-tasks/${task.id}`).set(csrf).set("cookie", owner.cookie).send({ name: "Renamed" });
    expect(res.status).toBe(200);
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "checklist_task.updated")));
    expect(log).toMatchObject({ newValue: { name: "Renamed" } });
  });

  it("archives and unarchives a task, and both are audited", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const archive = await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${task.id}/archive`).set(csrf).set("cookie", owner.cookie);
    expect(archive.status).toBe(200);
    const [row] = await ctx.db.select().from(checklistTasks).where(eq(checklistTasks.id, task.id));
    expect(row!.archivedAt).not.toBeNull();
    const unarchive = await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${task.id}/unarchive`).set(csrf).set("cookie", owner.cookie);
    expect(unarchive.status).toBe(200);
    const [row2] = await ctx.db.select().from(checklistTasks).where(eq(checklistTasks.id, task.id));
    expect(row2!.archivedAt).toBeNull();
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.entityId, task.id)));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["checklist_task.created", "checklist_task.archived", "checklist_task.unarchived"]));
  });

  it("moves a task up and down, swapping with its neighbor by sortOrder, and is a no-op at the edges", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createTask(ctx, owner.cookie, h.id, { name: "First", frequency: "DAILY" });
    const second = await createTask(ctx, owner.cookie, h.id, { name: "Second", frequency: "DAILY" });
    await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${second.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    const list = await ctx.request.get(`/api/households/${h.id}/checklist-tasks`).set("cookie", owner.cookie);
    expect(list.body.data.map((t: { name: string }) => t.name)).toEqual(["Second", "First"]);
    const noop = await ctx.request.post(`/api/households/${h.id}/checklist-tasks/${second.id}/move`).set(csrf).set("cookie", owner.cookie).send({ direction: "up" });
    expect(noop.status).toBe(200);
    const stillFirst = await ctx.request.get(`/api/households/${h.id}/checklist-tasks`).set("cookie", owner.cookie);
    expect(stillFirst.body.data[0].name).toBe("Second");
  });

  it("MEMBER can view but not manage checklist tasks", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    expect((await ctx.request.get(`/api/households/${h.id}/checklist-tasks`).set("cookie", member.cookie)).status).toBe(200);
    const res = await ctx.request.post(`/api/households/${h.id}/checklist-tasks`).set(csrf).set("cookie", member.cookie).send({ name: "X", frequency: "DAILY" });
    expect(res.status).toBe(403);
  });

  it("a member of household A cannot manage checklist tasks of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/checklist-tasks`).set(csrf).set("cookie", alice.cookie).send({ name: "X", frequency: "DAILY" });
    expect(res.status).toBe(404);
  });
});

describe("checklist assignments", () => {
  it("returns an empty set for a task with no assignments yet", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const res = await ctx.request.get(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("assigns one househelp, then adds a second while keeping the first", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const sunita = await createHousehelp(ctx, owner.cookie, h.id, "Sunita");
    const ramesh = await createHousehelp(ctx, owner.cookie, h.id, "Ramesh");

    const first = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [sunita.id] });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual([sunita.id]);

    ctx.clock.advance(3 * 86_400_000);
    const second = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [sunita.id, ramesh.id] });
    expect(second.status).toBe(200);
    expect(second.body.data.sort()).toEqual([sunita.id, ramesh.id].sort());
  });

  it("removing an assignee closes their row instead of deleting history, once it's from a prior day", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const sunita = await createHousehelp(ctx, owner.cookie, h.id, "Sunita");
    await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [sunita.id] });

    ctx.clock.advance(3 * 86_400_000);
    const res = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);

    const rows = await ctx.db.select().from(checklistAssignments).where(eq(checklistAssignments.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effectiveTo).not.toBeNull();
    expect(rows[0]!.effectiveFrom < rows[0]!.effectiveTo!).toBe(true); // never an inverted range
  });

  it("removing a same-day assignee deletes the row instead of leaving an inverted range", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const sunita = await createHousehelp(ctx, owner.cookie, h.id, "Sunita");
    await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [sunita.id] });
    const res = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [] });
    expect(res.status).toBe(200);
    const rows = await ctx.db.select().from(checklistAssignments).where(eq(checklistAssignments.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects a househelp id that belongs to another household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const bob = await signupUser(ctx);
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id);
    const res = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [bobsHelp.id] });
    expect(res.status).toBe(400);
  });

  it("audits an assignment change", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const sunita = await createHousehelp(ctx, owner.cookie, h.id, "Sunita");
    await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", owner.cookie).send({ househelpIds: [sunita.id] });
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "checklist_task.assignmentsChanged")));
    expect(log).toMatchObject({ newValue: { househelpIds: [sunita.id] } });
  });

  it("MEMBER can view assignments but not change them", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const task = await createTask(ctx, owner.cookie, h.id);
    expect((await ctx.request.get(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set("cookie", member.cookie)).status).toBe(200);
    const res = await ctx.request.put(`/api/households/${h.id}/checklist-tasks/${task.id}/assignments`).set(csrf).set("cookie", member.cookie).send({ househelpIds: [] });
    expect(res.status).toBe(403);
  });
});
