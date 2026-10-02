import { and, eq, isNull } from "drizzle-orm";
import type { Permission, RecordPaymentInput, SalaryPaymentDTO, SettlementStatus } from "@household/shared";
import { sumPaise } from "@household/shared";
import { salaryPayments, salarySettlements } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { toPaymentDTO } from "./salary-settlement.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };
type SettlementRow = typeof salarySettlements.$inferSelect;

/**
 * Re-sums all non-voided payments for `settlement` and persists the derived `amountPaidPaise`/
 * `status`/`paidAt` onto it, in the same transaction as the payment insert/void that triggered it.
 * This is the single source of truth `generateSettlement`'s regeneration-lock check relies on —
 * `status` must always be accurate the instant a payment pushes the paid amount across a threshold
 * in EITHER direction (recordPayment up, voidPayment back down), or a settlement whose real paid
 * amount has dropped would stay permanently stuck un-regeneratable.
 *
 * `CANCELLED` settlements are left alone (no cancel flow exists yet in this phase, but this keeps
 * the recompute from ever reviving a cancelled settlement's status based on payment totals alone).
 */
async function recomputeSettlementPaymentTotals(
  deps: Deps, tx: DbOrTx, actorUserId: string, membership: AuthedMembership, settlement: SettlementRow, ip?: string,
): Promise<void> {
  const rows = await tx.select({ amountPaise: salaryPayments.amountPaise }).from(salaryPayments)
    .where(and(
      eq(salaryPayments.householdId, membership.householdId),
      eq(salaryPayments.settlementId, settlement.id),
      isNull(salaryPayments.voidedAt),
    ));
  const amountPaidPaise = sumPaise(rows.map((r) => r.amountPaise));

  let status: SettlementStatus = settlement.status;
  if (status !== "CANCELLED") {
    if (amountPaidPaise <= 0) status = "PENDING";
    else if (amountPaidPaise >= settlement.netPayablePaise) status = "PAID";
    else status = "PARTIALLY_PAID";
  }
  // Set paidAt on first transition to PAID; keep it if already PAID; clear it if voided back below PAID.
  const paidAt = status === "PAID" ? (settlement.status === "PAID" ? settlement.paidAt : deps.clock.now()) : null;

  const values = { amountPaidPaise, status, paidAt };
  await tx.update(salarySettlements).set(values).where(eq(salarySettlements.id, settlement.id));
  await recordAudit(tx, {
    householdId: membership.householdId, actorUserId, action: "settlement.payment_recomputed", entityType: "salary_settlement", entityId: settlement.id,
    oldValue: { amountPaidPaise: settlement.amountPaidPaise, status: settlement.status, paidAt: settlement.paidAt },
    newValue: values, ipAddress: ip ?? null,
  });
}

/**
 * Records a payment against a settlement. Rejects if the settlement is `CANCELLED`, or if the new
 * payment would push `amountPaidPaise` past `netPayablePaise` (no overpayment). Recomputes and
 * persists the settlement's `amountPaidPaise`/`status`/`paidAt` in the same transaction.
 */
export async function recordPayment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, settlementId: string, input: RecordPaymentInput, ip?: string,
): Promise<SalaryPaymentDTO> {
  const row = await deps.db.transaction(async (tx) => {
    const [settlement] = await tx.select().from(salarySettlements)
      .where(and(eq(salarySettlements.householdId, membership.householdId), eq(salarySettlements.id, settlementId)))
      .for("update");
    if (!settlement) throw Errors.notFound("Settlement");
    if (settlement.status === "CANCELLED") {
      throw Errors.validation({ settlementId: "This settlement is cancelled and cannot accept payments." });
    }

    const existingPaid = await tx.select({ amountPaise: salaryPayments.amountPaise }).from(salaryPayments)
      .where(and(
        eq(salaryPayments.householdId, membership.householdId),
        eq(salaryPayments.settlementId, settlementId),
        isNull(salaryPayments.voidedAt),
      ));
    const currentPaidPaise = sumPaise(existingPaid.map((p) => p.amountPaise));
    const prospectivePaidPaise = sumPaise([currentPaidPaise, input.amountPaise]);
    if (prospectivePaidPaise > settlement.netPayablePaise) {
      throw Errors.validation({ amountPaise: "This payment would exceed the amount payable for this settlement." });
    }

    const [inserted] = await tx.insert(salaryPayments).values({
      householdId: membership.householdId, househelpId: settlement.househelpId, settlementId,
      amountPaise: input.amountPaise, paidOn: input.paidOn, method: input.method,
      reference: input.reference ?? null, notes: input.notes ?? null, recordedByUserId: actorUserId,
    }).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "payment.recorded", entityType: "salary_payment", entityId: inserted!.id,
      newValue: inserted, ipAddress: ip ?? null,
    });

    await recomputeSettlementPaymentTotals(deps, tx, actorUserId, membership, settlement, ip);

    return inserted!;
  });

  return toPaymentDTO(row);
}

/**
 * Soft-deletes (`voidedAt`/`voidReason`) a payment, then recomputes and persists the settlement's
 * `amountPaidPaise`/`status`/`paidAt` the same way, in reverse — this is what unsticks a settlement
 * whose status would otherwise remain stuck at `PAID`/`PARTIALLY_PAID` after its payment is reversed.
 */
export async function voidPayment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, paymentId: string, reason?: string, ip?: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [payment] = await tx.select().from(salaryPayments)
      .where(and(eq(salaryPayments.householdId, membership.householdId), eq(salaryPayments.id, paymentId)))
      .for("update");
    if (!payment) throw Errors.notFound("Payment");
    if (payment.voidedAt) throw Errors.validation({ paymentId: "This payment has already been voided." });

    const [voided] = await tx.update(salaryPayments).set({ voidedAt: deps.clock.now(), voidReason: reason ?? null })
      .where(eq(salaryPayments.id, paymentId)).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "payment.voided", entityType: "salary_payment", entityId: paymentId,
      oldValue: payment, newValue: voided, ipAddress: ip ?? null,
    });

    const [settlement] = await tx.select().from(salarySettlements)
      .where(and(eq(salarySettlements.householdId, membership.householdId), eq(salarySettlements.id, payment.settlementId)))
      .for("update");
    if (!settlement) throw Errors.notFound("Settlement"); // defensive: FK guarantees this exists
    await recomputeSettlementPaymentTotals(deps, tx, actorUserId, membership, settlement, ip);
  });
}
