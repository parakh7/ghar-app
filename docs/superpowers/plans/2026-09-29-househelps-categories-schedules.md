# Househelps, Categories, Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full CRUD for househelp categories (with up/down reordering), full CRUD for househelps (with status/archive and category tagging), and versioned schedule management — replacing the "Coming soon" placeholder at `/househelps` with a working feature.

**Architecture:** Three new API service files (`category.service.ts`, `househelp.service.ts`, `schedule.service.ts`), each mirroring the existing `household.service.ts`/`member.service.ts` style (plain functions taking `Deps`/`DbOrTx`). Routes are appended to the existing `household.routes.ts`, matching that file's own comment ("househelps, attendance, bills, … are mounted here in later phases"). The web side gets one new feature folder (`features/app/househelps/`) with a single growing hooks file (mirroring `members/useMembers.ts`) and four pages (list, form, detail, schedule editor), plus a categories page.

**Tech Stack:** Express 5, Drizzle ORM, zod 4, Vitest + Supertest (API, real Postgres), React 19 + TanStack Query + React Router 7, Vitest + Testing Library (web).

## Global Constraints

- TypeScript strict mode, `noUncheckedIndexedAccess` — non-null assertions only where a prior check or `.returning()` guarantees the row exists.
- Business logic lives in `apps/api/src/services/*`; routes only parse input, call a service, and respond.
- Every household-scoped route goes through `requireHousehold(deps, permission)`; downstream code uses `req.membership.householdId`, never the raw URL param. Non-members get 404, not 403.
- Every audit-logged mutation writes its `audit_logs` row inside the same transaction as the change, via `recordAudit(tx, entry)`.
- Money is always an integer number of paise (`packages/shared/src/money.ts`) — never floats. The web form collects rupees and converts with `rupeesToPaise`/formats with `formatINR` at the UI boundary only.
- Calendar dates are `"YYYY-MM-DD"` strings in the household's timezone (`packages/shared/src/time.ts`'s `dateInZone`/`addDays`) — never derived from server-local time.
- No hard deletes for this data: categories use `deletedAt`, househelps use `archivedAt`. Both are one-way-by-default (categories have no "restore" UI — a new category with the same name can just be created — but that name's uniqueness constraint already excludes soft-deleted rows) except househelps, which get an explicit unarchive action.
- No new `ErrorCode` values — this feature only needs `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN` (all already exist).
- API integration tests run against a real Postgres (`TEST_DATABASE_URL`), following the exact pattern in `apps/api/tests/members.test.ts` (same helpers: `createTestContext`, `signupUser`, `csrf`, `truncateAll`, `FakeClock`).
- Web component tests follow `apps/web/src/features/app/members/MembersPage.test.tsx`'s pattern: mock `globalThis.fetch`, wrap in `QueryClientProvider` + `MemoryRouter`.
- Spec: `docs/superpowers/specs/2026-09-29-househelps-categories-schedules-design.md`.

---

### Task 1: Shared schemas and DTOs

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/dto.ts`

**Interfaces:**
- Produces: `createCategorySchema`, `updateCategorySchema`, `moveCategorySchema`, `createHousehelpSchema`, `updateHousehelpSchema`, `updateScheduleSchema` (zod schemas) and `CreateCategoryInput`, `UpdateCategoryInput`, `MoveCategoryInput`, `CreateHousehelpInput`, `UpdateHousehelpInput`, `UpdateScheduleInput` (inferred types) from `schemas.ts`; `CategoryDTO`, `HousehelpDTO`, `ScheduleDTO` (types) from `dto.ts`. All re-exported via the existing `packages/shared/src/index.ts` barrel — no change needed there.

- [ ] **Step 1: Add the schemas to `schemas.ts`**

Add at the end of `packages/shared/src/schemas.ts`:

```ts
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use 24-hour HH:MM");
const paiseSchema = z.number().int().nonnegative();
const salaryModeSchema = z.enum(["FIXED_MONTHLY", "ATTENDANCE_BASED", "DAILY_RATE"]);

export const createCategorySchema = z.object({ name: z.string().trim().min(1, "Give the category a name").max(60) });
export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(60).optional(),
  isActive: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.isActive !== undefined, { message: "Provide a name or active state to update." });
export const moveCategorySchema = z.object({ direction: z.enum(["up", "down"]) });

export const createHousehelpSchema = z.object({
  name: z.string().trim().min(1, "Give the househelp a name").max(80),
  phone: z.string().trim().max(20).optional(),
  roleTitle: z.string().trim().max(60).optional(),
  salaryMode: salaryModeSchema.default("FIXED_MONTHLY"),
  monthlySalaryPaise: paiseSchema.optional(),
  dailyRatePaise: paiseSchema.optional(),
  halfDayRatePaise: paiseSchema.optional(),
  salaryDueDay: z.number().int().min(1).max(31).default(1),
  startDate: dateSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  categoryIds: z.array(z.string().uuid()).default([]),
});

