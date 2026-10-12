import { and, eq, inArray } from "drizzle-orm";
import type { ISODate } from "@household/shared";
import { daysBetween } from "@household/shared";
import { househelps, reminderRules } from "../db/schema.js";
import type { Deps } from "./deps.js";
import { listDueOccurrencesForHousehold } from "./bill-occurrence.service.js";
import { listSettlementsForHousehold } from "./salary-settlement.service.js";

/**
 * These types are API-internal, not `@household/shared` exports: nothing outside `apps/api`
 * consumes them yet (no route returns a due-item list — this task is purely the evaluation
 * engine Spec 3's notification-creation job will call directly, in-process). If a future spec
 * needs to expose this shape over HTTP or to the web client, promote it then.
 */
export type DueBillOccurrence = {
  billId: string;
  billName: string;
  occurrenceId: string;
  dueDate: ISODate;
  amountDuePaise: number;
  daysUntilDue: number;
  matchedOffsets: number[];
  isOverdue: boolean;
};

export type DueSettlement = {
  settlementId: string;
  househelpId: string;
  househelpName: string;
  dueDate: ISODate;
  netPayablePaise: number;
  daysUntilDue: number;
  matchedOffsets: number[];
  isOverdue: boolean;
};

type ReminderRuleRow = typeof reminderRules.$inferSelect;

/**
 * Every reminder rule for `(householdId, targetType)`, split into the household-default row
 * (`targetId IS NULL`) and a lookup map of specific-target overrides — loaded once per evaluation
 * call rather than once per due item, since a household has at most a handful of rules against
 * potentially many due items. `reminder_rules_target_uq` guarantees at most one row per target
 * (or per household-default), so there's no ambiguity to resolve within either bucket.
 */
async function loadRules(deps: Deps, householdId: string, targetType: "BILL" | "SALARY") {
  const rows = await deps.db.select().from(reminderRules)
    .where(and(eq(reminderRules.householdId, householdId), eq(reminderRules.targetType, targetType)));
  const overrides = new Map<string, ReminderRuleRow>();
  let defaultRule: ReminderRuleRow | null = null;
  for (const row of rows) {
    if (row.targetId === null) defaultRule = row;
    else overrides.set(row.targetId, row);
  }
  return { overrides, defaultRule };
}

/** Specific-target override if one exists for `targetId`, else the household-default row, else `null`. */
function effectiveRule(overrides: Map<string, ReminderRuleRow>, defaultRule: ReminderRuleRow | null, targetId: string): ReminderRuleRow | null {
  return overrides.get(targetId) ?? defaultRule;
}

/**
 * `matchedOffsets` = the subset of the rule's `offsetsDays` equal to `daysUntilDue` (empty when
 * nothing matches). This function assumes `offsetsDays` only ever contains non-negative "days
 * before due" values, but does not itself enforce that — there is no check constraint on the
 * column, and a negative offset (if one somehow got written) WOULD match a `daysUntilDue` of the
 * same negative value. Rejecting negative offsets at write time is Task 2's job (the `reminder_rules`
 * CRUD validation), not this read-only evaluator's. `isOverdue` folds in the rule's own `overdueDaily` flag
 * (not just the raw `daysUntilDue < 0` fact) — a rule with `overdueDaily: false` means this item
 * never flags as overdue for reminder purposes, no matter how late it is.
 *
 * An `isActive: false` rule suppresses both outcomes entirely, regardless of its stored
 * `offsetsDays`/`overdueDaily` values — same effect as no reminder being configured, but the item
 * is still returned (not skipped) so a caller inspecting "why didn't this fire" can see the rule
 * that suppressed it. `rule: null` (no rule at all, specific or default) is the one case the caller
 * must skip the item for instead of calling this — see `getDueBillOccurrences`/`getDueSettlements`.
 */
function evaluateRule(rule: ReminderRuleRow, daysUntilDue: number): { matchedOffsets: number[]; isOverdue: boolean } {
  if (!rule.isActive) return { matchedOffsets: [], isOverdue: false };
  return {
    matchedOffsets: rule.offsetsDays.filter((offset) => offset === daysUntilDue),
    isOverdue: daysUntilDue < 0 && rule.overdueDaily,
  };
}

