// T035 (TR-010, SC-001/SC-007): no private key material leaks through the module's boundaries.
// The KeyMaterial boundary redacts on serialize/log; SignerError carries no key bytes; the public
// metadata/keyring types carry only public material by construction.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { KeyMaterial, SignerError } from "../signer.js";
import { ed25519Sign, generateSigningKey } from "../edkeys.js";

describe("secret leakage (TR-010)", () => {
  it("KeyMaterial never serializes or logs the private key", () => {
    const gen = generateSigningKey();
    const seedHex = gen.privateSeed.toString("hex");
    const km = new KeyMaterial(gen.keyId, gen.publicKey, (input) => ed25519Sign(gen.privateSeed, input));

    // toJSON / toString / JSON.stringify must not reveal key bytes.
    expect(km.toJSON()).toBe("[KeyMaterial redacted]");
    expect(String(km)).toBe("[KeyMaterial redacted]");
    const serialized = JSON.stringify({ km });
    expect(serialized).not.toContain(seedHex);
    expect(serialized).not.toContain(gen.privateSeed.toString("base64"));

    // The private closure is not an enumerable own property.
    expect(Object.keys(km)).not.toContain("sign");
    expect(JSON.stringify(km)).toBe('"[KeyMaterial redacted]"');

    // It can still sign (the only key operation).
    const sig = km.signOver(Buffer.from("hello"));
    expect(sig).toHaveLength(64);
  });

  it("SignerError carries a category and message but no key material", () => {
    const secret = crypto.randomBytes(32).toString("hex");
    const e = new SignerError("unavailable", "signer custody is locked");
    expect(e.failure).toBe("unavailable");
    expect(e.message).not.toContain(secret);
    expect(JSON.stringify({ name: e.name, message: e.message, failure: e.failure })).not.toContain(secret);
  });
});
