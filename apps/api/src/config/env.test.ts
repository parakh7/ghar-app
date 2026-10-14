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
});
