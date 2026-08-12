// T028 [US2] (FR-006, SC-002/004/010): unit coverage of the PURE highest-priority-wins core
// (`resolveEntitlementDecision`) — the deterministic conflict-resolution + fail-closed heart of evaluate.ts,
// exercised without a DB (the plan's "pure where possible" tier). Proves:
//   - highest-priority-wins produces exactly ONE effect per entitlement (AD-005, INV-5);
//   - a stable `(rule_key, version)` tiebreak decides equal priorities reproducibly, regardless of input order;
//   - the matched-but-not-applied rules are recorded as `consideredRules` (SC-010);
//   - fail-closed: a per-rule error/absent-field skips that rule (base or the next match stands, INV-7);
//   - the trusted effect clamp bounds the applied value (adjust_limit <= authored max, SC-004).
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EntitlementBounds } from "../effect.js";
import { resolveEntitlementDecision, type CandidateRule } from "../evaluate.js";

/** A default in-bounds authored bound: an authored ceiling, rule-eligible boolean, two numeric tiers. */
const BOUNDS: EntitlementBounds = {
  ruleMax: 50_000,
  ruleEligible: true,
  ruleTiers: [100, 250],
  absoluteMax: 1_000_000_000,
};

/** A matching-context probe: usage.api_calls is high, entitlement.value is the base. */
const CONTEXT: Record<string, unknown> = {
  now: 1_700_000_000_000,
  usage: { api_calls: 20_000 },
  entitlement: { key: "api_calls", value: 100 },
};

/** Build a candidate rule with in-bounds defaults (always-true condition + a bounded adjust_limit effect). */
function rule(over: Partial<CandidateRule> = {}): CandidateRule {
  return {
    id: randomUUID(),
    ruleKey: "rule-a",
    version: 1,
    priority: 0,
    condition: { "==": [1, 1] },
    effect: { kind: "adjust_limit", target: "api_calls", value: 5_000 },
    ...over,
  };
}

describe("resolveEntitlementDecision — highest-priority-wins ONE effect (FR-006, INV-5)", () => {
  it("applies the highest-priority matching rule and records the rest as considered (SC-010)", () => {
    const high = rule({ ruleKey: "high", priority: 20, effect: { kind: "adjust_limit", target: "api_calls", value: 40_000 } });
    const low = rule({ ruleKey: "low", priority: 10, effect: { kind: "adjust_limit", target: "api_calls", value: 3_000 } });

    const r = resolveEntitlementDecision([low, high], CONTEXT, BOUNDS, 100);

    expect(r.enforced).toBe(true);
    expect(r.decision).toBe(40_000); // the priority-20 rule's effect, not the priority-10 one
    expect(r.firedRule).toEqual({ rule_id: high.id, rule_key: "high", version: 1 });
    // The lower-priority matching rule is recorded considered-but-not-applied (exactly one effect fired).
    expect(r.consideredRules).toEqual([{ rule_id: low.id, rule_key: "low", version: 1 }]);
  });

  it("orders three matching rules by priority, firing the top and considering the other two in order", () => {
    const p30 = rule({ ruleKey: "p30", priority: 30, effect: { kind: "adjust_limit", target: "api_calls", value: 30_000 } });
    const p20 = rule({ ruleKey: "p20", priority: 20 });
    const p10 = rule({ ruleKey: "p10", priority: 10 });

    const r = resolveEntitlementDecision([p10, p30, p20], CONTEXT, BOUNDS, 100);

    expect(r.firedRule?.rule_key).toBe("p30");
    expect(r.decision).toBe(30_000);
    expect(r.consideredRules.map((c) => c.rule_key)).toEqual(["p20", "p10"]);
  });

  it("clamps the fired effect to the authored maximum (SC-004: an over-max value is bounded)", () => {
    const over = rule({ ruleKey: "over", priority: 5, effect: { kind: "adjust_limit", target: "api_calls", value: 9_999_999 } });
    const r = resolveEntitlementDecision([over], CONTEXT, BOUNDS, 100);
    expect(r.enforced).toBe(true);
    expect(r.decision).toBe(50_000); // clamped to ruleMax
    expect(r.firedRule?.rule_key).toBe("over");
  });

  it("allows a lift ABOVE the base plan value up to the authored max (SC-015)", () => {
    const lift = rule({ ruleKey: "lift", priority: 5, effect: { kind: "adjust_limit", target: "api_calls", value: 25_000 } });
    const r = resolveEntitlementDecision([lift], CONTEXT, BOUNDS, 100);
    expect(r.decision).toBe(25_000); // above base (100), within ruleMax (50000)
  });
});

