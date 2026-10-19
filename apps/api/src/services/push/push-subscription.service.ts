import { and, eq } from "drizzle-orm";
import type { PushSubscribeInput } from "@household/shared";
import { pushSubscriptions } from "../../db/schema.js";
import type { Deps } from "../deps.js";

export async function subscribe(deps: Deps, userId: string, input: PushSubscribeInput): Promise<void> {
  const now = deps.clock.now();
  await deps.db.insert(pushSubscriptions)
    .values({
      userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
      userAgent: input.userAgent ?? null, lastUsedAt: now, revokedAt: null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent ?? null, lastUsedAt: now, revokedAt: null, updatedAt: now },
    });
}

export async function unsubscribe(deps: Deps, userId: string, endpoint: string): Promise<void> {
  await deps.db.update(pushSubscriptions)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
}
