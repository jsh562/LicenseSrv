/**
 * Private key material, confined to the signer/custody boundary (AD-007). It is never serialized,
 * logged, or returned; only its opaque `sign` closure crosses into the signer. `toJSON` is
 * overridden so an accidental `JSON.stringify`/log yields a redacted marker, never key bytes.
 */
export class KeyMaterial {
    keyId;
    publicKey;
    #sign;
    constructor(keyId, publicKey, sign) {
        this.keyId = keyId;
        this.publicKey = publicKey;
        this.#sign = sign;
    }
    /** Produce the 64-byte Ed25519 signature over `signingInput` — the only key operation. */
    signOver(signingInput) {
        return this.#sign(signingInput);
    }
    toJSON() {
        return "[KeyMaterial redacted]";
    }
    toString() {
        return "[KeyMaterial redacted]";
    }
}
/** A defined signing error carrying zero token bytes (TR-011/TR-018). Never includes key data. */
export class SignerError extends Error {
    failure;
    constructor(failure, message) {
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
export function buildDetachedSigningInput(domain, message) {
    return Buffer.concat([Buffer.from(domain, "ascii"), message]);
}
