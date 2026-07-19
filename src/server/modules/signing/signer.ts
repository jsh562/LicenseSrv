// The Signer interface (TR-001) — the single key-using surface issuance (E008) and air-gap (E010)
// call. Sign-only: there is deliberately NO export/read operation for private material (interface
// shape; runtime non-leakage is TR-010). Fail-closed: a custody/backend fault yields a defined
// error carrying zero token bytes (TR-011/TR-018).
import type { Claims } from "./token.js";

/**
 * Private key material, confined to the signer/custody boundary (AD-007). It is never serialized,
 * logged, or returned; only its opaque `sign` closure crosses into the signer. `toJSON` is
 * overridden so an accidental `JSON.stringify`/log yields a redacted marker, never key bytes.
 */
export class KeyMaterial {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  readonly #sign: (signingInput: Buffer) => Buffer;

  constructor(keyId: string, publicKey: Uint8Array, sign: (signingInput: Buffer) => Buffer) {
    this.keyId = keyId;
    this.publicKey = publicKey;
    this.#sign = sign;
  }

  /** Produce the 64-byte Ed25519 signature over `signingInput` — the only key operation. */
  signOver(signingInput: Buffer): Buffer {
    return this.#sign(signingInput);
  }

  toJSON(): string {
    return "[KeyMaterial redacted]";
  }
  toString(): string {
    return "[KeyMaterial redacted]";
  }
}

/** The reason a signing attempt failed, carried by `SignerError` (no key material, ever). */
export type SignerFailure =
  | "no-active-key" // no active key for the product
  | "unavailable" // custody locked or backend down (fail-closed, TR-011)
  | "conformance" // minted token failed verification against the core (TR-018)
  | "internal"; // caught fault

/** A defined signing error carrying zero token bytes (TR-011/TR-018). Never includes key data. */
export class SignerError extends Error {
  readonly failure: SignerFailure;
  constructor(failure: SignerFailure, message: string) {
    super(message);
    this.name = "SignerError";
    this.failure = failure;
  }
}

/**
 * The domain-separation tag for a detached CRL signature (E013/US4, FR-009). DISTINCT from the LIC1
 * token domain (`LICSRV-LICENSE-TOKEN-v1`, `token.ts`): domain separation guarantees a CRL signature can
 * never be confused for — or replayed as — a license-token signature under the same product key, and
 * vice versa. Any new detached-signed artifact MUST get its own tag.
 */
export const CRL_SIGNING_DOMAIN = "LICSRV-CRL-v1";

/**
 * The bytes a detached signer signs: `domain ‖ message`. The domain tag (ASCII) is prepended so the
 * Ed25519 signature is bound to exactly one protocol (cross-protocol confusion is impossible). The same
 * builder is used by the signer and by `verifyDetached`, so the two can never drift.
 */
export function buildDetachedSigningInput(domain: string, message: Buffer): Buffer {
  return Buffer.concat([Buffer.from(domain, "ascii"), message]);
}

/** The one signing surface. Implemented by the keystore signer (default) and the KMS adapter. */
export interface Signer {
  /**
   * Mint a signed `LIC1` token for `claims` under `tenantId`. The signer selects the product's
   * active key and stamps its `key_id` into the token. On success returns the token string, which
   * has been conformance-verified against the core before return (TR-018). On any fault throws
   * `SignerError` and returns no token bytes (TR-011).
   */
  sign(tenantId: string, claims: Claims): Promise<string>;

  /**
   * Produce a DETACHED Ed25519 signature over `domain ‖ message` using the product's active key
   * (E013/US4). Unlike {@link sign}, this signs arbitrary canonical bytes (e.g. a byte-stable CRL
   * document) rather than a LIC1 token, and it is domain-separated (`domain`, e.g.
   * {@link CRL_SIGNING_DOMAIN}) from the token protocol so signatures can never cross protocols.
   * Returns the base64url signature + the `key_id` that signed it (a PUBLIC identifier — never key
   * bytes). Fail-closed: a custody/backend/registry fault throws {@link SignerError} with no signature.
   */
  signDetached(
    tenantId: string,
    productId: string,
    domain: string,
    message: Buffer,
  ): Promise<{ signature: string; keyId: string }>;

  /** True when the signer can currently sign (custody unlocked, backend reachable). */
  ready(): boolean;
}
