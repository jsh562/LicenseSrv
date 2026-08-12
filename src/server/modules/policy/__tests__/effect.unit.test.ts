// [Foundational] T010 (FR-003/007): closed typed effect applier unit tests. Proves the load-bearing effect
// bound ADR-0014 requires: adjust_limit is CLAMPED to the authored `rule_max` ceiling (and any absolute cap) —
// a rule may lift above base but never above the authored maximum (SC-004/015); toggle_boolean applies ONLY
// where the entitlement is `rule_eligible`; select_tier resolves ONLY to a plan-defined NUMERIC `rule_tiers` value. An
// out-of-bounds / wrong-typed effect fails closed (`applied:false`). Pure — no DB.
import { describe, expect, it } from "vitest";

import { applyEffect, type PolicyEffect } from "../effect.js";

describe("applyEffect — adjust_limit clamp to authored rule_max (FR-007, SC-004/015)", () => {
  const effect = (value: unknown): PolicyEffect => ({ kind: "adjust_limit", target: "api_calls", value });

  it("applies a value at/below the authored maximum unchanged (lift above base allowed)", () => {
    const r = applyEffect(effect(50_000), { ruleMax: 50_000 });
    expect(r).toEqual({ applied: true, kind: "adjust_limit", target: "api_calls", value: 50_000, clamped: false });
  });

  it("CLAMPS a value above the authored maximum down to the ceiling (never grants more)", () => {
    const r = applyEffect(effect(999_999), { ruleMax: 50_000 });
    expect(r).toEqual({ applied: true, kind: "adjust_limit", target: "api_calls", value: 50_000, clamped: true });
  });

  it("clamps to the tighter of rule_max and the absolute per-entitlement cap (FR-021)", () => {
    expect(applyEffect(effect(80_000), { ruleMax: 100_000, absoluteMax: 60_000 })).toMatchObject({
      applied: true,
      value: 60_000,
      clamped: true,
    });
  });

  it("floors a negative requested value at 0", () => {
    expect(applyEffect(effect(-10), { ruleMax: 100 })).toMatchObject({ applied: true, value: 0, clamped: true });
  });

  it("refuses when no authored rule_max exists (fail closed to base)", () => {
    expect(applyEffect(effect(10), {})).toEqual({
      applied: false,
      kind: "adjust_limit",
      target: "api_calls",
      reason: "no_rule_max",
    });
    expect(applyEffect(effect(10), { ruleMax: null })).toMatchObject({ applied: false, reason: "no_rule_max" });
  });

  it("REFUSES when only an absolute cap exists but NO authored rule_max (FR-007/INV-4/SC-015)", () => {
    // The absolute cap is the catalog-layer governance bound on what rule_max may be SET to (FR-021) — it is
    // NOT an applier fallback ceiling. Without an authored rule_max the adjust_limit is refused (base stands),
    // it does NOT silently apply clamped to the global absolute cap.
    expect(applyEffect(effect(10), { absoluteMax: 1_000_000_000 })).toEqual({
      applied: false,
      kind: "adjust_limit",
      target: "api_calls",
      reason: "no_rule_max",
    });
    expect(applyEffect(effect(10), { ruleMax: null, absoluteMax: 1_000_000_000 })).toMatchObject({
      applied: false,
      reason: "no_rule_max",
    });
  });

  it("with a PRESENT rule_max clamps to min(rule_max, absoluteMax) — the tighter bound wins both ways", () => {
    // rule_max tighter than the absolute cap.
    expect(applyEffect(effect(80_000), { ruleMax: 50_000, absoluteMax: 1_000_000_000 })).toMatchObject({
      applied: true,
      value: 50_000,
      clamped: true,
    });
    // absolute cap tighter than rule_max (defense-in-depth).
    expect(applyEffect(effect(80_000), { ruleMax: 100_000, absoluteMax: 70_000 })).toMatchObject({
      applied: true,
      value: 70_000,
      clamped: true,
    });
  });

  it("refuses a non-numeric adjust_limit value", () => {
    expect(applyEffect(effect("50000"), { ruleMax: 100_000 })).toMatchObject({
      applied: false,
      reason: "invalid_value",
    });
  });
});

describe("applyEffect — toggle_boolean gated on rule_eligible (FR-003)", () => {
  const effect = (value: unknown): PolicyEffect => ({ kind: "toggle_boolean", target: "premium", value });

  it("applies to either reachable state when the entitlement is rule-eligible", () => {
    expect(applyEffect(effect(true), { ruleEligible: true })).toMatchObject({ applied: true, value: true });
    expect(applyEffect(effect(false), { ruleEligible: true })).toMatchObject({ applied: true, value: false });
  });

  it("refuses when the entitlement is NOT rule-eligible", () => {
    expect(applyEffect(effect(true), { ruleEligible: false })).toMatchObject({
      applied: false,
      reason: "not_rule_eligible",
    });
    expect(applyEffect(effect(true), {})).toMatchObject({ applied: false, reason: "not_rule_eligible" });
  });

  it("refuses a non-boolean toggle value", () => {
    expect(applyEffect(effect(1), { ruleEligible: true })).toMatchObject({ applied: false, reason: "invalid_value" });
  });
});

describe("applyEffect — select_tier gated on plan-defined NUMERIC rule_tiers (FR-003, SC-014/015)", () => {
  const effect = (value: unknown): PolicyEffect => ({ kind: "select_tier", target: "overage", value });

  it("resolves to a plan-defined numeric tier (flows through the token's numeric branch)", () => {
    expect(applyEffect(effect(250), { ruleTiers: [100, 250, 500] })).toMatchObject({
      applied: true,
      value: 250,
    });
  });

  it("refuses a tier NOT present in rule_tiers", () => {
    expect(applyEffect(effect(999), { ruleTiers: [100, 250] })).toMatchObject({
      applied: false,
      reason: "tier_not_defined",
    });
  });

  it("refuses a non-numeric tier value (a string can never be embedded in the signed token, SC-014)", () => {
    expect(applyEffect(effect("250"), { ruleTiers: [100, 250] })).toMatchObject({
      applied: false,
      reason: "invalid_value",
    });
  });

  it("refuses when no tiers are defined", () => {
    expect(applyEffect(effect(100), {})).toMatchObject({ applied: false, reason: "tier_not_defined" });
    expect(applyEffect(effect(100), { ruleTiers: null })).toMatchObject({
      applied: false,
      reason: "tier_not_defined",
    });
  });
});

describe("applyEffect — closed union (defense-in-depth)", () => {
  it("refuses an unknown effect kind (fail closed, not a throw)", () => {
    const rogue = { kind: "delete_license", target: "x", value: 1 } as unknown as PolicyEffect;
    expect(applyEffect(rogue, { ruleMax: 100 })).toMatchObject({ applied: false, reason: "unknown_kind" });
  });
});