export const updateHousehelpSchema = z.object({
  name: z.string().trim().min(1, "Give the househelp a name").max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  roleTitle: z.string().trim().max(60).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  salaryMode: salaryModeSchema.optional(),
  monthlySalaryPaise: paiseSchema.optional(),
  dailyRatePaise: paiseSchema.optional(),
  halfDayRatePaise: paiseSchema.optional(),
  salaryDueDay: z.number().int().min(1).max(31).optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Provide at least one field to update." });

export const updateScheduleSchema = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day")
    .refine((arr) => new Set(arr).size === arr.length, "No duplicate days"),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type MoveCategoryInput = z.infer<typeof moveCategorySchema>;
export type CreateHousehelpInput = z.input<typeof createHousehelpSchema>;
export type UpdateHousehelpInput = z.infer<typeof updateHousehelpSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
```

`CreateHousehelpInput` uses `z.input` (not `z.infer`) because the schema has `.default(...)` fields (`salaryMode`, `salaryDueDay`, `categoryIds`) — `z.input` keeps them optional for callers (the web form and tests don't have to pass them explicitly), matching the existing `CreateHouseholdInput` convention already in this file.

- [ ] **Step 2: Add the DTOs to `dto.ts`**

Add at the end of `packages/shared/src/dto.ts`:

```ts
export type CategoryDTO = { id: string; name: string; sortOrder: number; isActive: boolean };

export type HousehelpDTO = {
  id: string; name: string; phone: string | null; roleTitle: string | null;
  status: "ACTIVE" | "INACTIVE"; startDate: string | null; endDate: string | null;
  salaryMode: "FIXED_MONTHLY" | "ATTENDANCE_BASED" | "DAILY_RATE";
  monthlySalaryPaise: number | null; dailyRatePaise: number | null; halfDayRatePaise: number | null;
  salaryDueDay: number; notes: string | null; archivedAt: string | null;
  categoryIds: string[]; createdAt: string;
};

export type ScheduleDTO = { id: string; weekdays: number[]; startTime: string | null; endTime: string | null; effectiveFrom: string };
```

- [ ] **Step 3: Build and typecheck the shared package**

Run: `npm run build -w @household/shared && npm run typecheck -w @household/shared`
Expected: both succeed with no errors (no dedicated test file for `schemas.ts`/`dto.ts` additions, matching the existing convention — build + typecheck is the verification here).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/dto.ts
git commit -m "feat(shared): add category, househelp, and schedule schemas/DTOs"
```

---

### Task 2: Categories — API

**Files:**
- Create: `apps/api/src/services/category.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Create: `apps/api/tests/househelps.test.ts` (new file — this task writes the "categories" describe block; Tasks 3 and 4 append to the same file)

**Interfaces:**
- Consumes: `Deps`/`DbOrTx`, `Errors`, `recordAudit`, `requireHousehold`, `parseBody`, `ok`, `CategoryDTO`/`CreateCategoryInput`/`UpdateCategoryInput`/`MoveCategoryInput` (`@household/shared`), `househelpCategories` table (`apps/api/src/db/schema.ts`).
- Produces: `listCategories(db, householdId): Promise<CategoryDTO[]>`, `createCategory(deps, actorUserId, householdId, input, ip?): Promise<CategoryDTO>`, `updateCategory(deps, actorUserId, householdId, categoryId, patch, ip?): Promise<CategoryDTO>`, `softDeleteCategory(deps, actorUserId, householdId, categoryId, ip?): Promise<void>`, `moveCategory(deps, actorUserId, householdId, categoryId, direction, ip?): Promise<void>` — all from `category.service.ts`.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/tests/househelps.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: FAIL — `/api/households/:id/categories` routes don't exist yet.

- [ ] **Step 3: Implement `category.service.ts`**

Create `apps/api/src/services/category.service.ts`:

```ts
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { CategoryDTO } from "@household/shared";
import { househelpCategories } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function toCategoryDTO(row: { id: string; name: string; sortOrder: number; isActive: boolean }): CategoryDTO {
  return { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive };
}

export async function listCategories(db: DbOrTx, householdId: string): Promise<CategoryDTO[]> {
  const rows = await db.select({ id: househelpCategories.id, name: househelpCategories.name, sortOrder: househelpCategories.sortOrder, isActive: househelpCategories.isActive })
    .from(househelpCategories)
    .where(and(eq(househelpCategories.householdId, householdId), isNull(househelpCategories.deletedAt)))
    .orderBy(asc(househelpCategories.sortOrder));
  return rows.map(toCategoryDTO);
}

export async function createCategory(deps: Deps, actorUserId: string, householdId: string, input: { name: string }, ip?: string): Promise<CategoryDTO> {
  try {
    const category = await deps.db.transaction(async (tx) => {
      const [{ maxSort } = { maxSort: -1 }] = await tx
        .select({ maxSort: sql<number>`coalesce(max(${househelpCategories.sortOrder}), -1)` })
        .from(househelpCategories)
        .where(eq(househelpCategories.householdId, householdId));
      const [row] = await tx.insert(househelpCategories).values({ householdId, name: input.name, sortOrder: Number(maxSort) + 1 }).returning();
      await recordAudit(tx, { householdId, actorUserId, action: "category.created", entityType: "househelp_category", entityId: row!.id, newValue: { name: input.name }, ipAddress: ip ?? null });
      return row!;
    });
    return toCategoryDTO(category);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function updateCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, patch: { name?: string; isActive?: boolean }, ip?: string): Promise<CategoryDTO> {
  const changes: Partial<{ name: string; isActive: boolean }> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.isActive !== undefined) changes.isActive = patch.isActive;
  try {
    const updated = await deps.db.transaction(async (tx) => {
      const [before] = await tx.select({ name: househelpCategories.name, isActive: househelpCategories.isActive })
        .from(househelpCategories)
        .where(and(eq(househelpCategories.householdId, householdId), eq(househelpCategories.id, categoryId), isNull(househelpCategories.deletedAt)))
        .for("update");
      if (!before) throw Errors.notFound("Category");
      await tx.update(househelpCategories).set(changes).where(eq(househelpCategories.id, categoryId));
      await recordAudit(tx, { householdId, actorUserId, action: "category.updated", entityType: "househelp_category", entityId: categoryId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
      const [row] = await tx.select({ id: househelpCategories.id, name: househelpCategories.name, sortOrder: househelpCategories.sortOrder, isActive: househelpCategories.isActive })
        .from(househelpCategories).where(eq(househelpCategories.id, categoryId));
      return row!;
    });
    return toCategoryDTO(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function softDeleteCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelpCategories).set({ deletedAt: deps.clock.now() })
      .where(and(eq(househelpCategories.householdId, householdId), eq(househelpCategories.id, categoryId), isNull(househelpCategories.deletedAt)))
      .returning({ id: househelpCategories.id });
    if (!row) throw Errors.notFound("Category");
    await recordAudit(tx, { householdId, actorUserId, action: "category.deleted", entityType: "househelp_category", entityId: categoryId, ipAddress: ip ?? null });
  });
}

export async function moveCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, direction: "up" | "down", ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx.select({ id: househelpCategories.id, sortOrder: househelpCategories.sortOrder })
      .from(househelpCategories)
      .where(and(eq(househelpCategories.householdId, householdId), isNull(househelpCategories.deletedAt)))
      .orderBy(asc(househelpCategories.sortOrder))
      .for("update");
    const index = rows.findIndex((r) => r.id === categoryId);
    if (index === -1) throw Errors.notFound("Category");
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= rows.length) return; // already at the edge — no-op
    const a = rows[index]!;
    const b = rows[swapIndex]!;
    await tx.update(househelpCategories).set({ sortOrder: b.sortOrder }).where(eq(househelpCategories.id, a.id));
    await tx.update(househelpCategories).set({ sortOrder: a.sortOrder }).where(eq(househelpCategories.id, b.id));
    await recordAudit(tx, { householdId, actorUserId, action: "category.moved", entityType: "househelp_category", entityId: categoryId, newValue: { direction }, ipAddress: ip ?? null });
  });
}
```

- [ ] **Step 4: Add the category routes to `household.routes.ts`**

Add `createCategorySchema, moveCategorySchema, updateCategorySchema` to the existing `@household/shared` import line (it currently reads `createHouseholdSchema, inviteMemberSchema, updateHouseholdSchema, updateMemberSchema` — add the three new names, keeping alphabetical order: `createCategorySchema, createHouseholdSchema, inviteMemberSchema, moveCategorySchema, updateCategorySchema, updateHouseholdSchema, updateMemberSchema`).

Add this import alongside the existing `* as members` import:

```ts
import * as categories from "../services/category.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/categories", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await categories.listCategories(deps.db, req.membership!.householdId));
  });

  r.post("/:householdId/categories", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const input = parseBody(req, createCategorySchema);
    ok(res, await categories.createCategory(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Category added.");
  });

  r.patch("/:householdId/categories/:categoryId", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const patch = parseBody(req, updateCategorySchema);
    ok(res, await categories.updateCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, patch, req.ip), 200, "Category updated.");
  });

  r.delete("/:householdId/categories/:categoryId", requireHousehold(deps, "categories.manage"), async (req, res) => {
    await categories.softDeleteCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, req.ip);
    ok(res, null, 200, "Category removed.");
  });

  r.post("/:householdId/categories/:categoryId/move", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const { direction } = parseBody(req, moveCategorySchema);
    await categories.moveCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, direction, req.ip);
    ok(res, null, 200, "Category moved.");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: PASS — all 10 cases in the "categories" describe block.

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/category.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/househelps.test.ts
git commit -m "feat(api): category CRUD and reordering"
```

---

### Task 3: Househelps — API

**Files:**
- Create: `apps/api/src/services/househelp.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `apps/api/tests/househelps.test.ts` (append the "househelps" describe block)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `CreateHousehelpInput`/`UpdateHousehelpInput`/`HousehelpDTO` (`@household/shared`), `househelps`/`househelpCategoryLinks` tables (`apps/api/src/db/schema.ts`).
- Produces: `listHousehelps(db, householdId, includeArchived?): Promise<HousehelpDTO[]>`, `getHousehelp(db, householdId, id): Promise<HousehelpDTO>`, `createHousehelp(deps, actorUserId, householdId, input, ip?): Promise<HousehelpDTO>`, `updateHousehelp(deps, actorUserId, householdId, id, patch, ip?): Promise<HousehelpDTO>`, `archiveHousehelp(deps, actorUserId, householdId, id, ip?): Promise<void>`, `unarchiveHousehelp(deps, actorUserId, householdId, id, ip?): Promise<void>` — all from `househelp.service.ts`.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/tests/househelps.test.ts` (same file as Task 2). Extend the schema import line — it currently reads `auditLogs, householdMembers, househelpCategories` — to `auditLogs, householdMembers, househelpCategories, househelpCategoryLinks, househelps`:

```ts
describe("househelps", () => {
  it("creates a househelp with defaults applied", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Sunita", status: "ACTIVE", salaryMode: "FIXED_MONTHLY", salaryDueDay: 1, categoryIds: [] });
  });

  it("creates a househelp with category links", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const cats = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    const [cleaning, cooking] = cats.body.data;
    const res = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Sunita", categoryIds: [cleaning.id, cooking.id] });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryIds.sort()).toEqual([cleaning.id, cooking.id].sort());
  });

  it("stores money fields as integer paise", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Ramesh", salaryMode: "DAILY_RATE", dailyRatePaise: 80000, halfDayRatePaise: 40000 });
    expect(res.status).toBe(201);
    expect(res.body.data.dailyRatePaise).toBe(80000);
    expect(res.body.data.halfDayRatePaise).toBe(40000);
  });

  it("lists active househelps by default and includes archived on request", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    await ctx.request.post(`/api/households/${h.id}/househelps/${create.body.data.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const defaultList = await ctx.request.get(`/api/households/${h.id}/househelps`).set("cookie", owner.cookie);
    expect(defaultList.body.data).toHaveLength(0);
    const withArchived = await ctx.request.get(`/api/households/${h.id}/househelps?includeArchived=true`).set("cookie", owner.cookie);
    expect(withArchived.body.data).toHaveLength(1);
  });

  it("updates fields and fully replaces category links", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const cats = await ctx.request.get(`/api/households/${h.id}/categories`).set("cookie", owner.cookie);
    const [cleaning, cooking, utensils] = cats.body.data;
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Sunita", categoryIds: [cleaning.id, cooking.id] });
    const res = await ctx.request.patch(`/api/households/${h.id}/househelps/${create.body.data.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Sunita Devi", categoryIds: [utensils.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Sunita Devi");
    expect(res.body.data.categoryIds).toEqual([utensils.id]);
    const links = await ctx.db.select().from(househelpCategoryLinks).where(eq(househelpCategoryLinks.househelpId, create.body.data.id));
    expect(links).toHaveLength(1);
  });

  it("rejects an update with no fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const res = await ctx.request.patch(`/api/households/${h.id}/househelps/${create.body.data.id}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(res.status).toBe(400);
  });

  it("archives and unarchives a househelp, and both are audited", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const id = create.body.data.id;
    const archive = await ctx.request.post(`/api/households/${h.id}/househelps/${id}/archive`).set(csrf).set("cookie", owner.cookie);
    expect(archive.status).toBe(200);
    const [row] = await ctx.db.select().from(househelps).where(eq(househelps.id, id));
    expect(row!.archivedAt).not.toBeNull();
    const unarchive = await ctx.request.post(`/api/households/${h.id}/househelps/${id}/unarchive`).set(csrf).set("cookie", owner.cookie);
    expect(unarchive.status).toBe(200);
    const [row2] = await ctx.db.select().from(househelps).where(eq(househelps.id, id));
    expect(row2!.archivedAt).toBeNull();
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.entityId, id)));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["househelp.created", "househelp.archived", "househelp.unarchived"]));
  });

  it("an archived househelp is still fetchable by id", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    await ctx.request.post(`/api/households/${h.id}/househelps/${create.body.data.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${create.body.data.id}`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
  });

  it("MEMBER can view but not manage househelps", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    expect((await ctx.request.get(`/api/households/${h.id}/househelps`).set("cookie", member.cookie)).status).toBe(200);
    const res = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", member.cookie).send({ name: "X" });
    expect(res.status).toBe(403);
  });

  it("a member of household A cannot manage househelps of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/househelps`).set(csrf).set("cookie", alice.cookie).send({ name: "X" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: FAIL — all cases in the new "househelps" block (routes don't exist).

- [ ] **Step 3: Implement `househelp.service.ts`**

Create `apps/api/src/services/househelp.service.ts`:

```ts
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { CreateHousehelpInput, HousehelpDTO, UpdateHousehelpInput } from "@household/shared";
import { househelpCategoryLinks, househelps } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

type HousehelpRow = typeof househelps.$inferSelect;

function toHousehelpDTO(row: HousehelpRow, categoryIds: string[]): HousehelpDTO {
  return {
    id: row.id, name: row.name, phone: row.phone, roleTitle: row.roleTitle,
    status: row.status, startDate: row.startDate, endDate: row.endDate, salaryMode: row.salaryMode,
    monthlySalaryPaise: row.monthlySalaryPaise, dailyRatePaise: row.dailyRatePaise, halfDayRatePaise: row.halfDayRatePaise,
    salaryDueDay: row.salaryDueDay, notes: row.notes, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    categoryIds, createdAt: row.createdAt.toISOString(),
  };
}

async function categoryIdsFor(db: DbOrTx, householdId: string, househelpId: string): Promise<string[]> {
  const rows = await db.select({ categoryId: househelpCategoryLinks.categoryId }).from(househelpCategoryLinks)
    .where(and(eq(househelpCategoryLinks.householdId, householdId), eq(househelpCategoryLinks.househelpId, househelpId)));
  return rows.map((r) => r.categoryId);
}

export async function listHousehelps(db: DbOrTx, householdId: string, includeArchived = false): Promise<HousehelpDTO[]> {
  const rows = await db.select().from(househelps)
    .where(includeArchived ? eq(househelps.householdId, householdId) : and(eq(househelps.householdId, householdId), isNull(househelps.archivedAt)))
    .orderBy(asc(househelps.name));
  if (rows.length === 0) return [];
  const links = await db.select({ househelpId: househelpCategoryLinks.househelpId, categoryId: househelpCategoryLinks.categoryId })
    .from(househelpCategoryLinks)
    .where(and(eq(househelpCategoryLinks.householdId, householdId), inArray(househelpCategoryLinks.househelpId, rows.map((r) => r.id))));
  const byHousehelp = new Map<string, string[]>();
  for (const l of links) byHousehelp.set(l.househelpId, [...(byHousehelp.get(l.househelpId) ?? []), l.categoryId]);
  return rows.map((r) => toHousehelpDTO(r, byHousehelp.get(r.id) ?? []));
}

export async function getHousehelp(db: DbOrTx, householdId: string, id: string): Promise<HousehelpDTO> {
  const [row] = await db.select().from(househelps).where(and(eq(househelps.householdId, householdId), eq(househelps.id, id))).limit(1);
  if (!row) throw Errors.notFound("Househelp");
  return toHousehelpDTO(row, await categoryIdsFor(db, householdId, id));
}

export async function createHousehelp(deps: Deps, actorUserId: string, householdId: string, input: CreateHousehelpInput, ip?: string): Promise<HousehelpDTO> {
  const { categoryIds = [], ...fields } = input;
  const row = await deps.db.transaction(async (tx) => {
    const [inserted] = await tx.insert(househelps).values({ householdId, ...fields }).returning();
    if (categoryIds.length > 0) {
      await tx.insert(househelpCategoryLinks).values(categoryIds.map((categoryId) => ({ householdId, househelpId: inserted!.id, categoryId })));
    }
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.created", entityType: "househelp", entityId: inserted!.id, newValue: { name: fields.name }, ipAddress: ip ?? null });
    return inserted!;
  });
  return toHousehelpDTO(row, categoryIds);
}

export async function updateHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, patch: UpdateHousehelpInput, ip?: string): Promise<HousehelpDTO> {
  const { categoryIds, ...fields } = patch;
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(househelps).where(and(eq(househelps.householdId, householdId), eq(househelps.id, id))).for("update");
    if (!before) throw Errors.notFound("Househelp");
    const changes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length > 0) await tx.update(househelps).set(changes).where(eq(househelps.id, id));
    if (categoryIds !== undefined) {
      await tx.delete(househelpCategoryLinks).where(and(eq(househelpCategoryLinks.householdId, householdId), eq(househelpCategoryLinks.househelpId, id)));
      if (categoryIds.length > 0) await tx.insert(househelpCategoryLinks).values(categoryIds.map((categoryId) => ({ householdId, househelpId: id, categoryId })));
    }
    await recordAudit(tx, {
      householdId, actorUserId, action: "househelp.updated", entityType: "househelp", entityId: id,
      oldValue: before, newValue: { ...changes, ...(categoryIds !== undefined ? { categoryIds } : {}) }, ipAddress: ip ?? null,
    });
    const [after] = await tx.select().from(househelps).where(eq(househelps.id, id));
    return after!;
  });
  const finalCategoryIds = categoryIds !== undefined ? categoryIds : await categoryIdsFor(deps.db, householdId, id);
  return toHousehelpDTO(row, finalCategoryIds);
}

export async function archiveHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelps).set({ archivedAt: deps.clock.now() })
      .where(and(eq(househelps.householdId, householdId), eq(househelps.id, id), isNull(househelps.archivedAt)))
      .returning({ id: househelps.id });
    if (!row) throw Errors.notFound("Househelp");
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.archived", entityType: "househelp", entityId: id, ipAddress: ip ?? null });
  });
}

export async function unarchiveHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelps).set({ archivedAt: null })
      .where(and(eq(househelps.householdId, householdId), eq(househelps.id, id)))
      .returning({ id: househelps.id });
    if (!row) throw Errors.notFound("Househelp");
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.unarchived", entityType: "househelp", entityId: id, ipAddress: ip ?? null });
  });
}
```

- [ ] **Step 4: Add the househelp routes to `household.routes.ts`**

Add `createHousehelpSchema, updateHousehelpSchema` to the shared import line (keep alphabetical), and add:

```ts
import * as househelps from "../services/househelp.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/househelps", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await househelps.listHousehelps(deps.db, req.membership!.householdId, req.query.includeArchived === "true"));
  });

  r.post("/:householdId/househelps", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const input = parseBody(req, createHousehelpSchema);
    ok(res, await househelps.createHousehelp(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Househelp added.");
  });

  r.get("/:householdId/househelps/:id", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await househelps.getHousehelp(deps.db, req.membership!.householdId, req.params.id as string));
  });

  r.patch("/:householdId/househelps/:id", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const patch = parseBody(req, updateHousehelpSchema);
    ok(res, await househelps.updateHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, patch, req.ip), 200, "Househelp updated.");
  });

  r.post("/:householdId/househelps/:id/archive", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    await househelps.archiveHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Househelp removed.");
  });

  r.post("/:householdId/househelps/:id/unarchive", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    await househelps.unarchiveHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Househelp restored.");
  });
```

Note: the route file's local variable `households` (the service module for `/api/households` itself) and the new `househelps` import are visually similar but are two different names/modules — do not confuse them or merge their imports.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: PASS — all cases in both describe blocks (Task 2's + Task 3's).

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/househelp.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/househelps.test.ts
git commit -m "feat(api): househelp CRUD with status, archive, and category tagging"
```

---

### Task 4: Schedules — API

**Files:**
- Create: `apps/api/src/services/schedule.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `apps/api/tests/househelps.test.ts` (append the "schedules" describe block)

**Interfaces:**
- Consumes: everything Tasks 2-3 produced, plus `dateInZone`/`addDays` (`@household/shared`), `Membership` type (`apps/api/src/services/household.service.ts`), `attendanceSchedules` table (`apps/api/src/db/schema.ts`).
- Produces: `getCurrentSchedule(deps, membership, househelpId): Promise<ScheduleDTO | null>`, `putSchedule(deps, actorUserId, membership, househelpId, input, ip?): Promise<ScheduleDTO>` — from `schedule.service.ts`.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/tests/househelps.test.ts`. Extend the schema import line to also include `attendanceSchedules`, and the helpers import line to include `DAY`:

```ts
describe("schedules", () => {
  it("returns null when no schedule has been set", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${create.body.data.id}/schedule`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("creates the first schedule version starting today", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const id = create.body.data.id;
    const res = await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", owner.cookie)
      .send({ weekdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "13:00" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ weekdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "13:00", effectiveFrom: "2026-09-29" });
    const get = await ctx.request.get(`/api/households/${h.id}/househelps/${id}/schedule`).set("cookie", owner.cookie);
    expect(get.body.data.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("editing a schedule creates a new version and preserves the old one's history", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const id = create.body.data.id;
    await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    ctx.clock.advance(3 * DAY);
    const res = await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [6] });
    expect(res.status).toBe(200);
    expect(res.body.data.weekdays).toEqual([6]);
    const allVersions = await ctx.db.select().from(attendanceSchedules).where(eq(attendanceSchedules.househelpId, id));
    expect(allVersions).toHaveLength(2);
    const old = allVersions.find((v) => v.weekdays.length === 5)!;
    expect(old.effectiveTo).not.toBeNull();
    const current = await ctx.request.get(`/api/households/${h.id}/househelps/${id}/schedule`).set("cookie", owner.cookie);
    expect(current.body.data.weekdays).toEqual([6]);
  });

  it("rejects an empty or duplicate weekday list", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const id = create.body.data.id;
    expect((await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [] })).status).toBe(400);
    expect((await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 1] })).status).toBe(400);
  });

  it("MEMBER can view but not set a schedule", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const create = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    const id = create.body.data.id;
    expect((await ctx.request.get(`/api/households/${h.id}/househelps/${id}/schedule`).set("cookie", member.cookie)).status).toBe(200);
    expect((await ctx.request.put(`/api/households/${h.id}/househelps/${id}/schedule`).set(csrf).set("cookie", member.cookie).send({ weekdays: [1] })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: FAIL on every case in the new "schedules" block.

- [ ] **Step 3: Implement `schedule.service.ts`**

Create `apps/api/src/services/schedule.service.ts`:

```ts
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { ScheduleDTO, UpdateScheduleInput } from "@household/shared";
import { addDays, dateInZone } from "@household/shared";
import { attendanceSchedules } from "../db/schema.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

function toScheduleDTO(row: { id: string; weekdays: number[]; startTime: string | null; endTime: string | null; effectiveFrom: string }): ScheduleDTO {
  return { id: row.id, weekdays: row.weekdays, startTime: row.startTime, endTime: row.endTime, effectiveFrom: row.effectiveFrom };
}

function currentlyEffective(householdId: string, househelpId: string, today: string) {
  return and(
    eq(attendanceSchedules.householdId, householdId),
    eq(attendanceSchedules.househelpId, househelpId),
    lte(attendanceSchedules.effectiveFrom, today),
    or(isNull(attendanceSchedules.effectiveTo), gte(attendanceSchedules.effectiveTo, today)),
  );
}

export async function getCurrentSchedule(deps: Deps, membership: Membership, househelpId: string): Promise<ScheduleDTO | null> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const [row] = await deps.db.select().from(attendanceSchedules)
    .where(currentlyEffective(membership.householdId, househelpId, today))
    .orderBy(desc(attendanceSchedules.effectiveFrom))
    .limit(1);
  return row ? toScheduleDTO(row) : null;
}

export async function putSchedule(deps: Deps, actorUserId: string, membership: Membership, househelpId: string, input: UpdateScheduleInput, ip?: string): Promise<ScheduleDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const yesterday = addDays(today, -1);
  const row = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select({ id: attendanceSchedules.id }).from(attendanceSchedules)
      .where(currentlyEffective(membership.householdId, househelpId, today))
      .for("update");
    if (current) {
      await tx.update(attendanceSchedules).set({ effectiveTo: yesterday }).where(eq(attendanceSchedules.id, current.id));
    }
    const [inserted] = await tx.insert(attendanceSchedules).values({
      householdId: membership.householdId, househelpId, weekdays: input.weekdays,
      startTime: input.startTime ?? null, endTime: input.endTime ?? null, effectiveFrom: today,
    }).returning();
    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "schedule.updated", entityType: "attendance_schedule", entityId: inserted!.id,
      newValue: { weekdays: input.weekdays, startTime: input.startTime ?? null, endTime: input.endTime ?? null }, ipAddress: ip ?? null,
    });
    return inserted!;
  });
  return toScheduleDTO(row);
}
```

- [ ] **Step 4: Add the schedule routes to `household.routes.ts`**

Add `updateScheduleSchema` to the shared import line, and add:

```ts
import * as schedules from "../services/schedule.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/househelps/:id/schedule", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await schedules.getCurrentSchedule(deps, req.membership!, req.params.id as string));
  });

  r.put("/:householdId/househelps/:id/schedule", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const input = parseBody(req, updateScheduleSchema);
    ok(res, await schedules.putSchedule(deps, req.auth!.user.id, req.membership!, req.params.id as string, input, req.ip), 200, "Schedule updated.");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- househelps.test.ts`
Expected: PASS — all cases across all three describe blocks.

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/schedule.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/househelps.test.ts
git commit -m "feat(api): versioned schedule management"
```

---

### Task 5: Web — categories page

**Files:**
- Create: `apps/web/src/features/app/househelps/useHousehelps.ts`
- Create: `apps/web/src/features/app/househelps/CategoriesPage.tsx`
- Test: `apps/web/src/features/app/househelps/CategoriesPage.test.tsx`

**Interfaces:**
- Consumes: `get`/`post`/`patch`/`del` (`apps/web/src/lib/api.ts`), `ApiError` (same file), `CategoryDTO`/`CreateCategoryInput`/`createCategorySchema` (`@household/shared`), `Alert`/`Button`/`TextField` (`apps/web/src/components/*`), `useHousehold` (`apps/web/src/features/app/members/useMembers.ts` — reused across features, not duplicated), `useFormErrors`/`zodFieldErrors` (`apps/web/src/features/auth/*`).
- Produces: `useCategories`, `useCreateCategory`, `useUpdateCategory`, `useDeleteCategory`, `useMoveCategory` (`useHousehelps.ts`) — Task 6 appends more hooks to this same file.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/househelps/CategoriesPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { CategoriesPage } from "./CategoriesPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><CategoriesPage /></MemoryRouter></QueryClientProvider>);
}

