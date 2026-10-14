import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  attendanceRecords, attendanceSchedules, auditLogs, householdMembers, salaryAdjustments, salaryPayments, salarySettlements,
} from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

// FakeClock defaults to 2026-09-29T04:30:00Z = 2026-09-29 10:00 IST, so August 2026 (31 days, ending
// Aug 31) has fully elapsed while September has not — this is the elapsed/current-month split every
// generation test below relies on.
const AUGUST_DAYS = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

type AttendanceStatusValue = "PRESENT" | "ABSENT" | "HALF_DAY" | "LEAVE" | "HOLIDAY";

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function createHousehelp(c: TestContext, cookie: string, householdId: string, body: Record<string, unknown> = {}) {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name: "Sunita", ...body });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

/** A schedule covering every weekday, effective well before August 2026 — makes all 31 August days "working days". */
async function scheduleWholeWeek(c: TestContext, householdId: string, househelpId: string) {
  await c.db.insert(attendanceSchedules).values({ householdId, househelpId, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: "2026-01-01" });
}

/** A schedule covering only the given ISO weekdays (1=Mon…7=Sun), effective well before August 2026. */
async function scheduleCustom(c: TestContext, householdId: string, househelpId: string, weekdays: number[]) {
  await c.db.insert(attendanceSchedules).values({ householdId, househelpId, weekdays, effectiveFrom: "2026-01-01" });
}

/** Same ISO-weekday formula the service uses — lets a test compute "which August dates are working days" without hand-counting a calendar. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** August 2026 dates whose ISO weekday is in `weekdays`. */
function augustDatesFor(weekdays: number[]): string[] {
  return AUGUST_DAYS.filter((d) => weekdays.includes(isoWeekdayOf(d)));
}

/** Marks every August 2026 day, defaulting to PRESENT except any date named in `overrides`. */
async function markAugust(c: TestContext, householdId: string, househelpId: string, overrides: Record<string, AttendanceStatusValue> = {}) {
  await c.db.insert(attendanceRecords).values(
    AUGUST_DAYS.map((date) => ({ householdId, househelpId, date, status: overrides[date] ?? "PRESENT", markedAt: c.clock.now() })),
  );
}

/** Marks only the given dates (e.g. a partial-week schedule's working days), defaulting to PRESENT except any named in `overrides`. */
async function markDates(c: TestContext, householdId: string, househelpId: string, dates: string[], overrides: Record<string, AttendanceStatusValue> = {}) {
  await c.db.insert(attendanceRecords).values(
    dates.map((date) => ({ householdId, househelpId, date, status: overrides[date] ?? "PRESENT", markedAt: c.clock.now() })),
  );
}

function generate(c: TestContext, cookie: string, householdId: string, househelpId: string, periodMonth = "2026-08-01") {
  return c.request.post(`/api/households/${householdId}/househelps/${househelpId}/salary/settlements`).set(csrf).set("cookie", cookie).send({ periodMonth });
}

