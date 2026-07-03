// Interactive sign-in + lockout (FR-001/007/018, AD-001/005). Login resolves the tenant by slug
// (email is unique only per tenant), verifies the password with a slow KDF, and — on success — mints
// a server-side session. Repeated failures increment a per-user counter and lock the account for a
// bounded window. Failures return a single generic reason (no user/tenant enumeration).
import type pg from "pg";

import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { hmacKey } from "../../db/hash.js";
import type { Role } from "../../auth/rbac.js";
import { verifyPassword } from "./password.js";
import { createSession, revokeSession } from "./session.js";

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

export type LoginOutcome =
  | {
      ok: true;
      token: string;
      sessionId: string;
      expiresAt: Date;
      tenantId: string;
      userId: string;
      role: Role;
    }
  | { ok: false; reason: "invalid" | "locked" };

interface UserRow {
  id: string;
  password_hash: string | null;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}

/** Resolve a tenant slug to its id (privileged pre-tenant lookup; tenant.slug is globally unique). */
async function tenantIdBySlug(pool: pg.Pool, slug: string): Promise<string | null> {
  return privileged(pool, async (q) => {
    const r = await q("SELECT id FROM tenant WHERE slug = $1 AND deleted_at IS NULL", [slug]);
    return r.rowCount ? (r.rows[0] as { id: string }).id : null;
  });
}

/**
 * Attempt an interactive sign-in. On success mints a session (returns the raw token for the cookie).
 * Fail-closed and enumeration-safe: unknown tenant/email, wrong password, deactivated user, and
 * malformed input all return `{ ok:false, reason:"invalid" }`; a locked account returns `"locked"`.
 */
export async function login(
  pool: pg.Pool,
  secret: string,
  input: { tenantSlug: string; email: string; password: string },
  ttlSeconds: number,
): Promise<LoginOutcome> {
  const tenantId = await tenantIdBySlug(pool, input.tenantSlug);
  if (!tenantId) return { ok: false, reason: "invalid" };

  const emailHash = hmacKey(input.email.trim().toLowerCase(), secret);

  const result = await withTenant(pool, tenantId, async (q): Promise<LoginOutcome> => {
    const r = await q(
      `SELECT id, password_hash, status, failed_login_count, locked_until
         FROM app_user WHERE email_hash = $1`,
      [emailHash],
    );
    if (!r.rowCount) return { ok: false, reason: "invalid" };
    const user = r.rows[0] as UserRow;

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      return { ok: false, reason: "locked" };
    }

    const good =
      user.status === "active" &&
      user.password_hash !== null &&
      verifyPassword(input.password, user.password_hash);

    if (!good) {
      const fails = user.failed_login_count + 1;
      const lock = fails >= MAX_FAILED_LOGINS;
      await q(
        `UPDATE app_user
            SET failed_login_count = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4::int * interval '1 second') ELSE locked_until END
          WHERE id = $1`,
        [user.id, fails, lock, LOCKOUT_SECONDS],
      );
      await recordSecurityEvent(q, {
        actor: user.id,
        action: lock ? "auth.locked_out" : "auth.login_failed",
        target: input.tenantSlug,
      });
      return { ok: false, reason: lock ? "locked" : "invalid" };
    }

    // Success: reset the counter and resolve the highest role.
    await q("UPDATE app_user SET failed_login_count = 0, locked_until = NULL WHERE id = $1", [user.id]);
    const roleRow = await q("SELECT role FROM role WHERE user_id = $1", [user.id]);
    const roles = (roleRow.rows as { role: Role }[]).map((x) => x.role);
    const order: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };
    const role: Role = roles.length
      ? roles.reduce((b, c) => (order[c] > order[b] ? c : b))
      : "viewer";
    await writeAudit(q, { actor: user.id, action: "auth.login", target: input.tenantSlug });
    return { ok: true, token: "", sessionId: "", expiresAt: new Date(0), tenantId, userId: user.id, role };
  });

  if (!result.ok) return result;

  // Mint the session outside the login tx (its own tenant tx).
  const session = await createSession(pool, tenantId, result.userId, ttlSeconds);
  return { ...result, token: session.token, sessionId: session.sessionId, expiresAt: session.expiresAt };
}

/** Sign out — revoke the current session (FR-003). */
export async function logout(pool: pg.Pool, tenantId: string, sessionId: string): Promise<void> {
  await revokeSession(pool, tenantId, sessionId);
}
