// E004-signed short-TTL lease handle (E015, FR-022, SC-018; ADR-0012/AD-004, HINT-003). By default an
// acquire/renew returns a signed, SHORT-TTL, tamper-evident `leaseHandle` — a public artifact minted by the
// EXISTING E004 signer via its DETACHED signing surface (`signDetached`) with a DOMAIN-SEPARATED payload
// (`LICSRV-LEASE-v1`, DISTINCT from the E001 LIC1 token domain `LICSRV-LICENSE-TOKEN-v1` and the E013 CRL
// domain `LICSRV-CRL-v1`) so a lease handle can never be confused with — or replayed as — a license token or
// a CRL under the same product key. A local gate verifies a held lease OFFLINE against the E004 public key
// between heartbeats, while the SERVER stays the sole authority for the seat count.
//
// NO new crypto is introduced. Only the PUBLIC signed artifact + the OPAQUE signing-key id are returned —
// NEVER the signing private key or any lease secret (SC-015). The handle validity is bounded to (and kept
// SHORT relative to) the lease TTL: `exp = min(lease expiry, issuedAt + handleTtlSeconds)` where
// `handleTtlSeconds` is the heartbeat interval (FR-022) — a fresh handle is reissued every renew.
import type { ConcurrencyScope } from "./config.js";
import { verifyDetached } from "../signing/keystore-signer.js";
import type { Signer } from "../signing/signer.js";

/**
 * The domain-separation tag for a lease handle (FR-022). DISTINCT from the LIC1 token domain
 * (`LICSRV-LICENSE-TOKEN-v1`) and the CRL domain (`LICSRV-CRL-v1`): domain separation guarantees a lease
 * handle's signature can never be confused for — or replayed as — a license-token or CRL signature under the
 * same product key, and vice versa.
 */
export const LEASE_SIGNING_DOMAIN = "LICSRV-LEASE-v1";

/** The transport prefix for the assembled handle artifact (`LEASE1.<payload>.<signature>`). */
const HANDLE_PREFIX = "LEASE1";

/** The signed lease-handle claims (the exact object the detached signature covers, canonicalized). */
export interface LeaseHandleClaims {
  /** Domain tag, embedded in the payload for self-description (the signature is ALSO domain-separated). */
  dom: string;
  /** Lease id. */
  lid: string;
  /** License id. */
  lic: string;
  /** Pseudonymous holder key (salted-hash string) — never the raw reference (SC-015). */
  hk: string;
  /** Concurrency scope snapshot. */
  scope: ConcurrencyScope;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Handle expiry (unix seconds) — bounded to the lease TTL / heartbeat interval (FR-022). */
  exp: number;
}

/** The inputs to {@link signLeaseHandle} (all PUBLIC lease metadata — no secret material). */
export interface LeaseHandleInput {
  leaseId: string;
  licenseId: string;
  holderKey: string;
  scope: ConcurrencyScope;
  issuedAtUnix: number;
  leaseExpiresAtUnix: number;
  /** The handle validity bound (seconds) — the heartbeat interval; exp is clamped to this from issuedAt (FR-022). */
  handleTtlSeconds: number;
}

/** The result of minting a lease handle: the PUBLIC artifact + the OPAQUE key id + the bounded expiry. */
export interface SignedLeaseHandle {
  leaseHandle: string;
  keyId: string;
  handleExpiresAtUnix: number;
}

const base64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Deterministically serialize the handle claims to canonical JSON (sorted keys, no insignificant whitespace)
 * so re-encoding the SAME claims — at mint or at verify — reproduces byte-identical signing input and the
 * detached signature verifies identically (mirrors the CRL canonicalizer).
 */
function canonicalClaims(claims: LeaseHandleClaims): Buffer {
  const src = claims as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) ordered[k] = src[k];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/** Compute the bounded handle expiry: `min(lease expiry, issuedAt + handleTtl)`, clamped short of the TTL (FR-022). */
export function boundedHandleExpiry(input: LeaseHandleInput): number {
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
export async function signLeaseHandle(
  signer: Signer,
  tenantId: string,
  productId: string,
  input: LeaseHandleInput,
): Promise<SignedLeaseHandle> {
  const exp = boundedHandleExpiry(input);
  const claims: LeaseHandleClaims = {
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

/** The outcome of verifying a lease handle offline against the E004 public key. */
export interface LeaseHandleVerification {
  valid: boolean;
  claims?: LeaseHandleClaims;
  /** Present when `valid` is false: why verification failed (for diagnostics — never leaks key material). */
  reason?: "malformed" | "bad_signature" | "wrong_domain" | "expired";
}

/**
 * Verify a lease handle OFFLINE against a product's raw 32-byte Ed25519 public key (the COUNTERPART to
 * {@link signLeaseHandle}). Reuses the shared detached-signature verifier with the SAME `LICSRV-LEASE-v1`
 * domain, so a tampered payload or a signature made under a DIFFERENT domain fails (SC-018). Public-key only
 * — no private material is involved. When `nowUnix` is provided, an `exp`-lapsed handle is reported expired.
 */
export function verifyLeaseHandle(
  publicKey: Uint8Array,
  handle: string,
  nowUnix?: number,
): LeaseHandleVerification {
  const parts = handle.split(".");
  if (parts.length !== 3 || parts[0] !== HANDLE_PREFIX) return { valid: false, reason: "malformed" };
  let message: Buffer;
  let claims: LeaseHandleClaims;
  try {
    message = fromBase64url(parts[1]!);
    claims = JSON.parse(message.toString("utf8")) as LeaseHandleClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (claims.dom !== LEASE_SIGNING_DOMAIN) return { valid: false, reason: "wrong_domain" };
  const signature = fromBase64url(parts[2]!);
  if (!verifyDetached(publicKey, LEASE_SIGNING_DOMAIN, message, signature)) {
    return { valid: false, reason: "bad_signature" };
  }
  if (typeof nowUnix === "number" && nowUnix >= claims.exp) return { valid: false, reason: "expired", claims };
  return { valid: true, claims };
}
