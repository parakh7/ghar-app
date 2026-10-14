import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiError, put } from "./api";

export type QueuedMutationType = "attendance" | "checklist";

export type QueuedMutation = {
  id?: number;
  type: QueuedMutationType;
  householdId: string;
  clientMutationId: string;
  endpoint: string;
  body: Record<string, unknown>;
  pendingKey: string;
  createdAt: string;
};

export type SyncFailure = { pendingKey: string; message: string };

interface QueueDB extends DBSchema {
  mutations: { key: number; value: QueuedMutation };
}

const DB_NAME = "ghar-offline-queue";
const STORE_NAME = "mutations";

// Intentionally not cached at module scope: tests swap out `globalThis.indexedDB` between
// cases to get a clean store, and a cached connection would keep pointing at the old one.
function getDb(): Promise<IDBPDatabase<QueueDB>> {
  return openDB<QueueDB>(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    },
  });
}

// Pending-key store as a tiny external store (not React state) — this module has no React
// dependency otherwise, and the data needs to be readable from plain hook code.
let pendingKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function addPendingKey(key: string): void {
  const next = new Set(pendingKeys);
  next.add(key);
  pendingKeys = next;
  notify();
}

function removePendingKey(key: string): void {
  const next = new Set(pendingKeys);
  next.delete(key);
  pendingKeys = next;
  notify();
}

export function getPendingKeysSnapshot(): ReadonlySet<string> {
  return pendingKeys;
}

export function subscribePendingKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribePendingKeys, getPendingKeysSnapshot, getPendingKeysSnapshot);
}

export async function enqueueMutation(item: Omit<QueuedMutation, "id">): Promise<void> {
  const db = await getDb();
  await db.add(STORE_NAME, item as QueuedMutation);
  addPendingKey(item.pendingKey);
}

function queryKeyFor(item: QueuedMutation): readonly [string, string, string] {
  return item.type === "attendance" ? (["attendance", "today", item.householdId] as const) : (["checklist", "today", item.householdId] as const);
}

export async function drainQueue(qc: QueryClient): Promise<SyncFailure[]> {
  const db = await getDb();
  const failures: SyncFailure[] = [];
  const items = await db.getAll(STORE_NAME);
  for (const item of items) {
    try {
      await put(item.endpoint, item.body);
      await db.delete(STORE_NAME, item.id!);
      removePendingKey(item.pendingKey);
      await qc.invalidateQueries({ queryKey: queryKeyFor(item) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "NETWORK_ERROR") break;
      await db.delete(STORE_NAME, item.id!);
      removePendingKey(item.pendingKey);
      failures.push({ pendingKey: item.pendingKey, message: err instanceof ApiError ? err.message : "Sync failed." });
    }
  }
  return failures;
}
