import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { BillOccurrenceDTO, BillFrequency, BillStatus, OccurrenceStatus, UpdateOccurrenceAmountInput } from "@household/shared";
import { dateInZone, occurrenceDueDate } from "@household/shared";
import { bills, billOccurrences } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type OccurrenceRow = typeof billOccurrences.$inferSelect;

/** The subset of a bill's columns `ensureOccurrences` needs — matches `bill.service.ts`'s `BillRow` shape structurally. */
export type EnsureOccurrencesBillFields = {
  id: string;
  householdId: string;
  status: BillStatus;
  frequency: BillFrequency;
  intervalCount: number;
  intervalUnit: string | null;
  firstDueDate: string;
  endDate: string | null;
  amountPaise: number | null;
};

function toOccurrenceDTO(row: OccurrenceRow): BillOccurrenceDTO {
  return {
    id: row.id, billId: row.billId, sequence: row.sequence, dueDate: row.dueDate,
    amountDuePaise: row.amountDuePaise, amountPaidPaise: row.amountPaidPaise, status: row.status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null, waivedAt: row.waivedAt ? row.waivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireBillInHousehold(db: DbOrTx, householdId: string, billId: string): Promise<void> {
  const [row] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.householdId, householdId), eq(bills.id, billId)));
  if (!row) throw Errors.notFound("Bill");
}

/**
 * Loads the columns `ensureOccurrences` needs for a bill the route layer only has an id for
 * (the `POST .../occurrences/sync` endpoint) — `createBill`/`updateBill` already hold the full
 * row from their own transaction and pass it straight through instead of calling this.
 */
export async function requireBillForSync(deps: Deps, membership: Membership, billId: string): Promise<EnsureOccurrencesBillFields> {
  const [row] = await deps.db.select({
    id: bills.id, householdId: bills.householdId, status: bills.status, frequency: bills.frequency,
    intervalCount: bills.intervalCount, intervalUnit: bills.intervalUnit, firstDueDate: bills.firstDueDate,
    endDate: bills.endDate, amountPaise: bills.amountPaise,
  }).from(bills).where(and(eq(bills.householdId, membership.householdId), eq(bills.id, billId)));
  if (!row) throw Errors.notFound("Bill");
  return row;
}

/**
 * `today + 12 calendar months`, clamped (Jan 31 -> following Jan 31, or Jan 29 in a non-leap year).
 * Reuses `occurrenceDueDate`'s YEARLY-case month math (`sequence * 12` months) instead of
 * duplicating the clamped-month-addition logic that already lives in `@household/shared`.
 */
function oneYearOut(date: string): string {
  return occurrenceDueDate({ frequency: "YEARLY", intervalCount: 1, intervalUnit: null, firstDueDate: date }, 1);
}

/**
 * A row is safe for the generator to touch (update in place, or delete when it falls outside the
 * newly-computed range) only while it's still exactly what generation produced and nothing real
 * has happened to it yet: still PENDING, nothing paid against it, and not yet due. Once any of
 * those stop holding — paid, waived, partially paid, or simply due-or-past-due — it's locked:
 * a household member may have already relied on the amount/date shown, so edits to the bill's
 * schedule going forward must never silently rewrite or remove it.
 */
function isGeneratorOwned(row: OccurrenceRow, today: string): boolean {
  return row.status === "PENDING" && row.amountPaidPaise === 0 && row.dueDate > today;
}

/**
 * Idempotent sync: brings `bill_occurrences` for one bill in line with its current configuration,
 * out to a rolling horizon. No-op for a non-ACTIVE bill (PAUSED/ARCHIVED bills don't generate).
 */
