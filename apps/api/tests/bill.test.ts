import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, billCategories, bills, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function billCategoryId(householdId: string, name = "Electricity"): Promise<string> {
  const [row] = await ctx.db.select({ id: billCategories.id }).from(billCategories)
    .where(and(eq(billCategories.householdId, householdId), eq(billCategories.name, name)));
  return row!.id;
}

const monthly = { name: "Electricity bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" };

describe("bill definitions", () => {
  it("creates a MONTHLY bill with no interval config", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Electricity bill", frequency: "MONTHLY", status: "ACTIVE", intervalCount: 1, intervalUnit: null, autopay: false });
  });

  it.each([
    ["ONE_TIME", "2026-11-05"],
    ["WEEKLY", "2026-11-05"],
    ["QUARTERLY", "2026-11-05"],
    ["HALF_YEARLY", "2026-11-05"],
    ["YEARLY", "2026-11-05"],
  ])("creates a %s bill with no interval config", async (frequency, firstDueDate) => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: `${frequency} bill`, frequency, firstDueDate });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ frequency, status: "ACTIVE" });
  });

  it("creates a CUSTOM bill with intervalCount and intervalUnit", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Custom bill", frequency: "CUSTOM", intervalCount: 3, intervalUnit: "week", firstDueDate: "2026-11-05" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ frequency: "CUSTOM", intervalCount: 3, intervalUnit: "week" });
  });

  it("creates a CUSTOM bill defaulting intervalCount to 1 when omitted", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Custom bill", frequency: "CUSTOM", intervalUnit: "day", firstDueDate: "2026-11-05" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ intervalCount: 1, intervalUnit: "day" });
  });

  it("rejects intervalUnit set on a MONTHLY bill", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, intervalUnit: "day" });
    expect(res.status).toBe(400);
  });

  it("rejects intervalCount set on a WEEKLY bill", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Weekly bill", frequency: "WEEKLY", firstDueDate: "2026-11-05", intervalCount: 2 });
    expect(res.status).toBe(400);
  });

  it("rejects a CUSTOM bill missing intervalUnit", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Custom bill", frequency: "CUSTOM", firstDueDate: "2026-11-05" });
    expect(res.status).toBe(400);
  });

  it("rejects endDate before firstDueDate on create", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, endDate: "2026-10-01" });
    expect(res.status).toBe(400);
  });

  it("accepts endDate equal to firstDueDate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, endDate: monthly.firstDueDate });
    expect(res.status).toBe(201);
  });

  it("creates a bill with a valid categoryId from this household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const categoryId = await billCategoryId(h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, categoryId });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryId).toBe(categoryId);
  });

  it("rejects a categoryId that does not exist in this household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, categoryId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
  });

  it("rejects a categoryId belonging to another household", async () => {
    const owner = await signupUser(ctx);
    const other = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const hOther = await createHousehold(ctx, other.cookie, "Other");
    const otherCategoryId = await billCategoryId(hOther.id);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, categoryId: otherCategoryId });
    expect(res.status).toBe(400);
  });

  it("rejects a categoryId that has been soft-deleted", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const categoryId = await billCategoryId(h.id);
    await ctx.request.delete(`/api/households/${h.id}/bill-categories/${categoryId}`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, categoryId });
    expect(res.status).toBe(400);
  });

  it("records an audit log entry on create", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.created")));
    expect(log).toMatchObject({ entityId: res.body.data.id, newValue: { name: "Electricity bill", frequency: "MONTHLY" } });
  });

  it("gets a bill by id", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.get(`/api/households/${h.id}/bills/${id}`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it("404s getting a bill that does not exist", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/bills/00000000-0000-0000-0000-000000000000`).set("cookie", owner.cookie);
    expect(res.status).toBe(404);
  });

  it("lists bills hiding archived ones by default", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send({ name: "Second bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
    await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/bills`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Second bill");
  });

  it("lists only ARCHIVED bills when filtered", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/bills?status=ARCHIVED`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(id);
  });

  it("rejects an invalid status filter value", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/bills?status=BOGUS`).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("updates general fields without touching frequency", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie)
      .send({ provider: "BESCOM", amountPaise: 150000, autopay: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: "BESCOM", amountPaise: 150000, autopay: true, frequency: "MONTHLY" });
  });

  it("rejects an update with no fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(res.status).toBe(400);
  });

  it("rejects changing intervalCount without including frequency", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Custom bill", frequency: "CUSTOM", intervalUnit: "week", firstDueDate: "2026-11-05" });
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ intervalCount: 5 });
    expect(res.status).toBe(400);
  });

  it("switching frequency from CUSTOM to MONTHLY clears the interval config", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Custom bill", frequency: "CUSTOM", intervalCount: 2, intervalUnit: "week", firstDueDate: "2026-11-05" });
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "MONTHLY" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ frequency: "MONTHLY", intervalCount: 1, intervalUnit: null });
  });

  it("switching frequency to CUSTOM requires intervalUnit", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "CUSTOM" });
    expect(res.status).toBe(400);
  });

  it("rejects an update moving endDate before the existing firstDueDate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ endDate: "2026-10-01" });
    expect(res.status).toBe(400);
  });

  it("rejects an update moving firstDueDate after the existing endDate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie)
      .send({ ...monthly, endDate: "2026-12-05" });
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ firstDueDate: "2027-01-01" });
    expect(res.status).toBe(400);
  });

  it("rejects an update categoryId that does not exist in this household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    const res = await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie)
      .send({ categoryId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
  });

  it("records old/new values in the audit log on update", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", owner.cookie).send({ provider: "BESCOM" });
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.updated")));
    expect(log.newValue).toMatchObject({ provider: "BESCOM" });
  });

  describe("status transitions", () => {
    async function createActiveBill(h: { id: string }, cookie: string) {
      const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie).send(monthly);
      return res.body.data.id as string;
    }

    it("pauses an active bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      const [row] = await ctx.db.select().from(bills).where(eq(bills.id, id));
      expect(row!.status).toBe("PAUSED");
    });

    it("rejects pausing an already-paused bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("rejects pausing an archived bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("resumes a paused bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/resume`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      const [row] = await ctx.db.select().from(bills).where(eq(bills.id, id));
      expect(row!.status).toBe("ACTIVE");
    });

    it("rejects resuming an active bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/resume`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("rejects resuming an archived bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/resume`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("archives an active bill, setting archivedAt", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      const [row] = await ctx.db.select().from(bills).where(eq(bills.id, id));
      expect(row!.status).toBe("ARCHIVED");
      expect(row!.archivedAt).not.toBeNull();
    });

    it("archives a paused bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
    });

    it("rejects archiving an already-archived bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("unarchives a bill back to ACTIVE, clearing archivedAt", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/archive`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/unarchive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      const [row] = await ctx.db.select().from(bills).where(eq(bills.id, id));
      expect(row!.status).toBe("ACTIVE");
      expect(row!.archivedAt).toBeNull();
    });

    it("rejects unarchiving an active bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/unarchive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("rejects unarchiving a paused bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const id = await createActiveBill(h, owner.cookie);
      await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/${id}/unarchive`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(409);
    });

    it("404s transitioning a bill that does not exist", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const res = await ctx.request.post(`/api/households/${h.id}/bills/00000000-0000-0000-0000-000000000000/pause`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(404);
    });
  });

  it("VIEWER can list and view bills but not manage them", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const createRes = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", owner.cookie).send(monthly);
    const id = createRes.body.data.id;
    expect((await ctx.request.get(`/api/households/${h.id}/bills`).set("cookie", viewer.cookie)).status).toBe(200);
    expect((await ctx.request.get(`/api/households/${h.id}/bills/${id}`).set("cookie", viewer.cookie)).status).toBe(200);
    expect((await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", viewer.cookie).send(monthly)).status).toBe(403);
    expect((await ctx.request.patch(`/api/households/${h.id}/bills/${id}`).set(csrf).set("cookie", viewer.cookie).send({ provider: "X" })).status).toBe(403);
    expect((await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", viewer.cookie)).status).toBe(403);
  });

  it("a member of household A cannot view or manage bills of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const createRes = await ctx.request.post(`/api/households/${b.id}/bills`).set(csrf).set("cookie", bob.cookie).send(monthly);
    const id = createRes.body.data.id;
    expect((await ctx.request.get(`/api/households/${b.id}/bills`).set("cookie", alice.cookie)).status).toBe(404);
    expect((await ctx.request.get(`/api/households/${b.id}/bills/${id}`).set("cookie", alice.cookie)).status).toBe(404);
    expect((await ctx.request.post(`/api/households/${b.id}/bills`).set(csrf).set("cookie", alice.cookie).send(monthly)).status).toBe(404);
    expect((await ctx.request.post(`/api/households/${b.id}/bills/${id}/pause`).set(csrf).set("cookie", alice.cookie)).status).toBe(404);
  });
});
