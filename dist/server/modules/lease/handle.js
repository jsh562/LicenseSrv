import { verifyDetached } from "../signing/keystore-signer.js";
/**
 * The domain-separation tag for a lease handle (FR-022). DISTINCT from the LIC1 token domain
 * (`LICSRV-LICENSE-TOKEN-v1`) and the CRL domain (`LICSRV-CRL-v1`): domain separation guarantees a lease
 * handle's signature can never be confused for — or replayed as — a license-token or CRL signature under the
 * same product key, and vice versa.
 */
export const LEASE_SIGNING_DOMAIN = "LICSRV-LEASE-v1";
/** The transport prefix for the assembled handle artifact (`LEASE1.<payload>.<signature>`). */
const HANDLE_PREFIX = "LEASE1";
const base64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromBase64url(s) {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
/**
 * Deterministically serialize the handle claims to canonical JSON (sorted keys, no insignificant whitespace)
 * so re-encoding the SAME claims — at mint or at verify — reproduces byte-identical signing input and the
 * detached signature verifies identically (mirrors the CRL canonicalizer).
 */
function canonicalClaims(claims) {
    const src = claims;
    const ordered = {};
    for (const k of Object.keys(src).sort())
        ordered[k] = src[k];
    return Buffer.from(JSON.stringify(ordered), "utf8");
}
/** Compute the bounded handle expiry: `min(lease expiry, issuedAt + handleTtl)`, clamped short of the TTL (FR-022). */
export function boundedHandleExpiry(input) {
    const cap = input.issuedAtUnix + Math.max(1, Math.floor(input.handleTtlSeconds));
    return Math.min(input.leaseExpiresAtUnix, cap);
}
/**
 * Mint the signed, short-TTL lease handle (FR-022). Builds the domain-tagged claims, canonicalizes them, and
 * DETACHED-signs the canonical bytes via the E004 signer (`LICSRV-LEASE-v1` domain, Principle I — the lease
 * module never touches the keystore directly). Returns the PUBLIC artifact `LEASE1.<payload>.<signature>` +
 * the OPAQUE `keyId` — never the signing key. On any signer fault the underlying {@link Signer.signDetached}
 * throws `SignerError`, which acquire/renew map to `503 signer_unavailable` FAIL-CLOSED (no seat consumed on
 * acquire; the lease left unchanged on renew).
 */
export async function signLeaseHandle(signer, tenantId, productId, input) {
    const exp = boundedHandleExpiry(input);
    const claims = {
        dom: LEASE_SIGNING_DOMAIN,
        lid: input.leaseId,
        lic: input.licenseId,
        hk: input.holderKey,
        scope: input.scope,
        iat: input.issuedAtUnix,
        exp,
    };
    const message = canonicalClaims(claims);
    const { signature, keyId } = await signer.signDetached(tenantId, productId, LEASE_SIGNING_DOMAIN, message);
    const leaseHandle = `${HANDLE_PREFIX}.${base64url(message)}.${signature}`;
    return { leaseHandle, keyId, handleExpiresAtUnix: exp };
}
/**
 * Verify a lease handle OFFLINE against a product's raw 32-byte Ed25519 public key (the COUNTERPART to
 * {@link signLeaseHandle}). Reuses the shared detached-signature verifier with the SAME `LICSRV-LEASE-v1`
 * domain, so a tampered payload or a signature made under a DIFFERENT domain fails (SC-018). Public-key only
 * — no private material is involved. When `nowUnix` is provided, an `exp`-lapsed handle is reported expired.
 */
export function verifyLeaseHandle(publicKey, handle, nowUnix) {
    const parts = handle.split(".");
    if (parts.length !== 3 || parts[0] !== HANDLE_PREFIX)
        return { valid: false, reason: "malformed" };
    let message;
    let claims;
    try {
        message = fromBase64url(parts[1]);
        claims = JSON.parse(message.toString("utf8"));
    }
    catch {
        return { valid: false, reason: "malformed" };
    }
    if (claims.dom !== LEASE_SIGNING_DOMAIN)
        return { valid: false, reason: "wrong_domain" };
    const signature = fromBase64url(parts[2]);
    if (!verifyDetached(publicKey, LEASE_SIGNING_DOMAIN, message, signature)) {
        return { valid: false, reason: "bad_signature" };
    }
    if (typeof nowUnix === "number" && nowUnix >= claims.exp)
        return { valid: false, reason: "expired", claims };
    return { valid: true, claims };
}
