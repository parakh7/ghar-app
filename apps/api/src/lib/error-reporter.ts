import type { Logger } from "./logger.js";

export type ErrorContext = { reqId?: string; path?: string };

/** Swap in Sentry/Bugsnag/etc. later without touching error-handling code — same pattern as EmailProvider. */
export interface ErrorReporter {
  report(err: unknown, context: ErrorContext): void;
}

/** Development/production-without-a-vendor: routes through the existing structured logger. */
export class ConsoleErrorReporter implements ErrorReporter {
  constructor(private readonly logger: Logger) {}
  report(err: unknown, context: ErrorContext): void {
    this.logger.error({ err, ...context }, "reported error");
  }
}

/** Tests: keeps reported errors in memory so assertions can inspect them. */
export class MemoryErrorReporter implements ErrorReporter {
  readonly reported: Array<{ err: unknown; context: ErrorContext }> = [];
  report(err: unknown, context: ErrorContext): void {
    this.reported.push({ err, context });
  }
  last(): { err: unknown; context: ErrorContext } | undefined {
    return this.reported[this.reported.length - 1];
  }
}