export async function ensureOccurrences(deps: Deps, membership: Membership, bill: EnsureOccurrencesBillFields): Promise<void> {
  if (bill.status !== "ACTIVE") return;

  const today = dateInZone(deps.clock.now(), membership.timezone);
  const horizonCap = oneYearOut(today);
  const horizon = bill.endDate && bill.endDate < horizonCap ? bill.endDate : horizonCap;

  const needed = new Map<number, string>();
  if (bill.frequency === "ONE_TIME") {
    if (bill.firstDueDate <= horizon) needed.set(0, bill.firstDueDate);
  } else {
    for (let sequence = 0; ; sequence++) {
      const dueDate = occurrenceDueDate(bill, sequence);
      if (dueDate > horizon) break;
      needed.set(sequence, dueDate);
    }
  }

  const amountDuePaise = bill.amountPaise ?? 0;

  await deps.db.transaction(async (tx) => {
    const existingRows = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, bill.householdId), eq(billOccurrences.billId, bill.id)));
    const existingBySequence = new Map(existingRows.map((row) => [row.sequence, row]));

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    for (const [sequence, dueDate] of needed) {
      const existing = existingBySequence.get(sequence);
      if (!existing) {
        await tx.insert(billOccurrences).values({
          householdId: bill.householdId, billId: bill.id, sequence, dueDate, amountDuePaise, status: "PENDING",
        });
        insertedCount += 1;
        continue;
      }
      if (isGeneratorOwned(existing, today) && (existing.dueDate !== dueDate || existing.amountDuePaise !== amountDuePaise)) {
        await tx.update(billOccurrences).set({ dueDate, amountDuePaise }).where(eq(billOccurrences.id, existing.id));
        updatedCount += 1;
      }
    }

    for (const [sequence, existing] of existingBySequence) {
      if (needed.has(sequence)) continue;
      if (isGeneratorOwned(existing, today)) {
        await tx.delete(billOccurrences).where(eq(billOccurrences.id, existing.id));
        deletedCount += 1;
      }
    }

    // System-triggered (no single human actor — `createBill`/`updateBill` already recorded their
    // own `bill.created`/`bill.updated` entry for the actor's edit); one summary entry per call,
    // not one per row.
    if (insertedCount > 0 || updatedCount > 0 || deletedCount > 0) {
      await recordAudit(tx, {
        householdId: bill.householdId, actorUserId: null, action: "bill.occurrencesSynced", entityType: "bill", entityId: bill.id,
        newValue: { inserted: insertedCount, updated: updatedCount, deleted: deletedCount },
      });
    }
  });
}

export type ListOccurrencesFilters = { status?: OccurrenceStatus; from?: string; to?: string };

export async function listOccurrences(
  deps: Deps, membership: Membership, billId: string, filters: ListOccurrencesFilters = {},
): Promise<BillOccurrenceDTO[]> {
  await requireBillInHousehold(deps.db, membership.householdId, billId);
  const conditions = [eq(billOccurrences.householdId, membership.householdId), eq(billOccurrences.billId, billId)];
  if (filters.status) conditions.push(eq(billOccurrences.status, filters.status));
  if (filters.from) conditions.push(gte(billOccurrences.dueDate, filters.from));
  if (filters.to) conditions.push(lte(billOccurrences.dueDate, filters.to));
  const rows = await deps.db.select().from(billOccurrences).where(and(...conditions)).orderBy(asc(billOccurrences.sequence));
  return rows.map(toOccurrenceDTO);
}

/**
 * Scoped by `(householdId, occurrenceId)` only, not also the bill — an occurrence id is already
 * unambiguous once household-scoped, matching how `salary/payments/:paymentId` doesn't re-require
 * its parent settlement id either.
 */
export async function updateOccurrenceAmount(
  deps: Deps, actorUserId: string, membership: Membership, occurrenceId: string, input: UpdateOccurrenceAmountInput, ip?: string,
): Promise<BillOccurrenceDTO> {
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, membership.householdId), eq(billOccurrences.id, occurrenceId)))
      .for("update");
    if (!before) throw Errors.notFound("Occurrence");
    if (before.status !== "PENDING") throw Errors.validation({ amountDuePaise: "Only a pending occurrence's amount can be changed." });

    const [updated] = await tx.update(billOccurrences).set({ amountDuePaise: input.amountDuePaise })
      .where(eq(billOccurrences.id, occurrenceId)).returning();
    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "bill.occurrenceAmountUpdated", entityType: "bill_occurrence", entityId: occurrenceId,
      oldValue: { amountDuePaise: before.amountDuePaise }, newValue: { amountDuePaise: input.amountDuePaise }, ipAddress: ip ?? null,
    });
    return updated!;
  });
  return toOccurrenceDTO(row);
}