describe("salary settlement generation", () => {
  it("FIXED_MONTHLY: deducts for every unworked day once the default leave allowance of 0 is exceeded", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
      "2026-08-06": "ABSENT", "2026-08-07": "ABSENT", "2026-08-08": "ABSENT", "2026-08-09": "ABSENT", "2026-08-10": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Default allowance is 0, so all 10 ABSENT days deduct: 10 * (3,100,000/31) = 1,000,000.
    expect(res.body.data).toMatchObject({
      status: "PENDING", basePaise: 3_100_000, absenceDeductionPaise: 1_000_000, netPayablePaise: 2_100_000, workingDays: 31, absentDays: 10,
    });
    expect(res.body.data.dueDate).toBe("2026-09-01"); // default salaryDueDay = 1, due the month after periodMonth
  });

  it("FIXED_MONTHLY: no deduction while unworked days stay within the configured allowance", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 5 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 0, netPayablePaise: 3_100_000, absentDays: 5 });
  });

  it("FIXED_MONTHLY: deducts only the days beyond the configured allowance", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 5 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
      "2026-08-06": "ABSENT", "2026-08-07": "ABSENT", "2026-08-08": "ABSENT", "2026-08-09": "ABSENT", "2026-08-10": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // 10 absences - 5 allowed = 5 excess days * (3,100,000/31) = 500,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 500_000, netPayablePaise: 2_600_000, absentDays: 10 });
  });

  it("FIXED_MONTHLY: a HALF_DAY counts as 0.5 toward the allowance and deducts at half the per-day rate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, { "2026-08-15": "HALF_DAY" });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Default allowance 0: 0.5 excess unit * (3,100,000/31) = 50,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 50_000, netPayablePaise: 3_050_000, halfDays: 1 });
  });

  it("a non-zero allowedLeavesPerMonth has no effect on ATTENDANCE_BASED's existing deduction formula", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 10 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, { "2026-08-05": "ABSENT", "2026-08-06": "ABSENT", "2026-08-07": "HALF_DAY" });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Identical scenario and result to the existing "ATTENDANCE_BASED: prorates absence and half-day
    // deductions" test above, just with allowedLeavesPerMonth set — proves the field has zero effect
    // on this mode's formula: prorate(3,100,000, 2, 31) + prorate(3,100,000, 1, 62) = 200,000 + 50,000 = 250,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 250_000, netPayablePaise: 2_850_000 });
  });

  it("ATTENDANCE_BASED: prorates absence and half-day deductions off the monthly salary", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    // 31 working days, 2 absent, 1 half-day, 28 present.
    await markAugust(ctx, h.id, help.id, { "2026-08-05": "ABSENT", "2026-08-06": "ABSENT", "2026-08-07": "HALF_DAY" });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Hand-verified: prorate(3,100,000, 2, 31) = 200,000; prorate(3,100,000, 1, 62) = 50,000; total 250,000.
    expect(res.body.data).toMatchObject({
      basePaise: 3_100_000, workingDays: 31, absentDays: 2, halfDays: 1, presentDays: 28,
      absenceDeductionPaise: 250_000, netPayablePaise: 2_850_000, status: "PENDING",
    });
  });

  it("ATTENDANCE_BASED: a partial (Mon-Sat) schedule yields a working-day count that doesn't evenly divide the salary", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED", monthlySalaryPaise: 1_000_000 });
    await scheduleCustom(ctx, h.id, help.id, [1, 2, 3, 4, 5, 6]); // Mon-Sat — August 2026 has 5 Sundays, so 26 working days.
    const workingDates = augustDatesFor([1, 2, 3, 4, 5, 6]);
    expect(workingDates).toHaveLength(26); // sanity check matching the brief's own worked example
    await markDates(ctx, h.id, help.id, workingDates, {
      [workingDates[0]!]: "ABSENT", [workingDates[1]!]: "ABSENT", [workingDates[2]!]: "HALF_DAY",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Hand-verified: prorate(1,000,000, 2, 26) = 76,923; prorate(1,000,000, 1, 52) = 19,231; total 96,154.
    expect(res.body.data).toMatchObject({
      basePaise: 1_000_000, workingDays: 26, absentDays: 2, halfDays: 1, presentDays: 23,
      absenceDeductionPaise: 96_154, netPayablePaise: 903_846, status: "PENDING",
    });
  });

  it("DAILY_RATE: a HOLIDAY day is paid at the full daily rate, same as a present day", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "DAILY_RATE", dailyRatePaise: 100_000, halfDayRatePaise: 60_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    // 25 present, 3 holiday, 2 half-day, 1 absent -> 31.
    await markAugust(ctx, h.id, help.id, {
      "2026-08-29": "HOLIDAY", "2026-08-30": "HOLIDAY", "2026-08-31": "HOLIDAY",
      "2026-08-27": "HALF_DAY", "2026-08-28": "HALF_DAY",
      "2026-08-26": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // (25 present + 3 holiday) * 100,000 + 2 half-day * 60,000 = 2,800,000 + 120,000 = 2,920,000.
    expect(res.body.data).toMatchObject({
      presentDays: 25, holidayDays: 3, halfDays: 2, absentDays: 1, basePaise: 2_920_000, netPayablePaise: 2_920_000,
    });
  });

  it("DAILY_RATE: a LEAVE day is paid at the full daily rate, same as a present day", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "DAILY_RATE", dailyRatePaise: 100_000, halfDayRatePaise: 60_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    // 25 present, 3 leave, 2 half-day, 1 absent -> 31.
    await markAugust(ctx, h.id, help.id, {
      "2026-08-29": "LEAVE", "2026-08-30": "LEAVE", "2026-08-31": "LEAVE",
      "2026-08-27": "HALF_DAY", "2026-08-28": "HALF_DAY",
      "2026-08-26": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // (25 present + 3 leave) * 100,000 + 2 half-day * 60,000 = 2,800,000 + 120,000 = 2,920,000.
    expect(res.body.data).toMatchObject({
      presentDays: 25, leaveDays: 3, halfDays: 2, absentDays: 1, basePaise: 2_920_000, netPayablePaise: 2_920_000,
    });
  });

  it("DAILY_RATE: present x rate + half x half-rate, with no monthly figure involved", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "DAILY_RATE", dailyRatePaise: 100_000, halfDayRatePaise: 60_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    // 20 present (default), 5 half-day, 6 absent.
    await markAugust(ctx, h.id, help.id, {
      "2026-08-21": "HALF_DAY", "2026-08-22": "HALF_DAY", "2026-08-23": "HALF_DAY", "2026-08-24": "HALF_DAY", "2026-08-25": "HALF_DAY",
      "2026-08-26": "ABSENT", "2026-08-27": "ABSENT", "2026-08-28": "ABSENT", "2026-08-29": "ABSENT", "2026-08-30": "ABSENT", "2026-08-31": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // 20 * 100,000 + 5 * 60,000 = 2,000,000 + 300,000 = 2,300,000.
    expect(res.body.data).toMatchObject({
      basePaise: 2_300_000, presentDays: 20, halfDays: 5, absentDays: 6, absenceDeductionPaise: 0, netPayablePaise: 2_300_000,
    });
  });

  it("DAILY_RATE: falls back to half of the daily rate when halfDayRatePaise isn't set", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "DAILY_RATE", dailyRatePaise: 100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-21": "HALF_DAY", "2026-08-22": "HALF_DAY",
      "2026-08-26": "ABSENT", "2026-08-27": "ABSENT", "2026-08-28": "ABSENT", "2026-08-29": "ABSENT", "2026-08-30": "ABSENT", "2026-08-31": "ABSENT", "2026-08-23": "ABSENT", "2026-08-24": "ABSENT", "2026-08-25": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // 20 present * 100,000 + 2 half-day * prorate(100,000, 1, 2)=50,000 => 2,000,000 + 100,000 = 2,100,000.
    expect(res.body.data).toMatchObject({ presentDays: 20, halfDays: 2, basePaise: 2_100_000, netPayablePaise: 2_100_000 });
  });

  it("rejects generation when the mode's required rate field is missing", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED" }); // no monthlySalaryPaise
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty("monthlySalaryPaise");
  });

  it("rejects generation when scheduled days in the month have no attendance record at all", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    // Only mark the first 20 of August's 31 working days — 11 left unmarked.
    await ctx.db.insert(attendanceRecords).values(
      AUGUST_DAYS.slice(0, 20).map((date) => ({ householdId: h.id, househelpId: help.id, date, status: "PRESENT" as const, markedAt: ctx.clock.now() })),
    );
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(400);
    expect(res.body.error.fields.attendance).toContain("11");
  });

  it("rejects generation for the current (not yet elapsed) month and for a future month", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    const current = await generate(ctx, owner.cookie, h.id, help.id, "2026-09-01");
    expect(current.status).toBe(400);
    const future = await generate(ctx, owner.cookie, h.id, help.id, "2026-10-01");
    expect(future.status).toBe(400);
  });

  it("allows regenerating a PENDING settlement, recomputing from current attendance in place", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, { "2026-08-05": "ABSENT" });
    const first = await generate(ctx, owner.cookie, h.id, help.id);
    expect(first.status).toBe(200);
    expect(first.body.data.absentDays).toBe(1);

    // Attendance is corrected after the fact: the absence is flipped to present.
    await ctx.db.update(attendanceRecords).set({ status: "PRESENT" }).where(and(eq(attendanceRecords.householdId, h.id), eq(attendanceRecords.date, "2026-08-05")));
    const second = await generate(ctx, owner.cookie, h.id, help.id);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.absentDays).toBe(0);
    expect(second.body.data.absenceDeductionPaise).toBe(0);
    expect(second.body.data.netPayablePaise).toBe(3_100_000);

    const rows = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.househelpId, help.id));
    expect(rows).toHaveLength(1); // regenerated in place, not a second row
    const logs = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "settlement.regenerated"));
    expect(logs).toHaveLength(1);
  });

  it("blocks regeneration once a payment has been recorded against the settlement", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const first = await generate(ctx, owner.cookie, h.id, help.id);
    expect(first.status).toBe(200);
    const settlementId = first.body.data.id as string;

    // Simulate Task 3's recordPayment having moved this settlement past PENDING.
    await ctx.db.insert(salaryPayments).values({ householdId: h.id, househelpId: help.id, settlementId, amountPaise: 500_000, paidOn: "2026-09-02", method: "CASH" });
    await ctx.db.update(salarySettlements).set({ status: "PARTIALLY_PAID", amountPaidPaise: 500_000 }).where(eq(salarySettlements.id, settlementId));

    const second = await generate(ctx, owner.cookie, h.id, help.id);
    expect(second.status).toBe(400);
  });

  it("rejects generation when the househelp has no active attendance schedule covering this month", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    // No schedule at all -> workingDays = 0 for August.
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(400);
  });

  it("auto-attaches unattached, non-voided adjustments on generation, summed by type (ADJUSTMENT is a straight addition, like BONUS/OVERTIME)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);

    const periodMonth = "2026-08-01";
    const [bonus, deduction, advance, adjustment, voided] = await ctx.db.insert(salaryAdjustments).values([
      { householdId: h.id, househelpId: help.id, periodMonth, type: "BONUS", amountPaise: 100_000 },
      { householdId: h.id, househelpId: help.id, periodMonth, type: "DEDUCTION", amountPaise: 20_000 },
      { householdId: h.id, househelpId: help.id, periodMonth, type: "ADVANCE", amountPaise: 50_000 },
      { householdId: h.id, househelpId: help.id, periodMonth, type: "ADJUSTMENT", amountPaise: 15_000 }, // addition, same as BONUS/OVERTIME
      { householdId: h.id, househelpId: help.id, periodMonth, type: "BONUS", amountPaise: 999_999, voidedAt: ctx.clock.now() }, // voided, must be ignored
    ]).returning({ id: salaryAdjustments.id });
    void voided;

    const res = await generate(ctx, owner.cookie, h.id, help.id, periodMonth);
    expect(res.status).toBe(200);
    // additions: 100,000 (bonus) + 15,000 (adjustment) = 115,000; deductions: 20,000; advance: 50,000.
    expect(res.body.data).toMatchObject({ additionsPaise: 115_000, deductionsPaise: 20_000, advancePaise: 50_000 });
    // net = 1,000,000 - 0 + 115,000 - 20,000 - 50,000 = 1,045,000
    expect(res.body.data.netPayablePaise).toBe(1_045_000);

    const settlementId = res.body.data.id as string;
    const attached = await ctx.db.select({ id: salaryAdjustments.id, settlementId: salaryAdjustments.settlementId })
      .from(salaryAdjustments).where(eq(salaryAdjustments.householdId, h.id));
    const byId = new Map(attached.map((a) => [a.id, a.settlementId]));
    expect(byId.get(bonus!.id)).toBe(settlementId);
    expect(byId.get(deduction!.id)).toBe(settlementId);
    expect(byId.get(advance!.id)).toBe(settlementId);
    expect(byId.get(adjustment!.id)).toBe(settlementId);

    const detail = await ctx.request.get(`/api/households/${h.id}/salary/settlements/${settlementId}`).set("cookie", owner.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.adjustments).toHaveLength(4); // the voided bonus is excluded from attachment, but still exists unattached
  });

  it("regenerating re-sums adjustments already attached to this settlement, and also sweeps newly-created ones, without zeroing totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const periodMonth = "2026-08-01";

    const [firstBonus] = await ctx.db.insert(salaryAdjustments)
      .values({ householdId: h.id, househelpId: help.id, periodMonth, type: "BONUS", amountPaise: 50_000 })
      .returning({ id: salaryAdjustments.id });

    const first = await generate(ctx, owner.cookie, h.id, help.id, periodMonth);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ additionsPaise: 50_000, netPayablePaise: 1_050_000 });
    const [afterFirst] = await ctx.db.select({ settlementId: salaryAdjustments.settlementId }).from(salaryAdjustments).where(eq(salaryAdjustments.id, firstBonus!.id));
    expect(afterFirst!.settlementId).toBe(first.body.data.id);

    // A second adjustment is added after the first generate, while the first is already attached.
    await ctx.db.insert(salaryAdjustments).values({ householdId: h.id, househelpId: help.id, periodMonth, type: "BONUS", amountPaise: 30_000 });

    const second = await generate(ctx, owner.cookie, h.id, help.id, periodMonth);
    expect(second.status).toBe(200);
    // Without the fix this would regress to 30,000 (the already-attached 50,000 bonus silently dropped).
    expect(second.body.data).toMatchObject({ additionsPaise: 80_000, netPayablePaise: 1_080_000 });
  });

  it("a member of household A cannot generate, list, or view household B's settlements", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, b.id, bobsHelp.id);
    await markAugust(ctx, b.id, bobsHelp.id);
    const bobsSettlement = await generate(ctx, bob.cookie, b.id, bobsHelp.id);
    expect(bobsSettlement.status).toBe(200);

    const genAttempt = await generate(ctx, alice.cookie, a.id, bobsHelp.id);
    expect(genAttempt.status).toBe(404);

    const listAttempt = await ctx.request.get(`/api/households/${a.id}/househelps/${bobsHelp.id}/salary/settlements`).set("cookie", alice.cookie);
    expect(listAttempt.status).toBe(404);

    const viewAttempt = await ctx.request.get(`/api/households/${a.id}/salary/settlements/${bobsSettlement.body.data.id}`).set("cookie", alice.cookie);
    expect(viewAttempt.status).toBe(404);
  });

  it("VIEWER can list and view settlements but not generate them", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);

    const denied = await generate(ctx, viewer.cookie, h.id, help.id);
    expect(denied.status).toBe(403);

    const ownerGen = await generate(ctx, owner.cookie, h.id, help.id);
    expect(ownerGen.status).toBe(200);

    const list = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/salary/settlements`).set("cookie", viewer.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });
});
