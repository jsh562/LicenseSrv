// Shared catalog validation + the typed error the routes map to an HTTP status (FR-005/008, AD-005).
// The value↔type agreement (a per-plan value must match its entitlement's type) is the one invariant a
// single-table DB CHECK can't express — a CHECK can't join `entitlement` — so it lives here (HINT-002).
import { z } from "zod";

/** A catalog error carrying the HTTP status + machine code the route surfaces as `{code,message}`. */
export class CatalogError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/** A stable catalog key: a lowercase slug (letters/digits, with `-`/`_` inside), 2–64 chars. */
export const catalogKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, "key must be a lowercase slug (a-z, 0-9, - or _)");

export const entitlementTypeSchema = z.enum(["boolean", "integer_limit"]);
export type EntitlementType = z.infer<typeof entitlementTypeSchema>;

/** A list `?status=` filter. `all` returns both; default (undefined) means active-only. */
export const statusFilterSchema = z.enum(["active", "archived", "all"]).optional();

/**
 * Validate a per-plan value against its entitlement's declared type and return the typed columns.
 * boolean → a real boolean; integer_limit → a non-negative integer. A mismatch is a 400 (FR-008/SC-005).
 */
export function assertValueMatchesType(
  type: EntitlementType,
  value: unknown,
): { boolValue: boolean | null; intValue: number | null } {
  if (type === "boolean") {
    if (typeof value !== "boolean") {
      throw new CatalogError("validation_error", 400, "value must be a boolean for a boolean entitlement");
    }
    return { boolValue: value, intValue: null };
  }
  // integer_limit
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CatalogError(
      "validation_error",
      400,
      "value must be a non-negative integer for an integer-limit entitlement",
    );
  }
  return { boolValue: null, intValue: value };
}

/** Map a Postgres unique-violation (23505) to a typed duplicate-key CatalogError; rethrow otherwise. */
export function asDuplicateKey(e: unknown, message: string): never {
  if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
    throw new CatalogError("duplicate_key", 409, message);
  }
  throw e;
}
