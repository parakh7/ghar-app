import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { CategoryDTO } from "@household/shared";
import { househelpCategories } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function toCategoryDTO(row: { id: string; name: string; sortOrder: number; isActive: boolean }): CategoryDTO {
  return { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive };
}

export async function listCategories(db: DbOrTx, householdId: string): Promise<CategoryDTO[]> {
  const rows = await db.select({ id: househelpCategories.id, name: househelpCategories.name, sortOrder: househelpCategories.sortOrder, isActive: househelpCategories.isActive })
    .from(househelpCategories)
    .where(and(eq(househelpCategories.householdId, householdId), isNull(househelpCategories.deletedAt)))
    .orderBy(asc(househelpCategories.sortOrder));
  return rows.map(toCategoryDTO);
}

export async function createCategory(deps: Deps, actorUserId: string, householdId: string, input: { name: string }, ip?: string): Promise<CategoryDTO> {
  try {
    const category = await deps.db.transaction(async (tx) => {
      const [{ maxSort } = { maxSort: -1 }] = await tx
        .select({ maxSort: sql<number>`coalesce(max(${househelpCategories.sortOrder}), -1)` })
        .from(househelpCategories)
        .where(eq(househelpCategories.householdId, householdId));
      const [row] = await tx.insert(househelpCategories).values({ householdId, name: input.name, sortOrder: Number(maxSort) + 1 }).returning();
      await recordAudit(tx, { householdId, actorUserId, action: "category.created", entityType: "househelp_category", entityId: row!.id, newValue: { name: input.name }, ipAddress: ip ?? null });
      return row!;
    });
    return toCategoryDTO(category);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function updateCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, patch: { name?: string; isActive?: boolean }, ip?: string): Promise<CategoryDTO> {
  const changes: Partial<{ name: string; isActive: boolean }> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.isActive !== undefined) changes.isActive = patch.isActive;
  try {
    const updated = await deps.db.transaction(async (tx) => {
      const [before] = await tx.select({ name: househelpCategories.name, isActive: househelpCategories.isActive })
        .from(househelpCategories)
        .where(and(eq(househelpCategories.householdId, householdId), eq(househelpCategories.id, categoryId), isNull(househelpCategories.deletedAt)))
        .for("update");
      if (!before) throw Errors.notFound("Category");
      await tx.update(househelpCategories).set(changes).where(eq(househelpCategories.id, categoryId));
      await recordAudit(tx, { householdId, actorUserId, action: "category.updated", entityType: "househelp_category", entityId: categoryId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
      const [row] = await tx.select({ id: househelpCategories.id, name: househelpCategories.name, sortOrder: househelpCategories.sortOrder, isActive: househelpCategories.isActive })
        .from(househelpCategories).where(eq(househelpCategories.id, categoryId));
      return row!;
    });
    return toCategoryDTO(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("A category with this name already exists.");
    throw err;
  }
}

export async function softDeleteCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelpCategories).set({ deletedAt: deps.clock.now() })
      .where(and(eq(househelpCategories.householdId, householdId), eq(househelpCategories.id, categoryId), isNull(househelpCategories.deletedAt)))
      .returning({ id: househelpCategories.id });
    if (!row) throw Errors.notFound("Category");
    await recordAudit(tx, { householdId, actorUserId, action: "category.deleted", entityType: "househelp_category", entityId: categoryId, ipAddress: ip ?? null });
  });
}

export async function moveCategory(deps: Deps, actorUserId: string, householdId: string, categoryId: string, direction: "up" | "down", ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx.select({ id: househelpCategories.id, sortOrder: househelpCategories.sortOrder })
      .from(househelpCategories)
      .where(and(eq(househelpCategories.householdId, householdId), isNull(househelpCategories.deletedAt)))
      .orderBy(asc(househelpCategories.sortOrder))
      .for("update");
    const index = rows.findIndex((r) => r.id === categoryId);
    if (index === -1) throw Errors.notFound("Category");
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= rows.length) return; // already at the edge — no-op
    const a = rows[index]!;
    const b = rows[swapIndex]!;
    await tx.update(househelpCategories).set({ sortOrder: b.sortOrder }).where(eq(househelpCategories.id, a.id));
    await tx.update(househelpCategories).set({ sortOrder: a.sortOrder }).where(eq(househelpCategories.id, b.id));
    await recordAudit(tx, { householdId, actorUserId, action: "category.moved", entityType: "househelp_category", entityId: categoryId, newValue: { direction }, ipAddress: ip ?? null });
  });
}
