import { describe, expect, it } from "vitest";
import { FakeQueue } from "./queue.js";

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
