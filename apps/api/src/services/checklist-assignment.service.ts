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
