import { DEFAULT_LOCKOUT } from "./auth.js";
import { registerAdminRoutes } from "./routes.js";
/** Default admin session lifetime: 8 hours (FR-003). */
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Hard ceiling on a configured session lifetime: 24 hours (FR-003). */
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** A positive integer from the environment, or a fallback when unset/invalid. */
function positiveInt(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
/** Read admin config from the environment, clamping the session TTL into the supported bound (FR-003/018). */
export function loadAdminConfig(env = process.env) {
    const ttlRaw = Number(env.ADMIN_SESSION_TTL_SECONDS);
    const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0
        ? Math.min(ttlRaw, MAX_SESSION_TTL_SECONDS)
        : DEFAULT_SESSION_TTL_SECONDS;
    return {
        sessionTtlSeconds: ttl,
        maxFailedLogins: positiveInt(env.ADMIN_MAX_FAILED_LOGINS, DEFAULT_LOCKOUT.maxFailedLogins),
        lockoutSeconds: positiveInt(env.ADMIN_LOCKOUT_SECONDS, DEFAULT_LOCKOUT.lockoutSeconds),
    };
}
/** The module's registration seam (ADR-0005). Wires the /admin console routes under session auth. */
export function registerAdmin(app, deps) {
    const config = loadAdminConfig();
    registerAdminRoutes(app, deps.pool, {
        sessionTtlSeconds: config.sessionTtlSeconds,
        maxFailedLogins: config.maxFailedLogins,
        lockoutSeconds: config.lockoutSeconds,
        secret: deps.apiKeySecret,
    });
}
