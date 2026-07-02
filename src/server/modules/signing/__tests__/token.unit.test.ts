// AD-001 / TR-018 in-repo proof: the TS LIC1 encoder is byte-identical to the Rust core, and the
// conformance oracle (real verifier-core via E003 WASM) accepts minted tokens and rejects tampered
// ones. No DB needed.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ed25519Sign, privateKeyFromSeed } from "../edkeys.js";
import type { Claims } from "../token.js";
import { assembleToken, buildSigningInput, conformanceVerify } from "../token.js";
import crypto from "node:crypto";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../bindings/wasm/tests/fixture.json", import.meta.url), "utf8"),
) as { keyId: string; publicKey: number[]; nowUnix: number; expiredNow: number; token: string; tampered: string };

/** The exact deterministic fixture claims (mirrors gen_wasm_fixture.rs / common/mod.rs). */
function fixtureClaims(): Claims {
  return {
    tokenVersion: 1,
    licenseId: "lic-1",
    productId: "prod-1",
    planId: "plan-1",
    customerId: "cust-1",
    issuedAt: 1_700_000_000,
    expiresAt: 1_900_000_000,
    maxActivations: 3,
    entitlements: { pro: true, seats: 5 },
    keyId: "k-test-1",
    nonce: "nonce-1",
  };
}

function pubFromSeed(seed: Buffer): Buffer {
  return Buffer.from(
    crypto.createPublicKey(privateKeyFromSeed(seed)).export({ type: "spki", format: "der" }).subarray(-32),
  );
}

describe("LIC1 encoder — byte conformance with the Rust core", () => {
  it("reproduces the committed deterministic fixture token exactly", () => {
    const seed = Buffer.alloc(32, 7); // gen_wasm_fixture.rs uses SigningKey::from_bytes([7;32])
    const { payload, signingInput } = buildSigningInput(fixtureClaims());
    const token = assembleToken(payload, ed25519Sign(seed, signingInput));
    expect(token).toBe(FIXTURE.token); // byte-identical to ciborium+dalek output
  });

  it("mints a token the real verifier-core accepts (conformance oracle)", () => {
    const seed = Buffer.alloc(32, 7);
    const pub = pubFromSeed(seed);
    const { payload, signingInput } = buildSigningInput(fixtureClaims());
    const token = assembleToken(payload, ed25519Sign(seed, signingInput));
    expect(conformanceVerify(token, pub, "k-test-1", FIXTURE.nowUnix)).toBe(true);
  });

  it("rejects a tampered token via the conformance oracle", () => {
    const seed = Buffer.alloc(32, 7);
    const pub = pubFromSeed(seed);
    expect(conformanceVerify(FIXTURE.tampered, pub, "k-test-1", FIXTURE.nowUnix)).toBe(false);
  });

  it("treats an expired token as non-conformant at a later now", () => {
    const seed = Buffer.alloc(32, 7);
    const pub = pubFromSeed(seed);
    const { payload, signingInput } = buildSigningInput(fixtureClaims());
    const token = assembleToken(payload, ed25519Sign(seed, signingInput));
    expect(conformanceVerify(token, pub, "k-test-1", FIXTURE.expiredNow)).toBe(false);
  });
});
