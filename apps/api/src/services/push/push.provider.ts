import type { Logger } from "../../lib/logger.js";

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; tag: string; linkPath: string | null };

/** Thrown when the push service itself reports the subscription is dead (HTTP 404/410) — the one
 *  error shape dispatch code special-cases to revoke the subscription instead of retrying. */
export class PushSendError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PushSendError";
  }
}

export interface PushProvider {
  send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void>;
}

/** Development: prints the push payload to the log instead of sending a real push. */
export class ConsolePushProvider implements PushProvider {
  constructor(private readonly logger: Logger) {}
  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    this.logger.info({ push: { endpoint: subscription.endpoint, title: payload.title } }, `🔔 ${payload.title}\n${payload.body}`);
  }
}

/** Tests: records every send; failNext lets a test simulate one endpoint failing or expiring. */
export class MemoryPushProvider implements PushProvider {
  readonly sent: Array<{ subscription: PushSubscriptionKeys; payload: PushPayload }> = [];
  private readonly failures = new Map<string, "error" | "expired">();
  failNext(endpoint: string, mode: "error" | "expired"): void {
    this.failures.set(endpoint, mode);
  }
  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    const mode = this.failures.get(subscription.endpoint);
    if (mode === "expired") throw new PushSendError("subscription expired", 410);
    if (mode === "error") throw new Error("push send failed");
    this.sent.push({ subscription, payload });
  }
}
