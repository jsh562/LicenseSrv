// T031 (OBJ4, TR-011/TR-012, SC-006): custody unit tests — Shamir k-of-n split/recombine,
// AES-256-GCM envelope round-trip + tamper detection, and fail-closed behaviour when locked.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { Custody, shamirCombine, shamirSplit, unwrapKey, wrapKey } from "../custody.js";

describe("Shamir k-of-n", () => {
  it("reconstructs the secret from exactly k of n shares, in any combination", () => {
    const secret = crypto.randomBytes(32);
    const n = 5;
    const k = 3;
    const shares = shamirSplit(secret, n, k);
    expect(shares).toHaveLength(n);

    // Every distinct k-subset reconstructs the secret.
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        for (let l = j + 1; l < n; l++) {
          const recovered = shamirCombine([shares[i]!, shares[j]!, shares[l]!]);
          expect(recovered.equals(secret)).toBe(true);
        }
  });

  it("does not reconstruct the secret from fewer than k shares", () => {
    const secret = crypto.randomBytes(32);
    const shares = shamirSplit(secret, 5, 3);
    const recovered = shamirCombine([shares[0]!, shares[1]!]); // only 2 < k
    expect(recovered.equals(secret)).toBe(false);
  });

  it("rejects invalid thresholds and duplicate share indices", () => {
    expect(() => shamirSplit(Buffer.alloc(8), 3, 4)).toThrow();
    const shares = shamirSplit(Buffer.alloc(8), 3, 2);
    expect(() => shamirCombine([shares[0]!, shares[0]!])).toThrow(/duplicate/);
  });
});

describe("AES-256-GCM envelope", () => {
  it("round-trips a wrapped private key", () => {
    const master = crypto.randomBytes(32);
    const priv = crypto.randomBytes(32);
    const blob = wrapKey(master, priv);
    expect(blob.equals(priv)).toBe(false); // wrapped != plaintext
    expect(unwrapKey(master, blob).equals(priv)).toBe(true);
  });

  it("fails to unwrap under the wrong master key or a tampered blob", () => {
    const master = crypto.randomBytes(32);
    const blob = wrapKey(master, crypto.randomBytes(32));
    expect(() => unwrapKey(crypto.randomBytes(32), blob)).toThrow();
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff; // corrupt the auth tag
    expect(() => unwrapKey(master, tampered)).toThrow();
  });
});

describe("Custody (fail-closed)", () => {
  it("is locked until unlocked with k shares, then wraps/unwraps", () => {
    const master = crypto.randomBytes(32);
    const shares = shamirSplit(master, 5, 3);
    const custody = new Custody();

    expect(custody.unlocked).toBe(false);
    expect(() => custody.wrap(crypto.randomBytes(32))).toThrow(/locked/); // fail-closed

    custody.unlock([shares[0]!, shares[2]!, shares[4]!]);
    expect(custody.unlocked).toBe(true);

    const priv = crypto.randomBytes(32);
    const wrapped = custody.wrap(priv);
    expect(custody.unwrap(wrapped).equals(priv)).toBe(true);

    custody.zeroize();
    expect(custody.unlocked).toBe(false);
    expect(() => custody.unwrap(wrapped)).toThrow(/locked/);
  });
});
