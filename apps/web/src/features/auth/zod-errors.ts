import type { ZodError } from "zod";

export function zodFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join(".") || "_"] ??= issue.message;
  return out;
}
