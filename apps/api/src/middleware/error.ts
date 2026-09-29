import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, Errors } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { fail } from "../lib/respond.js";

export const notFoundHandler: RequestHandler = (_req, res) => fail(res, Errors.notFound("That page"));

/** Users never see raw errors; technical details go to logs with the request id. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof AppError) return fail(res, err);
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") return fail(res, Errors.validation({ _: "Malformed JSON body." }, "Malformed request."));
    if (e?.type === "entity.too.large") return fail(res, new AppError("VALIDATION_ERROR", "Request is too large.", 413));
    logger.error({ err, reqId: req.requestId, path: req.path }, "unhandled error");
    fail(res, new AppError("INTERNAL_ERROR", "Something went wrong on our side. Please try again.", 500));
  };
}
