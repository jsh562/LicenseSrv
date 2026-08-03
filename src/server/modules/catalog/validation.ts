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

/**
 * The COUNTER-ONLY MVP aggregation set for a metered entitlement (E016 FR-008): SUM of quantities, COUNT of
 * events, UNIQUE_COUNT of distinct dimension values. Gauge/peak (MAX concurrent, LATEST snapshot) are a
 * documented extension — deliberately NOT admitted here (they need point-in-time semantics that break additive
 * reversal), so a gauge/peak `aggregation` is a `validation_error` at authoring time.
 */
export const meteredAggregationSchema = z.enum(["sum", "count", "unique_count"]);
export type MeteredAggregation = z.infer<typeof meteredAggregationSchema>;

/** The catalog `entitlement.type` kind, extended with the additive E016 `metered` third kind (FR-008). */
export type EntitlementKind = EntitlementType | "metered";

/** A validated metered definition (the DB `entitlement_metered_shape` CHECK requires aggregation + unit set). */
export interface MeteredDefinition {
  aggregation: MeteredAggregation;
  unit: string;
  allowance: number | null;
}

/** A list `?status=` filter. `all` returns both; default (undefined) means active-only. */
export const statusFilterSchema = z.enum(["active", "archived", "all"]).optional();

/**
 * Validate a metered entitlement's authoring shape (E016 FR-008, AD-005) and return its typed columns.
 * COUNTER-ONLY: the `aggregation` MUST be one of sum|count|unique_count — a gauge/peak (or any other) value is a
 * 400 `validation_error` (gauge/peak is a documented extension, not the MVP). A `unit` is REQUIRED (a non-empty
 * label). An `allowance` is OPTIONAL (signal-only quota, FR-014): absent/null means no quota, otherwise it MUST
 * be a finite, non-negative number. These mirror the DB CHECKs (`entitlement_aggregation_valid`,
 * `entitlement_allowance_nonneg`, `entitlement_metered_shape`) so a malformed definition is refused at the edge.
 */
export function assertMeteredShape(input: {
  aggregation?: unknown;
  unit?: unknown;
  allowance?: unknown;
}): MeteredDefinition {
  const agg = meteredAggregationSchema.safeParse(input.aggregation);
  if (!agg.success) {
    throw new CatalogError(
      "validation_error",
      400,
      "a metered entitlement requires a counter aggregation of sum, count, or unique_count",
    );
  }
  if (typeof input.unit !== "string" || input.unit.trim().length === 0) {
    throw new CatalogError("validation_error", 400, "a metered entitlement requires a non-empty unit");
  }
  let allowance: number | null = null;
  if (input.allowance !== undefined && input.allowance !== null) {
    if (typeof input.allowance !== "number" || !Number.isFinite(input.allowance) || input.allowance < 0) {
      throw new CatalogError("validation_error", 400, "allowance must be a non-negative number when supplied");
    }
    allowance = input.allowance;
  }
  return { aggregation: agg.data, unit: input.unit.trim(), allowance };
}

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
