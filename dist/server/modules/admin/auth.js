import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { hmacKey } from "../../db/hash.js";
import { verifyPassword } from "./password.js";
import { createSession, revokeSession } from "../../console/session.js";
/** Default lockout threshold + window (FR-018) — both operator-configurable via AdminConfig. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_SECONDS = 15 * 60;
export const DEFAULT_LOCKOUT = {
    maxFailedLogins: MAX_FAILED_LOGINS,
    lockoutSeconds: LOCKOUT_SECONDS,
};
/** Resolve a tenant slug to its id (privileged pre-tenant lookup; tenant.slug is globally unique). */
async function tenantIdBySlug(pool, slug) {
    return privileged(pool, async (q) => {
        const r = await q("SELECT id FROM tenant WHERE slug = $1 AND deleted_at IS NULL", [slug]);
        return r.rowCount ? r.rows[0].id : null;
    });
}
/**
 * Attempt an interactive sign-in. On success mints a session (returns the raw token for the cookie).
 * Fail-closed and enumeration-safe: unknown tenant/email, wrong password, deactivated user, and
 * malformed input all return `{ ok:false, reason:"invalid" }`; a locked account returns `"locked"`.
 */
export async function login(pool, secret, input, ttlSeconds, lockout = DEFAULT_LOCKOUT) {
    const tenantId = await tenantIdBySlug(pool, input.tenantSlug);
    if (!tenantId)
        return { ok: false, reason: "invalid" };
    const emailHash = hmacKey(input.email.trim().toLowerCase(), secret);
    const result = await withTenant(pool, tenantId, async (q) => {
        const r = await q(`SELECT id, password_hash, status, failed_login_count, locked_until
         FROM app_user WHERE email_hash = $1`, [emailHash]);
        if (!r.rowCount)
            return { ok: false, reason: "invalid" };
        const user = r.rows[0];
        if (user.locked_until && user.locked_until.getTime() > Date.now()) {
            return { ok: false, reason: "locked" };
        }
        const good = user.status === "active" &&
            user.password_hash !== null &&
            verifyPassword(input.password, user.password_hash);
        if (!good) {
            const fails = user.failed_login_count + 1;
            const lock = fails >= lockout.maxFailedLogins;
            await q(`UPDATE app_user
            SET failed_login_count = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4::int * interval '1 second') ELSE locked_until END
          WHERE id = $1`, [user.id, fails, lock, lockout.lockoutSeconds]);
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
        const roles = roleRow.rows.map((x) => x.role);
        const order = { viewer: 1, admin: 2, owner: 3 };
        const role = roles.length
            ? roles.reduce((b, c) => (order[c] > order[b] ? c : b))
            : "viewer";
        await writeAudit(q, { actor: user.id, action: "auth.login", target: input.tenantSlug });
        return { ok: true, token: "", sessionId: "", expiresAt: new Date(0), tenantId, userId: user.id, role };
    });
    if (!result.ok)
        return result;
    // Mint the session outside the login tx (its own tenant tx).
    const session = await createSession(pool, tenantId, result.userId, ttlSeconds);
    return { ...result, token: session.token, sessionId: session.sessionId, expiresAt: session.expiresAt };
}
/** Sign out — revoke the current session (FR-003). */
export async function logout(pool, tenantId, sessionId) {
    await revokeSession(pool, tenantId, sessionId);
}
