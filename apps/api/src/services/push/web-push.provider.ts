import webpush from "web-push";
import type { Logger } from "../../lib/logger.js";
import { PushSendError, type PushPayload, type PushProvider, type PushSubscriptionKeys } from "./push.provider.js";

/** web-push's sendNotification rejects with a WebPushError carrying `.statusCode` rather than a
 *  typed error class — 404/410 specifically mean the push service itself says the subscription is
 *  gone, normalized here into PushSendError so dispatch code can tell "device gone" apart from
 *  "send failed" without depending on web-push's error shape directly. */
export class WebPushProvider implements PushProvider {
  constructor(publicKey: string, privateKey: string, subject: string, private readonly logger: Logger) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
      );
      this.logger.info({ push: { endpoint: subscription.endpoint, tag: payload.tag } }, "push sent via web-push");
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) throw new PushSendError("subscription expired", statusCode);
      throw err;
    }
  }
}
