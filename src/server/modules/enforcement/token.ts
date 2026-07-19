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
import type { License } from "../issuance/licenses.js";
import type { Signer } from "../signing/signer.js";

export interface MintShortLivedInput {
  /** The E008 license snapshot (ids/expiry/seat-limit source for the re-signed claims). */
  license: License;
  /** The activation's N signal hashes (E009) -> the LIC1 `fp` claim (machine binding preserved). */
  signalHashes: string[];
  /** K in the K-of-N match -> the LIC1 `fpk` claim. */
  fpMin: number;
  /** Clock-skew window stamped into the credential -> the LIC1 `sk` claim. */
  maxSkewSecs: number;
  /** The CURRENT effective entitlements (E007, re-read this beat) baked into the token (FR-017). */
  entitlements: Record<string, boolean | number>;
  /** The short-token TTL / renewal window (seconds); `exp` = now + this (bounded by the license expiry). */
  renewalWindowSecs: number;
  /** When the client SHOULD renew (seconds from now, ~50-70% of the TTL) -> `renewAfter`; clamped <= `exp`. */
  renewAfterSecs: number;
  /** The signed server-time anchor (unix seconds) — becomes the token `iat` and the check-in anchor (FR-014). */
  nowUnix: number;
}

export interface ShortLivedToken {
  /** The re-signed short-TTL LIC1 token (public artifact; verifies offline against the product keyring). */
  token: string;
  /** The signed server-time anchor embedded in the token (= `nowUnix`); the client advances its anchor to this. */
  serverTimeUnix: number;
  /** The token's `exp` (unix seconds); after this, offline verification FAILS CLOSED (FR-005). Null = perpetual. */
  expiresAtUnix: number | null;
  /** When the client should renew (unix seconds), never after `exp` (FR-003/007). */
  renewAfterUnix: number;
}

/**
 * Mint a short-TTL LIC1 renewal token for a valid binding (FR-002). Reuses `buildMachineClaims` with
 * `credentialTtlSecs = renewalWindowSecs` and `issuedAt = nowUnix` (the signed server-time anchor), then
 * OVERRIDES the claims' entitlements with the CURRENT effective entitlements (FR-017) before signing via
 * the E004 signer. `exp` = min(license expiry, now + renewal window) — the token never outlives the
 * license. `renewAfter` = now + `renewAfterSecs`, clamped to <= `exp`. A `SignerError` from `signer.sign`
 * propagates unchanged (the caller maps it to 503 signer_unavailable; no anchor is advanced).
 */
export async function mintShortLivedToken(
  signer: Signer,
  tenantId: string,
  input: MintShortLivedInput,
): Promise<ShortLivedToken> {
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
