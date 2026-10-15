import { describe, expect, it } from "vitest";
import { createTestContext, truncateAll } from "./helpers.js";
import { runAllJobs, type NamedJob } from "../src/routes/internal.routes.js";

describe("POST /api/internal/run-jobs", () => {
  it("rejects a missing or wrong jobs secret", async () => {
    const ctx = createTestContext({ JOB_RUNNER: "http", JOBS_SECRET: "correct-secret" });
    await truncateAll(ctx.db);

    const missing = await ctx.request.post("/api/internal/run-jobs");
    expect(missing.status).toBe(403);

    const wrong = await ctx.request.post("/api/internal/run-jobs").set("x-jobs-secret", "nope");
    expect(wrong.status).toBe(403);

    await ctx.close();
  });

  it("runs all three jobs and reports them when the secret matches", async () => {
    const ctx = createTestContext({ JOB_RUNNER: "http", JOBS_SECRET: "correct-secret" });
    await truncateAll(ctx.db);

    const res = await ctx.request.post("/api/internal/run-jobs").set("x-jobs-secret", "correct-secret");

    expect(res.status).toBe(200);
    expect(res.body.data.ran).toEqual([
      { name: "heartbeat", ok: true },
      { name: "evaluate-reminders", ok: true },
      { name: "dispatch-email-deliveries", ok: true },
    ]);

    await ctx.close();
  });

  it("skips a concurrent request while a run is already in progress", async () => {
    const ctx = createTestContext({ JOB_RUNNER: "http", JOBS_SECRET: "correct-secret" });
    await truncateAll(ctx.db);

    const [first, second] = await Promise.all([
      ctx.request.post("/api/internal/run-jobs").set("x-jobs-secret", "correct-secret"),
      ctx.request.post("/api/internal/run-jobs").set("x-jobs-secret", "correct-secret"),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
    const skippedRes = first.status === 202 ? first : second;
    expect(skippedRes.body.data).toEqual({ skipped: true });

    await ctx.close();
  });

  it("does not register the route when JOB_RUNNER is not http — falls through to CSRF protection like any other unmatched POST", async () => {
    const ctx = createTestContext();
    await truncateAll(ctx.db);

    const res = await ctx.request.post("/api/internal/run-jobs").set("x-jobs-secret", "anything");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");

    await ctx.close();
  });
});

describe("runAllJobs", () => {
  it("isolates one job's thrown error so the rest still run", async () => {
    const ctx = createTestContext();
    await truncateAll(ctx.db);

    const calls: string[] = [];
    const jobs: NamedJob[] = [
      { name: "first", run: async () => { calls.push("first"); } },
      { name: "second", run: async () => { calls.push("second"); throw new Error("boom"); } },
      { name: "third", run: async () => { calls.push("third"); } },
    ];

    const results = await runAllJobs(jobs, ctx.deps);

    expect(calls).toEqual(["first", "second", "third"]);
    expect(results).toEqual([
      { name: "first", ok: true },
      { name: "second", ok: false, error: "boom" },
      { name: "third", ok: true },
    ]);

    await ctx.close();
  });
});
