# Checklist Tasks and Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full CRUD for checklist tasks (name, description, category tag, frequency config, priority, reordering, archiving) and versioned assignment of tasks to zero-or-more househelps — replacing the "Coming soon" placeholder at `/checklist` with a working feature.

**Architecture:** Two new API service files (`checklist-task.service.ts`, `checklist-assignment.service.ts`), mirroring `category.service.ts`/`schedule.service.ts`'s style. Routes appended to the existing `household.routes.ts`. The web side gets one new feature folder (`features/app/checklist/`) with a hooks file, a small frequency-formatting helper, a list page (grouped by category, mirroring `HousehelpsListPage`), a create/edit form (frequency-type-driven field visibility, mirroring `HousehelpFormPage`'s salary-mode-driven pattern), and a detail page with an inline assignment editor.

**Tech Stack:** Express 5, Drizzle ORM, zod 4, Vitest + Supertest (API, real Postgres), React 19 + TanStack Query + React Router 7, Vitest + Testing Library (web).

## Global Constraints

- TypeScript strict mode, `noUncheckedIndexedAccess` — non-null assertions only where a prior check or `.returning()` guarantees the row exists.
- Business logic lives in `apps/api/src/services/*`; routes only parse input, call a service, and respond.
- Every household-scoped route goes through `requireHousehold(deps, permission)`; downstream code uses `req.membership.householdId`, never the raw URL param. Non-members get 404, not 403.
- Every audit-logged mutation writes its `audit_logs` row inside the same transaction as the change, via `recordAudit(tx, entry)`.
- Calendar dates are `"YYYY-MM-DD"` strings in the household's timezone (`dateInZone`/`addDays`) — never derived from server-local time.
- No migration, no new permissions — `checklist_tasks`/`checklist_assignments` (schema) and `checklists.view`/`checklists.manage`/`checklists.complete` (permissions, with correct default role grants) already exist from Phase 1.
- **Frequency config validation is strict, not loose like the salary fields.** Each `frequency` value accepts exactly its own config fields (`weekdays` for WEEKLY, `dayOfMonth` for MONTHLY, `specificDate` for SPECIFIC_DATE, `intervalDays`+`anchorDate` for CUSTOM; DAILY and WEEKDAYS take none) and rejects the others being present — an inapplicable field left populated would make a later "is this task due today" check ambiguous. `WEEKDAYS` is a fixed Mon–Fri set the service stores canonically (`[1,2,3,4,5]`); it is never client-supplied.
- **Changing `frequency` on update replaces the entire config block** — all five config fields (`weekdays`, `dayOfMonth`, `specificDate`, `intervalDays`, `anchorDate`) are explicitly set (to the patch's values or `null`) whenever `frequency` is present in the patch, so a stale field from the task's previous frequency can never survive a switch.
- **Assignment versioning uses a simplified variant of the schedule pattern.** Because a task's assignee set is zero-to-many (not the schedule's always-exactly-one), `PUT` does not do the single-row same-day-edit-in-place optimization `schedule.service.ts` does. Instead: a currently-effective assignment row being removed is **deleted outright if its `effectiveFrom` is today** (it was never effective on any prior day, so closing it with `effectiveTo = yesterday` would create an invalid inverted range) and otherwise closed with `effectiveTo = yesterday`; a newly-added assignee gets a fresh row with `effectiveFrom = today`. A household re-assigning the same task twice in one day still creates a closed-then-reopened pair for a househelp who stays assigned across both edits (accepted minor history noise), but same-day churn never produces a corrupt row.
- No UI for reordering checklist tasks in this spec: the list page groups tasks by category (not a flat orderable list), so a global `sortOrder`-based move control would visually reorder a task relative to neighbors not shown adjacent to it. The `move` API endpoint is still built (for a future flat-list view), just not wired into any page yet — matching the "defer speculative UI" precedent from schedule-history in Phase 2 Spec 2.
- API integration tests run against a real Postgres (`TEST_DATABASE_URL`), following the exact pattern in `apps/api/tests/attendance.test.ts` (same helpers: `createTestContext`, `signupUser`, `csrf`, `truncateAll`, `FakeClock` via `ctx.clock`).
- Web component tests follow `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`'s pattern: mock `globalThis.fetch`, wrap in `QueryClientProvider` + `MemoryRouter`.
- Spec: `docs/superpowers/specs/2026-09-30-checklist-tasks-assignments-design.md`.

---

### Task 1: Shared schemas and DTOs

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/dto.ts`

**Interfaces:**
- Produces: `taskFrequencySchema`, `taskPrioritySchema`, `createChecklistTaskSchema`, `updateChecklistTaskSchema`, `putAssignmentsSchema` (zod schemas) and `CreateChecklistTaskInput`, `UpdateChecklistTaskInput`, `PutAssignmentsInput` (inferred types) from `schemas.ts`; `TaskFrequency`, `TaskPriority`, `ChecklistTaskDTO` (types) from `dto.ts`. Reuses the existing `moveCategorySchema`/`MoveCategoryInput` for checklist-task reordering — no new move schema. All re-exported via the existing `packages/shared/src/index.ts` wildcard barrel.

- [ ] **Step 1: Add the schemas to `schemas.ts`**

Add at the end of `packages/shared/src/schemas.ts`:

```ts
export const taskFrequencySchema = z.enum(["DAILY", "WEEKLY", "WEEKDAYS", "MONTHLY", "SPECIFIC_DATE", "CUSTOM"]);
export const taskPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH"]);

type FrequencyConfigFields = {
  weekdays?: number[]; dayOfMonth?: number; specificDate?: string; intervalDays?: number; anchorDate?: string;
};

/**
 * Each frequency accepts exactly its own config fields and rejects the others — an inapplicable
 * field left populated would make "is this task due today" (a later spec) ambiguous. WEEKDAYS takes
 * no input at all: it's a fixed Mon–Fri set the service stores canonically, never client-supplied.
 */
