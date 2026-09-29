import type { ActiveSession } from "./services/session.service.js";
import type { Membership } from "./services/household.service.js";
import type { Permission } from "@household/shared";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: ActiveSession;
      membership?: Membership & { permissions: Set<Permission> };
    }
  }
}
export {};
