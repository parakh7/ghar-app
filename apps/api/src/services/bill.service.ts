import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { BillDTO, BillStatus, CreateBillInput, UpdateBillInput } from "@household/shared";
import { billCategories, bills } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { applyAmountChange, ensureOccurrences } from "./bill-occurrence.service.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type BillRow = typeof bills.$inferSelect;

function toBillDTO(row: BillRow): BillDTO {
  return {
    id: row.id, name: row.name, categoryId: row.categoryId, provider: row.provider, accountNumber: row.accountNumber,
    amountPaise: row.amountPaise, frequency: row.frequency, intervalCount: row.intervalCount, intervalUnit: row.intervalUnit,
    firstDueDate: row.firstDueDate, endDate: row.endDate, paymentMethod: row.paymentMethod, autopay: row.autopay,
    status: row.status, notes: row.notes, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireCategoryInHousehold(db: DbOrTx, householdId: string, categoryId: string): Promise<void> {
  const [row] = await db.select({ id: billCategories.id }).from(billCategories)
    .where(and(eq(billCategories.householdId, householdId), eq(billCategories.id, categoryId), isNull(billCategories.deletedAt)));
  if (!row) throw Errors.validation({ categoryId: "That category doesn't exist." });
}

export type ListBillsFilters = { status?: BillStatus; includeArchived?: boolean };

/**
 * With no `status` and no `includeArchived`, archived bills are hidden — the UI's primary list is
 * "bills I still manage". `status` is an exact match (so `?status=ARCHIVED` already works without
 * `includeArchived`); `includeArchived=true` is the escape hatch for "every status, in one request",
 * matching the `?includeArchived=true` convention every other list endpoint in this codebase uses.
 */
export async function listBills(deps: Deps, membership: Membership, filters: ListBillsFilters = {}): Promise<BillDTO[]> {
  const conditions = [eq(bills.householdId, membership.householdId)];
  if (filters.status) conditions.push(eq(bills.status, filters.status));
  else if (!filters.includeArchived) conditions.push(ne(bills.status, "ARCHIVED"));
  const rows = await deps.db.select().from(bills).where(and(...conditions)).orderBy(asc(bills.name));
  return rows.map(toBillDTO);
}

export async function getBill(deps: Deps, membership: Membership, billId: string): Promise<BillDTO> {
  const [row] = await deps.db.select().from(bills).where(and(eq(bills.householdId, membership.householdId), eq(bills.id, billId)));
  if (!row) throw Errors.notFound("Bill");
  return toBillDTO(row);
}

export async function createBill(deps: Deps, actorUserId: string, membership: Membership, input: CreateBillInput, ip?: string): Promise<BillDTO> {
  if (input.categoryId) await requireCategoryInHousehold(deps.db, membership.householdId, input.categoryId);
  const row = await deps.db.transaction(async (tx) => {
    const values: typeof bills.$inferInsert = {
      householdId: membership.householdId, name: input.name, categoryId: input.categoryId ?? null,
      provider: input.provider ?? null, accountNumber: input.accountNumber ?? null,
      amountPaise: input.amountPaise ?? null, frequency: input.frequency, intervalUnit: input.intervalUnit ?? null,
      firstDueDate: input.firstDueDate, endDate: input.endDate ?? null, paymentMethod: input.paymentMethod ?? null,
      autopay: input.autopay, notes: input.notes ?? null, status: "ACTIVE", createdByUserId: actorUserId,
    };
    // Omitted (rather than forced to a literal) so a non-CUSTOM bill relies on the column's own
    // default(1) instead of us re-asserting it — same gap the DB constraint already covers.
    if (input.intervalCount !== undefined) values.intervalCount = input.intervalCount;
    const [inserted] = await tx.insert(bills).values(values).returning();
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "bill.created", entityType: "bill", entityId: inserted!.id, newValue: { name: input.name, frequency: input.frequency }, ipAddress: ip ?? null });
    return inserted!;
  });
  // A brand-new bill has no occurrences yet; run outside the insert's own transaction (same
  // pattern as updateBill below) since ensureOccurrences opens its own. This is the ONLY call site
  // that ever passes `isInitialGeneration: true` — see ensureOccurrences's doc comment for why.
  await ensureOccurrences(deps, actorUserId, membership, row, true, ip);
  return toBillDTO(row);
}

