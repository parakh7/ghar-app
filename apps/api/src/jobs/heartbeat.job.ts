import { recordAudit } from "../services/audit.service.js";
import type { Deps } from "../services/deps.js";

/**
 * Throwaway proof-of-life job: no real work, just an auditable row written through the
 * full queue pipeline. `householdId`/`actorUserId` are both null — there's no household
 * or human actor behind a system-scheduled tick, matching how `actorUserId` already
 * tolerates `null` elsewhere (e.g. after a user is deleted, via `onDelete: "set null"`).
 */
export async function runHeartbeat(deps: Deps): Promise<void> {
  await recordAudit(deps.db, {
    householdId: null,
    actorUserId: null,
    action: "system.heartbeat",
    entityType: "system",
    // `.toISOString()`, not a raw Date: `recordAudit`'s scrub() walks plain objects via
    // `Object.entries`, which silently flattens a Date's (non-enumerable) fields to `{}`.
    newValue: { ranAt: deps.clock.now().toISOString() },
  });
}
