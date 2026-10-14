import { and, asc, eq, isNull } from "drizzle-orm";
import type { CompletionStatus, MarkCompletionInput, Permission, TodayChecklistDTO } from "@household/shared";
import { dateInZone, isTaskDueOn } from "@household/shared";
import { checklistCompletions, checklistTasks } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };

export type ChecklistCompletionRecordDTO = { date: string; status: CompletionStatus; note: string | null };

function toRecordDTO(row: { date: string; status: CompletionStatus; note: string | null }): ChecklistCompletionRecordDTO {
  return { date: row.date, status: row.status, note: row.note };
}

/**
 * Narrows the DB's `CompletionStatus` down to the entry DTO's `"COMPLETED" | "SKIPPED" | null`.
 * A completion row only ever gets written with COMPLETED or SKIPPED (see the mark endpoint's
 * Zod schema), so PENDING should never appear here in practice; if it ever did, treat it as
 * unmarked (`null`) rather than silently coercing it to a wrong done/skipped value.
 */
function toEntryStatus(status: CompletionStatus | undefined): "COMPLETED" | "SKIPPED" | null {
  return status === "COMPLETED" || status === "SKIPPED" ? status : null;
}

/** Same-day writes only need `checklists.complete`; any other date needs `checklists.editHistory`. Never allows a future date. */
function assertWritable(membership: AuthedMembership, date: string, today: string): void {
  if (date > today) throw Errors.validation({ date: "Can't mark a date in the future." });
  if (date !== today && !membership.permissions.has("checklists.editHistory")) throw Errors.forbidden();
}

async function requireTaskInHousehold(db: DbOrTx, householdId: string, taskId: string): Promise<void> {
  const [row] = await db.select({ id: checklistTasks.id }).from(checklistTasks)
    .where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.id, taskId)));
  if (!row) throw Errors.notFound("Checklist task");
}

export async function getTodayChecklist(deps: Deps, membership: Membership, dateParam?: string): Promise<TodayChecklistDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const date = dateParam ?? today;
  if (date > today) throw Errors.validation({ date: "Can't view a date in the future." });

  const activeTasks = await deps.db.select({
    id: checklistTasks.id, name: checklistTasks.name, frequency: checklistTasks.frequency,
    weekdays: checklistTasks.weekdays, dayOfMonth: checklistTasks.dayOfMonth,
    specificDate: checklistTasks.specificDate, intervalDays: checklistTasks.intervalDays, anchorDate: checklistTasks.anchorDate,
  }).from(checklistTasks)
    .where(and(eq(checklistTasks.householdId, membership.householdId), eq(checklistTasks.isActive, true), isNull(checklistTasks.archivedAt)))
    .orderBy(asc(checklistTasks.sortOrder));
  const dueTasks = activeTasks.filter((t) => isTaskDueOn(t, date));
  if (dueTasks.length === 0) return { date, entries: [] };

  const completions = await deps.db.select({ taskId: checklistCompletions.taskId, status: checklistCompletions.status, note: checklistCompletions.note })
    .from(checklistCompletions)
    .where(and(eq(checklistCompletions.householdId, membership.householdId), eq(checklistCompletions.date, date)));
  const completionByTask = new Map(completions.map((c) => [c.taskId, c]));

  // `dueTasks` is already sortOrder-sorted (inherited from `activeTasks`); every entry here is due today by construction.
  const entries = dueTasks.map((t) => ({
    taskId: t.id, name: t.name,
    status: toEntryStatus(completionByTask.get(t.id)?.status),
    note: completionByTask.get(t.id)?.note ?? null,
  }));

  return { date, entries };
}

export async function markCompletion(
  deps: Deps, actorUserId: string, membership: AuthedMembership, taskId: string, input: MarkCompletionInput, ip?: string,
): Promise<ChecklistCompletionRecordDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  assertWritable(membership, input.date, today);
  await requireTaskInHousehold(deps.db, membership.householdId, taskId);
  const note = input.note ?? null;
  const isCorrection = input.date !== today;

  if (input.clientMutationId) {
    const [already] = await deps.db.select().from(checklistCompletions)
      .where(and(eq(checklistCompletions.householdId, membership.householdId), eq(checklistCompletions.clientMutationId, input.clientMutationId)));
    if (already) return toRecordDTO(already);
  }

  const row = await deps.db.transaction(async (tx) => {
    const [before] = isCorrection
      ? await tx.select({ status: checklistCompletions.status, note: checklistCompletions.note }).from(checklistCompletions)
          .where(and(eq(checklistCompletions.householdId, membership.householdId), eq(checklistCompletions.taskId, taskId), eq(checklistCompletions.date, input.date)))
      : [undefined];
    const now = deps.clock.now();
    const [inserted] = await tx.insert(checklistCompletions).values({
      householdId: membership.householdId, taskId, househelpId: null, date: input.date, status: input.status, note,
      recordedByUserId: actorUserId, recordedAt: now, clientMutationId: input.clientMutationId ?? null,
    }).onConflictDoUpdate({
      target: [checklistCompletions.taskId, checklistCompletions.date],
      set: { status: input.status, note, househelpId: null, recordedByUserId: actorUserId, recordedAt: now, clientMutationId: input.clientMutationId ?? null },
    }).returning();
    if (isCorrection) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "checklist.completionCorrected", entityType: "checklist_completion", entityId: inserted!.id,
        oldValue: before ? { status: before.status, note: before.note } : null, newValue: { status: input.status, note }, ipAddress: ip ?? null,
      });
    }
    return inserted!;
  });
  return toRecordDTO(row);
}

export async function clearCompletion(
  deps: Deps, actorUserId: string, membership: AuthedMembership, taskId: string, date: string, ip?: string,
): Promise<void> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  assertWritable(membership, date, today);
  await requireTaskInHousehold(deps.db, membership.householdId, taskId);
  const isCorrection = date !== today;

  await deps.db.transaction(async (tx) => {
    const [before] = await tx.delete(checklistCompletions)
      .where(and(eq(checklistCompletions.householdId, membership.householdId), eq(checklistCompletions.taskId, taskId), eq(checklistCompletions.date, date)))
      .returning({ id: checklistCompletions.id, status: checklistCompletions.status, note: checklistCompletions.note });
    if (before && isCorrection) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "checklist.completionCorrected", entityType: "checklist_completion", entityId: before.id,
        oldValue: { status: before.status, note: before.note }, newValue: null, ipAddress: ip ?? null,
      });
    }
  });
}