export async function updateBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, patch: UpdateBillInput, ip?: string): Promise<BillDTO> {
  if (patch.categoryId) await requireCategoryInHousehold(deps.db, membership.householdId, patch.categoryId);
  // Same "did this patch touch the recurrence config" question updateBillSchema's own superRefine
  // asks (there: whether to require `frequency` alongside a config field) — here it decides whether
  // existing/future occurrences need resyncing to the new schedule.
  const configTouched = patch.frequency !== undefined || patch.intervalCount !== undefined || patch.intervalUnit !== undefined
    || patch.firstDueDate !== undefined || patch.endDate !== undefined;
  // Captured from inside the transaction below — used after it to decide whether the amount
  // ACTUALLY changed (not just whether the field was present in the request body; a client that
  // always resends every field, like a plain "save this form" PATCH, would otherwise retrigger
  // `applyAmountChange` on every edit, even one that never touched the amount).
  let beforeAmountPaise: number | null = null;
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(bills).where(and(eq(bills.householdId, membership.householdId), eq(bills.id, billId))).for("update");
    if (!before) throw Errors.notFound("Bill");
    beforeAmountPaise = before.amountPaise;

    // The schema's refine only catches endDate < firstDueDate when both arrive in the same patch;
    // this catches the case where only one of the pair is being changed against the other's stored value.
    const effectiveFirstDueDate = patch.firstDueDate ?? before.firstDueDate;
    const effectiveEndDate = patch.endDate !== undefined ? patch.endDate : before.endDate;
    if (effectiveEndDate && effectiveEndDate < effectiveFirstDueDate) {
      throw Errors.validation({ endDate: "End date must be on or after the first due date." });
    }

    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.categoryId !== undefined) changes.categoryId = patch.categoryId;
    if (patch.provider !== undefined) changes.provider = patch.provider;
    if (patch.accountNumber !== undefined) changes.accountNumber = patch.accountNumber;
    if (patch.amountPaise !== undefined) changes.amountPaise = patch.amountPaise;
    if (patch.firstDueDate !== undefined) changes.firstDueDate = patch.firstDueDate;
    if (patch.endDate !== undefined) changes.endDate = patch.endDate;
    if (patch.paymentMethod !== undefined) changes.paymentMethod = patch.paymentMethod;
    if (patch.autopay !== undefined) changes.autopay = patch.autopay;
    if (patch.notes !== undefined) changes.notes = patch.notes;
    // Changing frequency replaces the entire interval config block — a stale intervalUnit from a
    // past CUSTOM config must not survive a switch away from CUSTOM (same reasoning as checklist tasks).
    // intervalCount only resets to the canonical 1 on a GENUINE frequency change with no count given —
    // resending the bill's current frequency (e.g. a CUSTOM bill patched with only a new intervalUnit)
    // must not silently blow away an existing intervalCount the request never mentioned.
    if (patch.frequency !== undefined) {
      changes.frequency = patch.frequency;
      changes.intervalUnit = patch.intervalUnit ?? null;
      if (patch.intervalCount !== undefined) changes.intervalCount = patch.intervalCount;
      else if (patch.frequency !== before.frequency) changes.intervalCount = 1;
    }
    if (Object.keys(changes).length > 0) await tx.update(bills).set(changes).where(eq(bills.id, billId));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "bill.updated", entityType: "bill", entityId: billId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
    const [after] = await tx.select().from(bills).where(eq(bills.id, billId));
    return after!;
  });
  if (configTouched) await ensureOccurrences(deps, actorUserId, membership, row, false, ip);
  // A deliberate re-pricing (the household changed the bill's own amount) is handled separately from
  // `ensureOccurrences`'s schedule-resync — see `applyAmountChange`'s doc comment for why this
  // cascades (including overriding an earlier manual `updateOccurrenceAmount` correction) while a
  // routine resync must never touch an existing row's amount at all. Gated on the amount having
  // ACTUALLY changed vs. the stored value, not merely being present in the patch — a client that
  // resends every field on every save (e.g. a "save this form" PATCH that always includes
  // `amountPaise` even when only `name` changed) must not retrigger this.
  if (patch.amountPaise !== undefined && patch.amountPaise !== beforeAmountPaise) {
    await applyAmountChange(deps, actorUserId, membership, row, row.amountPaise ?? 0, ip);
  }
  return toBillDTO(row);
}

