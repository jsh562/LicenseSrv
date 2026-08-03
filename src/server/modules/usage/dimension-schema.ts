// Usage-event dimension allow-list + per-aggregation quantity guard (E016, FR-016; HINT-002/HINT-005). The
// server-side schema that keeps PII out of the free-form `dimensions` map and pins the per-aggregation
// `quantity` shape so a malformed event is a PER-EVENT `validation_error` (never silently coerced, dropped,
// or stored — a bad value can therefore never corrupt an aggregate). Mirrors the E014 `payload_summary`
// allow-list: a bounded key set, scalar values only, and size caps (SC-013). Pure — no DB, cheap enough for
// the fast-ack ingest path.

/** The metered aggregation type (matches the E007 `entitlement.aggregation` CHECK). */
export type Aggregation = "sum" | "count" | "unique_count";

/** A scalar dimension value: the ONLY shapes the allow-list admits (no nested object/array, no null). */
export type DimensionValue = string | number | boolean;

/** A validated, allow-listed dimension map — minimized, non-PII (FR-016). */
export type ValidatedDimensions = Record<string, DimensionValue>;

/** The outcome of {@link validateDimensions}: either the validated map or a per-event validation reason. */
export type DimensionResult =
  | { ok: true; dimensions: ValidatedDimensions }
  | { ok: false; message: string; field?: string };

/** The outcome of {@link validateQuantity}: either the finite numeric quantity or a per-event reason. */
export type QuantityResult = { ok: true; quantity: number } | { ok: false; message: string };

// --- Bounds (the allow-list "schema") ---------------------------------------------------------------
/** Max number of dimension keys per event (matches the OpenAPI `Dimensions.maxProperties`). */
export const MAX_DIMENSION_KEYS = 16;
/** Max length of a dimension key (bounded so a key can never smuggle a large PII blob). */
export const MAX_DIMENSION_KEY_LENGTH = 64;
/** Max length of a string dimension value (matches the OpenAPI `Dimensions` string `maxLength`). */
export const MAX_DIMENSION_VALUE_LENGTH = 256;
/** Allowed key shape: a bounded slug (letters/digits/`_`/`-`/`.`) so keys are stable + non-free-form. */
const DIMENSION_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate a client-supplied `dimensions` value against the server allow-list (FR-016/HINT-005). Returns the
 * validated scalar map on success, or a per-event `validation_error` reason on the FIRST violation (never
 * silently dropping a disallowed entry, so PII cannot leak into free-form dimensions, SC-013). Rules:
 *   - absent / null → an empty map (dimensions are optional);
 *   - MUST be a plain object (not an array, not a scalar);
 *   - at most {@link MAX_DIMENSION_KEYS} keys;
 *   - each key matches the bounded slug shape + length cap;
 *   - each value is a SCALAR: a string ≤ {@link MAX_DIMENSION_VALUE_LENGTH}, a FINITE number, or a boolean —
 *     a nested object/array, a null, or a non-finite number is rejected.
 */
export function validateDimensions(input: unknown): DimensionResult {
  if (input === undefined || input === null) return { ok: true, dimensions: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "dimensions must be an object", field: "dimensions" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_DIMENSION_KEYS) {
    return {
      ok: false,
      message: `dimensions may carry at most ${MAX_DIMENSION_KEYS} keys`,
      field: "dimensions",
    };
  }
  const out: ValidatedDimensions = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_DIMENSION_KEY_LENGTH || !DIMENSION_KEY_RE.test(key)) {
      return { ok: false, message: `disallowed dimension key '${key}'`, field: `dimensions.${key}` };
    }
    if (typeof value === "string") {
      if (value.length > MAX_DIMENSION_VALUE_LENGTH) {
        return { ok: false, message: `dimension '${key}' value exceeds the size cap`, field: `dimensions.${key}` };
      }
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return { ok: false, message: `dimension '${key}' value must be a finite number`, field: `dimensions.${key}` };
      }
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      // null, nested object, array, undefined → rejected (scalar-only allow-list).
      return { ok: false, message: `dimension '${key}' value must be a scalar`, field: `dimensions.${key}` };
    }
  }
  return { ok: true, dimensions: out };
}

/**
 * Guard the per-aggregation `quantity` shape (HINT-002) so a malformed quantity is a per-event
 * `validation_error`, never coerced or dropped (it cannot corrupt an aggregate). Rules, PINNED:
 *   - SUM         → any FINITE signed numeric (a negative value is a reversal; zero is a harmless no-op);
 *   - COUNT       → a NON-ZERO INTEGER (typically +1; a -1 is a reversal that decrements the count);
 *   - UNIQUE_COUNT→ a POSITIVE INTEGER (typically +1); a reversal cannot retract a distinct value, so a
 *     negative/zero/non-integer quantity is rejected (the distinct set is monotonic within a bucket).
 * A non-number / NaN / ±Infinity quantity is rejected for every aggregation.
 */
export function validateQuantity(aggregation: Aggregation, quantity: unknown): QuantityResult {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return { ok: false, message: "quantity must be a finite number" };
  }
  switch (aggregation) {
    case "sum":
      return { ok: true, quantity };
    case "count":
      if (!Number.isInteger(quantity) || quantity === 0) {
        return { ok: false, message: "a count quantity must be a non-zero integer" };
      }
      return { ok: true, quantity };
    case "unique_count":
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return { ok: false, message: "a unique_count quantity must be a positive integer" };
      }
      return { ok: true, quantity };
    /* v8 ignore next 2 -- exhaustive switch; the Aggregation union has no other member. */
    default:
      return { ok: false, message: "unknown aggregation" };
  }
}
