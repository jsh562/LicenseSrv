// T018 (FR-007/008): the pure value↔type validation + key slug rules — the one invariant a single-table
// DB CHECK can't express (a CHECK can't join entitlement.type), so it lives in the app layer.
import { describe, expect, it } from "vitest";

import { assertValueMatchesType, catalogKeySchema, CatalogError } from "../validation.js";

describe("assertValueMatchesType (FR-008)", () => {
  it("accepts a boolean for a boolean entitlement and stores it in bool_value", () => {
    expect(assertValueMatchesType("boolean", true)).toEqual({ boolValue: true, intValue: null });
    expect(assertValueMatchesType("boolean", false)).toEqual({ boolValue: false, intValue: null });
  });

  it("accepts a non-negative integer for an integer-limit entitlement", () => {
    expect(assertValueMatchesType("integer_limit", 0)).toEqual({ boolValue: null, intValue: 0 });
    expect(assertValueMatchesType("integer_limit", 50)).toEqual({ boolValue: null, intValue: 50 });
  });

  it("rejects a number on a boolean entitlement (400)", () => {
    expect(() => assertValueMatchesType("boolean", 1)).toThrow(CatalogError);
    try {
      assertValueMatchesType("boolean", 1);
    } catch (e) {
      expect((e as CatalogError).status).toBe(400);
    }
  });

  it("rejects a boolean, a negative, and a non-integer on an integer-limit entitlement", () => {
    expect(() => assertValueMatchesType("integer_limit", true)).toThrow(CatalogError);
    expect(() => assertValueMatchesType("integer_limit", -1)).toThrow(/non-negative/);
    expect(() => assertValueMatchesType("integer_limit", 1.5)).toThrow(/non-negative integer/);
  });
});

describe("catalogKeySchema", () => {
  it("accepts lowercase slugs and rejects bad keys", () => {
    expect(catalogKeySchema.safeParse("acme-cad").success).toBe(true);
    expect(catalogKeySchema.safeParse("max_projects").success).toBe(true);
    expect(catalogKeySchema.safeParse("a1").success).toBe(true);
    expect(catalogKeySchema.safeParse("Acme").success).toBe(false); // uppercase
    expect(catalogKeySchema.safeParse("a").success).toBe(false); // too short
    expect(catalogKeySchema.safeParse("has space").success).toBe(false);
    expect(catalogKeySchema.safeParse("-lead").success).toBe(false); // must start alnum
  });
});
