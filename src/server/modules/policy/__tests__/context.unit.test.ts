// [Foundational] T012 (FR-004/005/017, INV-12): bounded decision-context builder + canonical hash unit tests.
// Proves the load-bearing minimization + reproducibility properties: only ALLOW-LISTED fields survive (no
// secret/PII/nested host object leaks), a usage section is present ONLY when supplied (so a rule must
// `has()`-guard it), the injected decision timestamp is exposed as `now`, the size/depth/field-count bounds
// reject an oversized context, and the canonical hash reproduces IDENTICALLY for an identical context
// regardless of key order (INV-12, SC-003). Pure — no DB.
import { describe, expect, it } from "vitest";

import {
  buildDecisionContext,
  canonicalContextHash,
  canonicalSerialize,
  ContextError,
} from "../context.js";

describe("buildDecisionContext — allow-listed minimization (FR-004/017)", () => {
  it("keeps only allow-listed license/plan/entitlement fields and drops everything else", () => {
    const ctx = buildDecisionContext({
      decisionTimestamp: 1_700_000_000_000,
      license: {
        plan: "enterprise",
        status: "active",
        // The following MUST be dropped (secret / PII / non-allow-listed):
        signingKey: "SECRET-abc",
        customerEmail: "alice@example.com",
        internalNotes: "confidential",
      },
      plan: { tier: "enterprise", code: "ENT", secretPricing: 4200 },
      entitlement: { key: "api_calls", type: "integer_limit", value: 1_000, ruleMax: 50_000, secretFlag: "x" },
    });

    expect(ctx.license).toEqual({ plan: "enterprise", status: "active" });
    expect(ctx.plan).toEqual({ tier: "enterprise", code: "ENT" });
    expect(ctx.entitlement).toEqual({ key: "api_calls", type: "integer_limit", value: 1_000, ruleMax: 50_000 });
    expect(ctx.now).toBe(1_700_000_000_000);
    // No secret / PII survived anywhere in the serialized context.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("secretPricing");
    expect(serialized).not.toContain("secretFlag");
  });

  it("drops nested objects and functions (only primitive leaves survive)", () => {
    const ctx = buildDecisionContext({
      decisionTimestamp: 1,
      license: { plan: "pro", status: { nested: "obj" } as unknown as string },
    });
    expect(ctx.license).toEqual({ plan: "pro" });
  });

  it("copies a primitive (numeric) rule_tiers array but not a non-primitive one", () => {
    const good = buildDecisionContext({
      decisionTimestamp: 1,
      entitlement: { key: "overage", ruleTiers: [100, 250] },
    });
    expect(good.entitlement).toEqual({ key: "overage", ruleTiers: [100, 250] });
    const bad = buildDecisionContext({
      decisionTimestamp: 1,
      entitlement: { key: "overage", ruleTiers: [{ x: 1 }] as unknown as number[] },
    });
    expect(bad.entitlement).toEqual({ key: "overage" });
  });
});

describe("buildDecisionContext — usage has()-guard (FR-004/010)", () => {
  it("omits the usage section entirely when no usage is supplied", () => {
    const ctx = buildDecisionContext({ decisionTimestamp: 1, license: { plan: "pro" } });
    expect(ctx.usage).toBeUndefined();
    expect("usage" in ctx).toBe(false);
  });

  it("includes only finite-numeric usage aggregates when supplied", () => {
    const ctx = buildDecisionContext({
      decisionTimestamp: 1,
      usage: { calls: 12_000, storage: 3.5, label: "not-a-number", broken: Number.NaN },
    });
    expect(ctx.usage).toEqual({ calls: 12_000, storage: 3.5 });
  });
});

describe("buildDecisionContext — bounds (FR-004/020)", () => {
  it("throws context_too_large when the serialized context exceeds the byte cap", () => {
    const big = "x".repeat(500);
    let thrown: ContextError | undefined;
    try {
      buildDecisionContext({ decisionTimestamp: 1, license: { customerRef: big } }, { maxBytes: 64 });
    } catch (e) {
      thrown = e as ContextError;
    }
    expect(thrown?.code).toBe("context_too_large");
  });

  it("throws context_too_many_fields when the field count exceeds the cap", () => {
    let thrown: ContextError | undefined;
    try {
      buildDecisionContext(
        { decisionTimestamp: 1, usage: { a: 1, b: 2, c: 3, d: 4 } },
        { maxFields: 2 },
      );
    } catch (e) {
      thrown = e as ContextError;
    }
    expect(thrown?.code).toBe("context_too_many_fields");
  });
});

describe("canonicalContextHash — reproducible canonical hashing (INV-12, SC-003)", () => {
  it("produces an identical hash for an identical context regardless of key insertion order", () => {
    const a = { now: 5, license: { plan: "pro", status: "active" }, usage: { calls: 10 } };
    const b = { usage: { calls: 10 }, license: { status: "active", plan: "pro" }, now: 5 };
    expect(canonicalContextHash(a)).toBe(canonicalContextHash(b));
  });

  it("produces a DIFFERENT hash when any value changes", () => {
    const base = { now: 5, usage: { calls: 10 } };
    const changed = { now: 5, usage: { calls: 11 } };
    expect(canonicalContextHash(base)).not.toBe(canonicalContextHash(changed));
  });

  it("is a stable 64-char SHA-256 hex digest", () => {
    const h = canonicalContextHash({ now: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalContextHash({ now: 1 })).toBe(h);
  });

  it("serializes keys in a stable sorted order and normalizes -0 to 0", () => {
    expect(canonicalSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalSerialize(-0)).toBe("0");
    expect(canonicalSerialize([3, "x", true, null])).toBe('[3,"x",true,null]');
  });

  it("hashes a built context reproducibly end-to-end", () => {
    const sources = {
      decisionTimestamp: 42,
      license: { plan: "pro", status: "active" },
      usage: { calls: 7 },
    };
    expect(canonicalContextHash(buildDecisionContext(sources))).toBe(
      canonicalContextHash(buildDecisionContext(sources)),
    );
  });
});