function checkFrequencyConfig(v: { frequency: z.infer<typeof taskFrequencySchema> } & FrequencyConfigFields, ctx: z.RefinementCtx): void {
  const has = {
    weekdays: v.weekdays !== undefined, dayOfMonth: v.dayOfMonth !== undefined,
    specificDate: v.specificDate !== undefined, intervalDays: v.intervalDays !== undefined, anchorDate: v.anchorDate !== undefined,
  };
  const reject = (field: keyof typeof has) => { if (has[field]) ctx.addIssue({ code: "custom", path: [field], message: `Not used for a ${v.frequency} task.` }); };
  const rejectAllExcept = (...allowed: (keyof typeof has)[]) => {
    (Object.keys(has) as (keyof typeof has)[]).forEach((f) => { if (!allowed.includes(f)) reject(f); });
  };
  switch (v.frequency) {
    case "DAILY":
    case "WEEKDAYS":
      rejectAllExcept();
      break;
    case "WEEKLY":
      rejectAllExcept("weekdays");
      if (!v.weekdays || v.weekdays.length === 0) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Pick at least one weekday for a weekly task." });
      else if (new Set(v.weekdays).size !== v.weekdays.length) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "No duplicate days." });
      break;
    case "MONTHLY":
      rejectAllExcept("dayOfMonth");
      if (!has.dayOfMonth) ctx.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Give the day of the month for a monthly task." });
      break;
    case "SPECIFIC_DATE":
      rejectAllExcept("specificDate");
      if (!has.specificDate) ctx.addIssue({ code: "custom", path: ["specificDate"], message: "Give the date for a one-time task." });
      break;
    case "CUSTOM":
      rejectAllExcept("intervalDays", "anchorDate");
      if (!has.intervalDays) ctx.addIssue({ code: "custom", path: ["intervalDays"], message: "Give the repeat interval in days." });
      if (!has.anchorDate) ctx.addIssue({ code: "custom", path: ["anchorDate"], message: "Give the anchor date to count the interval from." });
      break;
  }
}

export const createChecklistTaskSchema = z.object({
  name: z.string().trim().min(1, "Give the task a name").max(120),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.string().uuid().optional(),
  frequency: taskFrequencySchema,
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  specificDate: dateSchema.optional(),
  intervalDays: z.number().int().min(1).optional(),
  anchorDate: dateSchema.optional(),
  preferredTime: timeSchema.optional(),
  priority: taskPrioritySchema.default("NORMAL"),
}).superRefine(checkFrequencyConfig);

