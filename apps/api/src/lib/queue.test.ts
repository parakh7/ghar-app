import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeQueue } from "./queue.js";

// Spies standing in for BullMQ's `Queue`/`Worker` classes, so these tests can assert on
// construction/call behavior without a real Redis connection. Each records every instance
// constructed and every call made to it.
const queueInstances: Array<{ onCalls: string[] }> = [];
const workerInstances: Array<{ onCalls: string[] }> = [];

vi.mock("bullmq", () => {
  class FakeBullQueue {
    onCalls: string[] = [];
    constructor(..._args: unknown[]) {
      queueInstances.push(this);
    }
    on(event: string, _handler: unknown) {
      this.onCalls.push(event);
    }
    async upsertJobScheduler() {}
    async close() {}
  }
  class FakeBullWorker {
    onCalls: string[] = [];
    constructor(..._args: unknown[]) {
      workerInstances.push(this);
    }
    on(event: string, _handler: unknown) {
      this.onCalls.push(event);
    }
    async close() {}
  }
  return { Queue: FakeBullQueue, Worker: FakeBullWorker };
});

describe("BullMQQueue", () => {
  afterEach(() => {
    queueInstances.length = 0;
    workerInstances.length = 0;
    vi.resetModules();
  });

  it("does not construct a Worker when { consume: true } is omitted (defaults to non-consuming)", async () => {
    const { BullMQQueue } = await import("./queue.js");
    const env = { REDIS_URL: "redis://localhost:6379" } as never;
    const logger = { error: vi.fn() } as never;

    new BullMQQueue(env, logger);

    expect(queueInstances).toHaveLength(1);
    expect(workerInstances).toHaveLength(0);
  });

  it("does not construct a Worker when explicitly passed { consume: false }", async () => {
    const { BullMQQueue } = await import("./queue.js");
    const env = { REDIS_URL: "redis://localhost:6379" } as never;
    const logger = { error: vi.fn() } as never;

    new BullMQQueue(env, logger, { consume: false });

    expect(queueInstances).toHaveLength(1);
    expect(workerInstances).toHaveLength(0);
  });

  it("constructs a Worker only when passed { consume: true }", async () => {
    const { BullMQQueue } = await import("./queue.js");
    const env = { REDIS_URL: "redis://localhost:6379" } as never;
    const logger = { error: vi.fn() } as never;

    new BullMQQueue(env, logger, { consume: true });

    expect(queueInstances).toHaveLength(1);
    expect(workerInstances).toHaveLength(1);
  });

  it("attaches an error listener to the underlying Queue so BullMQ doesn't fall back to console.error", async () => {
    const { BullMQQueue } = await import("./queue.js");
    const env = { REDIS_URL: "redis://localhost:6379" } as never;
    const logger = { error: vi.fn() } as never;

    new BullMQQueue(env, logger);

    expect(queueInstances[0]?.onCalls).toContain("error");
  });
});

describe("FakeQueue", () => {
  it("runHandler invokes the registered handler with the given data", async () => {
    const queue = new FakeQueue();
    const seen: unknown[] = [];
    queue.registerHandler("heartbeat", async (data) => {
      seen.push(data);
    });

    await queue.runHandler("heartbeat", { tick: 1 });

    expect(seen).toEqual([{ tick: 1 }]);
  });

  it("scheduleRepeating records the call without invoking the handler", async () => {
    const queue = new FakeQueue();
    let called = false;
    queue.registerHandler("heartbeat", async () => {
      called = true;
    });

    await queue.scheduleRepeating("heartbeat", { every: "minute" }, 60_000);

    expect(queue.scheduled).toEqual([{ jobName: "heartbeat", data: { every: "minute" }, everyMs: 60_000 }]);
    expect(called).toBe(false);
  });

  it("runHandler throws a clear error for an unregistered job name", async () => {
    const queue = new FakeQueue();
    await expect(queue.runHandler("unknown-job", {})).rejects.toThrow(/no handler registered for job "unknown-job"/);
  });
});
