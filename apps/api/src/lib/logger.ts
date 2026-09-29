import pino, { type Logger } from "pino";
import type { Env } from "../config/env.js";

/** Never log secrets: passwords, tokens, cookies, auth headers, account numbers. */
export const REDACT_PATHS = [
  "req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']",
  "*.password", "*.currentPassword", "*.newPassword", "*.token", "*.passwordHash", "*.tokenHash",
  "*.accountNumber", "*.p256dh", "*.auth",
];

export function createLogger(env: Pick<Env, "LOG_LEVEL" | "NODE_ENV" | "LOG_PRETTY">): Logger {
  const pretty = env.LOG_PRETTY ?? env.NODE_ENV === "development";
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "household-api" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } } : {}),
  });
}

export type { Logger };