export const updateChecklistTaskSchema = z.object({
  name: z.string().trim().min(1, "Give the task a name").max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  frequency: taskFrequencySchema.optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  specificDate: dateSchema.optional(),
  intervalDays: z.number().int().min(1).optional(),
  anchorDate: dateSchema.optional(),
  preferredTime: timeSchema.nullable().optional(),
  priority: taskPrioritySchema.optional(),
}).superRefine((v, ctx) => {
  const configTouched = v.weekdays !== undefined || v.dayOfMonth !== undefined || v.specificDate !== undefined || v.intervalDays !== undefined || v.anchorDate !== undefined;
  if (v.frequency === undefined) {
    if (configTouched) ctx.addIssue({ code: "custom", path: ["frequency"], message: "Include frequency when changing its config fields." });
    return;
  }
  checkFrequencyConfig(v, ctx);
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Provide at least one field to update." });

export const putAssignmentsSchema = z.object({ househelpIds: z.array(z.string().uuid()) });

export type CreateChecklistTaskInput = z.input<typeof createChecklistTaskSchema>;
export type UpdateChecklistTaskInput = z.infer<typeof updateChecklistTaskSchema>;
export type PutAssignmentsInput = z.infer<typeof putAssignmentsSchema>;
```

`CreateChecklistTaskInput` uses `z.input` (not `z.infer`) because `priority` has `.default("NORMAL")` — same reasoning as `CreateHousehelpInput`.

- [ ] **Step 2: Add the DTO to `dto.ts`**

Add at the end of `packages/shared/src/dto.ts`:

```ts
export type TaskFrequency = "DAILY" | "WEEKLY" | "WEEKDAYS" | "MONTHLY" | "SPECIFIC_DATE" | "CUSTOM";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH";

export type ChecklistTaskDTO = {
  id: string; name: string; description: string | null; categoryId: string | null;
  frequency: TaskFrequency; weekdays: number[] | null; dayOfMonth: number | null;
  specificDate: string | null; intervalDays: number | null; anchorDate: string | null;
  preferredTime: string | null; priority: TaskPriority; sortOrder: number;
  isActive: boolean; archivedAt: string | null; createdAt: string;
};
```

- [ ] **Step 3: Build and typecheck the shared package**

Run: `npm run build -w @household/shared && npm run typecheck -w @household/shared`
Expected: both succeed with no errors (no dedicated test file for `schemas.ts`/`dto.ts` additions — matches the existing convention; build + typecheck is the verification here).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/dto.ts
git commit -m "feat(shared): add checklist task and assignment schemas/DTOs"
```

---

### Task 2: Checklist tasks — API (CRUD, reorder, archive)

**Files:**
- Create: `apps/api/src/services/checklist-task.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Create: `apps/api/tests/checklist.test.ts` (new file — this task writes the "checklist tasks" describe block; Task 3 appends the "checklist assignments" block)

**Interfaces:**
- Consumes: `Deps`/`DbOrTx`, `Errors`, `recordAudit`, `requireHousehold`, `parseBody`, `ok`, `ChecklistTaskDTO`/`CreateChecklistTaskInput`/`UpdateChecklistTaskInput`/`createChecklistTaskSchema`/`updateChecklistTaskSchema`/`moveCategorySchema` (`@household/shared`), `checklistTasks`/`househelpCategories` tables (`apps/api/src/db/schema.ts`).
- Produces: `listChecklistTasks(db, householdId, includeArchived?): Promise<ChecklistTaskDTO[]>`, `getChecklistTask(db, householdId, id): Promise<ChecklistTaskDTO>`, `createChecklistTask(deps, actorUserId, householdId, input, ip?): Promise<ChecklistTaskDTO>`, `updateChecklistTask(deps, actorUserId, householdId, id, patch, ip?): Promise<ChecklistTaskDTO>`, `archiveChecklistTask(deps, actorUserId, householdId, id, ip?): Promise<void>`, `unarchiveChecklistTask(deps, actorUserId, householdId, id, ip?): Promise<void>`, `moveChecklistTask(deps, actorUserId, householdId, id, direction, ip?): Promise<void>` — all from `checklist-task.service.ts`. Task 3 consumes nothing from this file directly but shares its test file's local helpers.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/tests/checklist.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, checklistTasks, householdMembers, househelpCategories } from "../src/db/schema.js";
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- checklist.test.ts`
Expected: FAIL — `/api/households/:id/checklist-tasks` routes don't exist yet.

- [ ] **Step 3: Implement `checklist-task.service.ts`**

Create `apps/api/src/services/checklist-task.service.ts`:

```ts
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ChecklistTaskDTO, CreateChecklistTaskInput, TaskFrequency, UpdateChecklistTaskInput } from "@household/shared";
import { checklistTasks, househelpCategories } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

type ChecklistTaskRow = typeof checklistTasks.$inferSelect;

function toHHMM(t: string | null): string | null {
  return t === null ? null : t.slice(0, 5);
}

function toChecklistTaskDTO(row: ChecklistTaskRow): ChecklistTaskDTO {
  return {
    id: row.id, name: row.name, description: row.description, categoryId: row.categoryId,
    frequency: row.frequency, weekdays: row.weekdays, dayOfMonth: row.dayOfMonth,
    specificDate: row.specificDate, intervalDays: row.intervalDays, anchorDate: row.anchorDate,
    preferredTime: toHHMM(row.preferredTime), priority: row.priority, sortOrder: row.sortOrder,
    isActive: row.isActive, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** WEEKDAYS is a fixed Mon–Fri set — never client-supplied (the schema already rejects a client
 *  `weekdays` for it), always stored canonically. */
function canonicalWeekdays(frequency: TaskFrequency, weekdays?: number[]): number[] | null {
  if (frequency === "WEEKDAYS") return [1, 2, 3, 4, 5];
  return weekdays ?? null;
}

async function requireCategoryInHousehold(db: DbOrTx, householdId: string, categoryId: string): Promise<void> {
  const [row] = await db.select({ id: househelpCategories.id }).from(househelpCategories)
    .where(and(eq(househelpCategories.householdId, householdId), eq(househelpCategories.id, categoryId), isNull(househelpCategories.deletedAt)));
  if (!row) throw Errors.validation({ categoryId: "That category doesn't exist." });
}

export async function listChecklistTasks(db: DbOrTx, householdId: string, includeArchived = false): Promise<ChecklistTaskDTO[]> {
  const rows = await db.select().from(checklistTasks)
    .where(includeArchived ? eq(checklistTasks.householdId, householdId) : and(eq(checklistTasks.householdId, householdId), isNull(checklistTasks.archivedAt)))
    .orderBy(asc(checklistTasks.sortOrder));
  return rows.map(toChecklistTaskDTO);
}

export async function getChecklistTask(db: DbOrTx, householdId: string, id: string): Promise<ChecklistTaskDTO> {
  const [row] = await db.select().from(checklistTasks).where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, id)));
  if (!row) throw Errors.notFound("Checklist task");
  return toChecklistTaskDTO(row);
}

export async function createChecklistTask(deps: Deps, actorUserId: string, householdId: string, input: CreateChecklistTaskInput, ip?: string): Promise<ChecklistTaskDTO> {
  if (input.categoryId) await requireCategoryInHousehold(deps.db, householdId, input.categoryId);
  const row = await deps.db.transaction(async (tx) => {
    const [{ maxSort } = { maxSort: -1 }] = await tx
      .select({ maxSort: sql<number>`coalesce(max(${checklistTasks.sortOrder}), -1)` })
      .from(checklistTasks)
      .where(eq(checklistTasks.householdId, householdId));
    const [inserted] = await tx.insert(checklistTasks).values({
      householdId, name: input.name, description: input.description ?? null, categoryId: input.categoryId ?? null,
      frequency: input.frequency, weekdays: canonicalWeekdays(input.frequency, input.weekdays),
      dayOfMonth: input.dayOfMonth ?? null, specificDate: input.specificDate ?? null,
      intervalDays: input.intervalDays ?? null, anchorDate: input.anchorDate ?? null,
      preferredTime: input.preferredTime ?? null, priority: input.priority, sortOrder: Number(maxSort) + 1,
    }).returning();
    await recordAudit(tx, { householdId, actorUserId, action: "checklist_task.created", entityType: "checklist_task", entityId: inserted!.id, newValue: { name: input.name, frequency: input.frequency }, ipAddress: ip ?? null });
    return inserted!;
  });
  return toChecklistTaskDTO(row);
}

export async function updateChecklistTask(deps: Deps, actorUserId: string, householdId: string, id: string, patch: UpdateChecklistTaskInput, ip?: string): Promise<ChecklistTaskDTO> {
  if (patch.categoryId) await requireCategoryInHousehold(deps.db, householdId, patch.categoryId);
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(checklistTasks).where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, id))).for("update");
    if (!before) throw Errors.notFound("Checklist task");

    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.categoryId !== undefined) changes.categoryId = patch.categoryId;
    if (patch.preferredTime !== undefined) changes.preferredTime = patch.preferredTime;
    if (patch.priority !== undefined) changes.priority = patch.priority;
    // Changing frequency replaces the ENTIRE config block, clearing whichever fields the new
    // frequency doesn't use — otherwise a stale dayOfMonth from a past MONTHLY config would survive
    // a switch to SPECIFIC_DATE, making a later "is this due today" check ambiguous.
    if (patch.frequency !== undefined) {
      changes.frequency = patch.frequency;
      changes.weekdays = canonicalWeekdays(patch.frequency, patch.weekdays);
      changes.dayOfMonth = patch.dayOfMonth ?? null;
      changes.specificDate = patch.specificDate ?? null;
      changes.intervalDays = patch.intervalDays ?? null;
      changes.anchorDate = patch.anchorDate ?? null;
    }
    if (Object.keys(changes).length > 0) await tx.update(checklistTasks).set(changes).where(eq(checklistTasks.id, id));
    await recordAudit(tx, { householdId, actorUserId, action: "checklist_task.updated", entityType: "checklist_task", entityId: id, oldValue: before, newValue: changes, ipAddress: ip ?? null });
    const [after] = await tx.select().from(checklistTasks).where(eq(checklistTasks.id, id));
    return after!;
  });
  return toChecklistTaskDTO(row);
}

export async function archiveChecklistTask(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(checklistTasks).set({ archivedAt: deps.clock.now() })
      .where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, id), isNull(checklistTasks.archivedAt)))
      .returning({ id: checklistTasks.id });
    if (!row) throw Errors.notFound("Checklist task");
    await recordAudit(tx, { householdId, actorUserId, action: "checklist_task.archived", entityType: "checklist_task", entityId: id, ipAddress: ip ?? null });
  });
}

export async function unarchiveChecklistTask(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(checklistTasks).set({ archivedAt: null })
      .where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, id)))
      .returning({ id: checklistTasks.id });
    if (!row) throw Errors.notFound("Checklist task");
    await recordAudit(tx, { householdId, actorUserId, action: "checklist_task.unarchived", entityType: "checklist_task", entityId: id, ipAddress: ip ?? null });
  });
}

export async function moveChecklistTask(deps: Deps, actorUserId: string, householdId: string, id: string, direction: "up" | "down", ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx.select({ id: checklistTasks.id, sortOrder: checklistTasks.sortOrder })
      .from(checklistTasks)
      .where(and(eq(checklistTasks.householdId, householdId), isNull(checklistTasks.archivedAt)))
      .orderBy(asc(checklistTasks.sortOrder))
      .for("update");
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) throw Errors.notFound("Checklist task");
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= rows.length) return; // already at the edge — no-op
    const a = rows[index]!;
    const b = rows[swapIndex]!;
    await tx.update(checklistTasks).set({ sortOrder: b.sortOrder }).where(eq(checklistTasks.id, a.id));
    await tx.update(checklistTasks).set({ sortOrder: a.sortOrder }).where(eq(checklistTasks.id, b.id));
    await recordAudit(tx, { householdId, actorUserId, action: "checklist_task.moved", entityType: "checklist_task", entityId: id, newValue: { direction }, ipAddress: ip ?? null });
  });
}
```

- [ ] **Step 4: Add the checklist-task routes to `household.routes.ts`**

Extend the existing `@household/shared` import line — it currently reads:
`createCategorySchema, createHousehelpSchema, createHouseholdSchema, dateSchema, inviteMemberSchema, markAttendanceSchema, markHolidaySchema, monthSchema, moveCategorySchema, updateCategorySchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema`
— add `createChecklistTaskSchema, updateChecklistTaskSchema`, keeping alphabetical order:
`createCategorySchema, createChecklistTaskSchema, createHousehelpSchema, createHouseholdSchema, dateSchema, inviteMemberSchema, markAttendanceSchema, markHolidaySchema, monthSchema, moveCategorySchema, updateCategorySchema, updateChecklistTaskSchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema`

Add this import alongside the existing `* as categories` import:

```ts
import * as checklistTasks from "../services/checklist-task.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/checklist-tasks", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistTasks.listChecklistTasks(deps.db, req.membership!.householdId, req.query.includeArchived === "true"));
  });

  r.post("/:householdId/checklist-tasks", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const input = parseBody(req, createChecklistTaskSchema);
    ok(res, await checklistTasks.createChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Checklist task added.");
  });

  r.get("/:householdId/checklist-tasks/:id", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistTasks.getChecklistTask(deps.db, req.membership!.householdId, req.params.id as string));
  });

  r.patch("/:householdId/checklist-tasks/:id", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const patch = parseBody(req, updateChecklistTaskSchema);
    ok(res, await checklistTasks.updateChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, patch, req.ip), 200, "Checklist task updated.");
  });

  r.post("/:householdId/checklist-tasks/:id/archive", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    await checklistTasks.archiveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Checklist task removed.");
  });

  r.post("/:householdId/checklist-tasks/:id/unarchive", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    await checklistTasks.unarchiveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Checklist task restored.");
  });

  r.post("/:householdId/checklist-tasks/:id/move", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const { direction } = parseBody(req, moveCategorySchema);
    await checklistTasks.moveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, direction, req.ip);
    ok(res, null, 200, "Checklist task moved.");
  });
```

`moveCategorySchema` (`{direction: "up"|"down"}`) is reused as-is — its shape isn't category-specific, so a second identical schema isn't needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- checklist.test.ts`
Expected: PASS — all cases in the "checklist tasks" describe block.

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/checklist-task.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/checklist.test.ts
git commit -m "feat(api): checklist task CRUD, frequency validation, reorder, and archive"
```

---

### Task 3: Checklist assignments — API

**Files:**
- Create: `apps/api/src/services/checklist-assignment.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `apps/api/tests/checklist.test.ts` (append the "checklist assignments" describe block)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `Membership` (`apps/api/src/services/household.service.ts`), `dateInZone`/`addDays`/`putAssignmentsSchema` (`@household/shared`), `checklistAssignments`/`househelps` tables (`apps/api/src/db/schema.ts`).
- Produces: `getCurrentAssignments(deps, membership, taskId): Promise<string[]>`, `putAssignments(deps, actorUserId, membership, taskId, househelpIds, ip?): Promise<string[]>` — from `checklist-assignment.service.ts`.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/tests/checklist.test.ts` (same file as Task 2). Add `checklistAssignments`/`househelps` to the existing schema import line (`auditLogs, checklistTasks, householdMembers, househelpCategories` → `auditLogs, checklistAssignments, checklistTasks, householdMembers, househelpCategories, househelps`), and add a local helper right after `createTask`:

```ts
async function createHousehelp(c: TestContext, cookie: string, householdId: string, name = "Sunita") {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}
```

Then append this describe block:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- checklist.test.ts`
Expected: FAIL on every case in the new "checklist assignments" block (routes don't exist yet).

- [ ] **Step 3: Implement `checklist-assignment.service.ts`**

Create `apps/api/src/services/checklist-assignment.service.ts`:

```ts
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { addDays, dateInZone } from "@household/shared";
import { checklistAssignments, checklistTasks, househelps } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

function currentlyEffective(householdId: string, taskId: string, today: string) {
  return and(
    eq(checklistAssignments.householdId, householdId),
    eq(checklistAssignments.taskId, taskId),
    lte(checklistAssignments.effectiveFrom, today),
    or(isNull(checklistAssignments.effectiveTo), gte(checklistAssignments.effectiveTo, today)),
  );
}

async function requireTaskInHousehold(db: DbOrTx, householdId: string, taskId: string): Promise<void> {
  const [row] = await db.select({ id: checklistTasks.id }).from(checklistTasks)
    .where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, taskId)));
  if (!row) throw Errors.notFound("Checklist task");
}

