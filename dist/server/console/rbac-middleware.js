import { recordSecurityEvent } from "../audit/index.js";
import { authorize } from "../auth/rbac.js";
import { withTenant } from "../db/client.js";
import { CSRF_COOKIE, CSRF_HEADER, csrfValid } from "./csrf.js";
import { resolveSession, SESSION_COOKIE } from "./session.js";
const ROLE_ORDER = { viewer: 1, admin: 2, owner: 3 };
/** The tenant's highest role for a user (owner > admin > viewer), or null if none (→ no access). */
async function highestRole(pool, tenantId, userId) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q("SELECT role FROM role WHERE user_id = $1", [userId]);
        const roles = r.rows.map((x) => x.role);
        if (!roles.length)
            return null;
        return roles.reduce((best, cur) => (ROLE_ORDER[cur] > ROLE_ORDER[best] ? cur : best));
    });
}
function headerValue(v) {
    return Array.isArray(v) ? v[0] : v;
}
/**
 * A Fastify preHandler enforcing an authenticated session with at least `minRole`. Fail-closed:
 * no/invalid session → 401; missing role or below minRole → 403 (+ audited security event); a
 * state-changing request without a valid CSRF token → 403.
 */
export function requireRole(pool, minRole) {
    return async function preHandler(req, reply) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = token ? await resolveSession(pool, token) : null;
        if (!session) {
            await reply.code(401).send({ code: "unauthenticated", message: "authentication required" });
            return;
        }
        // CSRF gate on state-changing methods (cookie-authenticated) — before any effect. A CSRF failure on
        // an authenticated session is a security-relevant denial, so it is audited like an authz denial.
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
            if (!csrfValid(req.cookies?.[CSRF_COOKIE], headerValue(req.headers[CSRF_HEADER]))) {
                await withTenant(pool, session.tenantId, (q) => recordSecurityEvent(q, {
                    actor: session.userId,
                    action: "authz.denied",
                    target: `${req.method} ${req.url} (csrf)`,
                }));
                await reply.code(403).send({ code: "forbidden", message: "invalid or missing CSRF token" });
                return;
            }
        }
        const role = await highestRole(pool, session.tenantId, session.userId);
        if (!role) {
            // No role at all is also a deny-by-default outcome (FR-005) — record it as a security event.
            await withTenant(pool, session.tenantId, (q) => recordSecurityEvent(q, {
                actor: session.userId,
                action: "authz.denied",
                target: `${req.method} ${req.url}`,
            }));
            await reply.code(403).send({ code: "forbidden", message: "no role assigned" });
            return;
        }
        // Reuse the E002 authorization gate. Human sessions carry the implicit "admin" console scope; the
        // meaningful check here is role >= minRole (deny-by-default).
        const decision = authorize({ role, scopes: ["admin"] }, { minRole, requiredScope: "admin" });
        if (!decision.allowed) {
            await withTenant(pool, session.tenantId, (q) => recordSecurityEvent(q, {
                actor: session.userId,
                action: "authz.denied",
                target: `${req.method} ${req.url}`,
            }));
            await reply.code(403).send({ code: "forbidden", message: "insufficient role" });
            return;
        }
        req.admin = { ...session, role };
    };
}
