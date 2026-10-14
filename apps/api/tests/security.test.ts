import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, csrf, signupUser, truncateAll } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

describe("CSRF protection", () => {
  it("blocks state-changing requests without the client header", async () => {
    const res = await ctx.request.post("/api/auth/login").send({ email: "a@example.com", password: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("blocks requests from a foreign Origin even with the header", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/households").set(csrf).set("origin", "https://evil.example").set("cookie", u.cookie).send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("allows the app's own origin", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/households").set(csrf).set("origin", "http://localhost:5173").set("cookie", u.cookie).send({ name: "Home" });
    expect(res.status).toBe(201);
  });

  it("does not send CORS allow headers to foreign origins", async () => {
    const res = await ctx.request.options("/api/auth/login").set("origin", "https://evil.example").set("access-control-request-method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("hardening", () => {
  it("sets secure headers and hides the framework", async () => {
    const res = await ctx.request.get("/api/health/live");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("never leaks internals on malformed input", async () => {
    const res = await ctx.request.post("/api/auth/login").set(csrf).set("content-type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Malformed request.", fields: { _: expect.any(String) } } });
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|SyntaxError/);
  });

  it("returns a JSON 404 envelope for unknown routes", async () => {
    const res = await ctx.request.get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("marks API responses as non-cacheable", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.get("/api/auth/me").set("cookie", u.cookie);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("reports readiness including the database", async () => {
    const res = await ctx.request.get("/api/health/ready");
    expect(res.body.data).toEqual({ status: "ok", db: "ok" });
  });

  it("reports a genuinely unhandled error to the error reporter", async () => {
    const { errorHandler } = await import("../src/middleware/error.js");
    const { MemoryErrorReporter } = await import("../src/lib/error-reporter.js");
    const reporter = new MemoryErrorReporter();
    const handler = errorHandler(ctx.deps.logger, reporter);
    const req = { requestId: "req-1", path: "/api/whatever" } as never;
    const res = { status: () => res, json: () => res } as never;
    handler(new Error("boom"), req, res, (() => {}) as never);
    expect(reporter.reported).toHaveLength(1);
    expect(reporter.reported[0]?.context).toEqual({ reqId: "req-1", path: "/api/whatever" });
  });

  it("does not report an AppError (expected 4xx) to the error reporter", async () => {
    const { errorHandler } = await import("../src/middleware/error.js");
    const { MemoryErrorReporter } = await import("../src/lib/error-reporter.js");
    const { Errors } = await import("../src/lib/errors.js");
    const reporter = new MemoryErrorReporter();
    const handler = errorHandler(ctx.deps.logger, reporter);
    const req = { requestId: "req-2", path: "/api/whatever" } as never;
    const res = { status: () => res, json: () => res } as never;
    handler(Errors.validation({ field: "bad" }), req, res, (() => {}) as never);
    expect(reporter.reported).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  const limited = createTestContext({ RATE_LIMIT_AUTH_MAX: "3" });
  afterAll(() => limited.close());

  it("throttles repeated login attempts for the same email", async () => {
    const attempt = () => limited.request.post("/api/auth/login").set(csrf).send({ email: "victim@example.com", password: "guess guess" });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    // a different account from the same IP is unaffected
    const other = await limited.request.post("/api/auth/login").set(csrf).send({ email: "someone-else@example.com", password: "guess guess" });
    expect(other.status).toBe(401);
  });

  it("throttles invite creation and resend so they can't be used to email-bomb strangers", async () => {
    const owner = await signupUser(limited);
    const created = await limited.request.post("/api/households").set(csrf).set("cookie", owner.cookie).send({ name: "Rate Limited Home" });
    const householdId = created.body.data.id as string;
    const attempt = (n: number) => limited.request.post(`/api/households/${householdId}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: `invitee${n}@example.com`, role: "MEMBER" });
    for (let i = 0; i < 3; i++) expect((await attempt(i)).status).toBe(201);
    const blocked = await attempt(3);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});