export async function getCurrentAssignments(deps: Deps, membership: Membership, taskId: string): Promise<string[]> {
  await requireTaskInHousehold(deps.db, membership.householdId, taskId);
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const rows = await deps.db.select({ househelpId: checklistAssignments.househelpId }).from(checklistAssignments)
    .where(currentlyEffective(membership.householdId, taskId, today));
  return rows.map((r) => r.househelpId);
}

export async function putAssignments(deps: Deps, actorUserId: string, membership: Membership, taskId: string, househelpIds: string[], ip?: string): Promise<string[]> {
  await requireTaskInHousehold(deps.db, membership.householdId, taskId);
  const uniqueIds = [...new Set(househelpIds)];

  if (uniqueIds.length > 0) {
    const rows = await deps.db.select({ id: househelps.id }).from(househelps)
      .where(and(eq(househelps.householdId, membership.householdId), inArray(househelps.id, uniqueIds)));
    if (rows.length !== uniqueIds.length) throw Errors.validation({ househelpIds: "One or more househelps don't belong to this household." });
  }

  const today = dateInZone(deps.clock.now(), membership.timezone);
  const yesterday = addDays(today, -1);
  const wantedIds = new Set(uniqueIds);

  await deps.db.transaction(async (tx) => {
    const current = await tx.select({ id: checklistAssignments.id, househelpId: checklistAssignments.househelpId, effectiveFrom: checklistAssignments.effectiveFrom })
      .from(checklistAssignments)
      .where(currentlyEffective(membership.householdId, taskId, today))
      .for("update");
    const currentIds = new Set(current.map((r) => r.househelpId));

    const toRemove = current.filter((r) => !wantedIds.has(r.househelpId));
    for (const row of toRemove) {
      // A row whose effectiveFrom is today was never effective on any prior day — closing it with
      // effectiveTo = yesterday would create an invalid inverted range, so it's deleted outright
      // instead (same-day churn leaves no trace, which is correct: nothing was ever "in effect").
      if (row.effectiveFrom === today) await tx.delete(checklistAssignments).where(eq(checklistAssignments.id, row.id));
      else await tx.update(checklistAssignments).set({ effectiveTo: yesterday }).where(eq(checklistAssignments.id, row.id));
    }
    const toAdd = uniqueIds.filter((id) => !currentIds.has(id));
    if (toAdd.length > 0) {
      await tx.insert(checklistAssignments).values(toAdd.map((househelpId) => ({
        householdId: membership.householdId, taskId, househelpId, effectiveFrom: today,
      })));
    }
    if (toRemove.length > 0 || toAdd.length > 0) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "checklist_task.assignmentsChanged", entityType: "checklist_task", entityId: taskId,
        newValue: { househelpIds: uniqueIds }, ipAddress: ip ?? null,
      });
    }
  });
  return uniqueIds;
}
```

- [ ] **Step 4: Add the assignment routes to `household.routes.ts`**

Add `putAssignmentsSchema` to the shared import line (keep alphabetical: `... moveCategorySchema, putAssignmentsSchema, updateCategorySchema, ...`), and add this import alongside the `* as checklistTasks` import:

```ts
import * as checklistAssignments from "../services/checklist-assignment.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/checklist-tasks/:id/assignments", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistAssignments.getCurrentAssignments(deps, req.membership!, req.params.id as string));
  });

  r.put("/:householdId/checklist-tasks/:id/assignments", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const { househelpIds } = parseBody(req, putAssignmentsSchema);
    ok(res, await checklistAssignments.putAssignments(deps, req.auth!.user.id, req.membership!, req.params.id as string, househelpIds, req.ip), 200, "Assignments updated.");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- checklist.test.ts`
Expected: PASS — all cases across both describe blocks.

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/checklist-assignment.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/checklist.test.ts
git commit -m "feat(api): versioned checklist-task assignment to househelps"
```

---

### Task 4: Web — checklist list page and hooks

**Files:**
- Create: `apps/web/src/features/app/checklist/useChecklist.ts`
- Create: `apps/web/src/features/app/checklist/frequency.ts`
- Test: `apps/web/src/features/app/checklist/frequency.test.ts`
- Create: `apps/web/src/features/app/checklist/ChecklistListPage.tsx`
- Test: `apps/web/src/features/app/checklist/ChecklistListPage.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `get`/`post`/`patch`/`put` (`apps/web/src/lib/api.ts`), `ChecklistTaskDTO`/`CreateChecklistTaskInput`/`UpdateChecklistTaskInput`/`MoveCategoryInput`/`PutAssignmentsInput` (`@household/shared`), `Button`/`EmptyState` (`apps/web/src/components/*`), `useHousehold` (`apps/web/src/features/app/members/useMembers.ts`), `useCategories` (`apps/web/src/features/app/househelps/useHousehelps.ts` — reused, not redefined).
- Produces: `useChecklistTasks`, `useChecklistTask`, `useCreateChecklistTask`, `useUpdateChecklistTask`, `useArchiveChecklistTask`, `useUnarchiveChecklistTask`, `useMoveChecklistTask`, `useChecklistAssignments`, `usePutChecklistAssignments` (`useChecklist.ts` — Task 5 consumes all of these); `formatFrequency` (`frequency.ts` — Task 5 also uses this).

- [ ] **Step 1: Write the failing unit test for `formatFrequency`**

Create `apps/web/src/features/app/checklist/frequency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChecklistTaskDTO } from "@household/shared";
import { formatFrequency } from "./frequency";

function task(overrides: Partial<ChecklistTaskDTO>): ChecklistTaskDTO {
  return {
    id: "t1", name: "Task", description: null, categoryId: null, frequency: "DAILY",
    weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null,
    preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

describe("formatFrequency", () => {
  it("formats DAILY and WEEKDAYS", () => {
    expect(formatFrequency(task({ frequency: "DAILY" }))).toBe("Every day");
    expect(formatFrequency(task({ frequency: "WEEKDAYS" }))).toBe("Weekdays");
  });

  it("formats WEEKLY as a day-name list", () => {
    expect(formatFrequency(task({ frequency: "WEEKLY", weekdays: [1, 3, 5] }))).toBe("Every Mon, Wed, Fri");
  });

  it("formats MONTHLY with an ordinal day", () => {
    expect(formatFrequency(task({ frequency: "MONTHLY", dayOfMonth: 1 }))).toBe("Monthly on the 1st");
    expect(formatFrequency(task({ frequency: "MONTHLY", dayOfMonth: 22 }))).toBe("Monthly on the 22nd");
  });

  it("formats SPECIFIC_DATE and CUSTOM", () => {
    expect(formatFrequency(task({ frequency: "SPECIFIC_DATE", specificDate: "2026-10-15" }))).toBe("On 2026-10-15");
    expect(formatFrequency(task({ frequency: "CUSTOM", intervalDays: 1 }))).toBe("Every 1 day");
    expect(formatFrequency(task({ frequency: "CUSTOM", intervalDays: 14 }))).toBe("Every 14 days");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- frequency`
Expected: FAIL — `./frequency` doesn't exist yet.

- [ ] **Step 3: Implement `frequency.ts`**

Create `apps/web/src/features/app/checklist/frequency.ts`:

```ts
import type { ChecklistTaskDTO } from "@household/shared";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function formatFrequency(t: ChecklistTaskDTO): string {
  switch (t.frequency) {
    case "DAILY": return "Every day";
    case "WEEKDAYS": return "Weekdays";
    case "WEEKLY": return `Every ${(t.weekdays ?? []).map((d) => DAY_NAMES[d - 1]).join(", ")}`;
    case "MONTHLY": return `Monthly on the ${ordinal(t.dayOfMonth ?? 1)}`;
    case "SPECIFIC_DATE": return `On ${t.specificDate}`;
    case "CUSTOM": return `Every ${t.intervalDays} day${t.intervalDays === 1 ? "" : "s"}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- frequency`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Add checklist hooks**

Create `apps/web/src/features/app/checklist/useChecklist.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChecklistTaskDTO, CreateChecklistTaskInput, MoveCategoryInput, PutAssignmentsInput, UpdateChecklistTaskInput } from "@household/shared";
import { get, patch, post, put } from "../../../lib/api";

export function useChecklistTasks(householdId: string | undefined, includeArchived: boolean) {
  return useQuery({
    queryKey: ["checklist-tasks", householdId, includeArchived],
    queryFn: ({ signal }) => get<ChecklistTaskDTO[]>(`/households/${householdId}/checklist-tasks${includeArchived ? "?includeArchived=true" : ""}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useChecklistTask(householdId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["checklist-task", householdId, id],
    queryFn: ({ signal }) => get<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks/${id}`, signal).then((r) => r.data),
    enabled: !!householdId && !!id,
  });
}

function invalidateChecklistTaskQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, id?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["checklist-tasks", householdId] }),
    ...(id ? [qc.invalidateQueries({ queryKey: ["checklist-task", householdId, id] })] : []),
  ]);
}

export function useCreateChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChecklistTaskInput) => post<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks`, body),
    onSuccess: () => invalidateChecklistTaskQueries(qc, householdId),
  });
}

export function useUpdateChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateChecklistTaskInput }) => patch<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks/${id}`, body),
    onSuccess: (_data, { id }) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useArchiveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/checklist-tasks/${id}/archive`),
    onSuccess: (_data, id) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useUnarchiveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/checklist-tasks/${id}/unarchive`),
    onSuccess: (_data, id) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useMoveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: MoveCategoryInput["direction"] }) => post<null>(`/households/${householdId}/checklist-tasks/${id}/move`, { direction }),
    onSuccess: () => invalidateChecklistTaskQueries(qc, householdId),
  });
}

export function useChecklistAssignments(householdId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ["checklist-assignments", householdId, taskId],
    queryFn: ({ signal }) => get<string[]>(`/households/${householdId}/checklist-tasks/${taskId}/assignments`, signal).then((r) => r.data),
    enabled: !!householdId && !!taskId,
  });
}

export function usePutChecklistAssignments(householdId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutAssignmentsInput) => put<string[]>(`/households/${householdId}/checklist-tasks/${taskId}/assignments`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["checklist-assignments", householdId, taskId] }),
  });
}
```

- [ ] **Step 6: Write the failing component test for `ChecklistListPage`**

Create `apps/web/src/features/app/checklist/ChecklistListPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistListPage } from "./ChecklistListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ChecklistListPage /></MemoryRouter></QueryClientProvider>);
}

describe("ChecklistListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("groups tasks by category and puts categoryless ones under Uncategorized", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }], message: null });
      if (url.includes("/checklist-tasks")) {
        return jsonResponse({
          success: true,
          data: [
            { id: "t1", name: "Sweep floors", description: null, categoryId: "c1", frequency: "DAILY", weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "t2", name: "Pay rent reminder", description: null, categoryId: null, frequency: "MONTHLY", weekdays: null, dayOfMonth: 5, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "HIGH", sortOrder: 1, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
          ],
          message: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sweep floors")).toBeInTheDocument();
    expect(screen.getByText("Cleaning")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByText("Pay rent reminder")).toBeInTheDocument();
    expect(screen.getByText(/High priority/)).toBeInTheDocument();
  });

  it("hides the add-task action for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.includes("/checklist-tasks")) {
        return jsonResponse({ success: true, data: [{ id: "t1", name: "Sweep floors", description: null, categoryId: null, frequency: "DAILY", weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sweep floors");
    expect(screen.queryByRole("button", { name: /add task/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- ChecklistListPage`
Expected: FAIL — `./ChecklistListPage` doesn't exist yet.

- [ ] **Step 8: Implement `ChecklistListPage.tsx`**

Create `apps/web/src/features/app/checklist/ChecklistListPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import type { ChecklistTaskDTO } from "@household/shared";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories } from "../househelps/useHousehelps";
import { formatFrequency } from "./frequency";
import { useChecklistTasks } from "./useChecklist";

function TaskRow({ t }: { t: ChecklistTaskDTO }) {
  return (
    <Link to={`/checklist/${t.id}`} className="list__item">
      <span className="list__text">
        <span className="list__label" style={{ display: "block" }}>{t.name}{t.archivedAt && " (archived)"}</span>
        <span className="list__meta">{formatFrequency(t)}{t.priority === "HIGH" && " · High priority"}</span>
      </span>
    </Link>
  );
}

export function ChecklistListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const tasksQuery = useChecklistTasks(householdId, showArchived);
  const categoriesQuery = useCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;

  if (!householdId) return null;

  const tasks = tasksQuery.data ?? [];
  const activeCategories = (categoriesQuery.data ?? []).filter((c) => c.isActive);
  const activeCategoryIds = new Set(activeCategories.map((c) => c.id));
  const uncategorized = tasks.filter((t) => !t.categoryId || !activeCategoryIds.has(t.categoryId));

  return (
    <>
      <header className="page-head"><h1 className="page-title">Checklist</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
      </div>

      {tasks.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No tasks yet" text="Add a daily, weekly or monthly task to start tracking."
            action={canManage ? <Button onClick={() => navigate("/checklist/new")}>Add task</Button> : undefined}
          />
        </div>
      )}

      {activeCategories.map((c) => {
        const inCategory = tasks.filter((t) => t.categoryId === c.id);
        if (inCategory.length === 0) return null;
        return (
          <div key={c.id}>
            <h2 className="section-title">{c.name}</h2>
            <div className="list">{inCategory.map((t) => <TaskRow key={t.id} t={t} />)}</div>
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div>
          <h2 className="section-title">Uncategorized</h2>
          <div className="list">{uncategorized.map((t) => <TaskRow key={t.id} t={t} />)}</div>
        </div>
      )}

      {canManage && tasks.length > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/checklist/new")}>Add task</Button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 9: Wire the route, replacing the "Coming soon" placeholder**

In `apps/web/src/App.tsx`:
- Remove `ClipboardCheck` from the `lucide-react` import line (it's used only by the checklist `ComingSoonPage` route being replaced; `ReceiptIndianRupee` stays, it's still used by the `bills` route).
- Add `import { ChecklistListPage } from "./features/app/checklist/ChecklistListPage";` — alphabetically (case-insensitive) among the `app/` imports, this sorts right after `./features/app/attendance/TodayPage` and before `./features/app/ComingSoonPage`.
- Replace the existing line `<Route path="checklist" element={<ComingSoonPage title="Checklist" icon={<ClipboardCheck size={22} />} heading="No tasks yet" text="Daily, weekly and monthly checklists are coming soon." />} />` with `<Route path="checklist" element={<ChecklistListPage />} />`.

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- ChecklistListPage`
Expected: PASS — both cases.

- [ ] **Step 11: Run the full web suite to check for regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/features/app/checklist apps/web/src/App.tsx
git commit -m "feat(web): checklist list page grouped by category"
```

---

### Task 5: Web — task form and detail/assignment page

**Files:**
- Create: `apps/web/src/features/app/checklist/ChecklistTaskFormPage.tsx`
- Test: `apps/web/src/features/app/checklist/ChecklistTaskFormPage.test.tsx`
- Create: `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.tsx`
- Test: `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: everything Task 4 produced, plus `useHousehelps` (`apps/web/src/features/app/househelps/useHousehelps.ts`), `Alert`/`TextField` (`apps/web/src/components/*`), `useFormErrors`/`zodFieldErrors` (`apps/web/src/features/auth/*`), `createChecklistTaskSchema`/`updateChecklistTaskSchema` (`@household/shared`).

- [ ] **Step 1: Write the failing component test for the form**

Create `apps/web/src/features/app/checklist/ChecklistTaskFormPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistTaskFormPage } from "./ChecklistTaskFormPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ChecklistTaskFormPage mode="create" /></MemoryRouter></QueryClientProvider>);
}

describe("ChecklistTaskFormPage — create mode", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("switching frequency to Weekly reveals the weekday picker, and submits the picked days", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/checklist-tasks")) return jsonResponse({ success: true, data: { id: "t1" }, message: null }, 201);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Water plants");
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "WEEKLY");
    await userEvent.click(screen.getByRole("button", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Wednesday" }));
    await userEvent.click(screen.getByRole("button", { name: /add task/i }));
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/checklist-tasks") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "Water plants", frequency: "WEEKLY", weekdays: [1, 3] });
  });

  it("rejects submitting a Monthly task with no day of month picked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Pay rent reminder");
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "MONTHLY");
    await userEvent.clear(screen.getByLabelText("Day of month"));
    await userEvent.click(screen.getByRole("button", { name: /add task/i }));
    expect(await screen.findByText(/give the day of the month/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- ChecklistTaskFormPage`
Expected: FAIL — `./ChecklistTaskFormPage` doesn't exist yet.

- [ ] **Step 3: Implement `ChecklistTaskFormPage.tsx`**

Create `apps/web/src/features/app/checklist/ChecklistTaskFormPage.tsx`:

```tsx
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { createChecklistTaskSchema, updateChecklistTaskSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories } from "../househelps/useHousehelps";
import { useChecklistTask, useCreateChecklistTask, useUpdateChecklistTask } from "./useChecklist";

const FREQUENCIES = [
  { value: "DAILY", label: "Every day" },
  { value: "WEEKDAYS", label: "Weekdays (Mon–Fri)" },
  { value: "WEEKLY", label: "Specific weekdays" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "SPECIFIC_DATE", label: "One-time, on a date" },
  { value: "CUSTOM", label: "Every N days" },
] as const;

const PRIORITIES = [{ value: "LOW", label: "Low" }, { value: "NORMAL", label: "Normal" }, { value: "HIGH", label: "High" }] as const;

const WEEKDAYS = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }, { value: 7, label: "Sunday" },
] as const;

export function ChecklistTaskFormPage({ mode }: { mode: "create" | "edit" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;
  const categoriesQuery = useCategories(householdId);
  const existing = useChecklistTask(householdId, mode === "edit" ? id : undefined);
  const createTask = useCreateChecklistTask(householdId ?? "");
  const updateTask = useUpdateChecklistTask(householdId ?? "");
  const errors = useFormErrors();

  const [form, setForm] = useState({
    name: "", description: "", categoryId: "", frequency: "DAILY" as (typeof FREQUENCIES)[number]["value"],
    dayOfMonth: "1", specificDate: "", intervalDays: "1", anchorDate: "", preferredTime: "",
    priority: "NORMAL" as (typeof PRIORITIES)[number]["value"],
  });
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [seeded, setSeeded] = useState(false);

  // Seed form state from the loaded task once — same pattern as HousehelpFormPage/ScheduleEditorPage:
  // the tracker starts at a constant, never at the query value, so a warm cache at mount still runs
  // the seeding block instead of rendering blank.
  if (mode === "edit" && existing.data && !seeded) {
    const t = existing.data;
    setSeeded(true);
    setForm({
      name: t.name, description: t.description ?? "", categoryId: t.categoryId ?? "", frequency: t.frequency,
      dayOfMonth: String(t.dayOfMonth ?? 1), specificDate: t.specificDate ?? "",
      intervalDays: String(t.intervalDays ?? 1), anchorDate: t.anchorDate ?? "", preferredTime: t.preferredTime ?? "",
      priority: t.priority,
    });
    setWeekdays(t.weekdays ?? []);
  }

  function set<K extends keyof typeof form>(key: K) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleWeekday(day: number) {
    setWeekdays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();

    const configByFrequency: Record<string, Record<string, unknown>> = {
      DAILY: {}, WEEKDAYS: {}, WEEKLY: { weekdays },
      MONTHLY: { dayOfMonth: form.dayOfMonth ? Number(form.dayOfMonth) : undefined },
      SPECIFIC_DATE: { specificDate: form.specificDate || undefined },
      CUSTOM: { intervalDays: form.intervalDays ? Number(form.intervalDays) : undefined, anchorDate: form.anchorDate || undefined },
    };

    const common = {
      name: form.name, description: form.description || undefined, categoryId: form.categoryId || undefined,
      frequency: form.frequency, preferredTime: form.preferredTime || undefined, priority: form.priority,
      ...configByFrequency[form.frequency],
    };

    if (mode === "create") {
      const parsed = createChecklistTaskSchema.safeParse(common);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      createTask.mutate(parsed.data, { onSuccess: (result) => navigate(`/checklist/${result.data.id}`, { replace: true }), onError: errors.fromError });
    } else {
      const body = { ...common, description: form.description.trim() ? form.description : null, categoryId: form.categoryId || null, preferredTime: form.preferredTime || null };
      const parsed = updateChecklistTaskSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      updateTask.mutate({ id: id!, body: parsed.data }, { onSuccess: () => navigate(`/checklist/${id}`, { replace: true }), onError: errors.fromError });
    }
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/checklist" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{mode === "create" ? "Add task" : "Edit task"}</h1></header>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />
        <TextField label="Description" value={form.description} onChange={set("description")} error={errors.fieldErrors.description} />

        <div className="field">
          <label className="field__label" htmlFor="frequency">Repeats</label>
          <select id="frequency" className="input" value={form.frequency} onChange={set("frequency")}>
            {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        {form.frequency === "WEEKLY" && (
          <div className="field">
            <span className="field__label">Which days</span>
            <div className="chips">
              {WEEKDAYS.map((d) => (
                <button key={d.value} type="button" className="chip" aria-pressed={weekdays.includes(d.value)} onClick={() => toggleWeekday(d.value)}>{d.label}</button>
              ))}
            </div>
            {errors.fieldErrors.weekdays && <p className="field__error">{errors.fieldErrors.weekdays}</p>}
          </div>
        )}
        {form.frequency === "MONTHLY" && (
          <TextField label="Day of month" hint="1-31" inputMode="numeric" value={form.dayOfMonth} onChange={set("dayOfMonth")} error={errors.fieldErrors.dayOfMonth} />
        )}
        {form.frequency === "SPECIFIC_DATE" && (
          <TextField label="Date" type="date" value={form.specificDate} onChange={set("specificDate")} error={errors.fieldErrors.specificDate} />
        )}
        {form.frequency === "CUSTOM" && (
          <>
            <TextField label="Repeat every N days" inputMode="numeric" value={form.intervalDays} onChange={set("intervalDays")} error={errors.fieldErrors.intervalDays} />
            <TextField label="Starting from" type="date" value={form.anchorDate} onChange={set("anchorDate")} error={errors.fieldErrors.anchorDate} />
          </>
        )}

        <TextField label="Preferred time" hint="24-hour, e.g. 09:00 (optional)" value={form.preferredTime} onChange={set("preferredTime")} error={errors.fieldErrors.preferredTime} />

        <div className="field">
          <label className="field__label" htmlFor="priority">Priority</label>
          <select id="priority" className="input" value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>

        {(categoriesQuery.data?.length ?? 0) > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="category">Category</label>
            <select id="category" className="input" value={form.categoryId} onChange={set("categoryId")}>
              <option value="">No category</option>
              {categoriesQuery.data!.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <Button type="submit" block loading={createTask.isPending || updateTask.isPending}>
          {mode === "create" ? "Add task" : "Save changes"}
        </Button>
      </form>
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- ChecklistTaskFormPage`
Expected: PASS — both cases.

- [ ] **Step 5: Write the failing component test for the detail/assignment page**

Create `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistTaskDetailPage } from "./ChecklistTaskDetailPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const TASK = { id: "t1", name: "Sweep floors", description: null, categoryId: null, frequency: "DAILY" as const, weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL" as const, sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
const SUNITA = { id: "hh1", name: "Sunita", phone: null, roleTitle: null, status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/checklist/t1"]}>
        <Routes><Route path="/checklist/:id" element={<ChecklistTaskDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChecklistTaskDetailPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("toggles a househelp and saves the assignment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/checklist-tasks/t1")) return jsonResponse({ success: true, data: TASK, message: null });
      if (url.endsWith("/checklist-tasks/t1/assignments") && (!init || init.method === undefined)) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "PUT" && url.endsWith("/assignments")) return jsonResponse({ success: true, data: ["hh1"], message: null });
      if (url.includes("/househelps")) return jsonResponse({ success: true, data: [SUNITA], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sweep floors");
    await userEvent.click(screen.getByRole("button", { name: "Sunita" }));
    await userEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/assignments") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ househelpIds: ["hh1"] });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- ChecklistTaskDetailPage`
Expected: FAIL — `./ChecklistTaskDetailPage` doesn't exist yet.

- [ ] **Step 7: Implement `ChecklistTaskDetailPage.tsx`**

Create `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelps } from "../househelps/useHousehelps";
import { formatFrequency } from "./frequency";
import { useArchiveChecklistTask, useChecklistAssignments, useChecklistTask, usePutChecklistAssignments, useUnarchiveChecklistTask } from "./useChecklist";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function ChecklistTaskDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const taskQuery = useChecklistTask(householdId, id);
  const househelpsQuery = useHousehelps(householdId, false);
  const assignmentsQuery = useChecklistAssignments(householdId, id);
  const archive = useArchiveChecklistTask(householdId ?? "");
  const unarchive = useUnarchiveChecklistTask(householdId ?? "");
  const putAssignments = usePutChecklistAssignments(householdId ?? "", id ?? "");
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);

  if (!householdId || !taskQuery.data) return null;
  const t = taskQuery.data;
  const currentIds = selected ?? assignmentsQuery.data ?? [];

  function toggle(hId: string) {
    setSelected(currentIds.includes(hId) ? currentIds.filter((x) => x !== hId) : [...currentIds, hId]);
  }

  function onSaveAssignments() {
    putAssignments.mutate({ househelpIds: currentIds }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  function onArchive() {
    if (!window.confirm(`Remove ${t.name}? Its history stays, but it'll drop off the main list.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">{t.name}</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}
      {t.archivedAt && <Alert tone="info" title="This task is archived." />}

      <div className="list">
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Repeats</span><span className="list__meta">{formatFrequency(t)}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Priority</span><span className="list__meta">{t.priority}</span></span></div>
        {t.description && <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Description</span><span className="list__meta">{t.description}</span></span></div>}
      </div>

      {(househelpsQuery.data?.length ?? 0) > 0 && (
        <div className="field" style={{ marginTop: "var(--space-6)" }}>
          <span className="field__label">Assigned to</span>
          <div className="chips">
            {househelpsQuery.data!.map((h) => (
              <button key={h.id} type="button" className="chip" aria-pressed={currentIds.includes(h.id)} disabled={!canManage} onClick={() => canManage && toggle(h.id)}>{h.name}</button>
            ))}
          </div>
          {canManage && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Button variant="secondary" loading={putAssignments.isPending} onClick={onSaveAssignments}>Save assignment</Button>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div style={{ marginTop: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <Button variant="secondary" block onClick={() => navigate(`/checklist/${id}/edit`)}>Edit details</Button>
          {t.archivedAt ? (
            <Button variant="secondary" block loading={unarchive.isPending} onClick={() => unarchive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Restore</Button>
          ) : (
            <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Remove task</Button>
          )}
        </div>
      )}
      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/checklist")}>Back to checklist</Button></div>
    </>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- ChecklistTaskDetailPage`
Expected: PASS.

- [ ] **Step 9: Wire the remaining routes**

In `apps/web/src/App.tsx`, add these imports (alphabetically among the `app/` imports, both sorting near the existing `ChecklistListPage` import added in Task 4):

```tsx
import { ChecklistTaskDetailPage } from "./features/app/checklist/ChecklistTaskDetailPage";
import { ChecklistTaskFormPage } from "./features/app/checklist/ChecklistTaskFormPage";
```

Add these routes next to the existing `checklist` route:

```tsx
        <Route path="checklist/new" element={<ChecklistTaskFormPage mode="create" />} />
        <Route path="checklist/:id" element={<ChecklistTaskDetailPage />} />
        <Route path="checklist/:id/edit" element={<ChecklistTaskFormPage mode="edit" />} />
```

- [ ] **Step 10: Run the full web suite to check for regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS.

- [ ] **Step 11: Run the full monorepo build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both PASS across `shared`, `api`, `web`.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/features/app/checklist apps/web/src/App.tsx
git commit -m "feat(web): checklist task form and detail/assignment page"
```
