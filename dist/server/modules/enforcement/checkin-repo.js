// Check-in repository (FR-008/014/019; AD-002/AD-006). The BOUNDED, TTL-pruned anti-replay + idempotent-
// replay store for validate/heartbeat, plus the monotonic last-seen anchor advance. Every function takes a
// tenant-scoped `TxQuery` (the `withTenant()` RLS choke point) so it stays unit-testable with a stub. The
// store is append-only from the app role (SELECT+INSERT only; no UPDATE/DELETE) — a replay READS the
// original row, it never mutates one. Distinct from the E009 permanent per-activation nonce: check-ins are
// FREQUENT, so a nonce is retained only while a token minted for it could still be valid (<= the renewal
// window), then pruned by the platform owner path (`pruneExpiredCheckins`, no DELETE grant to the app role).
import { randomUUID } from "node:crypto";
import { EnforcementError } from "./index.js";
function toRecord(row, replayed) {
    return {
        id: row.id,
        activationId: row.activation_id,
        outcome: row.outcome,
        reason: row.reason,
        renewedToken: row.renewed_token,
        createdAt: row.created_at.toISOString(),
        replayed,
    };
}
/** Postgres unique-violation SQLSTATE — the anti-replay/idempotency store-and-replay trigger. */
function isUniqueViolation(e) {
    return typeof e === "object" && e !== null && e.code === "23505";
}
/**
 * Record one accepted validate/heartbeat as an immutable check-in row (FR-008). Store-and-replay, mirroring
 * the E009 `activate` nonce pattern: a PRE-CHECK `SELECT` for the nonce runs BEFORE the insert (a failed
 * insert aborts the whole Postgres transaction, so the original row cannot be read afterwards). A prior row
 * for the SAME activation is an idempotent retry -> its stored `outcome`/`renewed_token` are REPLAYED
 * (`replayed: true`; no second token minted, no anchor advance) (SC-010). A prior row for a DIFFERENT
 * activation is a forgery attempt -> throws `EnforcementError('nonce_replayed', 409)`. Otherwise a fresh row
 * is inserted (`replayed: false`). A concurrent request that grabs the same nonce between the pre-check and
 * the insert surfaces the unique violation, also refused `nonce_replayed`. `tenant_id` comes from the
 * transaction-local GUC so the write is tenant-scoped under RLS.
 */
export async function recordCheckin(q, input) {
    // Pre-check the nonce (visible under the tenant RLS predicate) before inserting.
    const prior = await q(`SELECT id, activation_id, outcome, reason, renewed_token, created_at FROM checkin WHERE nonce = $1`, [input.nonce]);
    const priorRow = prior.rows[0];
    if (priorRow) {
        if (priorRow.activation_id === input.activationId)
            return toRecord(priorRow, true); // idempotent replay
        throw new EnforcementError("nonce_replayed", 409, "this nonce has already been used for a different check-in", { reason: "replayed_nonce" });
    }
    const id = randomUUID();
    try {
        const r = await q(`INSERT INTO checkin (id, tenant_id, activation_id, nonce, outcome, reason, renewed_token)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6)
       RETURNING id, activation_id, outcome, reason, renewed_token, created_at`, [id, input.activationId, input.nonce, input.outcome, input.reason, input.renewedToken]);
        return toRecord(r.rows[0], false);
    }
    catch (e) {
        // A concurrent request grabbed the same nonce between the pre-check and this insert -> the tx aborts;
        // refuse the forged second check-in (never mint a second token). No further read in the aborted tx.
        if (isUniqueViolation(e)) {
            throw new EnforcementError("nonce_replayed", 409, "this nonce has already been used for a different check-in", { reason: "replayed_nonce" });
        }
        throw e;
    }
}
/**
 * Advance the activation's last-seen anchor MONOTONICALLY (FR-014, AD-006). A guarded `UPDATE` sets
 * `last_checkin_at = now()` and `last_anchor_at = to_timestamp(anchorUnix)` ONLY when the new anchor is not
 * older than the current one (`last_anchor_at IS NULL OR last_anchor_at <= to_timestamp(anchorUnix)`) —
 * the non-decreasing invariant is enforced here in the repo, NEVER by a DB trigger. Returns `true` when the
 * anchor advanced; `false` when the guard blocked it (a client asserting a time preceding the floor — a
 * rollback attempt) OR the activation id does not resolve in this tenant. Runs on a SUCCESSFUL beat only;
 * a refused beat or an idempotent replay does NOT advance the anchor.
 */
export async function advanceAnchor(q, activationId, anchorUnix) {
    const r = await q(`UPDATE activation
       SET last_checkin_at = now(),
           last_anchor_at  = to_timestamp($2)
     WHERE id = $1
       AND (last_anchor_at IS NULL OR last_anchor_at <= to_timestamp($2))`, [activationId, anchorUnix]);
    return (r.rowCount ?? 0) > 0;
}
/**
 * Prune check-in rows older than the retention horizon (`retainSecs` = renewal window + skew) (FR-008
 * boundedness). A nonce beyond that could only replay an already-expired token (fail-closed), so forgetting
 * it is safe. This is the PLATFORM RETENTION PATH: the app role has NO DELETE grant, so run this on a
 * privileged (owner) transaction, not under `withTenant`. Returns the number of rows pruned. The
 * `checkin_prune` BRIN index makes the age-range delete cheap.
 */
export async function pruneExpiredCheckins(q, retainSecs) {
    const r = await q(`DELETE FROM checkin WHERE created_at < now() - ($1::double precision * interval '1 second')`, [retainSecs]);
    return r.rowCount ?? 0;
}
