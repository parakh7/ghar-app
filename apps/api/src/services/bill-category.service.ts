import { and, asc, eq, isNull } from "drizzle-orm";
import type { BillCategoryDTO } from "@household/shared";
import { billCategories } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function toBillCategoryDTO(row: { id: string; name: string; icon: string | null; sortOrder: number; isActive: boolean }): BillCategoryDTO {
  return { id: row.id, name: row.name, icon: row.icon, sortOrder: row.sortOrder, isActive: row.isActive };
}

export async function listBillCategories(db: DbOrTx, householdId: string): Promise<BillCategoryDTO[]> {
  const rows = await db.select({ id: billCategories.id, name: billCategories.name, icon: billCategories.icon, sortOrder: billCategories.sortOrder, isActive: billCategories.isActive })
    .from(billCategories)
    .where(and(eq(billCategories.householdId, householdId), isNull(billCategories.deletedAt)))
    .orderBy(asc(billCategories.sortOrder));
  return rows.map(toBillCategoryDTO);
}

export async function createBillCategory(deps: Deps, actorUserId: string, householdId: string, input: { name: string; icon?: string }, ip?: string): Promise<BillCategoryDTO> {
  try {
    const category = await deps.db.transaction(async (tx) => {
      // Locks every bill category row in the household for the duration of the insert — Postgres rejects
      // FOR UPDATE combined with an aggregate, so the max is computed in JS from the locked rows
      // (same pattern as moveBillCategory's locked ordered read, and countActiveOwners in member.service.ts).
      const existing = await tx.select({ sortOrder: billCategories.sortOrder }).from(billCategories)
        .where(eq(billCategories.householdId, householdId))
        .for("update");
      const maxSort = existing.reduce((max, r) => Math.max(max, r.sortOrder), -1);
      const [row] = await tx.insert(billCategories).values({ householdId, name: input.name, icon: input.icon ?? null, sortOrder: maxSort + 1 }).returning();
      await recordAudit(tx, { householdId, actorUserId, action: "bill_category.created", entityType: "bill_category", entityId: row!.id, newValue: { name: input.name, icon: input.icon ?? null }, ipAddress: ip ?? null });
      return row!;
    });
    return toBillCategoryDTO(category);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function updateBillCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, patch: { name?: string; icon?: string | null; isActive?: boolean }, ip?: string): Promise<BillCategoryDTO> {
  const changes: Partial<{ name: string; icon: string | null; isActive: boolean }> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.icon !== undefined) changes.icon = patch.icon;
  if (patch.isActive !== undefined) changes.isActive = patch.isActive;
  try {
    const updated = await deps.db.transaction(async (tx) => {
      const [before] = await tx.select({ name: billCategories.name, icon: billCategories.icon, isActive: billCategories.isActive })
        .from(billCategories)
        .where(and(eq(billCategories.householdId, householdId), eq(billCategories.id, categoryId), isNull(billCategories.deletedAt)))
        .for("update");
      if (!before) throw Errors.notFound("Bill category");
      await tx.update(billCategories).set(changes).where(eq(billCategories.id, categoryId));
      await recordAudit(tx, { householdId, actorUserId, action: "bill_category.updated", entityType: "bill_category", entityId: categoryId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
      const [row] = await tx.select({ id: billCategories.id, name: billCategories.name, icon: billCategories.icon, sortOrder: billCategories.sortOrder, isActive: billCategories.isActive })
        .from(billCategories).where(eq(billCategories.id, categoryId));
      return row!;
    });
    return toBillCategoryDTO(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function softDeleteBillCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(billCategories).set({ deletedAt: deps.clock.now() })
      .where(and(eq(billCategories.householdId, householdId), eq(billCategories.id, categoryId), isNull(billCategories.deletedAt)))
      .returning({ id: billCategories.id });
    if (!row) throw Errors.notFound("Bill category");
    await recordAudit(tx, { householdId, actorUserId, action: "bill_category.deleted", entityType: "bill_category", entityId: categoryId, ipAddress: ip ?? null });
  });
}

export async function moveBillCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, direction: "up" | "down", ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx.select({ id: billCategories.id, sortOrder: billCategories.sortOrder })
      .from(billCategories)
      .where(and(eq(billCategories.householdId, householdId), isNull(billCategories.deletedAt)))
      .orderBy(asc(billCategories.sortOrder))
      .for("update");
    const index = rows.findIndex((r) => r.id === categoryId);
    if (index === -1) throw Errors.notFound("Bill category");
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= rows.length) return; // already at the edge — no-op
    const a = rows[index]!;
    const b = rows[swapIndex]!;
    await tx.update(billCategories).set({ sortOrder: b.sortOrder }).where(eq(billCategories.id, a.id));
    await tx.update(billCategories).set({ sortOrder: a.sortOrder }).where(eq(billCategories.id, b.id));
    await recordAudit(tx, { householdId, actorUserId, action: "bill_category.moved", entityType: "bill_category", entityId: categoryId, newValue: { direction }, ipAddress: ip ?? null });
  });
}
