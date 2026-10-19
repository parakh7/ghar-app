import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("rejects the default placeholder EMAIL_FROM in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgresql://x/y" })).toThrow(/EMAIL_FROM/);
  });

  it("accepts an explicit non-placeholder EMAIL_FROM in production", () => {
    const env = loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgresql://x/y", EMAIL_FROM: "Ghar <no-reply@real-domain.com>" });
    expect(env.EMAIL_FROM).toBe("Ghar <no-reply@real-domain.com>");
  });

  it("still allows the default placeholder EMAIL_FROM in development and test", () => {
    const dev = loadEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://x/y" });
    expect(dev.EMAIL_FROM).toBe("Household <no-reply@example.com>");
    const test = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://x/y" });
    expect(test.EMAIL_FROM).toBe("Household <no-reply@example.com>");
  });

  it("requires RESEND_API_KEY when EMAIL_PROVIDER=resend", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", EMAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY/);
  });

  it("accepts EMAIL_PROVIDER=resend when RESEND_API_KEY is set", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" });
    expect(env.EMAIL_PROVIDER).toBe("resend");
    expect(env.RESEND_API_KEY).toBe("re_test_key");
  });

  it("does not require RESEND_API_KEY for console or memory providers", () => {
    const console_ = loadEnv({ DATABASE_URL: "postgresql://x/y", EMAIL_PROVIDER: "console" });
    expect(console_.RESEND_API_KEY).toBeUndefined();
  });

  it("defaults JOB_RUNNER to bullmq, no JOBS_SECRET required", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y" });
    expect(env.JOB_RUNNER).toBe("bullmq");
    expect(env.JOBS_SECRET).toBeUndefined();
  });

  it("requires JOBS_SECRET when JOB_RUNNER=http", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", JOB_RUNNER: "http" })).toThrow(/JOBS_SECRET/);
  });

  it("accepts JOB_RUNNER=http when JOBS_SECRET is set", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y", JOB_RUNNER: "http", JOBS_SECRET: "s3cret" });
    expect(env.JOB_RUNNER).toBe("http");
    expect(env.JOBS_SECRET).toBe("s3cret");
  });

  it("defaults PUSH_PROVIDER to console, no VAPID keys required", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y" });
    expect(env.PUSH_PROVIDER).toBe("console");
    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it("requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY when PUSH_PROVIDER=web-push", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push" })).toThrow(/VAPID_PUBLIC_KEY/);
  });

  it("accepts PUSH_PROVIDER=web-push when both VAPID keys are set", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    expect(env.PUSH_PROVIDER).toBe("web-push");
  });

  it("rejects a VAPID_EMAIL that isn't a mailto: or https: URI when PUSH_PROVIDER=web-push", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_EMAIL: "admin@example.com" }))
      .toThrow(/VAPID_EMAIL/);
  });
});