describe("resolveEntitlementDecision — deterministic tiebreak (FR-006, INV-6)", () => {
  it("breaks an equal-priority tie by rule_key ASC, independent of input order", () => {
    const aaa = rule({ ruleKey: "aaa", priority: 10, effect: { kind: "adjust_limit", target: "api_calls", value: 11_000 } });
    const bbb = rule({ ruleKey: "bbb", priority: 10, effect: { kind: "adjust_limit", target: "api_calls", value: 22_000 } });

    const forward = resolveEntitlementDecision([aaa, bbb], CONTEXT, BOUNDS, 100);
    const reverse = resolveEntitlementDecision([bbb, aaa], CONTEXT, BOUNDS, 100);

    // "aaa" < "bbb" wins in BOTH orderings -> the tiebreak is stable + input-order independent.
    expect(forward.firedRule?.rule_key).toBe("aaa");
    expect(reverse.firedRule?.rule_key).toBe("aaa");
    expect(forward.decision).toBe(11_000);
    expect(reverse.decision).toBe(11_000);
  });

  it("breaks an equal (priority, rule_key) tie by version DESC", () => {
    const v1 = rule({ ruleKey: "same", version: 1, priority: 10, effect: { kind: "adjust_limit", target: "api_calls", value: 1_000 } });
    const v2 = rule({ ruleKey: "same", version: 2, priority: 10, effect: { kind: "adjust_limit", target: "api_calls", value: 2_000 } });
    const r = resolveEntitlementDecision([v1, v2], CONTEXT, BOUNDS, 100);
    expect(r.firedRule?.version).toBe(2);
    expect(r.decision).toBe(2_000);
  });
});

describe("resolveEntitlementDecision — fail-closed (FR-010, INV-7)", () => {
  it("skips a rule whose condition ERRORS (unguarded absent field) so a lower matching rule wins", () => {
    // The higher-priority rule probes an ABSENT field WITHOUT a has()-guard -> the evaluator throws -> the rule
    // is fail-closed EXCLUDED from the match set; the lower-priority valid rule legitimately wins (no crash).
    const broken = rule({ ruleKey: "broken", priority: 99, condition: { ">": [{ var: "usage.missing_metric" }, 1] } });
    const ok = rule({ ruleKey: "ok", priority: 1, effect: { kind: "adjust_limit", target: "api_calls", value: 7_000 } });

    let r!: ReturnType<typeof resolveEntitlementDecision>;
    expect(() => {
      r = resolveEntitlementDecision([broken, ok], CONTEXT, BOUNDS, 100);
    }).not.toThrow();

    expect(r.firedRule?.rule_key).toBe("ok");
    expect(r.decision).toBe(7_000);
    // The errored rule never matched -> it is neither fired nor considered.
    expect(r.consideredRules).toEqual([]);
  });

  it("refuses an unsafe-operator condition fail-closed (no host reachable) and falls to base", () => {
    const unsafe = rule({ ruleKey: "unsafe", priority: 50, condition: { eval: ["process"] } });
    const r = resolveEntitlementDecision([unsafe], CONTEXT, BOUNDS, 100);
    expect(r.firedRule).toBeNull();
    expect(r.decision).toBe(100); // base stands
    expect(r.enforced).toBe(false);
  });

  it("stands on the base decision when the winning rule's effect is REFUSED (bound breach)", () => {
    // No authored ceiling -> an adjust_limit effect is refused by the trusted applier -> fail-closed to base; the
    // matched-but-not-applied winner is recorded considered (it matched but did not apply, FR-006/INV-7).
    const noCeiling: EntitlementBounds = { ruleMax: null, ruleEligible: false, ruleTiers: null };
    const wins = rule({ ruleKey: "wins", priority: 10 });
    const r = resolveEntitlementDecision([wins], CONTEXT, noCeiling, 100);
    expect(r.firedRule).toBeNull();
    expect(r.decision).toBe(100); // base stands (effect refused: no_rule_max)
    expect(r.enforced).toBe(false);
    expect(r.consideredRules).toEqual([{ rule_id: wins.id, rule_key: "wins", version: 1 }]);
  });

  it("stands on the base decision when NO rule matches", () => {
    const nomatch = rule({ ruleKey: "nomatch", priority: 10, condition: { ">": [{ var: "usage.api_calls" }, 1_000_000] } });
    const r = resolveEntitlementDecision([nomatch], CONTEXT, BOUNDS, 100);
    expect(r.firedRule).toBeNull();
    expect(r.decision).toBe(100);
    expect(r.consideredRules).toEqual([]);
  });
});

describe("resolveEntitlementDecision — closed effect kinds (FR-003)", () => {
  it("toggles a boolean ONLY where rule-eligible", () => {
    const toggle = rule({ ruleKey: "toggle", priority: 5, effect: { kind: "toggle_boolean", target: "export", value: true } });
    const on = resolveEntitlementDecision([toggle], CONTEXT, { ruleEligible: true }, false);
    expect(on.decision).toBe(true);
    expect(on.enforced).toBe(true);

    const off = resolveEntitlementDecision([toggle], CONTEXT, { ruleEligible: false }, false);
    expect(off.decision).toBe(false); // not rule-eligible -> refused -> base stands
    expect(off.firedRule).toBeNull();
  });

  it("selects only a plan-defined numeric tier", () => {
    const pick = rule({ ruleKey: "pick", priority: 5, effect: { kind: "select_tier", target: "tier", value: 250 } });
    const r = resolveEntitlementDecision([pick], CONTEXT, { ruleTiers: [100, 250] }, 10);
    expect(r.decision).toBe(250);

    const bad = rule({ ruleKey: "bad", priority: 5, effect: { kind: "select_tier", target: "tier", value: 999 } });
    const r2 = resolveEntitlementDecision([bad], CONTEXT, { ruleTiers: [100, 250] }, 10);
    expect(r2.firedRule).toBeNull(); // tier not defined -> refused -> base stands
    expect(r2.decision).toBe(10);
  });
});
