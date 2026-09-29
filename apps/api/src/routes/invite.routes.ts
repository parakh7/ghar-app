import { Router } from "express";
import { acceptInviteSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import type { Deps } from "../services/deps.js";
import * as members from "../services/member.service.js";

/** Accepting an invite happens before the caller is a member, so this can't live behind requireHousehold. */
export function inviteRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.post("/accept", async (req, res) => {
    const { token } = parseBody(req, acceptInviteSchema);
    ok(res, await members.acceptInvite(deps, req.auth!.user, token, req.ip), 200, "You've joined the household.");
  });

  return r;
}
