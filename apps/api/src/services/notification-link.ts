import { eq } from "drizzle-orm";
import { billOccurrences } from "../db/schema.js";
import type { Deps } from "./deps.js";

/**
 * BILL notifications store the bill OCCURRENCE id as entityId (set by evaluate-reminders.job.ts),
 * but the only bill detail route is /bills/:billId. Resolved here, at read time, rather than
 * touching the job's write-time shape or adding a migration — a SALARY row's entityId already IS
 * the settlement id the /salary/:id route expects, so it passes through unchanged.
 */
export async function resolveLinkPath(deps: Deps, row: { entityType: string | null; entityId: string | null }): Promise<string | null> {
  if (row.entityType === "bill_occurrence" && row.entityId) {
    const [occ] = await deps.db.select({ billId: billOccurrences.billId }).from(billOccurrences).where(eq(billOccurrences.id, row.entityId));
    return occ ? `/bills/${occ.billId}` : null;
  }
  if (row.entityType === "salary_settlement" && row.entityId) {
    return `/salary/${row.entityId}`;
  }
  return null;
}
