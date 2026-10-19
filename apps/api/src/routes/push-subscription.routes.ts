import { Router } from "express";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import * as pushSubscriptionService from "../services/push/push-subscription.service.js";
import type { Deps } from "../services/deps.js";

/** User-scoped, not household-scoped — a device subscription belongs to a user account, not a
 *  specific household: the same browser subscribes once and receives push for every household the
 *  signed-in user belongs to. */
export function pushSubscriptionRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.post("/", async (req, res) => {
    const input = parseBody(req, pushSubscribeSchema);
    await pushSubscriptionService.subscribe(deps, req.auth!.user.id, { ...input, userAgent: input.userAgent ?? req.get("user-agent") });
    ok(res, null, 201);
  });

  r.post("/unsubscribe", async (req, res) => {
    const { endpoint } = parseBody(req, pushUnsubscribeSchema);
    await pushSubscriptionService.unsubscribe(deps, req.auth!.user.id, endpoint);
    ok(res, null);
  });

  return r;
}
