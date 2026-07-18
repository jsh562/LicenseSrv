// Machine-bound claims builder (FR-007/018/022). Takes the E008 license snapshot and re-signs it as a
// LIC1 credential with the fingerprint claims populated (`fingerprint` = the N signal hashes → `fp`,
// `fpMin` = K → `fpk`, `maxSkewSecs` → `sk`), so the E001 core enforces the machine binding OFFLINE — no
// new crypto. The signer (E004) stamps the product's active key id; `keyId` is a placeholder here. The
// credential's expiry is bounded to the sooner of the license expiry and the configured credential TTL.
import { randomBytes } from "node:crypto";
/** The token format version this build emits (mirrors the core's LIC1 claim `v`). */
export const TOKEN_VERSION = 1;
/**
 * The effective machine-bound credential expiry in unix seconds (FR-022): the sooner of the license
 * expiry and `now + credentialTtlSecs`. Null (perpetual) only when the license is perpetual AND no TTL
 * is configured.
 */
export function effectiveExpiry(licenseExpiresAt, credentialTtlSecs, nowUnix) {
    const candidates = [];
    if (licenseExpiresAt)
        candidates.push(Math.floor(new Date(licenseExpiresAt).getTime() / 1000));
    if (credentialTtlSecs != null)
        candidates.push(nowUnix + credentialTtlSecs);
    return candidates.length ? Math.min(...candidates) : null;
}
/** Build the machine-bound Claims from the license snapshot + fingerprint, for the signer to mint (FR-007). */
export function buildMachineClaims(input) {
    const { license } = input;
    return {
        tokenVersion: TOKEN_VERSION,
        licenseId: license.id,
        productId: license.productId,
        planId: license.planId,
        customerId: license.customerId,
        issuedAt: input.nowUnix,
        expiresAt: effectiveExpiry(license.expiresAt, input.credentialTtlSecs, input.nowUnix),
        maxActivations: license.maxActivations,
        entitlements: license.entitlements,
        fingerprint: input.signalHashes,
        fpMin: input.fpMin,
        maxSkewSecs: input.maxSkewSecs,
        keyId: "", // stamped by the signer (it selects the product's active key)
        nonce: randomBytes(16).toString("hex"),
    };
}
