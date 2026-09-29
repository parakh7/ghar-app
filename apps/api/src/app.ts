import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { allowedOrigins } from "./config/env.js";
import { authenticate } from "./middleware/auth.js";
import { csrfProtection } from "./middleware/csrf.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { globalLimiter } from "./middleware/rate-limit.js";
import { requestContext } from "./middleware/request-context.js";
import { authRoutes } from "./routes/auth.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { householdRoutes } from "./routes/household.routes.js";
import { inviteRoutes } from "./routes/invite.routes.js";
import type { Deps } from "./services/deps.js";

export function createApp(deps: Deps): Express {
  const app = express();
  const origins = allowedOrigins(deps.env);

  app.disable("x-powered-by");
  app.set("trust proxy", deps.env.TRUST_PROXY);
  app.set("query parser", "simple");

  app.use(requestContext(deps.logger));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, // JSON API only
    crossOriginResourcePolicy: { policy: "same-site" },
  }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "x-household-client", "x-request-id", "authorization"],
    maxAge: 600,
  }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/api/health", healthRoutes(deps));
  app.use("/api", globalLimiter(deps.env.RATE_LIMIT_GLOBAL_MAX));
  app.use("/api", csrfProtection(origins));
  app.use("/api", authenticate(deps));
  app.use((_req, res, next) => { res.setHeader("cache-control", "no-store"); next(); });

  app.use("/api/auth", authRoutes(deps));
  app.use("/api/households", householdRoutes(deps));
  app.use("/api/invites", inviteRoutes(deps));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
