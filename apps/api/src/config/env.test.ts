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
});
