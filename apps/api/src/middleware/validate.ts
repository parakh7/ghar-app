import type { Request } from "express";
import type { z } from "zod";
import { Errors } from "../lib/errors.js";

/** Parse + validate untrusted input. Returns typed data or throws a friendly VALIDATION_ERROR. */
export function parseBody<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      fields[key] ??= issue.message;
    }
    throw Errors.validation(fields);
  }
  return result.data;
}
