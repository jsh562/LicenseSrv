/**
 * Evaluate the online-enforcement verdict for a license + activation at `nowUnix` (FR-004). Returns `valid`
 * ONLY when the license is `active` AND not expired AND the activation is `active`; otherwise returns the
 * refusal verdict + a specific reason (AD-001 — never throws). Precedence when several conditions hold:
 * license status (revoked > suspended) > expiry > activation status — the most severe/authoritative gate
 * first (a revoked license reports `revoked` even if also expired). Reinstating a suspended license
 * (status back to `active`) makes the next beat renew again (FR-006). `effectiveEntitlements` is the
 * CURRENT effective entitlements (E007, re-read per beat) baked into the renewed token (FR-017); pass
 * `null` to fall back to the license's stored snapshot.
 */
export function evaluateEnforcement(license, activation, effectiveEntitlements, nowUnix) {
    const entitlements = effectiveEntitlements ?? license.entitlements;
    if (license.status === "revoked")
        return { verdict: "revoked", reason: "revoked", entitlements };
    if (license.status === "suspended")
        return { verdict: "suspended", reason: "suspended", entitlements };
    const expiresAtUnix = license.expiresAt != null ? Math.floor(new Date(license.expiresAt).getTime() / 1000) : null;
    if (expiresAtUnix != null && expiresAtUnix <= nowUnix) {
        return { verdict: "expired", reason: "expired", entitlements };
    }
    if (activation.status !== "active") {
        return { verdict: "deactivated", reason: "activation_deactivated", entitlements };
    }
    return { verdict: "valid", reason: null, entitlements };
}
/**
 * The MONOTONIC last-seen anchor floor rule (FR-014/015; AD-006; HINT-005). The server-side anchor floor is
 * the highest SIGNED server time ever recorded for an activation (`activation.last_anchor_at`); a beat's
 * signed server time may only ADVANCE it, never regress it. Returns `true` when `candidateAnchorUnix` may
 * become the new floor — i.e. there is no floor yet (`currentFloorUnix === null`, a never-connected
 * activation) OR the candidate is not older than the floor. This is EXACTLY the predicate the guarded
 * `advanceAnchor` UPDATE encodes in SQL (`last_anchor_at IS NULL OR last_anchor_at <= to_timestamp($2)`),
 * expressed here as a pure, unit-testable helper so it cannot drift and so the SAME rule is documented for
 * the CLIENT to apply locally.
 *
 * Clock-tamper enforcement is ultimately CLIENT-side (HINT-005): the client persists this anchor and rejects
 * a local clock / token preceding the highest signed server time it has observed. The SERVER'S contribution
 * is threefold and NOTHING it cannot actually enforce: (1) it embeds SIGNED server time in every renewed
 * token (the token `iat` == the wire `serverTime` == the check-in anchor), (2) it caps the token with a
 * SHORT `exp` (fail-closed at expiry), and (3) it keeps this NON-DECREASING `last_anchor_at` floor so a
 * rolled-back client asserting an earlier time can never pull the recorded floor backwards. A NEVER-CONNECTED
 * client's pure-offline rollback is only BOUNDED by the per-plan offline-tolerance window (surfaced in-band
 * via `stalenessWindow.offlineToleranceSeconds`), NOT prevented — a disclosed, accepted limitation (FR-013).
 */
export function isMonotonicAnchor(currentFloorUnix, candidateAnchorUnix) {
    return currentFloorUnix === null || candidateAnchorUnix >= currentFloorUnix;
}
