// [Foundational] (FR-022, SC-018): E004-signed lease-handle unit tests. Mints a handle through a REAL
// Ed25519 detached-signing stub (the same `buildDetachedSigningInput(domain ‖ message)` path the keystore
// signer uses) and asserts: it verifies against the public key; a TAMPERED payload / wrong-domain / expired
// handle fails; the domain tag is DISTINCT from the LIC1 token + CRL domains; the validity is TTL-bounded
// (≤ heartbeat interval, FR-022); and NO private key material is present in the handle or the opaque keyId.
import { describe, expect, it } from "vitest";

import {
  boundedHandleExpiry,
  LEASE_SIGNING_DOMAIN,
  signLeaseHandle,
  verifyLeaseHandle,
} from "../handle.js";
import { ed25519Sign, generateSigningKey, type GeneratedKey } from "../../signing/edkeys.js";
import { CRL_SIGNING_DOMAIN, buildDetachedSigningInput, type Signer } from "../../signing/signer.js";
import type { Claims } from "../../signing/token.js";

const base64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A minimal REAL Ed25519 signer stub — detached-signs `domain ‖ message` exactly like the keystore signer. */
function fakeSigner(key: GeneratedKey): Signer {
  return {
    sign: (_t: string, _c: Claims) => Promise.reject(new Error("not used")),
    signDetached: (_tenantId, _productId, domain, message) =>
      Promise.resolve({
        signature: base64url(ed25519Sign(key.privateSeed, buildDetachedSigningInput(domain, message))),
        keyId: key.keyId,
      }),
    ready: () => true,
  };
}

const input = {
  leaseId: "9b2e1d40-1111-4a2b-8c3d-4e5f60718293",
  licenseId: "e5f60718-3333-4c4d-ae5f-60718293a4b5",
  holderKey: "Zk9Xp2QrL0sNvT7bYc4mHs6Jd1WuA3eZoG5iRfB2xM",
  scope: "session" as const,
  issuedAtUnix: 1_800_000_000,
  leaseExpiresAtUnix: 1_800_001_800, // +1800s (TTL)
  handleTtlSeconds: 600, // heartbeat interval
};

describe("signLeaseHandle / verifyLeaseHandle (FR-022, SC-018)", () => {
  it("mints a LEASE1 artifact that verifies against the E004 public key", async () => {
    const key = generateSigningKey();
    const { leaseHandle, keyId, handleExpiresAtUnix } = await signLeaseHandle(fakeSigner(key), "t", "prod", input);
    expect(leaseHandle.startsWith("LEASE1.")).toBe(true);
    expect(keyId).toBe(key.keyId);
    const v = verifyLeaseHandle(key.publicKey, leaseHandle);
    expect(v.valid).toBe(true);
    expect(v.claims?.dom).toBe(LEASE_SIGNING_DOMAIN);
    expect(v.claims?.lid).toBe(input.leaseId);
    expect(v.claims?.lic).toBe(input.licenseId);
    expect(v.claims?.hk).toBe(input.holderKey);
    expect(v.claims?.exp).toBe(handleExpiresAtUnix);
  });

  it("uses a DISTINCT domain from the LIC1 token and CRL domains (no cross-protocol confusion)", () => {
    expect(LEASE_SIGNING_DOMAIN).toBe("LICSRV-LEASE-v1");
    expect(LEASE_SIGNING_DOMAIN).not.toBe(CRL_SIGNING_DOMAIN);
    expect(LEASE_SIGNING_DOMAIN).not.toBe("LICSRV-LICENSE-TOKEN-v1");
  });

  it("fails a TAMPERED payload (tamper-evident)", async () => {
    const key = generateSigningKey();
    const { leaseHandle } = await signLeaseHandle(fakeSigner(key), "t", "prod", input);
    const [prefix, payloadSeg, sig] = leaseHandle.split(".");
    const claims = JSON.parse(fromBase64url(payloadSeg!).toString("utf8")) as Record<string, unknown>;
    claims.hk = "attacker-substituted-holder"; // forge a different holder, keep the original signature
    const forged = `${prefix}.${base64url(Buffer.from(JSON.stringify(claims), "utf8"))}.${sig}`;
    const v = verifyLeaseHandle(key.publicKey, forged);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("bad_signature");
  });

  it("fails verification against a DIFFERENT public key", async () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const { leaseHandle } = await signLeaseHandle(fakeSigner(key), "t", "prod", input);
    expect(verifyLeaseHandle(other.publicKey, leaseHandle).valid).toBe(false);
  });

  it("rejects a malformed handle", () => {
    const key = generateSigningKey();
    expect(verifyLeaseHandle(key.publicKey, "not-a-handle").reason).toBe("malformed");
    expect(verifyLeaseHandle(key.publicKey, "LEASE1.only-two").reason).toBe("malformed");
    expect(verifyLeaseHandle(key.publicKey, "WRONG.a.b").reason).toBe("malformed");
  });

  it("reports an expired handle when now ≥ exp", async () => {
    const key = generateSigningKey();
    const { leaseHandle, handleExpiresAtUnix } = await signLeaseHandle(fakeSigner(key), "t", "prod", input);
    expect(verifyLeaseHandle(key.publicKey, leaseHandle, handleExpiresAtUnix).reason).toBe("expired");
    expect(verifyLeaseHandle(key.publicKey, leaseHandle, handleExpiresAtUnix - 1).valid).toBe(true);
  });
});

describe("boundedHandleExpiry (TTL-bounded ≤ heartbeat interval, FR-022)", () => {
  it("clamps to issuedAt + heartbeat when the lease TTL is longer (short relative to TTL)", () => {
    const exp = boundedHandleExpiry(input); // lease expiry is +1800, heartbeat cap is +600
    expect(exp).toBe(input.issuedAtUnix + input.handleTtlSeconds);
    expect(exp - input.issuedAtUnix).toBeLessThanOrEqual(input.handleTtlSeconds);
    expect(exp).toBeLessThan(input.leaseExpiresAtUnix);
  });

  it("clamps to the lease expiry when it is sooner than the heartbeat window", () => {
    const near = { ...input, leaseExpiresAtUnix: input.issuedAtUnix + 100 };
    expect(boundedHandleExpiry(near)).toBe(input.issuedAtUnix + 100);
  });
});

describe("no key material leaked (SC-015)", () => {
  it("neither the handle nor the opaque keyId contains the private seed", async () => {
    const key = generateSigningKey();
    const { leaseHandle, keyId } = await signLeaseHandle(fakeSigner(key), "t", "prod", input);
    const seedB64 = base64url(key.privateSeed);
    const seedHex = key.privateSeed.toString("hex");
    for (const secret of [seedB64, seedHex]) {
      expect(leaseHandle).not.toContain(secret);
      expect(keyId).not.toContain(secret);
    }
  });
});
