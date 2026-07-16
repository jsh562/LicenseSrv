// The default keystore signer (TR-002). Resolves a product's active key, unwraps its private seed
// inside the custody boundary, signs the LIC1 signing input with node:crypto Ed25519, and — before
// returning — verifies the minted token against the real core (TR-018). Fail-closed: custody/backend
// faults and any conformance mismatch yield a defined SignerError with zero token bytes (TR-011).
import type pg from "pg";

import type { Custody } from "./custody.js";
import { ed25519Sign } from "./edkeys.js";
import { activeKey } from "./registry.js";
import type { Signer } from "./signer.js";
import { KeyMaterial, SignerError } from "./signer.js";
import type { Claims } from "./token.js";
import { assembleToken, buildSigningInput, conformanceVerify } from "./token.js";

export class KeystoreSigner implements Signer {
  readonly #pool: pg.Pool;
  readonly #custody: Custody;

  constructor(pool: pg.Pool, custody: Custody) {
    this.#pool = pool;
    this.#custody = custody;
  }

  ready(): boolean {
    return this.#custody.unlocked;
  }

  async sign(tenantId: string, claims: Claims): Promise<string> {
    if (!this.#custody.unlocked) {
      throw new SignerError("unavailable", "signer custody is locked");
    }

    let ak;
    try {
      ak = await activeKey(this.#pool, tenantId, claims.productId);
    } catch {
      throw new SignerError("internal", "signing-key registry read failed");
    }
    if (!ak) {
      throw new SignerError("no-active-key", "no active signing key for the product");
    }

    let seed: Buffer;
    try {
      seed = this.#custody.unwrap(ak.privateKeyRef);
    } catch {
      // A locked custody or a tampered/mis-scheme blob — fail closed, reveal nothing.
      throw new SignerError("unavailable", "could not access the signing key");
    }

    try {
      // Route the key through the KeyMaterial boundary (TR-010/AD-007): the private seed is only
      // reachable via the opaque `signOver` closure, never serialized/logged/returned.
      const km = new KeyMaterial(ak.keyId, ak.publicKey, (input) => ed25519Sign(seed, input));
      const stamped: Claims = { ...claims, keyId: km.keyId };
      const { payload, signingInput } = buildSigningInput(stamped);
      const signature = km.signOver(signingInput);
      const token = assembleToken(payload, signature);

      // Conformance oracle: the minted token MUST verify via the real core before we return it. A
      // machine-bound token (E009) carries a fingerprint, which must be supplied to the core here.
      if (!conformanceVerify(token, ak.publicKey, ak.keyId, stamped.issuedAt, stamped.fingerprint ?? null)) {
        throw new SignerError("conformance", "minted token failed core conformance verification");
      }
      return token;
    } catch (err) {
      if (err instanceof SignerError) throw err;
      throw new SignerError("internal", "signing failed");
    } finally {
      seed.fill(0); // wipe the unwrapped seed
    }
  }
}
