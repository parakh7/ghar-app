import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { CreateHousehelpInput, HousehelpDTO, UpdateHousehelpInput } from "@household/shared";
import { househelpCategoryLinks, househelps } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

type HousehelpRow = typeof househelps.$inferSelect;

function toHousehelpDTO(row: HousehelpRow, categoryIds: string[]): HousehelpDTO {
  return {
    id: row.id, name: row.name, phone: row.phone, roleTitle: row.roleTitle,
    status: row.status, startDate: row.startDate, endDate: row.endDate, salaryMode: row.salaryMode,
    monthlySalaryPaise: row.monthlySalaryPaise, dailyRatePaise: row.dailyRatePaise, halfDayRatePaise: row.halfDayRatePaise,
    salaryDueDay: row.salaryDueDay, notes: row.notes, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    categoryIds, createdAt: row.createdAt.toISOString(),
  };
}

async function categoryIdsFor(db: DbOrTx, householdId: string, househelpId: string): Promise<string[]> {
  const rows = await db.select({ categoryId: househelpCategoryLinks.categoryId }).from(househelpCategoryLinks)
    .where(and(eq(househelpCategoryLinks.householdId, householdId), eq(househelpCategoryLinks.househelpId, househelpId)));
  return rows.map((r) => r.categoryId);
}

export async function listHousehelps(db: DbOrTx, householdId: string, includeArchived = false): Promise<HousehelpDTO[]> {
  const rows = await db.select().from(househelps)
    .where(includeArchived ? eq(househelps.householdId, householdId) : and(eq(househelps.householdId, householdId), isNull(househelps.archivedAt)))
    .orderBy(asc(househelps.name));
  if (rows.length === 0) return [];
  const links = await db.select({ househelpId: househelpCategoryLinks.househelpId, categoryId: househelpCategoryLinks.categoryId })
    .from(househelpCategoryLinks)
    .where(and(eq(househelpCategoryLinks.householdId, householdId), inArray(househelpCategoryLinks.househelpId, rows.map((r) => r.id))));
  const byHousehelp = new Map<string, string[]>();
  for (const l of links) byHousehelp.set(l.househelpId, [...(byHousehelp.get(l.househelpId) ?? []), l.categoryId]);
  return rows.map((r) => toHousehelpDTO(r, byHousehelp.get(r.id) ?? []));
}

export async function getHousehelp(db: DbOrTx, householdId: string, id: string): Promise<HousehelpDTO> {
  const [row] = await db.select().from(househelps).where(and(eq(househelps.householdId, householdId), eq(househelps.id, id))).limit(1);
  if (!row) throw Errors.notFound("Househelp");
  return toHousehelpDTO(row, await categoryIdsFor(db, householdId, id));
}

export async function createHousehelp(deps: Deps, actorUserId: string, householdId: string, input: CreateHousehelpInput, ip?: string): Promise<HousehelpDTO> {
  const { categoryIds = [], ...fields } = input;
  const row = await deps.db.transaction(async (tx) => {
    const [inserted] = await tx.insert(househelps).values({ householdId, ...fields }).returning();
    if (categoryIds.length > 0) {
      await tx.insert(househelpCategoryLinks).values(categoryIds.map((categoryId) => ({ householdId, househelpId: inserted!.id, categoryId })));
    }
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.created", entityType: "househelp", entityId: inserted!.id, newValue: { name: fields.name }, ipAddress: ip ?? null });
    return inserted!;
  });
  return toHousehelpDTO(row, categoryIds);
}

export async function updateHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, patch: UpdateHousehelpInput, ip?: string): Promise<HousehelpDTO> {
  const { categoryIds, ...fields } = patch;
  const row = await deps.db.transaction(async (tx) => {
    const [before] = await tx.select().from(househelps).where(and(eq(househelps.householdId, householdId), eq(househelps.id, id))).for("update");
    if (!before) throw Errors.notFound("Househelp");
    const changes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length > 0) await tx.update(househelps).set(changes).where(eq(househelps.id, id));
    if (categoryIds !== undefined) {
      await tx.delete(househelpCategoryLinks).where(and(eq(househelpCategoryLinks.householdId, householdId), eq(househelpCategoryLinks.househelpId, id)));
      if (categoryIds.length > 0) await tx.insert(househelpCategoryLinks).values(categoryIds.map((categoryId) => ({ householdId, househelpId: id, categoryId })));
    }
    await recordAudit(tx, {
      householdId, actorUserId, action: "househelp.updated", entityType: "househelp", entityId: id,
      oldValue: before, newValue: { ...changes, ...(categoryIds !== undefined ? { categoryIds } : {}) }, ipAddress: ip ?? null,
    });
    const [after] = await tx.select().from(househelps).where(eq(househelps.id, id));
    return after!;
  });
  const finalCategoryIds = categoryIds !== undefined ? categoryIds : await categoryIdsFor(deps.db, householdId, id);
  return toHousehelpDTO(row, finalCategoryIds);
}

export async function archiveHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelps).set({ archivedAt: deps.clock.now() })
      .where(and(eq(househelps.householdId, householdId), eq(househelps.id, id), isNull(househelps.archivedAt)))
      .returning({ id: househelps.id });
    if (!row) throw Errors.notFound("Househelp");
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.archived", entityType: "househelp", entityId: id, ipAddress: ip ?? null });
  });
}

export async function unarchiveHousehelp(deps: Deps, actorUserId: string, householdId: string, id: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(househelps).set({ archivedAt: null })
      .where(and(eq(househelps.householdId, householdId), eq(househelps.id, id)))
      .returning({ id: househelps.id });
    if (!row) throw Errors.notFound("Househelp");
    await recordAudit(tx, { householdId, actorUserId, action: "househelp.unarchived", entityType: "househelp", entityId: id, ipAddress: ip ?? null });
  });
}