describe("CategoriesPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists categories and posts a new one from the add form", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.view", "categories.manage"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/categories")) return jsonResponse({ success: true, data: { id: "c2", name: "Pet care", sortOrder: 1, isActive: true }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Cleaning")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Category name"), "Pet care");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const postCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ name: "Pet care" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- CategoriesPage.test.tsx`
Expected: FAIL — `./CategoriesPage` doesn't exist yet.

- [ ] **Step 3: Create `useHousehelps.ts`**

Create `apps/web/src/features/app/househelps/useHousehelps.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryDTO, CreateCategoryInput, MoveCategoryInput, UpdateCategoryInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";

export function useCategories(householdId: string | undefined) {
  return useQuery({
    queryKey: ["categories", householdId],
    queryFn: ({ signal }) => get<CategoryDTO[]>(`/households/${householdId}/categories`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useCreateCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCategoryInput) => post<CategoryDTO>(`/households/${householdId}/categories`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useUpdateCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: string; body: UpdateCategoryInput }) => patch<CategoryDTO>(`/households/${householdId}/categories/${categoryId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useDeleteCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => del<null>(`/households/${householdId}/categories/${categoryId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useMoveCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, direction }: { categoryId: string; direction: MoveCategoryInput["direction"] }) =>
      post<null>(`/households/${householdId}/categories/${categoryId}/move`, { direction }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}
```

- [ ] **Step 4: Create `CategoriesPage.tsx`**

Create `apps/web/src/features/app/househelps/CategoriesPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { createCategorySchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories, useCreateCategory, useDeleteCategory, useMoveCategory, useUpdateCategory } from "./useHousehelps";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function CategoriesPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const categoriesQuery = useCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("categories.manage") ?? false;

  const createCategory = useCreateCategory(householdId ?? "");
  const updateCategory = useUpdateCategory(householdId ?? "");
  const deleteCategory = useDeleteCategory(householdId ?? "");
  const moveCategory = useMoveCategory(householdId ?? "");

  const [name, setName] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const errors = useFormErrors();

  function onAdd(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = createCategorySchema.safeParse({ name });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    createCategory.mutate(parsed.data, { onSuccess: () => setName(""), onError: errors.fromError });
  }

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Categories</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <div className="list">
        {categoriesQuery.data?.map((c, i) => (
          <div key={c.id} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{c.name}</span>
              {!c.isActive && <span className="list__meta">Inactive</span>}
            </span>
            {canManage && (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <Button
                  variant="ghost" icon={<ArrowUp size={18} aria-hidden />} aria-label={`Move ${c.name} up`}
                  disabled={i === 0}
                  onClick={() => moveCategory.mutate({ categoryId: c.id, direction: "up" }, { onError: (err) => setPageError(messageFrom(err)) })}
                />
                <Button
                  variant="ghost" icon={<ArrowDown size={18} aria-hidden />} aria-label={`Move ${c.name} down`}
                  disabled={i === (categoriesQuery.data?.length ?? 1) - 1}
                  onClick={() => moveCategory.mutate({ categoryId: c.id, direction: "down" }, { onError: (err) => setPageError(messageFrom(err)) })}
                />
                <button
                  type="button" className="chip" aria-pressed={c.isActive}
                  onClick={() => updateCategory.mutate({ categoryId: c.id, body: { isActive: !c.isActive } }, { onError: (err) => setPageError(messageFrom(err)) })}
                >
                  {c.isActive ? "Active" : "Inactive"}
                </button>
                <Button
                  variant="ghost" icon={<Trash2 size={18} aria-hidden />} aria-label={`Remove ${c.name}`}
                  onClick={() => deleteCategory.mutate(c.id, { onError: (err) => setPageError(messageFrom(err)) })}
                />
              </span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <form className="auth__form" onSubmit={onAdd} noValidate style={{ marginTop: "var(--space-6)" }}>
          {errors.formError && <Alert tone="error" title={errors.formError} />}
          <TextField label="Category name" value={name} onChange={(e) => setName(e.target.value)} error={errors.fieldErrors.name} />
          <Button type="submit" block loading={createCategory.isPending}>Add category</Button>
        </form>
      )}
    </>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- CategoriesPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/app/househelps/useHousehelps.ts apps/web/src/features/app/househelps/CategoriesPage.tsx apps/web/src/features/app/househelps/CategoriesPage.test.tsx
git commit -m "feat(web): categories page with reordering"
```

---

### Task 6: Web — househelps list, form, detail

**Files:**
- Modify: `apps/web/src/features/app/househelps/useHousehelps.ts` (append househelp hooks)
- Create: `apps/web/src/features/app/househelps/HousehelpsListPage.tsx`
- Create: `apps/web/src/features/app/househelps/HousehelpFormPage.tsx`
- Create: `apps/web/src/features/app/househelps/HousehelpDetailPage.tsx`
- Test: `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`

**Interfaces:**
- Consumes: everything Task 5 produced, plus `CreateHousehelpInput`/`HousehelpDTO`/`UpdateHousehelpInput`/`createHousehelpSchema` (`@household/shared`), `rupeesToPaise`/`formatINR` (`@household/shared`).
- Produces: `useHousehelps`, `useHousehelp`, `useCreateHousehelp`, `useUpdateHousehelp`, `useArchiveHousehelp`, `useUnarchiveHousehelp` (appended to `useHousehelps.ts`) — Task 7 appends schedule hooks to the same file.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { HousehelpsListPage } from "./HousehelpsListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><HousehelpsListPage /></MemoryRouter></QueryClientProvider>);
}

describe("HousehelpsListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists househelps and shows an add button when the viewer can manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.view", "househelps.manage"] }, message: null });
      if (url.includes("/households/h1/househelps")) {
        return jsonResponse({ success: true, data: [{ id: "hh1", name: "Sunita", phone: null, roleTitle: "Cook", status: "ACTIVE", startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1000000, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" }], message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sunita")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /add househelp/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- HousehelpsListPage.test.tsx`
Expected: FAIL — `./HousehelpsListPage` doesn't exist yet.

- [ ] **Step 3: Append househelp hooks to `useHousehelps.ts`**

Change the type-import line at the top of `apps/web/src/features/app/househelps/useHousehelps.ts` from:
```ts
import type { CategoryDTO, CreateCategoryInput, MoveCategoryInput, UpdateCategoryInput } from "@household/shared";
```
to:
```ts
import type { CategoryDTO, CreateCategoryInput, CreateHousehelpInput, HousehelpDTO, MoveCategoryInput, UpdateCategoryInput, UpdateHousehelpInput } from "@household/shared";
```

Append at the end of the file:

```ts
export function useHousehelps(householdId: string | undefined, includeArchived: boolean) {
  return useQuery({
    queryKey: ["househelps", householdId, includeArchived],
    queryFn: ({ signal }) => get<HousehelpDTO[]>(`/households/${householdId}/househelps${includeArchived ? "?includeArchived=true" : ""}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useHousehelp(householdId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["househelp", householdId, id],
    queryFn: ({ signal }) => get<HousehelpDTO>(`/households/${householdId}/househelps/${id}`, signal).then((r) => r.data),
    enabled: !!householdId && !!id,
  });
}

function invalidateHousehelpQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, id?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["househelps", householdId] }),
    ...(id ? [qc.invalidateQueries({ queryKey: ["househelp", householdId, id] })] : []),
  ]);
}

