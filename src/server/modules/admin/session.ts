// Server-side admin sessions (FR-001/003, AD-003). The browser holds an opaque random token in an
// httpOnly+Secure+SameSite cookie; the server stores only its SHA-256 hash in admin_session. Auth
// resolves a session by token_hash via a PRIVILEGED pre-tenant lookup (mirroring resolveApiKey),
// verifying the session is unexpired/unrevoked and the user is still active — then the caller drops
// to the session's tenant scope. The raw token never leaves the cookie.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { privileged, withTenant } from "../../db/client.js";

export const SESSION_COOKIE = "admin_session";

/** A resolved, valid session principal. Role is resolved separately (per-tenant) by the RBAC layer. */
export interface SessionPrincipal {
  tenantId: string;
  userId: string;
  sessionId: string;
}

/** Generate a fresh opaque session token (32 bytes, url-safe). The raw value goes only in the cookie. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the token — the only form persisted (a DB read cannot recover the cookie value). */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a session for `userId` in `tenantId`, expiring in `ttlSeconds`. Returns the raw token (cookie-only). */
export async function createSession(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  ttlSeconds: number,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await withTenant(pool, tenantId, (q) =>
    q(
      `INSERT INTO admin_session (id, tenant_id, user_id, token_hash, expires_at, last_seen_at)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, now())`,
      [id, userId, tokenHash(token), expiresAt],
    ),
  );
  return { token, sessionId: id, expiresAt };
}

/**
 * Resolve a raw session token to its principal, or null. Valid ⇔ the session exists, is unexpired and
 * unrevoked, AND its user is still `active` (a deactivated/invited user's sessions are dead — FR-007).
 * This is the sanctioned privileged pre-tenant lookup, keyed by the globally-unique token_hash.
 */
export async function resolveSession(pool: pg.Pool, token: string): Promise<SessionPrincipal | null> {
  const th = tokenHash(token);
  return privileged(pool, async (q) => {
    const r = await q(
      `SELECT s.id, s.tenant_id, s.user_id
         FROM admin_session s
         JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'active'`,
      [th],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0] as { id: string; tenant_id: string; user_id: string };
    // Best-effort last-seen touch (privileged; scoped by the unique token_hash).
    await q("UPDATE admin_session SET last_seen_at = now() WHERE token_hash = $1", [th]);
    return { tenantId: row.tenant_id, userId: row.user_id, sessionId: row.id };
  });
}

/** Revoke a session (sign-out) — tenant-scoped. An expired/revoked session grants no access. */
export async function revokeSession(pool: pg.Pool, tenantId: string, sessionId: string): Promise<void> {
  await withTenant(pool, tenantId, (q) =>
    q("UPDATE admin_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]),
  );
}