type Transition = { from: BillStatus[]; set: Partial<{ status: BillStatus; archivedAt: Date | null }>; action: string; conflictMessage: string };

/** Returns the bill's row after the transition — `resumeBill`/`unarchiveBill` need it to resync occurrences without an extra query. */
async function transitionBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, t: Transition, ip?: string): Promise<BillRow> {
  return deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(bills)
      .where(and(eq(bills.householdId, membership.householdId), eq(bills.id, billId)))
      .for("update");
    if (!before) throw Errors.notFound("Bill");
    if (!t.from.includes(before.status)) throw Errors.conflict(t.conflictMessage);
    await tx.update(bills).set(t.set).where(eq(bills.id, billId));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: t.action, entityType: "bill", entityId: billId, oldValue: { status: before.status }, newValue: t.set, ipAddress: ip ?? null });
    const [after] = await tx.select().from(bills).where(eq(bills.id, billId));
    return after!;
  });
}

export async function pauseBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, ip?: string): Promise<void> {
  await transitionBill(deps, actorUserId, membership, billId, {
    from: ["ACTIVE"], set: { status: "PAUSED" }, action: "bill.paused",
    conflictMessage: "Only an active bill can be paused.",
  }, ip);
}

/**
 * Resuming lands the bill back in ACTIVE — its schedule AND amount may have changed while paused
 * (both deferred then, same guard as `applyAmountChange` itself), so resync both now: the schedule
 * via `ensureOccurrences`, and the amount via `applyAmountChange` (using the bill's current
 * `amountPaise`, whatever it ended up being after however many edits happened while paused) so a
 * pending amount edit doesn't stay silently stale forever just because it landed while paused.
 */
export async function resumeBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, ip?: string): Promise<void> {
  const row = await transitionBill(deps, actorUserId, membership, billId, {
    from: ["PAUSED"], set: { status: "ACTIVE" }, action: "bill.resumed",
    conflictMessage: "Only a paused bill can be resumed.",
  }, ip);
  await ensureOccurrences(deps, actorUserId, membership, row, false, ip);
  await applyAmountChange(deps, actorUserId, membership, row, row.amountPaise ?? 0, ip);
}

export async function archiveBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, ip?: string): Promise<void> {
  await transitionBill(deps, actorUserId, membership, billId, {
    from: ["ACTIVE", "PAUSED"], set: { status: "ARCHIVED", archivedAt: deps.clock.now() }, action: "bill.archived",
    conflictMessage: "This bill is already archived.",
  }, ip);
}

/** Same reasoning as `resumeBill` — unarchiving also lands the bill back in ACTIVE. */
export async function unarchiveBill(deps: Deps, actorUserId: string, membership: Membership, billId: string, ip?: string): Promise<void> {
  const row = await transitionBill(deps, actorUserId, membership, billId, {
    from: ["ARCHIVED"], set: { status: "ACTIVE", archivedAt: null }, action: "bill.unarchived",
    conflictMessage: "Only an archived bill can be restored.",
  }, ip);
  await ensureOccurrences(deps, actorUserId, membership, row, false, ip);
  await applyAmountChange(deps, actorUserId, membership, row, row.amountPaise ?? 0, ip);
}
