// Short-TTL renewal token (FR-002/007/014/017; {SAD:ADR-0010}, AD-005). The renewal token is NOT a new
// token type: it re-signs the EXACT E001 LIC1 `Claims` shape via the EXISTING E004 signer, reusing the E009
// `buildMachineClaims` path (fp/fpk/sk machine binding preserved) so the client's E001 offline verifier
// verifies it UNCHANGED. Two things differ from the long-lived E009 credential: a near-term `exp` = now +
// the renewal window (bounded staleness <= TTL, FR-005), and `iat` = the SIGNED SERVER TIME anchor
// (FR-014). FR-017: the claims' entitlements are OVERRIDDEN with the CURRENT effective entitlements re-read
// this beat, so plan/entitlement changes propagate on renewal. The token is a SEPARATE public artifact,
// returned to the client and NOT persisted; the E009 `machine_bound_token` offline credential is untouched
// (offline-first, US5). A `SignerError` propagates (the handler maps it to 503 signer_unavailable).
import { buildMachineClaims } from "../activation/claims.js";
/**
 * Mint a short-TTL LIC1 renewal token for a valid binding (FR-002). Reuses `buildMachineClaims` with
 * `credentialTtlSecs = renewalWindowSecs` and `issuedAt = nowUnix` (the signed server-time anchor), then
 * OVERRIDES the claims' entitlements with the CURRENT effective entitlements (FR-017) before signing via
 * the E004 signer. `exp` = min(license expiry, now + renewal window) — the token never outlives the
 * license. `renewAfter` = now + `renewAfterSecs`, clamped to <= `exp`. A `SignerError` from `signer.sign`
 * propagates unchanged (the caller maps it to 503 signer_unavailable; no anchor is advanced).
 */
export async function mintShortLivedToken(signer, tenantId, input) {
    const claims = buildMachineClaims({
        license: input.license,
        signalHashes: input.signalHashes,
        fpMin: input.fpMin,
        maxSkewSecs: input.maxSkewSecs,
        nowUnix: input.nowUnix,
        credentialTtlSecs: input.renewalWindowSecs,
    });
    // FR-017: reflect the CURRENT effective entitlements, NOT the license's stored snapshot.
    claims.entitlements = input.entitlements;
    const token = await signer.sign(tenantId, claims); // conformance-verified by the signer; SignerError propagates
    const expiresAtUnix = claims.expiresAt ?? null;
    const renewAfterCandidate = input.nowUnix + input.renewAfterSecs;
    const renewAfterUnix = expiresAtUnix != null ? Math.min(renewAfterCandidate, expiresAtUnix) : renewAfterCandidate;
    return { token, serverTimeUnix: input.nowUnix, expiresAtUnix, renewAfterUnix };
}
