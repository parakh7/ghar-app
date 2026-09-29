import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "../lib/logger.js";

export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("x-request-id");
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", req.requestId);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      // path only — never the query string (reset tokens can live there)
      logger[level]({ reqId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), userId: req.auth?.user.id }, "request");
    });
    next();
  };
}
