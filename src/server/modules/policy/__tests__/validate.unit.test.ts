// [Foundational] T011 (FR-002/007/009): author-time rule-validation unit tests. Proves the REJECT-BEFORE-PERSIST
// guarantee ADR-0014 requires: every distinct 400 code path (`invalid_condition` / `unsafe_operator` /
// `condition_too_large` / `effect_out_of_bounds`) is exercised, plus a well-formed, safe, in-bounds rule that
// passes. Pure — no DB, no eval. `validateRule` throws a `PolicyError` carrying the distinct `code` on failure
// and returns normally for a valid rule.
import { describe, expect, it } from "vitest";

import { PolicyError } from "../index.js";
import { validateRule, type ValidateRuleInput } from "../validate.js";

/** Run `validateRule` and return the thrown PolicyError's code (or `"__none__"` when it did not throw). */
function codeOf(input: ValidateRuleInput, opts?: Parameters<typeof validateRule>[1]): string {
  try {
    validateRule(input, opts);
    return "__none__";
  } catch (err) {
    if (err instanceof PolicyError) return err.code;
    throw err;
  }
}

const validEffect = { kind: "adjust_limit", target: "api_calls", value: 5_000 } as const;
const looseBounds = { ruleMax: 10_000 };

describe("validateRule — a well-formed, safe, in-bounds rule passes", () => {
  it("accepts an allow-listed condition + an in-bounds adjust_limit effect (SC-001)", () => {
    const input: ValidateRuleInput = {
      condition: {
        and: [
          { ">": [{ var: "usage.api_calls" }, 10_000] },
          { "==": [{ var: "entitlement.type" }, "metered"] },
          { has: "usage.api_calls" },
        ],
      },
      effect: validEffect,
      bounds: looseBounds,
    };
    expect(() => validateRule(input)).not.toThrow();
    expect(codeOf(input)).toBe("__none__");
  });

  it("accepts a toggle_boolean on a rule-eligible entitlement and a select_tier within plan tiers", () => {
    expect(
      codeOf({
        condition: { "==": [{ var: "license.status" }, "active"] },
        effect: { kind: "toggle_boolean", target: "premium", value: true },
        bounds: { ruleEligible: true },
      }),
    ).toBe("__none__");
    expect(
      codeOf({
        condition: { "<": [{ var: "now" }, 9_999_999_999_999] },
        effect: { kind: "select_tier", target: "overage", value: 250 },
        bounds: { ruleTiers: [100, 250] },
      }),
    ).toBe("__none__");
  });
});

describe("validateRule — invalid_condition (structural shape + context-field type-check)", () => {
  it("refuses a non-object (free-text) condition", () => {
    expect(codeOf({ condition: "usage > 10000", effect: validEffect, bounds: looseBounds })).toBe(
      "invalid_condition",
    );
    expect(codeOf({ condition: [1, 2, 3], effect: validEffect, bounds: looseBounds })).toBe("invalid_condition");
  });

  it("refuses a multi-key (non-single-operator) node", () => {
    expect(
      codeOf({ condition: { "==": [1, 1], ">": [2, 1] }, effect: validEffect, bounds: looseBounds }),
    ).toBe("invalid_condition");
  });

  it("refuses a var/has path referencing a field OUTSIDE the allow-listed context schema", () => {
    expect(
      codeOf({ condition: { "==": [{ var: "secret.signingKey" }, 1] }, effect: validEffect, bounds: looseBounds }),
    ).toBe("invalid_condition");
    expect(
      codeOf({ condition: { "==": [{ var: "license.email" }, "x"] }, effect: validEffect, bounds: looseBounds }),
    ).toBe("invalid_condition");
  });

  it("refuses a malformed var path (non-string / empty)", () => {
    expect(codeOf({ condition: { var: 123 }, effect: validEffect, bounds: looseBounds })).toBe(
      "invalid_condition",
    );
  });
});

