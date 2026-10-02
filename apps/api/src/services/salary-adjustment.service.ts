import { and, eq, inArray } from "drizzle-orm";
import type { AdjustmentDTO, CreateAdjustmentInput, Permission } from "@household/shared";
import { sumPaise } from "@household/shared";
import { salaryAdjustments, salarySettlements } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { requireHousehelpInHousehold, sumUnattachedAdjustments, toAdjustmentDTO } from "./salary-settlement.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };
type SettlementRow = typeof salarySettlements.$inferSelect;

/**
 * Re-sums this still-PENDING settlement's adjustments (additions/deductions/advance) and its
 * derived `netPayablePaise`, leaving `basePaise`/`absenceDeductionPaise` untouched — only the
 * adjustment side of the calc changed, not attendance. Mirrors `generateSettlement`'s own
 * recompute, scoped to just the adjustment totals.
 *
 * Critically, this must also ATTACH every swept-but-still-unattached id the sum counted — exactly
 * like `generateSettlement` does right after its own sum — otherwise an adjustment counted into
 * these totals stays `settlementId: null` in the DB. That breaks `voidAdjustment`'s
 * `if (adjustment.settlementId)` gate (a later void of that adjustment would silently skip
 * recomputing, leaving stale/overstated totals permanently locked in once the settlement is paid)
 * and desyncs `getSettlement`'s adjustment list from the totals it's supposed to explain.
 */
async function recomputeSettlementAdjustmentTotals(
  tx: DbOrTx, actorUserId: string, membership: AuthedMembership, settlement: SettlementRow, ip?: string,
): Promise<void> {
  const { additionsPaise, deductionsPaise, advancePaise, ids } = await sumUnattachedAdjustments(
    tx, membership.householdId, settlement.househelpId, settlement.periodMonth, settlement.id,
  );
  const netPayablePaise = sumPaise([settlement.basePaise, -settlement.absenceDeductionPaise, additionsPaise, -deductionsPaise, -advancePaise]);
  const values = { additionsPaise, deductionsPaise, advancePaise, netPayablePaise };

  await tx.update(salarySettlements).set(values).where(eq(salarySettlements.id, settlement.id));
  if (ids.length > 0) {
    await tx.update(salaryAdjustments).set({ settlementId: settlement.id }).where(inArray(salaryAdjustments.id, ids));
  }
  await recordAudit(tx, {
    householdId: membership.householdId, actorUserId, action: "settlement.regenerated", entityType: "salary_settlement", entityId: settlement.id,
    oldValue: settlement, newValue: values, ipAddress: ip ?? null,
  });
}

/**
 * Inserts an adjustment. If a `PENDING` settlement already exists for `(househelpId, periodMonth)`,
 * attaches directly to it and recomputes its totals in the same transaction. If the settlement is
 * locked (paid/partially-paid) or doesn't exist yet, the adjustment is inserted unattached
 * (`settlementId: null`) regardless — a locked settlement's totals are never silently touched.
 */
export async function createAdjustment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, input: CreateAdjustmentInput, ip?: string,
): Promise<AdjustmentDTO> {
  await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const periodMonthFirst = `${input.periodMonth.slice(0, 7)}-01`;

  const row = await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(salarySettlements)
      .where(and(
        eq(salarySettlements.householdId, membership.householdId),
        eq(salarySettlements.househelpId, househelpId),
        eq(salarySettlements.periodMonth, periodMonthFirst),
      ))
      .for("update");

    const attachTo = existing && existing.status === "PENDING" ? existing : null;

    const [inserted] = await tx.insert(salaryAdjustments).values({
      householdId: membership.householdId, househelpId, settlementId: attachTo?.id ?? null,
      periodMonth: input.periodMonth, type: input.type, amountPaise: input.amountPaise,
      reason: input.reason ?? null, createdByUserId: actorUserId,
    }).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "adjustment.created", entityType: "salary_adjustment", entityId: inserted!.id,
      newValue: inserted, ipAddress: ip ?? null,
    });

    if (attachTo) {
      await recomputeSettlementAdjustmentTotals(tx, actorUserId, membership, attachTo, ip);
    }

    return inserted!;
  });

  return toAdjustmentDTO(row);
}

/**
 * Soft-deletes (`voidedAt`) an adjustment. If it was attached to a still-`PENDING` settlement,
 * that settlement's totals are recomputed in the same transaction. If attached to a locked
 * (paid/partially-paid) settlement, voiding is still allowed but does NOT retroactively change
 * that settlement's locked totals.
 */
export async function voidAdjustment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, adjustmentId: string, ip?: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [adjustment] = await tx.select().from(salaryAdjustments)
      .where(and(eq(salaryAdjustments.householdId, membership.householdId), eq(salaryAdjustments.id, adjustmentId)))
      .for("update");
    if (!adjustment) throw Errors.notFound("Adjustment");
    if (adjustment.voidedAt) throw Errors.validation({ adjustmentId: "This adjustment has already been voided." });

    const [voided] = await tx.update(salaryAdjustments).set({ voidedAt: deps.clock.now() })
      .where(eq(salaryAdjustments.id, adjustmentId)).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "adjustment.voided", entityType: "salary_adjustment", entityId: adjustmentId,
      oldValue: adjustment, newValue: voided, ipAddress: ip ?? null,
    });

    if (adjustment.settlementId) {
      const [settlement] = await tx.select().from(salarySettlements)
        .where(and(eq(salarySettlements.householdId, membership.householdId), eq(salarySettlements.id, adjustment.settlementId)))
        .for("update");
      if (settlement && settlement.status === "PENDING") {
        await recomputeSettlementAdjustmentTotals(tx, actorUserId, membership, settlement, ip);
      }
    }
  });
}
