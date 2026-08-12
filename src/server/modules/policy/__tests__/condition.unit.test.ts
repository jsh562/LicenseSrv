// [Foundational] T009 (FR-005/009): sandboxed allow-listed JSONLogic-subset evaluator unit tests. Proves the
// load-bearing sandbox properties ADR-0014 requires: NO eval/vm/host escape (an unknown/unsafe operator and a
// prototype-polluting `var` path are REFUSED), DETERMINISM (same context → same result; injected clock is the
// only time source), and RESOURCE BOUNDS (timeout via an injected watchdog clock, AST-depth, complexity). Also
// covers the `has()`-guard fail-closed semantics for an absent field. Pure — no DB.
import { describe, expect, it } from "vitest";

import { ALLOWED_OPERATORS, ConditionError, evaluateCondition } from "../condition.js";

describe("evaluateCondition — allow-listed evaluation (FR-005)", () => {
  it("evaluates comparison + boolean logic over the context", () => {
    const ctx = { license: { tier: "enterprise" }, usage: { calls: 12_000 } };
    const cond = {
      and: [
        { "==": [{ var: "license.tier" }, "enterprise"] },
        { ">": [{ var: "usage.calls" }, 10_000] },
      ],
    };
    expect(evaluateCondition(cond, ctx)).toBe(true);
    expect(evaluateCondition({ ">": [{ var: "usage.calls" }, 20_000] }, ctx)).toBe(false);
  });

  it("supports bounded arithmetic, in, and if", () => {
    const ctx = { plan: { tier: "pro" }, usage: { a: 3, b: 4 } };
    expect(evaluateCondition({ ">": [{ "+": [{ var: "usage.a" }, { var: "usage.b" }] }, 5] }, ctx)).toBe(true);
    expect(evaluateCondition({ in: [{ var: "plan.tier" }, ["pro", "enterprise"]] }, ctx)).toBe(true);
    expect(evaluateCondition({ in: [{ var: "plan.tier" }, ["free"]] }, ctx)).toBe(false);
    expect(evaluateCondition({ if: [{ ">": [{ var: "usage.a" }, 10] }, true, false] }, ctx)).toBe(false);
  });

  it("injects the decision timestamp as the `now` context var (the only time source)", () => {
    const cond = { ">": [{ var: "now" }, 1_000] };
    expect(evaluateCondition(cond, {}, { now: 2_000 })).toBe(true);
    expect(evaluateCondition(cond, {}, { now: 500 })).toBe(false);
  });

  it("a bare boolean/true literal condition always matches", () => {
    expect(evaluateCondition(true, {})).toBe(true);
    expect(evaluateCondition(false, {})).toBe(false);
  });
});

describe("evaluateCondition — sandbox / no-eval / no-vm escape refused (FR-009)", () => {
  it("refuses an unknown / dangerous operator with unsafe_operator", () => {
    for (const op of ["eval", "Function", "require", "process", "import", "child_process", "fetch"]) {
      expect(() => evaluateCondition({ [op]: [1] }, {})).toThrowError(ConditionError);
      try {
        evaluateCondition({ [op]: [1] }, {});
      } catch (e) {
        expect((e as ConditionError).code).toBe("unsafe_operator");
      }
    }
  });

  it("none of the dangerous operators are on the allow-list", () => {
    for (const op of ["eval", "Function", "require", "process", "constructor", "call", "apply"]) {
      expect(ALLOWED_OPERATORS.has(op)).toBe(false);
    }
  });

  it("refuses a prototype-polluting var path (no host/global reachable)", () => {
    for (const path of ["__proto__", "constructor", "constructor.prototype", "a.__proto__.polluted"]) {
      let thrown: ConditionError | undefined;
      try {
        evaluateCondition({ var: path }, { a: {} });
      } catch (e) {
        thrown = e as ConditionError;
      }
      expect(thrown).toBeInstanceOf(ConditionError);
      expect(thrown?.code).toBe("unsafe_operator");
    }
  });

  it("refuses a multi-key (ambiguous) operator node", () => {
    expect(() => evaluateCondition({ "==": [1, 1], ">": [2, 1] }, {})).toThrowError(/single-key/);
  });
});

