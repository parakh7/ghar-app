import { and, asc, eq } from "drizzle-orm";
import type { CreateReminderRuleInput, ReminderRuleDTO, ReminderTargetType, UpdateReminderRuleInput } from "@household/shared";
import { bills, househelps, reminderRules } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type ReminderRuleRow = typeof reminderRules.$inferSelect;

function toReminderRuleDTO(row: ReminderRuleRow): ReminderRuleDTO {
  return {
    id: row.id, targetType: row.targetType, targetId: row.targetId,
    offsetsDays: row.offsetsDays, overdueDaily: row.overdueDaily, sendHour: row.sendHour,
    isActive: row.isActive, createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `targetId`, when provided, must reference a row that actually exists in THIS household for the
 * given `targetType` — specifically a `bills.id` for BILL and a `househelps.id` for SALARY, **never**
 * a `salary_settlements.id`. A settlement recurs per househelp per period (a new row is generated
 * every month), so a settlement-row-id override would be a one-shot: it would silently stop applying
 * the moment the next period's settlement is generated, with nothing in the app surfacing that
 * failure. `reminder_rules.targetId` carries no FK (it's deliberately polymorphic across
 * BILL/SALARY/CHECKLIST/ATTENDANCE targets), so this existence check is the only thing standing
 * between a wrong-table id and a rule that silently never fires again.
 *
 * An archived/departed househelp's id still validates successfully here on purpose: their
 * outstanding unpaid settlements continue to be evaluated for reminders even after departure
 * (confirmed product decision carried forward from Task 1's review — see the doc comment on
 * `getDueSettlements` in `reminder-evaluation.service.ts`), so there is deliberately no "is this
 * househelp still active" check added here.
 *
 * CHECKLIST and ATTENDANCE have no seeded household-default rule and no evaluator yet (Task 1 only
 * built the BILL/SALARY due-item queries) — there is no established target table to validate a
 * `targetId` against for either yet, so one is accepted unchecked for now. A future spec that adds
 * CHECKLIST/ATTENDANCE evaluation should add the matching existence check here at that point.
 */
async function validateTargetId(db: DbOrTx, householdId: string, targetType: ReminderTargetType, targetId: string): Promise<void> {
  if (targetType === "BILL") {
    const [row] = await db.select({ id: bills.id }).from(bills)
      .where(and(eq(bills.householdId, householdId), eq(bills.id, targetId)));
    if (!row) throw Errors.validation({ targetId: "That bill doesn't exist." });
  } else if (targetType === "SALARY") {
    const [row] = await db.select({ id: househelps.id }).from(househelps)
      .where(and(eq(househelps.householdId, householdId), eq(househelps.id, targetId)));
    if (!row) throw Errors.validation({ targetId: "That househelp doesn't exist." });
  }
}

export async function listReminderRules(deps: Deps, membership: Membership): Promise<ReminderRuleDTO[]> {
  const rows = await deps.db.select().from(reminderRules)
    .where(eq(reminderRules.householdId, membership.householdId))
    .orderBy(asc(reminderRules.targetType), asc(reminderRules.createdAt));
  return rows.map(toReminderRuleDTO);
}

export async function createReminderRule(deps: Deps, actorUserId: string, membership: Membership, input: CreateReminderRuleInput, ip?: string): Promise<ReminderRuleDTO> {
  if (input.targetId) await validateTargetId(deps.db, membership.householdId, input.targetType, input.targetId);
  try {
    const row = await deps.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(reminderRules).values({
        householdId: membership.householdId,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        offsetsDays: input.offsetsDays,
        overdueDaily: input.overdueDaily,
        sendHour: input.sendHour,
        isActive: input.isActive,
      }).returning();
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "reminder_rule.created", entityType: "reminder_rule", entityId: inserted!.id,
        newValue: { targetType: input.targetType, targetId: input.targetId ?? null, offsetsDays: input.offsetsDays, overdueDaily: input.overdueDaily, sendHour: input.sendHour, isActive: input.isActive },
        ipAddress: ip ?? null,
      });
      return inserted!;
    });
    return toReminderRuleDTO(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A reminder rule already exists for this target.");
    throw err;
  }
}

export async function updateReminderRule(deps: Deps, actorUserId: string, membership: Membership, ruleId: string, input: UpdateReminderRuleInput, ip?: string): Promise<ReminderRuleDTO> {
  const changes: Partial<{ offsetsDays: number[]; overdueDaily: boolean; sendHour: number; isActive: boolean }> = {};
  if (input.offsetsDays !== undefined) changes.offsetsDays = input.offsetsDays;
  if (input.overdueDaily !== undefined) changes.overdueDaily = input.overdueDaily;
  if (input.sendHour !== undefined) changes.sendHour = input.sendHour;
  if (input.isActive !== undefined) changes.isActive = input.isActive;
  const updated = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select({ offsetsDays: reminderRules.offsetsDays, overdueDaily: reminderRules.overdueDaily, sendHour: reminderRules.sendHour, isActive: reminderRules.isActive })
      .from(reminderRules)
      .where(and(eq(reminderRules.householdId, membership.householdId), eq(reminderRules.id, ruleId)))
      .for("update");
    if (!before) throw Errors.notFound("Reminder rule");
    await tx.update(reminderRules).set(changes).where(eq(reminderRules.id, ruleId));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "reminder_rule.updated", entityType: "reminder_rule", entityId: ruleId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
    const [row] = await tx.select().from(reminderRules).where(eq(reminderRules.id, ruleId));
    return row!;
  });
  return toReminderRuleDTO(updated);
}

/**
 * A household-default row (`targetId IS NULL`) can't be deleted — household creation seeds exactly
 * one default rule per already-seeded `targetType` (see `DEFAULT_REMINDERS` in
 * `household.service.ts`), and the evaluator falls back to it whenever no specific-target override
 * exists. Deleting it would leave that targetType with no fallback at all rather than the "off"
 * state a caller presumably wants — use `updateReminderRule(..., { isActive: false })` for that
 * instead. Only specific-target override rows can be hard-deleted.
 */
export async function deleteReminderRule(deps: Deps, actorUserId: string, membership: Membership, ruleId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: reminderRules.id, targetId: reminderRules.targetId }).from(reminderRules)
      .where(and(eq(reminderRules.householdId, membership.householdId), eq(reminderRules.id, ruleId)))
      .for("update");
    if (!row) throw Errors.notFound("Reminder rule");
    if (row.targetId === null) throw Errors.conflict("The household-default rule can't be deleted — set isActive to false to turn it off instead.");
    await tx.delete(reminderRules).where(eq(reminderRules.id, ruleId));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "reminder_rule.deleted", entityType: "reminder_rule", entityId: ruleId, ipAddress: ip ?? null });
  });
}
