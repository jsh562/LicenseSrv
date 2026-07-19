import { ed25519Sign, ed25519Verify } from "./edkeys.js";
import { activeKey } from "./registry.js";
import { buildDetachedSigningInput, KeyMaterial, SignerError } from "./signer.js";
import { assembleToken, buildSigningInput, conformanceVerify } from "./token.js";
const base64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export class KeystoreSigner {
    #pool;
    #custody;
    constructor(pool, custody) {
        this.#pool = pool;
        this.#custody = custody;
    }
    ready() {
        return this.#custody.unlocked;
    }
    async sign(tenantId, claims) {
        if (!this.#custody.unlocked) {
            throw new SignerError("unavailable", "signer custody is locked");
        }
        let ak;
        try {
            ak = await activeKey(this.#pool, tenantId, claims.productId);
        }
        catch {
            throw new SignerError("internal", "signing-key registry read failed");
        }
        if (!ak) {
            throw new SignerError("no-active-key", "no active signing key for the product");
        }
        let seed;
        try {
            seed = this.#custody.unwrap(ak.privateKeyRef);
        }
        catch {
            // A locked custody or a tampered/mis-scheme blob — fail closed, reveal nothing.
            throw new SignerError("unavailable", "could not access the signing key");
        }
        try {
            // Route the key through the KeyMaterial boundary (TR-010/AD-007): the private seed is only
            // reachable via the opaque `signOver` closure, never serialized/logged/returned.
            const km = new KeyMaterial(ak.keyId, ak.publicKey, (input) => ed25519Sign(seed, input));
            const stamped = { ...claims, keyId: km.keyId };
            const { payload, signingInput } = buildSigningInput(stamped);
            const signature = km.signOver(signingInput);
            const token = assembleToken(payload, signature);
            // Conformance oracle: the minted token MUST verify via the real core before we return it. A
            // machine-bound token (E009) carries a fingerprint, which must be supplied to the core here.
            if (!conformanceVerify(token, ak.publicKey, ak.keyId, stamped.issuedAt, stamped.fingerprint ?? null)) {
                throw new SignerError("conformance", "minted token failed core conformance verification");
            }
            return token;
        }
        catch (err) {
            if (err instanceof SignerError)
                throw err;
            throw new SignerError("internal", "signing failed");
        }
        finally {
            seed.fill(0); // wipe the unwrapped seed
        }
    }
    /**
     * Detached-sign `domain ‖ message` under the product's active key (E013/US4, FR-009). Reuses the exact
     * key-resolution + KeyMaterial.signOver path as {@link sign} — the private seed is only reachable via the
     * opaque `signOver` closure, is never serialized/logged/returned, and is wiped in `finally`. Fail-closed:
     * a locked custody, a missing active key, or a registry/backend fault throws SignerError with no
     * signature bytes. Returns the base64url signature + the PUBLIC `key_id` that signed it.
     */
    async signDetached(tenantId, productId, domain, message) {
        if (!this.#custody.unlocked) {
            throw new SignerError("unavailable", "signer custody is locked");
        }
        let ak;
        try {
            ak = await activeKey(this.#pool, tenantId, productId);
        }
        catch {
            throw new SignerError("internal", "signing-key registry read failed");
        }
        if (!ak) {
            throw new SignerError("no-active-key", "no active signing key for the product");
        }
        let seed;
        try {
            seed = this.#custody.unwrap(ak.privateKeyRef);
        }
        catch {
            throw new SignerError("unavailable", "could not access the signing key");
        }
        try {
            // Route the key through the KeyMaterial boundary (TR-010/AD-007): the private seed is only reachable
            // via the opaque `signOver` closure, never serialized/logged/returned. The signing input is
            // domain-separated (`domain ‖ message`) so a CRL signature can never be confused with a LIC1 token.
            const km = new KeyMaterial(ak.keyId, ak.publicKey, (input) => ed25519Sign(seed, input));
            const signature = km.signOver(buildDetachedSigningInput(domain, message));
            return { signature: base64url(signature), keyId: km.keyId };
        }
        catch (err) {
            if (err instanceof SignerError)
                throw err;
            throw new SignerError("internal", "detached signing failed");
        }
        finally {
            seed.fill(0); // wipe the unwrapped seed
        }
    }
}
/**
 * Verify a detached Ed25519 `signature` over `domain ‖ message` against a product's raw 32-byte public
 * key (E013/US4). The COUNTERPART to {@link KeystoreSigner.signDetached}: it reuses the same
 * {@link buildDetachedSigningInput} so the domain separation matches exactly. Public-key only — no private
 * material is involved. Used by the CRL suites to confirm a generated/served CRL verifies against the
 * product keyring; a real client verifies the same way against its pinned keyring.
 */
export function verifyDetached(publicKey, domain, message, signature) {
    try {
        return ed25519Verify(publicKey, buildDetachedSigningInput(domain, message), signature);
    }
    catch {
        // A malformed signature/key surfaces as "not verified", never a throw (fail-closed for callers).
        return false;
    }
}
