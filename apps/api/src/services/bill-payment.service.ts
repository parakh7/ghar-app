import { and, eq, isNull } from "drizzle-orm";
import type { BillPaymentDTO, OccurrenceStatus, Permission, RecordBillPaymentInput } from "@household/shared";
import { sumPaise } from "@household/shared";
import { billOccurrences, billPayments } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };
type OccurrenceRow = typeof billOccurrences.$inferSelect;
type PaymentRow = typeof billPayments.$inferSelect;

function toPaymentDTO(row: PaymentRow): BillPaymentDTO {
  return {
    id: row.id, occurrenceId: row.occurrenceId, amountPaise: row.amountPaise, paidOn: row.paidOn, method: row.method,
    transactionRef: row.transactionRef, notes: row.notes,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null, voidReason: row.voidReason, createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Re-sums all non-voided payments for `occurrence` and persists the derived `amountPaidPaise`/
 * `status`/`paidAt` onto it, in the same transaction as the payment insert/void that triggered it.
 * Mirrors `salary-payment.service.ts`'s `recomputeSettlementPaymentTotals` exactly (see that file's
 * doc comment for why this must happen atomically with the triggering write in BOTH directions).
 *
 * `WAIVED` occurrences are left alone — mirroring how salary's version leaves `CANCELLED` settlements
 * alone. In practice this is defensive rather than load-bearing: `recordPayment` already refuses to
 * touch a `WAIVED` occurrence, and `waiveOccurrence` only accepts a `PENDING` (unpaid) occurrence, so
 * no payment can exist against one that's currently `WAIVED`. Kept anyway for the same reason the
 * salary-side guard is kept: so this recompute can never flip a locked status back to something
 * payment-derived no matter how the surrounding rules evolve later.
 */
async function recomputeOccurrencePaymentTotals(
  deps: Deps, tx: DbOrTx, actorUserId: string, membership: AuthedMembership, occurrence: OccurrenceRow, ip?: string,
): Promise<void> {
  const rows = await tx.select({ amountPaise: billPayments.amountPaise }).from(billPayments)
    .where(and(
      eq(billPayments.householdId, membership.householdId),
      eq(billPayments.occurrenceId, occurrence.id),
      isNull(billPayments.voidedAt),
    ));
  const amountPaidPaise = sumPaise(rows.map((r) => r.amountPaise));

  let status: OccurrenceStatus = occurrence.status;
  if (status !== "WAIVED") {
    if (amountPaidPaise <= 0) status = "PENDING";
    else if (amountPaidPaise >= occurrence.amountDuePaise) status = "PAID";
    else status = "PARTIALLY_PAID";
  }
  // Set paidAt on first transition to PAID; keep it if already PAID; clear it if voided back below PAID.
  const paidAt = status === "PAID" ? (occurrence.status === "PAID" ? occurrence.paidAt : deps.clock.now()) : null;

  const values = { amountPaidPaise, status, paidAt };
  await tx.update(billOccurrences).set(values).where(eq(billOccurrences.id, occurrence.id));
  await recordAudit(tx, {
    householdId: membership.householdId, actorUserId, action: "bill.occurrencePaymentRecomputed", entityType: "bill_occurrence", entityId: occurrence.id,
    oldValue: { amountPaidPaise: occurrence.amountPaidPaise, status: occurrence.status, paidAt: occurrence.paidAt },
    newValue: values, ipAddress: ip ?? null,
  });
}

/**
 * Records a payment against a bill occurrence. Rejects if the occurrence is `WAIVED`, or if the new
 * payment would push `amountPaidPaise` past `amountDuePaise` (no overpayment). Recomputes and
 * persists the occurrence's `amountPaidPaise`/`status`/`paidAt` in the same transaction.
 *
 * Scoped by `(householdId, billId, occurrenceId)` — the `billId` check exists purely so the URL's
 * `:id` segment can't lie about which bill it's touching, same as `updateOccurrenceAmount` in
 * `bill-occurrence.service.ts` (see its doc comment for the full reasoning).
 */
export async function recordPayment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, billId: string, occurrenceId: string, input: RecordBillPaymentInput, ip?: string,
): Promise<BillPaymentDTO> {
  const row = await deps.db.transaction(async (tx) => {
    const [occurrence] = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, membership.householdId), eq(billOccurrences.id, occurrenceId)))
      .for("update");
    if (!occurrence || occurrence.billId !== billId) throw Errors.notFound("Occurrence");
    if (occurrence.status === "WAIVED") {
      throw Errors.validation({ occurrenceId: "This occurrence has been waived and cannot accept payments." });
    }

    const existingPaid = await tx.select({ amountPaise: billPayments.amountPaise }).from(billPayments)
      .where(and(
        eq(billPayments.householdId, membership.householdId),
        eq(billPayments.occurrenceId, occurrenceId),
        isNull(billPayments.voidedAt),
      ));
    const currentPaidPaise = sumPaise(existingPaid.map((p) => p.amountPaise));
    const prospectivePaidPaise = sumPaise([currentPaidPaise, input.amountPaise]);
    if (prospectivePaidPaise > occurrence.amountDuePaise) {
      throw Errors.validation({ amountPaise: "This payment would exceed the amount due for this occurrence." });
    }

    const [inserted] = await tx.insert(billPayments).values({
      householdId: membership.householdId, billId: occurrence.billId, occurrenceId,
      amountPaise: input.amountPaise, paidOn: input.paidOn, method: input.method,
      transactionRef: input.transactionRef ?? null, notes: input.notes ?? null, recordedByUserId: actorUserId,
    }).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "bill.paymentRecorded", entityType: "bill_payment", entityId: inserted!.id,
      newValue: inserted, ipAddress: ip ?? null,
    });

    await recomputeOccurrencePaymentTotals(deps, tx, actorUserId, membership, occurrence, ip);

    return inserted!;
  });

  return toPaymentDTO(row);
}

