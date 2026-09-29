import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/household_test";

/** Wipes the test database and applies migrations from scratch — tests always run against the real schema. */
export default async function setup() {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) throw new Error(`Refusing to wipe non-test database: ${TEST_DB_URL}`);
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  await runMigrations(TEST_DB_URL);
}
