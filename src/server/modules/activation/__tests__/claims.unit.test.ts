// T007 (FR-007/022): the pure machine-bound claims builder — license snapshot → Claims with fp/fpk/sk, and
// the effective-expiry rule (the sooner of license expiry and now+TTL).
import { describe, expect, it } from "vitest";

import type { License } from "../../issuance/licenses.js";
import { buildMachineClaims, effectiveExpiry, TOKEN_VERSION } from "../claims.js";

const license: License = {
  id: "lic-1",
  productId: "prod-1",
  planId: "plan-1",
  customerId: "cust-1",
  status: "active",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  maxActivations: 5,
  entitlements: { pro: true, seats: 10 },
  keyId: "k1",
  transferCount: 0,
};

describe("effectiveExpiry (FR-022)", () => {
  const now = 1_800_000_000;
  const licExpIso = "2030-01-01T00:00:00.000Z";
  const licExpUnix = Math.floor(new Date(licExpIso).getTime() / 1000);

  it("uses the license expiry when no TTL is configured", () => {
    expect(effectiveExpiry(licExpIso, null, now)).toBe(licExpUnix);
  });
  it("uses now+TTL for a perpetual license with a TTL", () => {
    expect(effectiveExpiry(null, 3600, now)).toBe(now + 3600);
  });
  it("takes the sooner of the two when both are set", () => {
    expect(effectiveExpiry(licExpIso, 3600, now)).toBe(Math.min(licExpUnix, now + 3600));
  });
  it("is perpetual (null) when neither is set", () => {
    expect(effectiveExpiry(null, null, now)).toBeNull();
  });
});

describe("buildMachineClaims (FR-007)", () => {
  it("maps the license snapshot + fingerprint into Claims with fp/fpk/sk", () => {
    const c = buildMachineClaims({ license, signalHashes: ["a", "b", "c"], fpMin: 3, maxSkewSecs: 300, nowUnix: 1000, credentialTtlSecs: null });
    expect(c).toMatchObject({
      tokenVersion: TOKEN_VERSION,
      licenseId: "lic-1",
      productId: "prod-1",
      planId: "plan-1",
      customerId: "cust-1",
      maxActivations: 5,
      entitlements: { pro: true, seats: 10 },
      fingerprint: ["a", "b", "c"],
      fpMin: 3,
      maxSkewSecs: 300,
      expiresAt: null, // perpetual license, no TTL
      keyId: "", // stamped by the signer
    });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});