/**
 * Soft-deletes (`voidedAt`/`voidReason`) a payment, then recomputes and persists the occurrence's
 * `amountPaidPaise`/`status`/`paidAt` the same way, in reverse — this is what unsticks an occurrence
 * whose status would otherwise remain stuck at `PAID`/`PARTIALLY_PAID` after its payment is reversed.
 *
 * Scoped by `(householdId, billId, occurrenceId, paymentId)` — `billId`/`occurrenceId` are checked
 * against the payment's own stored columns (it carries both FKs directly) for the same reason
 * `recordPayment`/`updateOccurrenceAmount` check `billId`: the URL's parent segments shouldn't be
 * able to lie about which bill/occurrence a payment belongs to.
 */
export async function voidPayment(
  deps: Deps, actorUserId: string, membership: AuthedMembership, billId: string, occurrenceId: string, paymentId: string, reason?: string, ip?: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [payment] = await tx.select().from(billPayments)
      .where(and(eq(billPayments.householdId, membership.householdId), eq(billPayments.id, paymentId)))
      .for("update");
    if (!payment || payment.billId !== billId || payment.occurrenceId !== occurrenceId) throw Errors.notFound("Payment");
    if (payment.voidedAt) throw Errors.validation({ paymentId: "This payment has already been voided." });

    const [voided] = await tx.update(billPayments).set({ voidedAt: deps.clock.now(), voidReason: reason ?? null })
      .where(eq(billPayments.id, paymentId)).returning();

    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "bill.paymentVoided", entityType: "bill_payment", entityId: paymentId,
      oldValue: payment, newValue: voided, ipAddress: ip ?? null,
    });

    const [occurrence] = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, membership.householdId), eq(billOccurrences.id, payment.occurrenceId)))
      .for("update");
    if (!occurrence) throw Errors.notFound("Occurrence"); // defensive: FK guarantees this exists
    await recomputeOccurrencePaymentTotals(deps, tx, actorUserId, membership, occurrence, ip);
  });
}
