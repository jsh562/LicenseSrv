// Session + RBAC preHandler (FR-002/004/005, AD-004). Resolves the session cookie to a tenant-scoped
// principal + role, enforces minRole fail-closed, checks CSRF on state-changing requests, and records
// denials as security events. On success it sets req.admin and the route runs under that tenant scope.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";

import { recordSecurityEvent } from "../../audit/index.js";
import { authorize, type Role } from "../../auth/rbac.js";
import { withTenant } from "../../db/client.js";
import { CSRF_COOKIE, CSRF_HEADER, csrfValid } from "./csrf.js";
import { resolveSession, SESSION_COOKIE } from "./session.js";

export interface AdminPrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminPrincipal;
  }
}

const ROLE_ORDER: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

/** The tenant's highest role for a user (owner > admin > viewer), or null if none (→ no access). */
async function highestRole(pool: pg.Pool, tenantId: string, userId: string): Promise<Role | null> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT role FROM role WHERE user_id = $1", [userId]);
    const roles = (r.rows as { role: Role }[]).map((x) => x.role);
    if (!roles.length) return null;
    return roles.reduce((best, cur) => (ROLE_ORDER[cur] > ROLE_ORDER[best] ? cur : best));
  });
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A Fastify preHandler enforcing an authenticated session with at least `minRole`. Fail-closed:
 * no/invalid session → 401; missing role or below minRole → 403 (+ audited security event); a
 * state-changing request without a valid CSRF token → 403.
 */
export function requireRole(pool: pg.Pool, minRole: Role) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? await resolveSession(pool, token) : null;
    if (!session) {
      await reply.code(401).send({ code: "unauthenticated", message: "authentication required" });
      return;
    }

    // CSRF gate on state-changing methods (cookie-authenticated) — before any effect.
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      if (!csrfValid(req.cookies?.[CSRF_COOKIE], headerValue(req.headers[CSRF_HEADER]))) {
        await reply.code(403).send({ code: "forbidden", message: "invalid or missing CSRF token" });
        return;
      }
    }

    const role = await highestRole(pool, session.tenantId, session.userId);
    if (!role) {
      // No role at all is also a deny-by-default outcome (FR-005) — record it as a security event.
      await withTenant(pool, session.tenantId, (q) =>
        recordSecurityEvent(q, {
          actor: session.userId,
          action: "authz.denied",
          target: `${req.method} ${req.url}`,
        }),
      );
      await reply.code(403).send({ code: "forbidden", message: "no role assigned" });
      return;
    }

    // Reuse the E002 authorization gate. Human sessions carry the implicit "admin" console scope; the
    // meaningful check here is role >= minRole (deny-by-default).
    const decision = authorize({ role, scopes: ["admin"] }, { minRole, requiredScope: "admin" });
    if (!decision.allowed) {
      await withTenant(pool, session.tenantId, (q) =>
        recordSecurityEvent(q, {
          actor: session.userId,
          action: "authz.denied",
          target: `${req.method} ${req.url}`,
        }),
      );
      await reply.code(403).send({ code: "forbidden", message: "insufficient role" });
      return;
    }

    req.admin = { ...session, role };
  };
}