describe("validateRule — unsafe_operator (the safety-lint boundary)", () => {
  it("refuses an operator NOT on the fixed allow-list", () => {
    expect(codeOf({ condition: { eval: ["process.exit(1)"] }, effect: validEffect, bounds: looseBounds })).toBe(
      "unsafe_operator",
    );
    expect(codeOf({ condition: { require: ["fs"] }, effect: validEffect, bounds: looseBounds })).toBe(
      "unsafe_operator",
    );
  });

  it("refuses a prototype-polluting field path segment", () => {
    expect(
      codeOf({ condition: { var: "entitlement.__proto__" }, effect: validEffect, bounds: looseBounds }),
    ).toBe("unsafe_operator");
    expect(
      codeOf({ condition: { "==": [{ var: "constructor" }, 1] }, effect: validEffect, bounds: looseBounds }),
    ).toBe("unsafe_operator");
  });
});

describe("validateRule — condition_too_large (resource bounds)", () => {
  it("refuses a condition exceeding the serialized byte cap", () => {
    const big = { "==": [{ var: "usage.api_calls" }, "x".repeat(500)] };
    expect(codeOf({ condition: big, effect: validEffect, bounds: looseBounds }, { maxBytes: 64 })).toBe(
      "condition_too_large",
    );
  });

  it("refuses a condition exceeding the AST-depth cap", () => {
    // Nest `!` operators past a small depth cap.
    let nested: unknown = { var: "now" };
    for (let i = 0; i < 10; i++) nested = { "!": [nested] };
    expect(codeOf({ condition: nested as object, effect: validEffect, bounds: looseBounds }, { maxDepth: 4 })).toBe(
      "condition_too_large",
    );
  });

  it("refuses a condition exceeding the complexity (node-count) budget", () => {
    const many = { and: Array.from({ length: 20 }, () => ({ "==": [1, 1] })) };
    expect(codeOf({ condition: many, effect: validEffect, bounds: looseBounds }, { maxComplexity: 8 })).toBe(
      "condition_too_large",
    );
  });
});

describe("validateRule — effect_out_of_bounds (the authored-bound check, reject before persist)", () => {
  const okCondition = { "==": [1, 1] };

  it("refuses an adjust_limit above the authored maximum (a static literal is refused, not clamped)", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "adjust_limit", target: "api_calls", value: 999_999 },
        bounds: { ruleMax: 50_000 },
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses an adjust_limit when the entitlement has no authored rule_max", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "adjust_limit", target: "api_calls", value: 10 },
        bounds: {},
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses a toggle_boolean on a NON-rule-eligible entitlement", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "toggle_boolean", target: "premium", value: true },
        bounds: { ruleEligible: false },
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses a select_tier NOT in the plan-defined tiers", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "select_tier", target: "overage", value: 999 },
        bounds: { ruleTiers: [100, 250] },
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses a NON-NUMERIC select_tier value at author time (Principle I / SC-014)", () => {
    // A string tier could never be embedded in the signed `Record<string, boolean|number>` snapshot, so a
    // select_tier is constrained to a finite number end-to-end and a string value is rejected before persist.
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "select_tier", target: "overage", value: "250" },
        bounds: { ruleTiers: [100, 250] },
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses a select_tier whose plan-defined rule_tiers are non-numeric (Principle I / SC-014)", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "select_tier", target: "overage", value: 250 },
        bounds: { ruleTiers: ["gold", "silver"] as unknown as number[] },
      }),
    ).toBe("effect_out_of_bounds");
  });

  it("refuses a malformed effect descriptor (bad shape / unknown kind / missing target)", () => {
    expect(codeOf({ condition: okCondition, effect: "grant_all", bounds: looseBounds })).toBe(
      "effect_out_of_bounds",
    );
    expect(
      codeOf({ condition: okCondition, effect: { kind: "delete_license", target: "x", value: 1 }, bounds: looseBounds }),
    ).toBe("effect_out_of_bounds");
    expect(
      codeOf({ condition: okCondition, effect: { kind: "adjust_limit", target: "", value: 1 }, bounds: looseBounds }),
    ).toBe("effect_out_of_bounds");
  });

  it("clamps at the tighter absolute cap — a value above it is refused at author time (FR-021)", () => {
    expect(
      codeOf({
        condition: okCondition,
        effect: { kind: "adjust_limit", target: "api_calls", value: 80_000 },
        bounds: { ruleMax: 100_000, absoluteMax: 60_000 },
      }),
    ).toBe("effect_out_of_bounds");
  });
});
