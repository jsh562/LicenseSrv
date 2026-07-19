import { runEnforcement } from "./validate.js";
/**
 * Renew the short-lived token for a connected client before it expires (FR-003). Re-checks license status,
 * expiry, current effective entitlements (FR-017), and activation status this beat and, ONLY on `valid`,
 * mints a FRESH short-TTL LIC1 + advances the monotonic anchor (FR-014); a non-valid verdict refuses renewal
 * with a `200` + `verdict` and NO token (AD-001) so the outstanding token lapses within its TTL (FR-005). An
 * idempotent replay of the SAME nonce+activation returns the ORIGINAL result; a nonce reused for a DIFFERENT
 * activation throws `409 nonce_replayed`. Delegates to the shared `runEnforcement` flow — identical to
 * `validateOnline` save the audit action — so US1 and US3 can never drift apart.
 */
export async function heartbeatRenew(pool, signer, config, tenantId, input) {
    return runEnforcement("heartbeat", pool, signer, config, tenantId, input);
}
