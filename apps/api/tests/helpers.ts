import { sql } from "drizzle-orm";
import supertest from "supertest";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@household/shared";
import { createApp } from "../src/app.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { MemoryErrorReporter } from "../src/lib/error-reporter.js";
import { createLogger } from "../src/lib/logger.js";
import { FakeQueue } from "../src/lib/queue.js";
import { MemoryEmailProvider } from "../src/services/email/email.provider.js";
import { MemoryPushProvider } from "../src/services/push/push.provider.js";
import type { Deps } from "../src/services/deps.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/household_test";

export class FakeClock {
  constructor(private t = new Date("2026-09-29T04:30:00Z")) {} // 10:00 IST
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  set(iso: string) { this.t = new Date(iso); }
}

export const DAY = 86_400_000;

export type TestContext = {
  deps: Deps;
  db: Database;
  email: MemoryEmailProvider;
  push: MemoryPushProvider;
  clock: FakeClock;
  queue: FakeQueue;
  errorReporter: MemoryErrorReporter;
  request: ReturnType<typeof supertest>;
  close: () => Promise<void>;
};

export function createTestContext(envOverrides: Partial<Record<keyof Env, string>> = {}): TestContext {
  const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: TEST_DB_URL, LOG_LEVEL: "silent", RATE_LIMIT_AUTH_MAX: "1000", RATE_LIMIT_GLOBAL_MAX: "10000", APP_URL: "http://localhost:5173", ...envOverrides });
  const pool = createPool(env.DATABASE_URL, 5);
  const db = createDb(pool);
  const email = new MemoryEmailProvider();
  const push = new MemoryPushProvider();
  const clock = new FakeClock();
  const queue = new FakeQueue();
  const errorReporter = new MemoryErrorReporter();
  const deps: Deps = { env, db, logger: createLogger(env), clock, email, push, queue, errorReporter };
  const app = createApp(deps);
  return { deps, db, email, push, clock, queue, errorReporter, request: supertest(app), close: () => pool.end() };
}

export async function truncateAll(db: Database) {
  const rows = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = rows.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}

export const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE } as const;

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"] as string[] | undefined;
  const c = set?.find((s) => s.startsWith("hh_session="));
  if (!c) throw new Error("no session cookie set");
  return c.split(";")[0]!;
}

let n = 0;
export async function signupUser(ctx: TestContext, overrides: { name?: string; email?: string; password?: string } = {}) {
  n += 1;
  const body = { name: overrides.name ?? `User ${n}`, email: overrides.email ?? `user${n}-${Date.now()}@example.com`, password: overrides.password ?? "correct horse battery" };
  const res = await ctx.request.post("/api/auth/signup").set(csrf).send(body);
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...body, cookie: cookieFrom(res), id: res.body.data.user.id as string };
}

export function tokenFromLink(text: string): string {
  const m = /token=([A-Za-z0-9_\-%]+)/.exec(text);
  if (!m) throw new Error("no token in email");
  return decodeURIComponent(m[1]!);
}

/** Emails are sent fire-and-forget after signup; wait a tick for them to land. */
export const flush = () => new Promise((r) => setTimeout(r, 50));