describe("evaluateCondition — determinism (FR-005, SC-003)", () => {
  it("returns the identical result across repeated evaluations of the same context", () => {
    const ctx = { usage: { calls: 42 }, license: { tier: "pro" } };
    const cond = { and: [{ ">": [{ var: "usage.calls" }, 40] }, { "==": [{ var: "license.tier" }, "pro"] }] };
    const runs = Array.from({ length: 5 }, () => evaluateCondition(cond, ctx));
    expect(runs).toEqual([true, true, true, true, true]);
  });
});

describe("evaluateCondition — resource bounds (FR-009)", () => {
  it("times out when the injected watchdog clock passes the deadline", () => {
    let ticks = 0;
    // First call establishes the deadline (t=0); subsequent ticks jump past a 50ms budget.
    const monotonicNow = (): number => (ticks++ === 0 ? 0 : 1_000);
    let thrown: ConditionError | undefined;
    try {
      evaluateCondition({ ">": [{ var: "now" }, 1] }, {}, { now: 5, timeoutMs: 50, monotonicNow });
    } catch (e) {
      thrown = e as ConditionError;
    }
    expect(thrown?.code).toBe("timeout");
  });

  it("does NOT time out for a fast evaluation within the budget", () => {
    const monotonicNow = (): number => 0; // clock never advances → never exceeds the deadline
    expect(evaluateCondition({ ">": [{ var: "now" }, 1] }, {}, { now: 5, timeoutMs: 50, monotonicNow })).toBe(true);
  });

  it("refuses a condition nested past the AST-depth cap", () => {
    const deep = { "!": { "!": { "!": { "!": true } } } };
    let thrown: ConditionError | undefined;
    try {
      evaluateCondition(deep, {}, { maxDepth: 2 });
    } catch (e) {
      thrown = e as ConditionError;
    }
    expect(thrown?.code).toBe("max_depth_exceeded");
  });

  it("refuses a condition exceeding the complexity budget", () => {
    const wide = { and: [true, true, true, true, true, true] };
    let thrown: ConditionError | undefined;
    try {
      evaluateCondition(wide, {}, { maxComplexity: 3 });
    } catch (e) {
      thrown = e as ConditionError;
    }
    expect(thrown?.code).toBe("max_complexity_exceeded");
  });

  it("refuses a non-finite (divide-by-zero) arithmetic result", () => {
    let thrown: ConditionError | undefined;
    try {
      evaluateCondition({ ">": [{ "/": [1, 0] }, 0] }, {});
    } catch (e) {
      thrown = e as ConditionError;
    }
    expect(thrown?.code).toBe("arithmetic_error");
  });
});

describe("evaluateCondition — has()-guard + fail-closed missing field (FR-004/010)", () => {
  it("throws missing_field on an UNGUARDED absent-field access (rule fails closed)", () => {
    let thrown: ConditionError | undefined;
    try {
      evaluateCondition({ ">": [{ var: "usage.calls" }, 10] }, { license: { tier: "pro" } });
    } catch (e) {
      thrown = e as ConditionError;
    }
    expect(thrown?.code).toBe("missing_field");
  });

  it("a has()-guard short-circuits so the guarded var is never accessed when absent", () => {
    const cond = { and: [{ has: "usage.calls" }, { ">": [{ var: "usage.calls" }, 10] }] };
    // usage.calls absent → has() is false → and short-circuits → no throw, no match.
    expect(evaluateCondition(cond, { license: { tier: "pro" } })).toBe(false);
    // usage.calls present → guard passes → the comparison runs.
    expect(evaluateCondition(cond, { usage: { calls: 25 } })).toBe(true);
  });

  it("a var default supplies a value for an absent field without throwing", () => {
    expect(evaluateCondition({ ">": [{ var: ["usage.calls", 0] }, -1] }, {})).toBe(true);
  });
});
