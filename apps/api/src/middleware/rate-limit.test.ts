import { describe, expect, it, vi, beforeEach } from "vitest";

const sendCommandCalls: unknown[][] = [];

vi.mock("ioredis", () => {
  class FakeRedis {
    async call(...args: unknown[]) {
      sendCommandCalls.push(args);
      return "OK";
    }
  }
  return { default: FakeRedis, Redis: FakeRedis };
});

function runLimiter(limiter: ReturnType<typeof import("./rate-limit.js")["globalLimiter"]> extends never ? never : (req: unknown, res: unknown, next: () => void) => void) {
  return new Promise<void>((resolve) => {
    const req = { ip: "127.0.0.1", headers: {}, path: "/", method: "GET", app: { get: () => false } };
    const res = { setHeader: () => {}, getHeader: () => undefined, status: () => res, json: () => res, send: () => res, end: () => {} };
    limiter(req, res, () => resolve());
  });
}

describe("rate limiters with a Redis client", () => {
  beforeEach(() => { sendCommandCalls.length = 0; });

  it("globalLimiter issues a Redis command when given a redis client", async () => {
    const { Redis } = await import("ioredis");
    const { globalLimiter } = await import("./rate-limit.js");
    const redis = new Redis();
    const limiter = globalLimiter(100, redis as never);
    await runLimiter(limiter as never);
    expect(sendCommandCalls.length).toBeGreaterThan(0);
  });

  it("globalLimiter falls back to the in-memory store (no Redis command) when no redis client is given", async () => {
    const { globalLimiter } = await import("./rate-limit.js");
    const limiter = globalLimiter(100);
    await runLimiter(limiter as never);
    expect(sendCommandCalls.length).toBe(0);
  });
});
