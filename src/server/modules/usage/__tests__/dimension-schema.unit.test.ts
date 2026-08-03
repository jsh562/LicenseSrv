// [Foundational] (FR-016; HINT-002/HINT-005): dimension allow-list + per-aggregation quantity guard unit
// tests. Exercises the bounded-key / scalar-only / size-cap allow-list (a violation → validation_error,
// never a silent drop, SC-013) and the PINNED quantity shape per aggregation (SUM any finite signed; COUNT
// non-zero integer; UNIQUE_COUNT positive integer). Pure unit tests — no DB.
import { describe, expect, it } from "vitest";

import {
  MAX_DIMENSION_KEYS,
  MAX_DIMENSION_VALUE_LENGTH,
  validateDimensions,
  validateQuantity,
} from "../dimension-schema.js";

describe("validateDimensions (allow-list; FR-016/SC-013)", () => {
  it("treats absent / null dimensions as an empty map (dimensions are optional)", () => {
    expect(validateDimensions(undefined)).toEqual({ ok: true, dimensions: {} });
    expect(validateDimensions(null)).toEqual({ ok: true, dimensions: {} });
  });

  it("accepts a bounded map of scalar values (string / number / boolean)", () => {
    const res = validateDimensions({ region: "eu-west-1", jobType: "render", count: 3, retry: true });
    expect(res).toEqual({
      ok: true,
      dimensions: { region: "eu-west-1", jobType: "render", count: 3, retry: true },
    });
  });

  it("rejects a non-object (array or scalar) as validation_error", () => {
    expect(validateDimensions([1, 2, 3]).ok).toBe(false);
    expect(validateDimensions("nope").ok).toBe(false);
    expect(validateDimensions(42).ok).toBe(false);
  });

  it("rejects a disallowed key shape (never silently drops it)", () => {
    const res = validateDimensions({ "bad key!": "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/disallowed dimension key/);
  });

  it("rejects an over-long key", () => {
    const longKey = "k".repeat(65);
    expect(validateDimensions({ [longKey]: "x" }).ok).toBe(false);
  });

  it("rejects a non-scalar value (nested object, array, or null)", () => {
    expect(validateDimensions({ nested: { a: 1 } }).ok).toBe(false);
    expect(validateDimensions({ list: [1, 2] }).ok).toBe(false);
    expect(validateDimensions({ nul: null }).ok).toBe(false);
  });

  it("rejects a non-finite number value", () => {
    expect(validateDimensions({ x: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateDimensions({ x: Number.NaN }).ok).toBe(false);
  });

  it("rejects an over-cap string value (> the size cap)", () => {
    const big = "a".repeat(MAX_DIMENSION_VALUE_LENGTH + 1);
    expect(validateDimensions({ blob: big }).ok).toBe(false);
    // exactly at the cap is allowed
    const atCap = "a".repeat(MAX_DIMENSION_VALUE_LENGTH);
    expect(validateDimensions({ blob: atCap }).ok).toBe(true);
  });

  it("rejects a map with more than the allowed number of keys", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i <= MAX_DIMENSION_KEYS; i++) many[`k${i}`] = i;
    expect(validateDimensions(many).ok).toBe(false);
  });
});

describe("validateQuantity (per-aggregation guard; HINT-002)", () => {
  it("SUM accepts any finite signed numeric (positive, negative reversal, zero, fractional)", () => {
    expect(validateQuantity("sum", 1200)).toEqual({ ok: true, quantity: 1200 });
    expect(validateQuantity("sum", -200)).toEqual({ ok: true, quantity: -200 });
    expect(validateQuantity("sum", 0)).toEqual({ ok: true, quantity: 0 });
    expect(validateQuantity("sum", 1.5)).toEqual({ ok: true, quantity: 1.5 });
  });

  it("SUM rejects a non-finite / non-number quantity", () => {
    expect(validateQuantity("sum", Number.NaN).ok).toBe(false);
    expect(validateQuantity("sum", Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateQuantity("sum", "5" as unknown).ok).toBe(false);
  });

  it("COUNT accepts a non-zero integer (+1 and a -1 reversal) and rejects zero / non-integer", () => {
    expect(validateQuantity("count", 1)).toEqual({ ok: true, quantity: 1 });
    expect(validateQuantity("count", -1)).toEqual({ ok: true, quantity: -1 });
    expect(validateQuantity("count", 0).ok).toBe(false);
    expect(validateQuantity("count", 2.5).ok).toBe(false);
  });

  it("UNIQUE_COUNT accepts a positive integer and rejects zero / negative / non-integer", () => {
    expect(validateQuantity("unique_count", 1)).toEqual({ ok: true, quantity: 1 });
    expect(validateQuantity("unique_count", 0).ok).toBe(false);
    expect(validateQuantity("unique_count", -1).ok).toBe(false);
    expect(validateQuantity("unique_count", 1.5).ok).toBe(false);
  });
});
