import { Router } from "express";
import { createCategorySchema, createHousehelpSchema, createHouseholdSchema, dateSchema, inviteMemberSchema, markAttendanceSchema, moveCategorySchema, updateCategorySchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireHousehold } from "../middleware/household.js";
import { inviteLimiter } from "../middleware/rate-limit.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "../services/deps.js";
import * as attendance from "../services/attendance.service.js";
import * as categories from "../services/category.service.js";
import * as households from "../services/household.service.js";
import * as househelps from "../services/househelp.service.js";
import * as members from "../services/member.service.js";
import * as schedules from "../services/schedule.service.js";

/**
 * Household-scoped resources live under /api/households/:householdId/…
 * (househelps, attendance, bills, … are mounted here in later phases, each behind requireHousehold).
 */
export function householdRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  const limiter = inviteLimiter(deps.env.RATE_LIMIT_AUTH_MAX);

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

  r.get("/:householdId/invites", requireHousehold(deps, "members.manage"), async (req, res) => {
    ok(res, await members.listInvites(deps, req.membership!.householdId));
  });

  r.post("/:householdId/invites", requireHousehold(deps, "members.manage"), limiter, async (req, res) => {
    const input = parseBody(req, inviteMemberSchema);
    ok(res, await members.createInvite(deps, req.auth!.user.id, req.membership!, input, req.ip), 201, "Invite sent.");
  });

  r.delete("/:householdId/invites/:inviteId", requireHousehold(deps, "members.manage"), async (req, res) => {
    await members.revokeInvite(deps, req.auth!.user.id, req.membership!.householdId, req.params.inviteId as string, req.ip);
    ok(res, null, 200, "Invite revoked.");
  });

  r.post("/:householdId/invites/:inviteId/resend", requireHousehold(deps, "members.manage"), limiter, async (req, res) => {
    ok(res, await members.resendInvite(deps, req.auth!.user.id, req.membership!, req.params.inviteId as string, req.ip), 200, "Invite resent.");
  });

  r.get("/:householdId/categories", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await categories.listCategories(deps.db, req.membership!.householdId));
  });

  r.post("/:householdId/categories", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const input = parseBody(req, createCategorySchema);
    ok(res, await categories.createCategory(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Category added.");
  });

  r.patch("/:householdId/categories/:categoryId", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const patch = parseBody(req, updateCategorySchema);
    ok(res, await categories.updateCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, patch, req.ip), 200, "Category updated.");
  });

  r.delete("/:householdId/categories/:categoryId", requireHousehold(deps, "categories.manage"), async (req, res) => {
    await categories.softDeleteCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, req.ip);
    ok(res, null, 200, "Category removed.");
  });

  r.post("/:householdId/categories/:categoryId/move", requireHousehold(deps, "categories.manage"), async (req, res) => {
    const { direction } = parseBody(req, moveCategorySchema);
    await categories.moveCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, direction, req.ip);
    ok(res, null, 200, "Category moved.");
  });

  r.get("/:householdId/househelps", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await househelps.listHousehelps(deps.db, req.membership!.householdId, req.query.includeArchived === "true"));
  });

  r.post("/:householdId/househelps", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const input = parseBody(req, createHousehelpSchema);
    ok(res, await househelps.createHousehelp(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Househelp added.");
  });

  r.get("/:householdId/househelps/:id", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await househelps.getHousehelp(deps.db, req.membership!.householdId, req.params.id as string));
  });

  r.patch("/:householdId/househelps/:id", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const patch = parseBody(req, updateHousehelpSchema);
    ok(res, await househelps.updateHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, patch, req.ip), 200, "Househelp updated.");
  });

  r.post("/:householdId/househelps/:id/archive", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    await househelps.archiveHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Househelp removed.");
  });

  r.post("/:householdId/househelps/:id/unarchive", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    await househelps.unarchiveHousehelp(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Househelp restored.");
  });

  r.get("/:householdId/househelps/:id/schedule", requireHousehold(deps, "househelps.view"), async (req, res) => {
    ok(res, await schedules.getCurrentSchedule(deps, req.membership!, req.params.id as string));
  });

  r.put("/:householdId/househelps/:id/schedule", requireHousehold(deps, "househelps.manage"), async (req, res) => {
    const input = parseBody(req, updateScheduleSchema);
    ok(res, await schedules.putSchedule(deps, req.auth!.user.id, req.membership!, req.params.id as string, input, req.ip), 200, "Schedule updated.");
  });

  r.get("/:householdId/attendance/today", requireHousehold(deps, "attendance.view"), async (req, res) => {
    const dateParam = typeof req.query.date === "string" ? req.query.date : undefined;
    ok(res, await attendance.getToday(deps, req.membership!, dateParam));
  });

  r.put("/:householdId/attendance/:househelpId", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const input = parseBody(req, markAttendanceSchema);
    ok(res, await attendance.setAttendance(deps, req.auth!.user.id, req.membership!, req.params.househelpId as string, input, req.ip), 200, "Attendance updated.");
  });

  r.delete("/:householdId/attendance/:househelpId", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const parsedDate = dateSchema.safeParse(req.query.date);
    if (!parsedDate.success) throw Errors.validation({ date: "Use YYYY-MM-DD" });
    await attendance.clearAttendance(deps, req.auth!.user.id, req.membership!, req.params.househelpId as string, parsedDate.data, req.ip);
    ok(res, null, 200, "Attendance cleared.");
  });

  return r;
}
