import { Router } from "express";
import type { OccurrenceStatus } from "@household/shared";
import { billStatusSchema, createAdjustmentSchema, createBillCategorySchema, createBillSchema, createCategorySchema, createChecklistTaskSchema, createHousehelpSchema, createHouseholdSchema, dateSchema, generateSettlementSchema, inviteMemberSchema, markAttendanceSchema, markCompletionSchema, markHolidaySchema, monthSchema, moveCategorySchema, putAssignmentsSchema, recordPaymentSchema, updateBillCategorySchema, updateBillSchema, updateCategorySchema, updateChecklistTaskSchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateOccurrenceAmountSchema, updateScheduleSchema, voidReasonSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireHousehold } from "../middleware/household.js";
import { inviteLimiter } from "../middleware/rate-limit.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "../services/deps.js";
import * as attendance from "../services/attendance.service.js";
import * as billCategories from "../services/bill-category.service.js";
import * as bills from "../services/bill.service.js";
import * as billOccurrences from "../services/bill-occurrence.service.js";
import * as categories from "../services/category.service.js";
import * as checklistAssignments from "../services/checklist-assignment.service.js";
import * as checklistCompletions from "../services/checklist-completion.service.js";
import * as checklistTasks from "../services/checklist-task.service.js";
import * as households from "../services/household.service.js";
import * as househelps from "../services/househelp.service.js";
import * as members from "../services/member.service.js";
import * as schedules from "../services/schedule.service.js";
import * as salaryAdjustments from "../services/salary-adjustment.service.js";
import * as salaryPayments from "../services/salary-payment.service.js";
import * as salarySettlements from "../services/salary-settlement.service.js";

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

  r.get("/:householdId/bill-categories", requireHousehold(deps, "bills.view"), async (req, res) => {
    ok(res, await billCategories.listBillCategories(deps.db, req.membership!.householdId));
  });

  r.post("/:householdId/bill-categories", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const input = parseBody(req, createBillCategorySchema);
    ok(res, await billCategories.createBillCategory(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Bill category added.");
  });

  r.patch("/:householdId/bill-categories/:categoryId", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const patch = parseBody(req, updateBillCategorySchema);
    ok(res, await billCategories.updateBillCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, patch, req.ip), 200, "Bill category updated.");
  });

  r.delete("/:householdId/bill-categories/:categoryId", requireHousehold(deps, "bills.manage"), async (req, res) => {
    await billCategories.softDeleteBillCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, req.ip);
    ok(res, null, 200, "Bill category removed.");
  });

  r.post("/:householdId/bill-categories/:categoryId/move", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const { direction } = parseBody(req, moveCategorySchema);
    await billCategories.moveBillCategory(deps, req.auth!.user.id, req.membership!.householdId, req.params.categoryId as string, direction, req.ip);
    ok(res, null, 200, "Bill category moved.");
  });

  r.get("/:householdId/bills", requireHousehold(deps, "bills.view"), async (req, res) => {
    let status: "ACTIVE" | "PAUSED" | "ARCHIVED" | undefined;
    if (req.query.status !== undefined) {
      const parsed = billStatusSchema.safeParse(req.query.status);
      if (!parsed.success) throw Errors.validation({ status: "Use ACTIVE, PAUSED, or ARCHIVED." });
      status = parsed.data;
    }
    ok(res, await bills.listBills(deps, req.membership!, { status, includeArchived: req.query.includeArchived === "true" }));
  });

  r.post("/:householdId/bills", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const input = parseBody(req, createBillSchema);
    ok(res, await bills.createBill(deps, req.auth!.user.id, req.membership!, input, req.ip), 201, "Bill added.");
  });

  r.get("/:householdId/bills/:id", requireHousehold(deps, "bills.view"), async (req, res) => {
    ok(res, await bills.getBill(deps, req.membership!, req.params.id as string));
  });

  r.patch("/:householdId/bills/:id", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const patch = parseBody(req, updateBillSchema);
    ok(res, await bills.updateBill(deps, req.auth!.user.id, req.membership!, req.params.id as string, patch, req.ip), 200, "Bill updated.");
  });

  r.post("/:householdId/bills/:id/pause", requireHousehold(deps, "bills.manage"), async (req, res) => {
    await bills.pauseBill(deps, req.auth!.user.id, req.membership!, req.params.id as string, req.ip);
    ok(res, null, 200, "Bill paused.");
  });

  r.post("/:householdId/bills/:id/resume", requireHousehold(deps, "bills.manage"), async (req, res) => {
    await bills.resumeBill(deps, req.auth!.user.id, req.membership!, req.params.id as string, req.ip);
    ok(res, null, 200, "Bill resumed.");
  });

  r.post("/:householdId/bills/:id/archive", requireHousehold(deps, "bills.manage"), async (req, res) => {
    await bills.archiveBill(deps, req.auth!.user.id, req.membership!, req.params.id as string, req.ip);
    ok(res, null, 200, "Bill archived.");
  });

  r.post("/:householdId/bills/:id/unarchive", requireHousehold(deps, "bills.manage"), async (req, res) => {
    await bills.unarchiveBill(deps, req.auth!.user.id, req.membership!, req.params.id as string, req.ip);
    ok(res, null, 200, "Bill restored.");
  });

  const OCCURRENCE_STATUSES = ["PENDING", "PARTIALLY_PAID", "PAID", "WAIVED"] as const;

  r.get("/:householdId/bills/:id/occurrences", requireHousehold(deps, "bills.view"), async (req, res) => {
    let status: OccurrenceStatus | undefined;
    if (req.query.status !== undefined) {
      if (typeof req.query.status !== "string" || !(OCCURRENCE_STATUSES as readonly string[]).includes(req.query.status)) {
        throw Errors.validation({ status: "Use PENDING, PARTIALLY_PAID, PAID, or WAIVED." });
      }
      status = req.query.status as OccurrenceStatus;
    }
    let from: string | undefined;
    if (req.query.from !== undefined) {
      const parsed = dateSchema.safeParse(req.query.from);
      if (!parsed.success) throw Errors.validation({ from: "Use YYYY-MM-DD" });
      from = parsed.data;
    }
    let to: string | undefined;
    if (req.query.to !== undefined) {
      const parsed = dateSchema.safeParse(req.query.to);
      if (!parsed.success) throw Errors.validation({ to: "Use YYYY-MM-DD" });
      to = parsed.data;
    }
    ok(res, await billOccurrences.listOccurrences(deps, req.membership!, req.params.id as string, { status, from, to }));
  });

  // Gated on `bills.view`, not `bills.manage`: this is a read-triggered refresh (recomputing the
  // same derived rows a correct sync always would) rather than a human edit to bill data — see
  // task-2-report.md for the full reasoning.
  r.post("/:householdId/bills/:id/occurrences/sync", requireHousehold(deps, "bills.view"), async (req, res) => {
    const bill = await billOccurrences.requireBillForSync(deps, req.membership!, req.params.id as string);
    await billOccurrences.ensureOccurrences(deps, req.membership!, bill);
    ok(res, await billOccurrences.listOccurrences(deps, req.membership!, req.params.id as string));
  });

  r.patch("/:householdId/bills/:id/occurrences/:occurrenceId", requireHousehold(deps, "bills.manage"), async (req, res) => {
    const input = parseBody(req, updateOccurrenceAmountSchema);
    ok(res, await billOccurrences.updateOccurrenceAmount(deps, req.auth!.user.id, req.membership!, req.params.occurrenceId as string, input, req.ip), 200, "Occurrence updated.");
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

  r.post("/:householdId/househelps/:id/salary/settlements", requireHousehold(deps, "salaries.manage"), async (req, res) => {
    const input = parseBody(req, generateSettlementSchema);
    ok(res, await salarySettlements.generateSettlement(deps, req.auth!.user.id, req.membership!, req.params.id as string, input, req.ip), 200, "Settlement generated.");
  });

  r.get("/:householdId/househelps/:id/salary/settlements", requireHousehold(deps, "salaries.view"), async (req, res) => {
    ok(res, await salarySettlements.listSettlements(deps, req.membership!, req.params.id as string));
  });

  r.get("/:householdId/salary/settlements/:settlementId", requireHousehold(deps, "salaries.view"), async (req, res) => {
    ok(res, await salarySettlements.getSettlement(deps, req.membership!, req.params.settlementId as string));
  });

  r.post("/:householdId/househelps/:id/salary/adjustments", requireHousehold(deps, "salaries.manage"), async (req, res) => {
    const input = parseBody(req, createAdjustmentSchema);
    ok(res, await salaryAdjustments.createAdjustment(deps, req.auth!.user.id, req.membership!, req.params.id as string, input, req.ip), 201, "Adjustment recorded.");
  });

  r.delete("/:householdId/salary/adjustments/:adjustmentId", requireHousehold(deps, "salaries.manage"), async (req, res) => {
    await salaryAdjustments.voidAdjustment(deps, req.auth!.user.id, req.membership!, req.params.adjustmentId as string, req.ip);
    ok(res, null, 200, "Adjustment voided.");
  });

  r.post("/:householdId/salary/settlements/:settlementId/payments", requireHousehold(deps, "salaries.pay"), async (req, res) => {
    const input = parseBody(req, recordPaymentSchema);
    ok(res, await salaryPayments.recordPayment(deps, req.auth!.user.id, req.membership!, req.params.settlementId as string, input, req.ip), 201, "Payment recorded.");
  });

  r.delete("/:householdId/salary/payments/:paymentId", requireHousehold(deps, "salaries.pay"), async (req, res) => {
    let reason: string | undefined;
    if (req.query.reason !== undefined) {
      const parsed = voidReasonSchema.safeParse(req.query.reason);
      if (!parsed.success) throw Errors.validation({ reason: "Reason must be 500 characters or fewer." });
      reason = parsed.data;
    }
    await salaryPayments.voidPayment(deps, req.auth!.user.id, req.membership!, req.params.paymentId as string, reason, req.ip);
    ok(res, null, 200, "Payment voided.");
  });

  r.get("/:householdId/attendance/today", requireHousehold(deps, "attendance.view"), async (req, res) => {
    let dateParam: string | undefined;
    if (req.query.date !== undefined) {
      const parsed = dateSchema.safeParse(req.query.date);
      if (!parsed.success) throw Errors.validation({ date: "Use YYYY-MM-DD" });
      dateParam = parsed.data;
    }
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

  r.post("/:householdId/attendance/holiday", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const { date } = parseBody(req, markHolidaySchema);
    ok(res, await attendance.markHoliday(deps, req.auth!.user.id, req.membership!, date, req.ip), 200, "Marked as holiday.");
  });

  r.get("/:householdId/househelps/:id/attendance", requireHousehold(deps, "attendance.view"), async (req, res) => {
    const parsedMonth = monthSchema.safeParse(req.query.month);
    if (!parsedMonth.success) throw Errors.validation({ month: "Use YYYY-MM" });
    ok(res, await attendance.getMonthAttendance(deps.db, req.membership!.householdId, req.params.id as string, parsedMonth.data));
  });

  r.get("/:householdId/checklist/today", requireHousehold(deps, "checklists.view"), async (req, res) => {
    let dateParam: string | undefined;
    if (req.query.date !== undefined) {
      const parsed = dateSchema.safeParse(req.query.date);
      if (!parsed.success) throw Errors.validation({ date: "Use YYYY-MM-DD" });
      dateParam = parsed.data;
    }
    ok(res, await checklistCompletions.getTodayChecklist(deps, req.membership!, dateParam));
  });

  r.put("/:householdId/checklist/:taskId/completion", requireHousehold(deps, "checklists.complete"), async (req, res) => {
    const input = parseBody(req, markCompletionSchema);
    ok(res, await checklistCompletions.markCompletion(deps, req.auth!.user.id, req.membership!, req.params.taskId as string, input, req.ip), 200, "Checklist updated.");
  });

  r.delete("/:householdId/checklist/:taskId/completion", requireHousehold(deps, "checklists.complete"), async (req, res) => {
    const parsedDate = dateSchema.safeParse(req.query.date);
    if (!parsedDate.success) throw Errors.validation({ date: "Use YYYY-MM-DD" });
    await checklistCompletions.clearCompletion(deps, req.auth!.user.id, req.membership!, req.params.taskId as string, parsedDate.data, req.ip);
    ok(res, null, 200, "Checklist entry cleared.");
  });

  r.get("/:householdId/checklist-tasks", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistTasks.listChecklistTasks(deps.db, req.membership!.householdId, req.query.includeArchived === "true"));
  });

  r.post("/:householdId/checklist-tasks", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const input = parseBody(req, createChecklistTaskSchema);
    ok(res, await checklistTasks.createChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, input, req.ip), 201, "Checklist task added.");
  });

  r.get("/:householdId/checklist-tasks/:id", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistTasks.getChecklistTask(deps.db, req.membership!.householdId, req.params.id as string));
  });

  r.patch("/:householdId/checklist-tasks/:id", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const patch = parseBody(req, updateChecklistTaskSchema);
    ok(res, await checklistTasks.updateChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, patch, req.ip), 200, "Checklist task updated.");
  });

  r.post("/:householdId/checklist-tasks/:id/archive", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    await checklistTasks.archiveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Checklist task removed.");
  });

  r.post("/:householdId/checklist-tasks/:id/unarchive", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    await checklistTasks.unarchiveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, req.ip);
    ok(res, null, 200, "Checklist task restored.");
  });

  r.post("/:householdId/checklist-tasks/:id/move", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const { direction } = parseBody(req, moveCategorySchema);
    await checklistTasks.moveChecklistTask(deps, req.auth!.user.id, req.membership!.householdId, req.params.id as string, direction, req.ip);
    ok(res, null, 200, "Checklist task moved.");
  });

  r.get("/:householdId/checklist-tasks/:id/assignments", requireHousehold(deps, "checklists.view"), async (req, res) => {
    ok(res, await checklistAssignments.getCurrentAssignments(deps, req.membership!, req.params.id as string));
  });

  r.put("/:householdId/checklist-tasks/:id/assignments", requireHousehold(deps, "checklists.manage"), async (req, res) => {
    const { househelpIds } = parseBody(req, putAssignmentsSchema);
    ok(res, await checklistAssignments.putAssignments(deps, req.auth!.user.id, req.membership!, req.params.id as string, househelpIds, req.ip), 200, "Assignments updated.");
  });

  return r;
}
