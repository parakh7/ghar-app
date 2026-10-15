import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const PLACEHOLDER_EMAIL_FROM = "Household <no-reply@example.com>";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  EMAIL_PROVIDER: z.enum(["console", "memory", "resend"]).default("console"),
  EMAIL_FROM: z.string().default(PLACEHOLDER_EMAIL_FROM),
  RESEND_API_KEY: z.string().optional(),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: bool.optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.EMAIL_FROM === PLACEHOLDER_EMAIL_FROM) {
    ctx.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "EMAIL_FROM must be set to a real sender address in production (the default placeholder is for development only)." });
  }
  if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "RESEND_API_KEY is required when EMAIL_PROVIDER=resend." });
  }
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function allowedOrigins(env: Env): string[] {
  return [env.APP_URL, ...env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)].map((o) => new URL(o).origin);
}
