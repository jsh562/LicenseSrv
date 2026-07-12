// T007 (FR-002/003): the pure claims builder — snapshot → E001 Claims mapping + entitlements folding.
import { describe, expect, it } from "vitest";

import { buildClaims, TOKEN_VERSION, toEntitlementMap } from "../claims.js";

describe("buildClaims (FR-002)", () => {
  const base = {
    licenseId: "lic-1",
    productId: "prod-1",
    planId: "plan-1",
    customerId: "cust-1",
    issuedAt: 1_800_000_000,
    maxActivations: 3,
    entitlements: { pro: true, seats: 5 },
  };

  it("maps a time-limited issuance to claims with a placeholder keyId and a fresh nonce", () => {
    const c = buildClaims({ ...base, expiresAt: 1_900_000_000 });
    expect(c).toMatchObject({
      tokenVersion: TOKEN_VERSION,
      licenseId: "lic-1",
      productId: "prod-1",
      planId: "plan-1",
      customerId: "cust-1",
      issuedAt: 1_800_000_000,
      expiresAt: 1_900_000_000,
      maxActivations: 3,
      entitlements: { pro: true, seats: 5 },
      keyId: "", // stamped by the signer
    });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("emits a null expiresAt for a perpetual license, and a distinct nonce each time", () => {
    const a = buildClaims({ ...base, expiresAt: null });
    const b = buildClaims({ ...base, expiresAt: null });
    expect(a.expiresAt).toBeNull();
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("toEntitlementMap", () => {
  it("folds the effective entitlement list into a {key: value} map", () => {
    expect(
      toEntitlementMap([
        { key: "pro", value: true },
        { key: "seats", value: 50 },
      ]),
    ).toEqual({ pro: true, seats: 50 });
    expect(toEntitlementMap([])).toEqual({});
  });
});
