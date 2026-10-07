import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
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
 * `date + 12 calendar months`, clamped (Jan 31 -> following Jan 31, or Jan 29 in a non-leap year).
 * Reuses `occurrenceDueDate`'s YEARLY-case month math (`sequence * 12` months) instead of
 * duplicating the clamped-month-addition logic that already lives in `@household/shared`.
 */
function oneYearOut(date: string): string {
  return occurrenceDueDate({ frequency: "YEARLY", intervalCount: 1, intervalUnit: null, firstDueDate: date }, 1);
}

/**
 * `date - 12 calendar months`. Reuses the same clamped month-math via the CUSTOM/"month" branch
 * with a negative sequence — `occurrenceDueDate`'s `addMonthsClamped` helper is explicitly written
 * to stay correct for a negative total ("the modulo is written defensively so it stays correct if
 * that ever changes"); this is that case.
 */
function oneYearAgo(date: string): string {
  return occurrenceDueDate({ frequency: "CUSTOM", intervalCount: 12, intervalUnit: "month", firstDueDate: date }, -1);
}

/**
 * Unlocked = still exactly what generation would produce and nothing real has happened to it yet:
 * PENDING, nothing paid, not yet due. Everything else — paid, waived, partially paid, or simply
 * due-or-past-due — is locked: a household member may already be relying on the amount/date shown,
 * so the generator must never rewrite or remove it, no matter how the bill's schedule changes later.
 */
function isUnlocked(row: OccurrenceRow, today: string): boolean {
  return row.status === "PENDING" && row.amountPaidPaise === 0 && row.dueDate > today;
}

/**
 * The due dates the bill's current rule produces, bounded to `[floor, horizon]` (both inclusive).
 * `floor: null` means unbounded below.
 *
 * ONE_TIME is exempt from `floor` entirely, regardless of what's passed: it only ever has ONE
 * possible occurrence (`firstDueDate` itself), so there is no "worst-case backfill size" for the
 * floor to bound — applying it here would mean a `ONE_TIME` bill whose `firstDueDate` is more than
 * floor-many months in the past silently generates zero occurrences, forever, with no recovery path.
 */
function ruleDatesWithin(bill: EnsureOccurrencesBillFields, floor: string | null, horizon: string): string[] {
  if (bill.frequency === "ONE_TIME") {
    return bill.firstDueDate <= horizon ? [bill.firstDueDate] : [];
  }
  const dates: string[] = [];
  for (let sequence = 0; ; sequence++) {
    const dueDate = occurrenceDueDate(bill, sequence);
    if (dueDate > horizon) break;
    if (floor === null || dueDate >= floor) dates.push(dueDate);
  }
  return dates;
}

/**
 * Idempotent sync: brings `bill_occurrences` for one bill in line with its current configuration,
 * out to a rolling 12-month horizon. No-op for a non-ACTIVE bill (PAUSED/ARCHIVED don't generate).
 *
 * Matches by DUE DATE, not by sequence number — sequence is a pure row-identity counter (assigned
 * once at insert, never reused, never meaningful as "position in the schedule"). Matching by
 * sequence was the original (buggy) design: once any occurrence locks (paid/waived) at some
 * sequence, a later frequency/firstDueDate change can never create a new row at that same slot
 * (the unique `(billId, sequence)` index already occupied), leaving a permanent hole. Matching by
 * date instead means a locked row simply keeps its own historical date forever, and the current
 * rule's dates are generated/removed independently of what sequence numbers happen to exist.
 *
 * `isInitialGeneration` must be `true` ONLY from `createBill`'s own call, immediately after insert —
 * every other caller (`updateBill`, `resumeBill`, `unarchiveBill`, the `/sync` route) passes `false`.
 * This used to be inferred from "does this bill have zero existing occurrences" — which is exploitable:
 * delete/age out every row for a bill that's already been generated once (e.g. shorten `endDate` into
 * the past) and the NEXT plain resync would be wrongly read as "first generation" again, backfilling
 * a fresh flood of overdue history from a passive, read-gated `/sync` call. Making it an explicit,
 * one-time flag tied to bill creation removes that path entirely.
 */