export function useCreateHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHousehelpInput) => post<HousehelpDTO>(`/households/${householdId}/househelps`, body),
    onSuccess: () => invalidateHousehelpQueries(qc, householdId),
  });
}

export function useUpdateHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateHousehelpInput }) => patch<HousehelpDTO>(`/households/${householdId}/househelps/${id}`, body),
    onSuccess: (_data, { id }) => invalidateHousehelpQueries(qc, householdId, id),
  });
}

export function useArchiveHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/househelps/${id}/archive`),
    onSuccess: (_data, id) => invalidateHousehelpQueries(qc, householdId, id),
  });
}

export function useUnarchiveHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/househelps/${id}/unarchive`),
    onSuccess: (_data, id) => invalidateHousehelpQueries(qc, householdId, id),
  });
}
```

- [ ] **Step 4: Create `HousehelpsListPage.tsx`**

Create `apps/web/src/features/app/househelps/HousehelpsListPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelps } from "./useHousehelps";

export function HousehelpsListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const househelpsQuery = useHousehelps(householdId, showArchived);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Househelps</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
        {canManage && <Link to="/househelps/categories" className="list__label">Manage categories</Link>}
      </div>

      {househelpsQuery.data?.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No househelps yet" text="Add your first househelp to start tracking attendance and salary."
            action={canManage ? <Button onClick={() => navigate("/househelps/new")}>Add househelp</Button> : undefined}
          />
        </div>
      )}

      <div className="list">
        {househelpsQuery.data?.map((h) => (
          <Link key={h.id} to={`/househelps/${h.id}`} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{h.name}{h.archivedAt && " (archived)"}</span>
              <span className="list__meta">{h.roleTitle ?? "Househelp"}{h.status === "INACTIVE" && " · Inactive"}</span>
            </span>
          </Link>
        ))}
      </div>

      {canManage && (househelpsQuery.data?.length ?? 0) > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/househelps/new")}>
            Add househelp
          </Button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Create `HousehelpFormPage.tsx`**

Create `apps/web/src/features/app/househelps/HousehelpFormPage.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { createHousehelpSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories, useCreateHousehelp, useHousehelp, useUpdateHousehelp } from "./useHousehelps";

const SALARY_MODES = [
  { value: "FIXED_MONTHLY", label: "Fixed monthly" },
  { value: "ATTENDANCE_BASED", label: "Attendance-based monthly" },
  { value: "DAILY_RATE", label: "Daily rate" },
] as const;

function paiseToInput(paise: number | null | undefined): string {
  return paise == null ? "" : (paise / 100).toFixed(2);
}

function inputToPaise(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Math.round(Number(trimmed) * 100);
}

export function HousehelpFormPage({ mode }: { mode: "create" | "edit" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const categoriesQuery = useCategories(householdId);
  const existing = useHousehelp(householdId, mode === "edit" ? id : undefined);
  const createHousehelp = useCreateHousehelp(householdId ?? "");
  const updateHousehelp = useUpdateHousehelp(householdId ?? "");
  const errors = useFormErrors();

  const [form, setForm] = useState({
    name: "", phone: "", roleTitle: "", salaryMode: "FIXED_MONTHLY" as (typeof SALARY_MODES)[number]["value"],
    monthlySalaryPaise: "", dailyRatePaise: "", halfDayRatePaise: "", salaryDueDay: "1", notes: "",
  });
  const [categoryIds, setCategoryIds] = useState<string[]>([]);

  useEffect(() => {
    if (mode === "edit" && existing.data) {
      const h = existing.data;
      setForm({
        name: h.name, phone: h.phone ?? "", roleTitle: h.roleTitle ?? "", salaryMode: h.salaryMode,
        monthlySalaryPaise: paiseToInput(h.monthlySalaryPaise), dailyRatePaise: paiseToInput(h.dailyRatePaise), halfDayRatePaise: paiseToInput(h.halfDayRatePaise),
        salaryDueDay: String(h.salaryDueDay), notes: h.notes ?? "",
      });
      setCategoryIds(h.categoryIds);
    }
  }, [mode, existing.data]);

  function set<K extends keyof typeof form>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleCategory(categoryId: string) {
    setCategoryIds((ids) => (ids.includes(categoryId) ? ids.filter((c) => c !== categoryId) : [...ids, categoryId]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const body = {
      name: form.name, phone: form.phone || undefined, roleTitle: form.roleTitle || undefined, salaryMode: form.salaryMode,
      monthlySalaryPaise: inputToPaise(form.monthlySalaryPaise), dailyRatePaise: inputToPaise(form.dailyRatePaise), halfDayRatePaise: inputToPaise(form.halfDayRatePaise),
      salaryDueDay: Number(form.salaryDueDay), notes: form.notes || undefined, categoryIds,
    };
    if (mode === "create") {
      const parsed = createHousehelpSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      createHousehelp.mutate(parsed.data, { onSuccess: (data) => navigate(`/househelps/${data.id}`, { replace: true }), onError: errors.fromError });
    } else {
      updateHousehelp.mutate({ id: id!, body }, { onSuccess: () => navigate(`/househelps/${id}`, { replace: true }), onError: errors.fromError });
    }
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/househelps" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{mode === "create" ? "Add househelp" : "Edit househelp"}</h1></header>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />
        <TextField label="Phone" type="tel" value={form.phone} onChange={set("phone")} error={errors.fieldErrors.phone} />
        <TextField label="Role" hint="e.g. Cook, Full-time help" value={form.roleTitle} onChange={set("roleTitle")} error={errors.fieldErrors.roleTitle} />

        <div className="field">
          <label className="field__label" htmlFor="salary-mode">Salary type</label>
          <select id="salary-mode" className="input" value={form.salaryMode} onChange={set("salaryMode")}>
            {SALARY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        {(form.salaryMode === "FIXED_MONTHLY" || form.salaryMode === "ATTENDANCE_BASED") && (
          <TextField label="Monthly salary (₹)" inputMode="decimal" value={form.monthlySalaryPaise} onChange={set("monthlySalaryPaise")} error={errors.fieldErrors.monthlySalaryPaise} />
        )}
        {form.salaryMode === "DAILY_RATE" && (
          <>
            <TextField label="Daily rate (₹)" inputMode="decimal" value={form.dailyRatePaise} onChange={set("dailyRatePaise")} error={errors.fieldErrors.dailyRatePaise} />
            <TextField label="Half-day rate (₹)" inputMode="decimal" value={form.halfDayRatePaise} onChange={set("halfDayRatePaise")} error={errors.fieldErrors.halfDayRatePaise} />
          </>
        )}
        <TextField label="Salary due day" hint="Day of the month (1-31)" inputMode="numeric" value={form.salaryDueDay} onChange={set("salaryDueDay")} error={errors.fieldErrors.salaryDueDay} />
        <TextField label="Notes" value={form.notes} onChange={set("notes")} error={errors.fieldErrors.notes} />

        {(categoriesQuery.data?.length ?? 0) > 0 && (
          <div className="field">
            <span className="field__label">Categories</span>
            <div className="chips">
              {categoriesQuery.data!.filter((c) => c.isActive).map((c) => (
                <button key={c.id} type="button" className="chip" aria-pressed={categoryIds.includes(c.id)} onClick={() => toggleCategory(c.id)}>{c.name}</button>
              ))}
            </div>
          </div>
        )}

        <Button type="submit" block loading={createHousehelp.isPending || updateHousehelp.isPending}>
          {mode === "create" ? "Add househelp" : "Save changes"}
        </Button>
      </form>
    </>
  );
}
```

- [ ] **Step 6: Create `HousehelpDetailPage.tsx`**

Create `apps/web/src/features/app/househelps/HousehelpDetailPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatINR } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useArchiveHousehelp, useHousehelp, useUnarchiveHousehelp } from "./useHousehelps";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function HousehelpDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const househelpQuery = useHousehelp(householdId, id);
  const archive = useArchiveHousehelp(householdId ?? "");
  const unarchive = useUnarchiveHousehelp(householdId ?? "");
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);

  function onArchive() {
    if (!window.confirm(`Remove ${househelpQuery.data?.name}? Their history stays, but they'll drop off the main list.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  if (!householdId || !househelpQuery.data) return null;
  const h = househelpQuery.data;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{h.name}</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}
      {h.archivedAt && <Alert tone="info" title="This househelp is archived." />}

      <div className="list">
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Role</span><span className="list__meta">{h.roleTitle ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Phone</span><span className="list__meta">{h.phone ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Status</span><span className="list__meta">{h.status === "ACTIVE" ? "Active" : "Inactive"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Salary</span><span className="list__meta">{h.monthlySalaryPaise != null ? formatINR(h.monthlySalaryPaise) + "/month" : h.dailyRatePaise != null ? formatINR(h.dailyRatePaise) + "/day" : "—"}</span></span></div>
      </div>

      {canManage && (
        <div style={{ marginTop: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/edit`)}>Edit details</Button>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/schedule`)}>Set schedule</Button>
          {h.archivedAt ? (
            <Button variant="secondary" block loading={unarchive.isPending} onClick={() => unarchive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Restore</Button>
          ) : (
            <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Remove househelp</Button>
          )}
        </div>
      )}
      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/househelps")}>Back to list</Button></div>
    </>
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- HousehelpsListPage.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full web test suite and typecheck**

Run: `npm run test --workspace @household/web && npm run typecheck --workspace @household/web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/app/househelps
git commit -m "feat(web): househelps list, create/edit form, and detail page"
```

---

### Task 7: Web — schedule editor and route wiring

**Files:**
- Modify: `apps/web/src/features/app/househelps/useHousehelps.ts` (append schedule hooks)
- Create: `apps/web/src/features/app/househelps/ScheduleEditorPage.tsx`
- Test: `apps/web/src/features/app/househelps/ScheduleEditorPage.test.tsx`
- Modify: `apps/web/src/lib/api.ts` (add `put`)
- Modify: `apps/web/src/App.tsx` (replace the `/househelps` placeholder with the real routes)

**Interfaces:**
- Consumes: everything Tasks 5-6 produced, plus `ScheduleDTO`/`UpdateScheduleInput`/`updateScheduleSchema` (`@household/shared`).
- Produces: `put<T>(path, body)` (`lib/api.ts`), `useSchedule`, `useUpdateSchedule` (appended to `useHousehelps.ts`) — nothing consumed by later tasks, this is the last task.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/househelps/ScheduleEditorPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ScheduleEditorPage } from "./ScheduleEditorPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/hh1/schedule"]}>
        <Routes><Route path="/househelps/:id/schedule" element={<ScheduleEditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScheduleEditorPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("toggles weekday chips and saves via PUT", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (init?.method === "PUT") return jsonResponse({ success: true, data: { id: "s1", weekdays: [1], startTime: null, endTime: null, effectiveFrom: "2026-09-29" }, message: null });
      if (url.includes("/schedule")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    const putCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ weekdays: [1] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- ScheduleEditorPage.test.tsx`
Expected: FAIL — `./ScheduleEditorPage` doesn't exist yet, and `put` isn't exported from `lib/api.ts` yet.

- [ ] **Step 3: Add `put` to `lib/api.ts`**

In `apps/web/src/lib/api.ts`, add after the existing `patch` export:

```ts
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
```

- [ ] **Step 4: Append schedule hooks to `useHousehelps.ts`**

Change the type-import line to add `ScheduleDTO, UpdateScheduleInput`:
```ts
import type { CategoryDTO, CreateCategoryInput, CreateHousehelpInput, HousehelpDTO, MoveCategoryInput, ScheduleDTO, UpdateCategoryInput, UpdateHousehelpInput, UpdateScheduleInput } from "@household/shared";
```
Change the value-import line to add `put`:
```ts
import { del, get, patch, post, put } from "../../../lib/api";
```

Append at the end of the file:

```ts
export function useSchedule(householdId: string | undefined, househelpId: string | undefined) {
  return useQuery({
    queryKey: ["schedule", householdId, househelpId],
    queryFn: ({ signal }) => get<ScheduleDTO | null>(`/households/${householdId}/househelps/${househelpId}/schedule`, signal).then((r) => r.data),
    enabled: !!householdId && !!househelpId,
  });
}

export function useUpdateSchedule(householdId: string, househelpId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateScheduleInput) => put<ScheduleDTO>(`/households/${householdId}/househelps/${househelpId}/schedule`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", householdId, househelpId] }),
  });
}
```

- [ ] **Step 5: Create `ScheduleEditorPage.tsx`**

Create `apps/web/src/features/app/househelps/ScheduleEditorPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { updateScheduleSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelp, useSchedule, useUpdateSchedule } from "./useHousehelps";

const WEEKDAYS = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }, { value: 7, label: "Sunday" },
] as const;

