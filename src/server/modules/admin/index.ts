// Admin console module wiring (ADR-0008). The human console authenticates with session cookies (not
// the machine X-API-Key — app.ts exempts /admin/*), so this module owns login, RBAC, users, API-key
// management, and the read-only audit view. Session lifetime is operator-configurable and hard-bounded
// (default 8h, max 24h) per FR-003. The shared HMAC secret is the same one the machine auth path uses.
import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../../app.js";
import { registerAdminRoutes } from "./routes.js";

/** Default admin session lifetime: 8 hours (FR-003). */
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Hard ceiling on a configured session lifetime: 24 hours (FR-003). */
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface AdminConfig {
  sessionTtlSeconds: number;
}

/** Read admin config from the environment, clamping the session TTL into the supported bound. */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const raw = Number(env.ADMIN_SESSION_TTL_SECONDS);
  const ttl = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SESSION_TTL_SECONDS) : DEFAULT_SESSION_TTL_SECONDS;
  return { sessionTtlSeconds: ttl };
}

/** The module's registration seam (ADR-0005). Wires the /admin console routes under session auth. */
export function registerAdmin(app: FastifyInstance, deps: AppDeps): void {
  const config = loadAdminConfig();
  registerAdminRoutes(app, deps.pool, {
    sessionTtlSeconds: config.sessionTtlSeconds,
    secret: deps.apiKeySecret,
  });
}
