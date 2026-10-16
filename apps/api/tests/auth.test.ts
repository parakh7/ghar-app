import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authTokens, userSessions, users } from "../src/db/schema.js";
import { cookieFrom, createTestContext, csrf, DAY, flush, signupUser, tokenFromLink, truncateAll } from "./helpers.js";

const ctx = createTestContext();
beforeEach(async () => { await truncateAll(ctx.db); ctx.email.sent.length = 0; ctx.clock.set("2026-09-29T04:30:00Z"); });
afterAll(() => ctx.close());

describe("signup", () => {
  it("creates an account, signs the user in with an httpOnly cookie, and never stores the plain password", async () => {
    const res = await ctx.request.post("/api/auth/signup").set(csrf).send({ name: "Parakh", email: "Parakh@Example.com ", password: "correct horse battery" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, data: { user: { name: "Parakh", email: "parakh@example.com", emailVerified: false }, households: [] } });
    const setCookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const [row] = await ctx.db.select().from(users).where(eq(users.email, "parakh@example.com"));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain("correct horse");

    const me = await ctx.request.get("/api/auth/me").set("cookie", cookieFrom(res));
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("parakh@example.com");
  });

  it("uses SameSite=None and the __Host- cookie prefix in production, so a separately-hosted SPA (e.g. Netlify + Render) can authenticate cross-site", async () => {
    const prodCtx = createTestContext({ NODE_ENV: "production", EMAIL_FROM: "Ghar <no-reply@test.example.com>" });
    await truncateAll(prodCtx.db);
    const res = await prodCtx.request.post("/api/auth/signup").set(csrf).send({ name: "Parakh", email: "prod@example.com", password: "correct horse battery" });
    expect(res.status).toBe(201);
    const setCookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(setCookie).toMatch(/^__Host-hh_session=/);
    expect(setCookie).toMatch(/SameSite=None/i);
    expect(setCookie).toMatch(/Secure/i);
    await prodCtx.close();
  });

  it("stores only a hash of the session token", async () => {
    const u = await signupUser(ctx);
    const raw = u.cookie.split("=")[1]!;
    const sessions = await ctx.db.select().from(userSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).not.toBe(raw);
    expect(sessions[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a duplicate email regardless of case", async () => {
    await signupUser(ctx, { email: "dup@example.com" });
    const res = await ctx.request.post("/api/auth/signup").set(csrf).send({ name: "X", email: "DUP@example.com", password: "another long password" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: { code: "EMAIL_TAKEN", message: expect.any(String), fields: { email: expect.any(String) } } });
  });

  it("returns field-level validation errors", async () => {
    const res = await ctx.request.post("/api/auth/signup").set(csrf).send({ name: "", email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.body.error.fields).sort()).toEqual(["email", "name", "password"]);
  });
});

describe("login & sessions", () => {
  it("logs in with correct credentials", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(u.id);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("gives the same error for a wrong password and an unknown email (no account enumeration)", async () => {
    const u = await signupUser(ctx);
    const wrong = await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: "wrong password!" });
    const unknown = await ctx.request.post("/api/auth/login").set(csrf).send({ email: "nobody@example.com", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logout revokes the session server-side", async () => {
    const u = await signupUser(ctx);
    const out = await ctx.request.post("/api/auth/logout").set(csrf).set("cookie", u.cookie);
    expect(out.status).toBe(200);
    const me = await ctx.request.get("/api/auth/me").set("cookie", u.cookie); // replaying the old cookie
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("expires sessions after the TTL", async () => {
    const u = await signupUser(ctx);
    ctx.clock.advance(31 * DAY);
    const me = await ctx.request.get("/api/auth/me").set("cookie", u.cookie);
    expect(me.status).toBe(401);
  });

  it("slides the expiry forward while the session is in use", async () => {
    const u = await signupUser(ctx);
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(20 * DAY);
      expect((await ctx.request.get("/api/auth/me").set("cookie", u.cookie)).status).toBe(200);
    }
  });

  it("accepts a Bearer token (for future native apps)", async () => {
    const u = await signupUser(ctx);
    const token = u.cookie.split("=")[1]!;
    const me = await ctx.request.get("/api/auth/me").set("authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  it("rejects /me without a session", async () => {
    const me = await ctx.request.get("/api/auth/me");
    expect(me.status).toBe(401);
  });
});

describe("email verification", () => {
  it("verifies with the emailed link, and the link is single-use", async () => {
    const u = await signupUser(ctx);
    await flush();
    const mail = ctx.email.last("verify-email");
    expect(mail?.to).toBe(u.email);
    const token = tokenFromLink(mail!.text);

    const ok = await ctx.request.post("/api/auth/verify-email").set(csrf).send({ token });
    expect(ok.status).toBe(200);
    const me = await ctx.request.get("/api/auth/me").set("cookie", u.cookie);
    expect(me.body.data.user.emailVerified).toBe(true);

    const again = await ctx.request.post("/api/auth/verify-email").set(csrf).send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_TOKEN");
  });

  it("resending invalidates the previous link", async () => {
    const u = await signupUser(ctx);
    await flush();
    const first = tokenFromLink(ctx.email.last("verify-email")!.text);
    await ctx.request.post("/api/auth/resend-verification").set(csrf).set("cookie", u.cookie).expect(200);
    const second = tokenFromLink(ctx.email.last("verify-email")!.text);
    expect(second).not.toBe(first);
    expect((await ctx.request.post("/api/auth/verify-email").set(csrf).send({ token: first })).status).toBe(400);
    expect((await ctx.request.post("/api/auth/verify-email").set(csrf).send({ token: second })).status).toBe(200);
  });
});

describe("password reset", () => {
  it("responds identically for unknown emails and sends nothing", async () => {
    await signupUser(ctx, { email: "known@example.com" });
    await flush();
    ctx.email.sent.length = 0;
    const known = await ctx.request.post("/api/auth/forgot-password").set(csrf).send({ email: "known@example.com" });
    const unknown = await ctx.request.post("/api/auth/forgot-password").set(csrf).send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(ctx.email.sent.filter((m) => m.tag === "reset-password")).toHaveLength(1);
  });

  it("resets the password, revokes every existing session, and the token cannot be reused", async () => {
    const u = await signupUser(ctx);
    const secondDevice = await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: u.password });
    await ctx.request.post("/api/auth/forgot-password").set(csrf).send({ email: u.email }).expect(200);
    const token = tokenFromLink(ctx.email.last("reset-password")!.text);

    const res = await ctx.request.post("/api/auth/reset-password").set(csrf).send({ token, password: "a brand new password" });
    expect(res.status).toBe(200);

    expect((await ctx.request.get("/api/auth/me").set("cookie", u.cookie)).status).toBe(401);
    expect((await ctx.request.get("/api/auth/me").set("cookie", cookieFrom(secondDevice))).status).toBe(401);
    expect((await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: u.password })).status).toBe(401);
    expect((await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: "a brand new password" })).status).toBe(200);

    const reuse = await ctx.request.post("/api/auth/reset-password").set(csrf).send({ token, password: "yet another password" });
    expect(reuse.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects an expired reset link", async () => {
    const u = await signupUser(ctx);
    await ctx.request.post("/api/auth/forgot-password").set(csrf).send({ email: u.email });
    const token = tokenFromLink(ctx.email.last("reset-password")!.text);
    ctx.clock.advance(61 * 60 * 1000);
    const res = await ctx.request.post("/api/auth/reset-password").set(csrf).send({ token, password: "a brand new password" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("stores reset tokens hashed", async () => {
    const u = await signupUser(ctx);
    await ctx.request.post("/api/auth/forgot-password").set(csrf).send({ email: u.email });
    const token = tokenFromLink(ctx.email.last("reset-password")!.text);
    const rows = await ctx.db.select().from(authTokens).where(eq(authTokens.purpose, "PASSWORD_RESET"));
    expect(rows.every((r) => r.tokenHash !== token)).toBe(true);
  });
});

describe("change password", () => {
  it("keeps this device signed in and signs out the others", async () => {
    const u = await signupUser(ctx);
    const other = cookieFrom(await ctx.request.post("/api/auth/login").set(csrf).send({ email: u.email, password: u.password }));
    const res = await ctx.request.post("/api/auth/change-password").set(csrf).set("cookie", u.cookie).send({ currentPassword: u.password, newPassword: "changed password 42" });
    expect(res.status).toBe(200);
    expect((await ctx.request.get("/api/auth/me").set("cookie", u.cookie)).status).toBe(200);
    expect((await ctx.request.get("/api/auth/me").set("cookie", other)).status).toBe(401);
  });

  it("requires the current password", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/auth/change-password").set(csrf).set("cookie", u.cookie).send({ currentPassword: "nope nope", newPassword: "changed password 42" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.currentPassword).toBeDefined();
  });
});
