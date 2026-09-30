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
