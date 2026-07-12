// Claims builder (FR-002/003) — maps an issuance's plan snapshot to the E001 `Claims` the E004 signer
// mints into a LIC1 token. Pure: given the license id, product/plan/customer ids, term, seat limit, and
// entitlements map, it produces the claim set. `keyId` is a placeholder — the signer stamps the product's
// active key id; `nonce` is fresh per issuance.
import { randomBytes } from "node:crypto";

import type { Claims } from "../signing/token.js";

/** The token format version this build emits (mirrors the core's LIC1 claim `v`). */
export const TOKEN_VERSION = 1;

export interface IssueClaimsInput {
  licenseId: string;
  productId: string;
  planId: string;
  customerId: string;
  issuedAt: number; // unix seconds
  expiresAt: number | null; // unix seconds, or null for a perpetual license
  maxActivations: number; // snapshot seat limit
  entitlements: Record<string, boolean | number>; // snapshot entitlement values
}

/** Build the E001 Claims for an issuance. The signer overrides `keyId` with the product's active key. */
export function buildClaims(input: IssueClaimsInput): Claims {
  return {
    tokenVersion: TOKEN_VERSION,
    licenseId: input.licenseId,
    productId: input.productId,
    planId: input.planId,
    customerId: input.customerId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    maxActivations: input.maxActivations,
    entitlements: input.entitlements,
    keyId: "", // stamped by the signer (it selects the product's active key)
    nonce: randomBytes(16).toString("hex"),
  };
}

/** Fold the effective entitlements list ([{key,value}]) into the token's `{key: value}` map. */
export function toEntitlementMap(
  entitlements: { key: string; value: boolean | number }[],
): Record<string, boolean | number> {
  const map: Record<string, boolean | number> = {};
  for (const e of entitlements) map[e.key] = e.value;
  return map;
}
