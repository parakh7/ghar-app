import type { DbOrTx } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

const SENSITIVE = new Set(["password", "passwordHash", "tokenHash", "token", "accountNumber"]);

function scrub(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrub);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.has(k) ? "[redacted]" : scrub(v)]));
}

export type AuditEntry = {
  householdId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
};

/** Pass the same `tx` as the change being audited so audit + change commit atomically. */
export async function recordAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    householdId: entry.householdId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    oldValue: entry.oldValue === undefined ? null : scrub(entry.oldValue),
    newValue: entry.newValue === undefined ? null : scrub(entry.newValue),
    ipAddress: entry.ipAddress ?? null,
  });
}
