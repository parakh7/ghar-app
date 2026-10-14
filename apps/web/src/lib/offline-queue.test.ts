import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { drainQueue, enqueueMutation, getPendingKeysSnapshot } from "./offline-queue";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ITEM = {
  type: "attendance" as const, householdId: "h1", clientMutationId: "m1",
  endpoint: "/households/h1/attendance/hh1", body: { date: "2026-10-14", status: "PRESENT" },
  pendingKey: "attendance:hh1:2026-10-14", createdAt: "2026-10-14T00:00:00.000Z",
};

describe("offline-queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Fresh fake IndexedDB per test — without this, items from one test leak into the next
    // (the module never caches a single DB connection, but the underlying fake storage is
    // otherwise shared across the whole file).
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("enqueues a mutation and exposes its pending key", async () => {
    await enqueueMutation(ITEM);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(true);
  });

  it("drains a queued mutation on success, clearing its pending key and invalidating the query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true, data: { date: "2026-10-14", status: "PRESENT", note: null }, message: null }));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const failures = await drainQueue(qc);
    expect(failures).toEqual([]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["attendance", "today", "h1"] });
  });

  it("stops draining on a network error, leaving the item queued", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const failures = await drainQueue(qc);
    expect(failures).toEqual([]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(true);
  });

  it("drops an item and reports it on a non-network error, then continues", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: false, error: { code: "FORBIDDEN", message: "You don't have permission to do that." } }, 403));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const failures = await drainQueue(qc);
    expect(failures).toEqual([{ pendingKey: "attendance:hh1:2026-10-14", message: "You don't have permission to do that." }]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(false);
  });
});
