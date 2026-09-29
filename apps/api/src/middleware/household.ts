import type { RequestHandler } from "express";
import { resolvePermissions, type Permission } from "@household/shared";
import { z } from "zod";
import { Errors } from "../lib/errors.js";
import type { Deps } from "../services/deps.js";
import { getMembership } from "../services/household.service.js";

const uuid = z.string().uuid();

/**
 * Household authorization gate. Mount on any `/:householdId/...` route.
 *  - householdId in the URL is only a *request*; access is decided by the user's membership row.
 *  - Non-members get 404 (not 403) so household IDs can't be probed.
 *  - Downstream code MUST use `req.membership.householdId`, never the raw param or body.
 */
export function requireHousehold(deps: Deps, permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw Errors.unauthenticated();
    const parsed = uuid.safeParse(req.params.householdId);
    if (!parsed.success) throw Errors.householdNotFound();
    const membership = await getMembership(deps.db, req.auth.user.id, parsed.data);
    if (!membership) {
      deps.logger.warn({ event: "authz.household_denied", userId: req.auth.user.id, householdId: parsed.data }, "household access denied");
      throw Errors.householdNotFound();
    }
    const permissions = resolvePermissions(membership.role, membership.overrides);
    if (!permissions.has(permission)) throw Errors.forbidden();
    req.membership = { ...membership, permissions };
    next();
  };
}