/**
 * Every still-open bill occurrence in the household, evaluated against its effective BILL reminder
 * rule. `today` is the caller's already-computed `dateInZone(deps.clock.now(), household.timezone)`
 * — this function does no clock/timezone work of its own, it just does date arithmetic against the
 * value it's given (keeps it trivially testable with any `today`, and keeps "what is today" a
 * single decision made once by the caller).
 */
export async function getDueBillOccurrences(deps: Deps, householdId: string, today: ISODate): Promise<DueBillOccurrence[]> {
  const [occurrences, { overrides, defaultRule }] = await Promise.all([
    listDueOccurrencesForHousehold(deps, householdId),
    loadRules(deps, householdId, "BILL"),
  ]);

  const result: DueBillOccurrence[] = [];
  for (const occ of occurrences) {
    const rule = effectiveRule(overrides, defaultRule, occ.billId);
    if (!rule) continue; // defensive: household creation always seeds a default BILL rule; see household.service.ts
    const daysUntilDue = daysBetween(today, occ.dueDate);
    const { matchedOffsets, isOverdue } = evaluateRule(rule, daysUntilDue);
    result.push({
      billId: occ.billId, billName: occ.billName, occurrenceId: occ.occurrenceId, dueDate: occ.dueDate,
      amountDuePaise: occ.amountDuePaise, daysUntilDue, matchedOffsets, isOverdue,
    });
  }
  return result;
}

/**
 * Every still-unpaid salary settlement in the household, evaluated against its effective SALARY
 * reminder rule. Reuses `listSettlementsForHousehold` (a bare-`householdId` sibling of
 * `salary-settlement.service.ts`'s `listSettlements`, added for exactly this kind of internal/system
 * caller) rather than a bespoke query, avoiding duplicating its settlement-fetch/DTO-shaping logic
 * without having to fabricate a `Membership` this evaluator has no real one for.
 *
 * `reminder_rules.targetId` for `targetType = 'SALARY'` is a `househelps.id` — a settlement recurs
 * per househelp per month (a new row every period), so "override this specific settlement's
 * reminders" would be meaningless; "override this specific househelp's reminders" is the only
 * reading that makes the override durable across periods. No FK constraint ties `targetId` to any
 * table (it's polymorphic across BILL/SALARY/CHECKLIST/ATTENDANCE targets), but this is confirmed
 * by `reminderRules`'s own doc comment ("target_id NULL = household default for that target type")
 * read together with the settlement-per-househelp-per-month shape, not left to guesswork.
 */
export async function getDueSettlements(deps: Deps, householdId: string, today: ISODate): Promise<DueSettlement[]> {
  const [allSettlements, { overrides, defaultRule }] = await Promise.all([
    listSettlementsForHousehold(deps, householdId),
    loadRules(deps, householdId, "SALARY"),
  ]);
  const unpaid = allSettlements.filter((s) => s.status === "PENDING" || s.status === "PARTIALLY_PAID");
  if (unpaid.length === 0) return [];

  const househelpIds = [...new Set(unpaid.map((s) => s.househelpId))];
  const nameRows = await deps.db.select({ id: househelps.id, name: househelps.name }).from(househelps)
    .where(and(eq(househelps.householdId, householdId), inArray(househelps.id, househelpIds)));
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  const result: DueSettlement[] = [];
  for (const s of unpaid) {
    const rule = effectiveRule(overrides, defaultRule, s.househelpId);
    if (!rule) continue; // defensive: household creation always seeds a default SALARY rule; see household.service.ts
    const daysUntilDue = daysBetween(today, s.dueDate);
    const { matchedOffsets, isOverdue } = evaluateRule(rule, daysUntilDue);
    result.push({
      settlementId: s.id, househelpId: s.househelpId, househelpName: nameById.get(s.househelpId) ?? "",
      dueDate: s.dueDate, netPayablePaise: s.netPayablePaise, daysUntilDue, matchedOffsets, isOverdue,
    });
  }
  return result;
}
