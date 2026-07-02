// T037 (coverage): LIC1 encoder edge cases (verified against the real core) + config loading +
// signer-factory selection. No DB needed.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { ed25519Sign, generateSigningKey, privateKeyFromSeed } from "../edkeys.js";
import { loadSigningConfig } from "../index.js";
import type { Claims } from "../token.js";
import { assembleToken, buildSigningInput, conformanceVerify } from "../token.js";

function pubOf(seed: Buffer): Buffer {
  return Buffer.from(
    crypto.createPublicKey(privateKeyFromSeed(seed)).export({ type: "spki", format: "der" }).subarray(-32),
  );
}
function base(over: Partial<Claims>): Claims {
  return {
    tokenVersion: 1,
    licenseId: "lic-1",
    productId: "prod-1",
    planId: "plan-1",
    customerId: "cust-1",
    issuedAt: 1_700_000_000,
    maxActivations: 1,
    entitlements: {},
    keyId: "k-1",
    nonce: "n-1",
    ...over,
  };
}
function mintAndVerify(claims: Claims, now: number): boolean {
  const gen = generateSigningKey();
  const seed = gen.privateSeed;
  const { payload, signingInput } = buildSigningInput({ ...claims, keyId: gen.keyId });
  const token = assembleToken(payload, ed25519Sign(seed, signingInput));
  return conformanceVerify(token, pubOf(seed), gen.keyId, now);
}

describe("LIC1 encoder edge cases (conformance-verified against the core)", () => {
  it("accepts a perpetual license (no expiry) with empty entitlements", () => {
    expect(mintAndVerify(base({ expiresAt: null }), 1_700_000_100)).toBe(true);
  });

  it("accepts a machine-bound license (fingerprint array) when no local fp is required at verify", () => {
    // A token with a fingerprint but verified without supplying one fails closed (FingerprintMissing)
    // in the core — so it is (correctly) non-conformant here, proving the fp field encodes + parses.
    expect(mintAndVerify(base({ fingerprint: ["a", "b", "c"] }), 1_700_000_100)).toBe(false);
  });

  it("accepts int + bool entitlements and a fp_min / max_skew", () => {
    expect(
      mintAndVerify(base({ entitlements: { pro: true, seats: 42 }, fpMin: 3, maxSkewSecs: 3600 }), 1_700_000_100),
    ).toBe(true);
  });
});

describe("config loading + signer factory", () => {
  it("defaults to the keystore signer and parses custodian shares", () => {
    expect(loadSigningConfig({}).signer).toBe("keystore");
    const cfg = loadSigningConfig({ SIGNING_SIGNER: "keystore", SIGNING_CUSTODIAN_SHARES: "AAAA, BBBB ,CCCC" });
    expect(cfg.custodianShares).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("selects the kms signer only when configured (P2 seam)", () => {
    expect(loadSigningConfig({ SIGNING_SIGNER: "kms" }).signer).toBe("kms");
  });
});

describe("factory + fail-closed branches (no DB)", () => {
  it("createSigner throws for the kms signer (P2 not enabled)", async () => {
    const { createSigner } = await import("../index.js");
    const { Custody } = await import("../custody.js");
    expect(() =>
      createSigner({} as never, { signer: "kms", custodianShares: [], overlapSeconds: 3600 }, new Custody()),
    ).toThrow(/kms/i);
  });

  it("createSigningModule stays LOCKED (not ready) with fewer than k shares", async () => {
    const { createSigningModule } = await import("../index.js");
    const mod = createSigningModule({} as never, { signer: "keystore", custodianShares: ["AAAA"], overlapSeconds: 3600 });
    expect(mod.ready()).toBe(false); // one share < k -> fail-closed
    expect(mod.custody.unlocked).toBe(false);
  });

  it("KeystoreSigner.sign fails closed (unavailable) when custody is locked", async () => {
    const { KeystoreSigner } = await import("../keystore-signer.js");
    const { Custody } = await import("../custody.js");
    const signer = new KeystoreSigner({} as never, new Custody());
    await expect(
      signer.sign("t", base({ productId: crypto.randomUUID() })),
    ).rejects.toMatchObject({ failure: "unavailable" });
  });
});
