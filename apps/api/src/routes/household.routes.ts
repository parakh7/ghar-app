import { Router } from "express";
import { createHouseholdSchema, updateHouseholdSchema, updateMemberSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireHousehold } from "../middleware/household.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import type { Deps } from "../services/deps.js";
import * as households from "../services/household.service.js";
import * as members from "../services/member.service.js";

/**
 * Household-scoped resources live under /api/households/:householdId/…
 * (househelps, attendance, bills, … are mounted here in later phases, each behind requireHousehold).
 */
export function householdRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/", async (req, res) => {
    ok(res, await households.listHouseholdsForUser(deps.db, req.auth!.user.id));
  });

  r.post("/", async (req, res) => {
    const input = parseBody(req, createHouseholdSchema);
    ok(res, await households.createHousehold(deps, req.auth!.user.id, input, req.ip), 201, "Household created.");
  });

  r.get("/:householdId", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, await households.getHousehold(deps.db, req.membership!));
  });

  r.patch("/:householdId", requireHousehold(deps, "household.manage"), async (req, res) => {
    const patch = parseBody(req, updateHouseholdSchema);
    ok(res, await households.updateHousehold(deps, req.auth!.user.id, req.membership!, patch, req.ip), 200, "Household updated.");
  });

  r.get("/:householdId/members", requireHousehold(deps, "members.view"), async (req, res) => {
    ok(res, await members.listMembers(deps.db, req.membership!.householdId));
  });

  // Self-leave is gated on membership only, not members.manage — "members.view" is the closest
  // permission every ACTIVE role has by default, so this reuses requireHousehold rather than a new gate.
  r.delete("/:householdId/members/me", requireHousehold(deps, "members.view"), async (req, res) => {
    await members.leaveHousehold(deps, req.membership!, req.auth!.user.id, req.ip);
    ok(res, null, 200, "You've left the household.");
  });

  r.patch("/:householdId/members/:userId", requireHousehold(deps, "members.manage"), async (req, res) => {
    const patch = parseBody(req, updateMemberSchema);
    ok(res, await members.updateMember(deps, req.auth!.user.id, req.membership!, req.params.userId as string, patch, req.ip), 200, "Member updated.");
  });

  r.delete("/:householdId/members/:userId", requireHousehold(deps, "members.manage"), async (req, res) => {
    await members.removeMember(deps, req.auth!.user.id, req.membership!, req.params.userId as string, req.ip);
    ok(res, null, 200, "Member removed.");
  });

  return r;
}
