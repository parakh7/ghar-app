import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as the db. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

// Return `date` columns as plain "YYYY-MM-DD" strings — never as JS Dates shifted by server TZ.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string, max = 10): pg.Pool {
  // Every connection speaks UTC (set at connect time, before any query); household timezones are applied explicitly in code.
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, options: "-c TimeZone=UTC" });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema, casing: "snake_case" });
}

export { schema };
