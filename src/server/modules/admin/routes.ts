// The /admin REST surface for the human console (FR-001/004/006/010/013/019). Login is the one
// unauthenticated route; it mints a session cookie (httpOnly+Secure+SameSite=Strict) plus a readable
// CSRF cookie. Every other route runs behind requireRole(minRole) — which also enforces the CSRF
// double-submit on state-changing methods — so RBAC and CSRF are declared once, per route, by policy.
// Responses are camelCase (AD-007) and never carry a secret except an API key's one-time creation.
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";

import type { Role, Scope } from "../../auth/rbac.js";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "./apikeys.js";
import { listAuditEntries } from "./audit.js";
import { login, logout } from "./auth.js";
import { CSRF_COOKIE, issueCsrfToken } from "./csrf.js";
import { requireRole } from "./rbac-middleware.js";
import { SESSION_COOKIE } from "./session.js";
import { createUser, listUsers, updateUser } from "./users.js";

const roleSchema = z.enum(["owner", "admin", "viewer"]);
const scopeSchema = z.enum(["activate", "validate", "admin"]);

const loginSchema = z.object({
  tenantSlug: z.string().min(1),
  email: z.string().min(1),
  password: z.string().min(1),
});
const createUserSchema = z.object({
  email: z.string().min(3),
  role: roleSchema,
  password: z.string().min(8).optional(),
});
const updateUserSchema = z
  .object({ role: roleSchema.optional(), status: z.enum(["active", "deactivated"]).optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, { message: "no changes supplied" });
const createApiKeySchema = z.object({ scopes: z.array(scopeSchema).min(1) });
const userIdSchema = z.object({ userId: z.string().uuid() });
const keyIdSchema = z.object({ keyId: z.string().uuid() });
const auditQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  securityEvent: z.enum(["true", "false"]).optional(),
  actor: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

interface ApiError {
  code: string;
  message: string;
}
function err(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  const body: ApiError = { code, message };
  return reply.code(status).send(body);
}

export interface AdminRouteConfig {
  /** Session lifetime in seconds (AD-003; default 8h, bounded ≤ 24h by index.ts). */
  sessionTtlSeconds: number;
  /** Brute-force lockout threshold + window (FR-018), operator-configurable via index.ts. */
  maxFailedLogins: number;
  lockoutSeconds: number;
  /** The shared HMAC secret for email + API-key hashing (same secret as the machine auth path). */
  secret: string;
}

/**
 * Register the admin console routes. `requireRole` is applied per route as the RBAC + CSRF gate; the
 * x-rbac policy is: users/api-keys → admin, audit/me/logout → viewer, login → none.
 */
export function registerAdminRoutes(app: FastifyInstance, pool: pg.Pool, config: AdminRouteConfig): void {
  const ttl = config.sessionTtlSeconds;
  const sessionCookie = (maxAgeSeconds: number) =>
    ({ httpOnly: true, secure: true, sameSite: "strict" as const, path: "/admin", maxAge: maxAgeSeconds });
  const csrfCookie = (maxAgeSeconds: number) =>
    ({ httpOnly: false, secure: true, sameSite: "strict" as const, path: "/admin", maxAge: maxAgeSeconds });

  // --- Auth (US1) ---------------------------------------------------------------------------------

  // Sign in — the only unauthenticated route. Sets the session + CSRF cookies on success.
  app.post("/admin/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, "validation_error", "invalid login payload");
    const outcome = await login(pool, config.secret, parsed.data, ttl, {
      maxFailedLogins: config.maxFailedLogins,
      lockoutSeconds: config.lockoutSeconds,
    });
    if (!outcome.ok) {
      if (outcome.reason === "locked") {
        void reply.header("Retry-After", String(config.lockoutSeconds));
        return err(reply, 429, "account_locked", "too many failed attempts; try again later");
      }
      return err(reply, 401, "invalid_credentials", "invalid credentials");
    }
    const csrf = issueCsrfToken();
    void reply.setCookie(SESSION_COOKIE, outcome.token, sessionCookie(ttl));
    void reply.setCookie(CSRF_COOKIE, csrf, csrfCookie(ttl));
    return reply.code(200).send({
      userId: outcome.userId,
      role: outcome.role,
      expiresAt: outcome.expiresAt.toISOString(),
    });
  });

  // Current principal.
  app.get("/admin/auth/me", { preHandler: requireRole(pool, "viewer") }, async (req, reply) => {
    const a = req.admin!;
    return reply.code(200).send({ userId: a.userId, tenantId: a.tenantId, role: a.role });
  });

  // Sign out — revoke the session and clear cookies.
  app.post("/admin/auth/logout", { preHandler: requireRole(pool, "viewer") }, async (req, reply) => {
    const a = req.admin!;
    await logout(pool, a.tenantId, a.sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: "/admin" });
    void reply.clearCookie(CSRF_COOKIE, { path: "/admin" });
    return reply.code(204).send();
  });

  // --- Users (US3) — admin RBAC -------------------------------------------------------------------

  app.get("/admin/users", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const users = await listUsers(pool, req.admin!.tenantId);
    return reply.code(200).send({ users });
  });

  app.post("/admin/users", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, "validation_error", "invalid user payload");
    const a = req.admin!;
    const outcome = await createUser(pool, config.secret, a.tenantId, a.userId, parsed.data as never);
    if (!outcome.ok) return err(reply, 409, "duplicate_user", "a user with that email already exists");
    return reply.code(201).header("Location", `/admin/users/${outcome.id}`).send({ id: outcome.id, status: outcome.status });
  });

  app.patch("/admin/users/:userId", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const p = userIdSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid userId");
    const body = updateUserSchema.safeParse(req.body);
    if (!body.success) return err(reply, 400, "validation_error", "invalid update payload");
    const a = req.admin!;
    const outcome = await updateUser(pool, a.tenantId, a.userId, p.data.userId, body.data);
    if (!outcome.ok) {
      if (outcome.reason === "not-found") return err(reply, 404, "user_not_found", "unknown user");
      return err(reply, 409, "last_owner", "cannot remove the tenant's last owner");
    }
    return reply.code(200).send({ id: p.data.userId, role: outcome.role, status: outcome.status });
  });

  // --- API keys (US4) — admin RBAC ----------------------------------------------------------------

  app.get("/admin/api-keys", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const keys = await listApiKeys(pool, req.admin!.tenantId);
    return reply.code(200).send({ keys });
  });

  app.post("/admin/api-keys", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const parsed = createApiKeySchema.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, "validation_error", "invalid api-key payload");
    const a = req.admin!;
    const created = await createApiKey(pool, config.secret, a.tenantId, a.userId, parsed.data.scopes as Scope[]);
    // The secret is present exactly here, once.
    return reply.code(201).send(created);
  });

  app.post("/admin/api-keys/:keyId/rotate", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const p = keyIdSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid keyId");
    const a = req.admin!;
    const rotated = await rotateApiKey(pool, config.secret, a.tenantId, a.userId, p.data.keyId);
    if (!rotated) return err(reply, 404, "key_not_found", "unknown api key");
    return reply.code(200).send(rotated);
  });

  app.post("/admin/api-keys/:keyId/revoke", { preHandler: requireRole(pool, "admin") }, async (req, reply) => {
    const p = keyIdSchema.safeParse(req.params);
    if (!p.success) return err(reply, 400, "validation_error", "invalid keyId");
    const a = req.admin!;
    const revoked = await revokeApiKey(pool, a.tenantId, a.userId, p.data.keyId);
    if (!revoked) return err(reply, 404, "key_not_found", "unknown or already-revoked api key");
    return reply.code(200).send({ id: p.data.keyId, status: "revoked" });
  });

  // --- Audit (US5) — viewer RBAC, read-only -------------------------------------------------------

  app.get("/admin/audit", { preHandler: requireRole(pool, "viewer") }, async (req, reply) => {
    const q = auditQuerySchema.safeParse(req.query);
    if (!q.success) return err(reply, 400, "validation_error", "invalid audit filters");
    const page = await listAuditEntries(pool, req.admin!.tenantId, {
      from: q.data.from,
      to: q.data.to,
      securityEvent: q.data.securityEvent === "true" ? true : undefined,
      actor: q.data.actor,
      cursor: q.data.cursor,
      limit: q.data.limit,
    });
    return reply.code(200).send(page);
  });
}
