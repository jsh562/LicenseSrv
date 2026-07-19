// T008 (FR-004/005/006/017): the pure verdict logic. active -> valid; revoked/suspended/expired/
// deactivated -> the refusal verdict + a specific reason (AD-001 — returned, never thrown); the CURRENT
// effective entitlements are carried through for the renewed token (FR-017).
import { describe, expect, it } from "vitest";

import type { License } from "../../issuance/licenses.js";
import { evaluateEnforcement, isMonotonicAnchor } from "../enforce.js";

const NOW = 1_800_000_000; // fixed unix seconds
const FUTURE = "2035-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function license(over: Partial<License> = {}): License {
  return {
    id: "lic-1",
    productId: "prod-1",
    planId: "plan-1",
    customerId: "cust-1",
    status: "active",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: FUTURE,
    maxActivations: 5,
    entitlements: { pro: true, seats: 10 },
    keyId: "k1",
    transferCount: 0,
    ...over,
  };
}
const activeActivation = { status: "active" };

describe("evaluateEnforcement — valid path (FR-004)", () => {
  it("returns valid + no reason when license active/unexpired and activation active", () => {
    const r = evaluateEnforcement(license(), activeActivation, null, NOW);
    expect(r.verdict).toBe("valid");
    expect(r.reason).toBeNull();
  });

  it("is valid for a perpetual (null-expiry) license", () => {
    const r = evaluateEnforcement(license({ expiresAt: null }), activeActivation, null, NOW);
    expect(r.verdict).toBe("valid");
  });

  it("reinstating a suspended license (status back to active) renews again (FR-006)", () => {
    expect(evaluateEnforcement(license({ status: "suspended" }), activeActivation, null, NOW).verdict).toBe("suspended");
    expect(evaluateEnforcement(license({ status: "active" }), activeActivation, null, NOW).verdict).toBe("valid");
  });
});

describe("evaluateEnforcement — refusal verdicts + reasons (FR-004/005)", () => {
  it("revoked -> verdict revoked, reason revoked", () => {
    const r = evaluateEnforcement(license({ status: "revoked" }), activeActivation, null, NOW);
    expect(r).toMatchObject({ verdict: "revoked", reason: "revoked" });
  });

  it("suspended -> verdict suspended, reason suspended", () => {
    const r = evaluateEnforcement(license({ status: "suspended" }), activeActivation, null, NOW);
    expect(r).toMatchObject({ verdict: "suspended", reason: "suspended" });
  });

  it("expired license -> verdict expired, reason expired", () => {
    const r = evaluateEnforcement(license({ expiresAt: PAST }), activeActivation, null, NOW);
    expect(r).toMatchObject({ verdict: "expired", reason: "expired" });
  });

  it("expiry boundary: exp exactly now is expired (<= now)", () => {
    const nowIso = new Date(NOW * 1000).toISOString();
    expect(evaluateEnforcement(license({ expiresAt: nowIso }), activeActivation, null, NOW).verdict).toBe("expired");
  });

  it("deactivated activation on an active license -> verdict deactivated, reason activation_deactivated", () => {
    const r = evaluateEnforcement(license(), { status: "deactivated" }, null, NOW);
    expect(r).toMatchObject({ verdict: "deactivated", reason: "activation_deactivated" });
  });

  it("precedence: revoked wins over an also-expired license", () => {
    const r = evaluateEnforcement(license({ status: "revoked", expiresAt: PAST }), { status: "deactivated" }, null, NOW);
    expect(r.verdict).toBe("revoked");
  });

  it("precedence: expiry is checked before activation status", () => {
    const r = evaluateEnforcement(license({ expiresAt: PAST }), { status: "deactivated" }, null, NOW);
    expect(r.verdict).toBe("expired");
  });
});

describe("evaluateEnforcement — effective entitlements carried for the renewed token (FR-017)", () => {
  it("returns the CURRENT effective entitlements when provided (not the license snapshot)", () => {
    const current = { pro: true, seats: 50, beta: true };
    const r = evaluateEnforcement(license(), activeActivation, current, NOW);
    expect(r.entitlements).toEqual(current);
    expect(r.entitlements).not.toEqual(license().entitlements);
  });

  it("falls back to the license's stored entitlements when none are supplied", () => {
    const r = evaluateEnforcement(license(), activeActivation, null, NOW);
    expect(r.entitlements).toEqual({ pro: true, seats: 10 });
  });

  it("carries entitlements through even on a refusal (available to the caller regardless of verdict)", () => {
    const current = { pro: false };
    const r = evaluateEnforcement(license({ status: "revoked" }), activeActivation, current, NOW);
    expect(r.entitlements).toEqual(current);
  });
});

describe("isMonotonicAnchor — monotonic last-seen anchor floor (FR-014/015; US6)", () => {
  it("accepts ANY anchor when there is no floor yet (never-connected activation)", () => {
    // last_anchor_at IS NULL -> the first beat may set any signed server time as the floor.
    expect(isMonotonicAnchor(null, NOW)).toBe(true);
    expect(isMonotonicAnchor(null, NOW - 10_000)).toBe(true);
  });

  it("accepts an EQUAL anchor (an idempotent re-stamp at the same signed instant)", () => {
    expect(isMonotonicAnchor(NOW, NOW)).toBe(true);
  });

  it("accepts a STRICTLY-NEWER anchor (the normal advance)", () => {
    expect(isMonotonicAnchor(NOW, NOW + 1)).toBe(true);
    expect(isMonotonicAnchor(NOW, NOW + 86_400)).toBe(true);
  });

  it("REJECTS an anchor preceding the floor (a clock rollback -> the floor is never lowered)", () => {
    expect(isMonotonicAnchor(NOW, NOW - 1)).toBe(false);
    expect(isMonotonicAnchor(NOW, NOW - 100_000)).toBe(false);
  });

  it("mirrors the guarded advanceAnchor SQL predicate exactly (same rule, no drift)", () => {
    // The SQL guard is `last_anchor_at IS NULL OR last_anchor_at <= to_timestamp(candidate)`, i.e. accept iff
    // floor is null OR candidate >= floor — identical to this predicate for every floor/candidate pairing.
    for (const floor of [null, NOW - 1, NOW, NOW + 1] as (number | null)[]) {
      for (const cand of [NOW - 1, NOW, NOW + 1]) {
        const sqlWouldAdvance = floor === null || floor <= cand;
        expect(isMonotonicAnchor(floor, cand)).toBe(sqlWouldAdvance);
      }
    }
  });
});