export async function ensureOccurrences(
  deps: Deps, actorUserId: string, membership: Membership, bill: EnsureOccurrencesBillFields, isInitialGeneration: boolean, ip?: string,
): Promise<void> {
  if (bill.status !== "ACTIVE") return;

  const today = dateInZone(deps.clock.now(), membership.timezone);
  const horizonCap = oneYearOut(today);
  const horizon = bill.endDate && bill.endDate < horizonCap ? bill.endDate : horizonCap;
  const amountDuePaise = bill.amountPaise ?? 0;

  await deps.db.transaction(async (tx) => {
    const existingRows = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, bill.householdId), eq(billOccurrences.billId, bill.id)));

    // Initial generation backfills overdue history (clamped to 12 months back for recurring
    // frequencies, so a very old `firstDueDate` can't produce an unbounded number of historical
    // rows — ONE_TIME is exempt from that floor, see `ruleDatesWithin`). Every other resync only
    // ever looks forward — a frequency correction (or a passive `/sync` call) shouldn't suddenly
    // manufacture a flood of newly-overdue bills.
    let neededDates = isInitialGeneration ? ruleDatesWithin(bill, oneYearAgo(today), horizon) : ruleDatesWithin(bill, null, horizon);
    if (!isInitialGeneration) neededDates = neededDates.filter((d) => d > today);
    const neededSet = new Set(neededDates);

    const unlockedByDate = new Map<string, OccurrenceRow>();
    const lockedDates = new Set<string>();
    let maxSequence = -1;
    for (const row of existingRows) {
      maxSequence = Math.max(maxSequence, row.sequence);
      if (isUnlocked(row, today)) unlockedByDate.set(row.dueDate, row);
      else lockedDates.add(row.dueDate);
    }

    let nextSequence = maxSequence + 1;
    let insertedCount = 0;
    let deletedCount = 0;
    let skippedDuplicateCount = 0;

    for (const dueDate of neededDates) {
      if (unlockedByDate.has(dueDate)) continue; // already exactly right — no write
      if (lockedDates.has(dueDate)) { skippedDuplicateCount += 1; continue; } // history already covers this date
      await tx.insert(billOccurrences).values({
        householdId: bill.householdId, billId: bill.id, sequence: nextSequence, dueDate, amountDuePaise, status: "PENDING",
      });
      nextSequence += 1;
      insertedCount += 1;
    }

    for (const [dueDate, row] of unlockedByDate) {
      if (neededSet.has(dueDate)) continue;
      await tx.delete(billOccurrences).where(eq(billOccurrences.id, row.id));
      deletedCount += 1;
    }

    if (insertedCount > 0 || deletedCount > 0) {
      await recordAudit(tx, {
        householdId: bill.householdId, actorUserId, action: "bill.occurrencesSynced", entityType: "bill", entityId: bill.id,
        newValue: { inserted: insertedCount, deleted: deletedCount, skippedDuplicate: skippedDuplicateCount }, ipAddress: ip ?? null,
      });
    }
  });
}

/**
 * A deliberate re-pricing, distinct from `ensureOccurrences`'s "never touch `amountDuePaise` on an
 * existing row" rule. That rule exists to stop an INCIDENTAL resync — a frequency/date change, a
 * pause/resume, the passive `/sync` endpoint — from clobbering a human's manual
 * `updateOccurrenceAmount` correction. It was never meant to mean a bill's amount can never
 * propagate to its own occurrences at all. Changing the bill's `amountPaise` is the household
 * directly and explicitly re-pricing the bill, so it's expected (and here, unconditional) to
 * cascade — including overriding an earlier manual correction — to every occurrence still open to
 * change: `PENDING`, nothing paid, not yet due. Locked (paid/partial/waived) and past-due
 * occurrences are untouched, same protection as everywhere else in this feature.
 *
 * No-op for a non-ACTIVE bill, same guard `ensureOccurrences` opens with — every other kind of edit
 * on a PAUSED/ARCHIVED bill is deferred until it's resumed/unarchived (which already calls
 * `ensureOccurrences` again), so an amount edit shouldn't be the one exception that rewrites
 * existing rows immediately while the bill is otherwise frozen.
 */
export async function applyAmountChange(
  deps: Deps, actorUserId: string, membership: Membership, bill: { id: string; householdId: string; status: BillStatus }, amountDuePaise: number, ip?: string,
): Promise<void> {
  if (bill.status !== "ACTIVE") return;

  const today = dateInZone(deps.clock.now(), membership.timezone);
  await deps.db.transaction(async (tx) => {
    const candidates = await tx.select().from(billOccurrences).where(and(
      eq(billOccurrences.householdId, bill.householdId), eq(billOccurrences.billId, bill.id),
      eq(billOccurrences.status, "PENDING"), eq(billOccurrences.amountPaidPaise, 0),
    ));
    const targetIds = candidates.filter((row) => row.dueDate > today && row.amountDuePaise !== amountDuePaise).map((row) => row.id);
    if (targetIds.length === 0) return;

    await tx.update(billOccurrences).set({ amountDuePaise }).where(inArray(billOccurrences.id, targetIds));
    await recordAudit(tx, {
      householdId: bill.householdId, actorUserId, action: "bill.occurrenceAmountsRepriced", entityType: "bill", entityId: bill.id,
      newValue: { amountDuePaise, count: targetIds.length }, ipAddress: ip ?? null,
    });
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
  // Sequence no longer tracks schedule position (dates can be matched/inserted/deleted independently
  // of it), so ordering by it alone could show a locked historical row out of chronological order
  // next to freshly-generated ones. Date first, sequence only as the (never actually reached)
  // tiebreak for two rows sharing a due date.
  const rows = await deps.db.select().from(billOccurrences).where(and(...conditions))
    .orderBy(asc(billOccurrences.dueDate), asc(billOccurrences.sequence));
  return rows.map(toOccurrenceDTO);
}

/**
 * Scoped by `(householdId, billId, occurrenceId)` — the `billId` check exists purely so the URL's
 * `:id` segment can't lie about which bill it's touching (the occurrence is already unambiguous
 * once household-scoped, same as `salary/payments/:paymentId` not re-requiring its parent
 * settlement id, but a mismatched `billId` here would silently mutate a different bill's
 * occurrence than the one named in the request path).
 */
export async function updateOccurrenceAmount(
  deps: Deps, actorUserId: string, membership: Membership, billId: string, occurrenceId: string, input: UpdateOccurrenceAmountInput, ip?: string,
): Promise<BillOccurrenceDTO> {
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(billOccurrences)
      .where(and(eq(billOccurrences.householdId, membership.householdId), eq(billOccurrences.id, occurrenceId)))
      .for("update");
    if (!before || before.billId !== billId) throw Errors.notFound("Occurrence");
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