export function ScheduleEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const househelpQuery = useHousehelp(householdId, id);
  const scheduleQuery = useSchedule(householdId, id);
  const updateSchedule = useUpdateSchedule(householdId ?? "", id ?? "");
  const errors = useFormErrors();

  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  useEffect(() => {
    if (scheduleQuery.data) {
      setWeekdays(scheduleQuery.data.weekdays);
      setStartTime(scheduleQuery.data.startTime ?? "");
      setEndTime(scheduleQuery.data.endTime ?? "");
    }
  }, [scheduleQuery.data]);

  function toggleDay(day: number) {
    setWeekdays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  function onSave() {
    errors.clear();
    const body = { weekdays, startTime: startTime || undefined, endTime: endTime || undefined };
    const parsed = updateScheduleSchema.safeParse(body);
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    updateSchedule.mutate(parsed.data, { onSuccess: () => navigate(`/househelps/${id}`), onError: errors.fromError });
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/househelps" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Schedule{househelpQuery.data && ` — ${househelpQuery.data.name}`}</h1></header>
      {errors.formError && <Alert tone="error" title={errors.formError} />}

      <div className="field">
        <span className="field__label">Working days</span>
        <div className="chips">
          {WEEKDAYS.map((d) => (
            <button key={d.value} type="button" className="chip" aria-pressed={weekdays.includes(d.value)} onClick={() => toggleDay(d.value)}>{d.label}</button>
          ))}
        </div>
        {errors.fieldErrors.weekdays && <p className="field__error">{errors.fieldErrors.weekdays}</p>}
      </div>

      <TextField label="Start time" hint="24-hour, e.g. 09:00" value={startTime} onChange={(e) => setStartTime(e.target.value)} error={errors.fieldErrors.startTime} />
      <TextField label="End time" hint="24-hour, e.g. 13:00" value={endTime} onChange={(e) => setEndTime(e.target.value)} error={errors.fieldErrors.endTime} />

      <div style={{ marginTop: "var(--space-6)" }}>
        <Button block loading={updateSchedule.isPending} onClick={onSave}>Save schedule</Button>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- ScheduleEditorPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire the routes into `App.tsx`**

Replace this line in `apps/web/src/App.tsx`:
```tsx
        <Route path="househelps" element={<ComingSoonPage title="Househelps" icon={<Users size={22} />} heading="Your household doesn't have any househelps yet." text="Adding househelps, schedules and salaries is coming in the next update." />} />
```
with:
```tsx
        <Route path="househelps" element={<HousehelpsListPage />} />
        <Route path="househelps/categories" element={<CategoriesPage />} />
        <Route path="househelps/new" element={<HousehelpFormPage mode="create" />} />
        <Route path="househelps/:id" element={<HousehelpDetailPage />} />
        <Route path="househelps/:id/edit" element={<HousehelpFormPage mode="edit" />} />
        <Route path="househelps/:id/schedule" element={<ScheduleEditorPage />} />
```

Remove the now-unused `Users` import — change:
```tsx
import { ClipboardCheck, ReceiptIndianRupee, Users } from "lucide-react";
```
to:
```tsx
import { ClipboardCheck, ReceiptIndianRupee } from "lucide-react";
```

Add these imports alongside the other `app` feature imports (and remove the `ComingSoonPage` import only if it becomes otherwise unused — check first: `ComingSoonPage` is still used for `checklist` and `bills` routes, so keep that import):

```ts
import { CategoriesPage } from "./features/app/househelps/CategoriesPage";
import { HousehelpDetailPage } from "./features/app/househelps/HousehelpDetailPage";
import { HousehelpFormPage } from "./features/app/househelps/HousehelpFormPage";
import { HousehelpsListPage } from "./features/app/househelps/HousehelpsListPage";
import { ScheduleEditorPage } from "./features/app/househelps/ScheduleEditorPage";
```

- [ ] **Step 8: Run the full web test suite, typecheck, lint, and build**

Run: `npm run test --workspace @household/web && npm run typecheck && npm run lint && npm run build`
Expected: PASS / no errors across the whole repo (shared, api, web).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/app/househelps/useHousehelps.ts apps/web/src/features/app/househelps/ScheduleEditorPage.tsx apps/web/src/features/app/househelps/ScheduleEditorPage.test.tsx apps/web/src/lib/api.ts apps/web/src/App.tsx
git commit -m "feat(web): schedule editor and route wiring for househelps"
```

---

## After this plan

Update `README.md`'s roadmap table: Phase 2 (both specs) is now complete — mark it ✅ and update "Status" near the top of the file, matching the style used for Phase 1. This isn't part of any task above since it's a small doc touch-up better done once both specs are visibly working end-to-end — your call at execution time.
