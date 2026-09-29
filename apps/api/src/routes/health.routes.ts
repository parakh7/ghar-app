import { sql } from "drizzle-orm";
import { Router } from "express";
import { ok } from "../lib/respond.js";
import { AppError } from "../lib/errors.js";
import type { Deps } from "../services/deps.js";

export function healthRoutes(deps: Deps): Router {
  const r = Router();
  r.get("/live", (_req, res) => ok(res, { status: "ok" }));
  r.get("/ready", async (_req, res) => {
    try {
      await deps.db.execute(sql`select 1`);
      ok(res, { status: "ok", db: "ok" });
    } catch (err) {
      deps.logger.error({ err }, "readiness check failed");
      throw new AppError("INTERNAL_ERROR", "Not ready.", 503);
    }
  });
  return r;
}
