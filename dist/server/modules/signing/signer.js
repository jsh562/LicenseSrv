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
