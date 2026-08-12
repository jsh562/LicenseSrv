// Bounded, minimized decision-context builder + canonical hashing (E017, FR-004/005/017; ADR-0014, INV-12).
//
// buildDecisionContext assembles the READ-ONLY decision context a guarded rule sees from allow-listed E007
// entitlement / E008 license / E016 usage inputs plus an INJECTED decision timestamp (`now`) — the ONLY time
// source (FR-005). Minimization is an EXPLICIT allow-list per section (the author-time type-check target and
// the privacy boundary, FR-004/017): a field not on the allow-list is dropped, and only primitive leaves (plus
// a primitive `rule_tiers` array) are copied, so no secret, signing key, PII, or nested host object can leak.
// A usage aggregate section is included ONLY when the source is present, so a rule must `has()`-guard it
// (FR-004/010). The assembled context is BOUNDED — serialized size / JSON-depth / field-count caps (FR-004/020,
// the SAME caps a dry-run supplied context is validated against) — a breach throws a `ContextError`.
//
// canonicalContextHash computes `input_hash` over a CANONICAL serialization — stable key ordering + normalized
// value encoding — so an IDENTICAL decision context deterministically reproduces the IDENTICAL hash (INV-12,
// SC-003). It uses node:crypto's SHA-256 for a plain digest — NO signing key, no cryptographic secret (FR-018).
import { createHash } from "node:crypto";

import { z } from "zod";

/** A typed context-builder error; `code` distinguishes the bound that was breached (FR-004/020). */
export class ContextError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextError";
  }
}

/** Allow-listed E008 license claim fields (pseudonymous only — never an email/name/secret). */
export const LICENSE_FIELDS: readonly string[] = [
  "plan", "planId", "product", "productId", "status", "tier", "customerRef", "expiresAt", "seats",
];
/** Allow-listed E007 plan fields. */
export const PLAN_FIELDS: readonly string[] = ["tier", "code", "interval"];
/** Allow-listed E007 entitlement fields (the static values + authored bound a rule adjusts within). */
export const ENTITLEMENT_FIELDS: readonly string[] = [
  "key", "type", "value", "baseValue", "ruleMax", "ruleEligible", "ruleTiers",
];

/** The raw sources assembled into the bounded decision context. Any non-allow-listed field is dropped. */
export interface DecisionContextSources {
  /** The injected decision timestamp (epoch millis) — the ONLY time source, exposed as `now` (FR-005). */
  decisionTimestamp: number;
  /** E008 license claims (read-only); minimized to LICENSE_FIELDS. */
  license?: Record<string, unknown> | null;
  /** E007 plan values (read-only); minimized to PLAN_FIELDS. */
  plan?: Record<string, unknown> | null;
  /** E007 entitlement values + authored bound (read-only); minimized to ENTITLEMENT_FIELDS. */
  entitlement?: Record<string, unknown> | null;
  /** E016 usage aggregates (read-only, when available); numeric leaves only, `has()`-guarded (FR-004/010). */
  usage?: Record<string, unknown> | null;
}

/** Caps bounding the assembled (or dry-run supplied) context (FR-004/020). Omit to use generous defaults. */
export interface BuildContextOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxFields?: number;
}

/** The bounded, minimized decision context a guarded rule evaluates against. */
export interface DecisionContext {
  now: number;
  license?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  entitlement?: Record<string, unknown>;
  usage?: Record<string, number>;
}

const DEFAULT_MAX_BYTES = 16_384;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FIELDS = 128;

/** True for a value safe to copy verbatim into the minimized context: a finite number, string, or boolean. */
function isPrimitiveLeaf(v: unknown): v is number | string | boolean {
  return (
    (typeof v === "number" && Number.isFinite(v)) ||
    typeof v === "string" ||
    typeof v === "boolean"
  );
}

/** Copy ONLY the allow-listed keys whose value is a primitive leaf (or, for `rule_tiers`, a primitive array). */
function pickAllowed(
  source: Record<string, unknown> | null | undefined,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null || typeof source !== "object") return out;
  for (const key of allow) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (isPrimitiveLeaf(value)) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every(isPrimitiveLeaf)) {
      out[key] = [...value];
    }
    // Nested objects / functions / non-allow-listed shapes are dropped (minimization, no host leak).
  }
  return out;
}

/** Include ONLY finite-numeric usage aggregates (the metered read); non-numeric / nested values are dropped. */
function pickUsage(source: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (source === null || typeof source !== "object") return out;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Max JSON-nesting depth of a value (a primitive is depth 1). */
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  let max = 0;
  for (const child of children) max = Math.max(max, jsonDepth(child));
  return 1 + max;
}

/** Count primitive-leaf fields (the field-count cap dimension). */
function countLeafFields(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce<number>((acc, child) => acc + countLeafFields(child), 0);
}

/**
 * Build the bounded, minimized decision context from allow-listed sources plus the injected timestamp. A
 * non-allow-listed field (incl. any secret/PII) is dropped; a usage section is present only when supplied so a
 * rule must `has()`-guard it. Enforces the serialized-size / JSON-depth / field-count caps (FR-004/020) —
 * throws `ContextError` (`context_too_large` / `context_too_deep` / `context_too_many_fields`) on a breach.
 */
export function buildDecisionContext(
  sources: DecisionContextSources,
  opts: BuildContextOptions = {},
): DecisionContext {
  const context: DecisionContext = { now: sources.decisionTimestamp };

  if (sources.license != null) context.license = pickAllowed(sources.license, LICENSE_FIELDS);
  if (sources.plan != null) context.plan = pickAllowed(sources.plan, PLAN_FIELDS);
  if (sources.entitlement != null) context.entitlement = pickAllowed(sources.entitlement, ENTITLEMENT_FIELDS);
  if (sources.usage != null) context.usage = pickUsage(sources.usage);

  enforceContextBounds(context, opts);
  return context;
}

/**
 * Enforce the decision-context bounds on an already-assembled (real OR dry-run supplied) context (FR-004/020).
 * Throws `ContextError` on the first breached cap so an oversized/over-deep/over-wide context can never reach
 * the evaluator (defense against a resource-bound escape via a supplied context, FR-020).
 */
export function enforceContextBounds(context: unknown, opts: BuildContextOptions = {}): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFields = opts.maxFields ?? DEFAULT_MAX_FIELDS;

  const bytes = Buffer.byteLength(JSON.stringify(context) ?? "", "utf8");
  if (bytes > maxBytes) {
    throw new ContextError("context_too_large", `decision context exceeds ${maxBytes} bytes`);
  }
  if (jsonDepth(context) > maxDepth) {
    throw new ContextError("context_too_deep", `decision context exceeds depth ${maxDepth}`);
  }
  if (countLeafFields(context) > maxFields) {
    throw new ContextError("context_too_many_fields", `decision context exceeds ${maxFields} fields`);
  }
}

/**
 * Canonically serialize a value: object keys are sorted (stable ordering) and `-0` is normalized to `0`, so an
 * IDENTICAL logical value produces an IDENTICAL string regardless of key insertion order (INV-12). A non-finite
 * number (which JSON cannot represent) is encoded as `null`. Used as the pre-image for the canonical hash.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  return "null"; // functions/symbols are never present in a minimized context; encode defensively.
}

/**
 * Compute the canonical `input_hash` of a decision context (INV-12, SC-003): SHA-256 (hex) over the canonical
 * serialization, so re-evaluating an identical context reproduces the identical hash. A plain digest — NO
 * signing key, no cryptographic secret (FR-018). Deterministic; pure.
 */
export function canonicalContextHash(context: unknown): string {
  return createHash("sha256").update(canonicalSerialize(context), "utf8").digest("hex");
}

// --- Dry-run SUPPLIED-context bounding (E017, FR-020, INV-9; T039) -------------------------------------------
//
// A dry-run may supply a SAMPLE decision context (the OpenAPI `DecisionContext`) INSTEAD of a real license. It
// MUST be validated against the SAME allow-listed field schema + serialized-size / JSON-depth / field-count caps
// the real assembled context is bound by (FR-004/020) BEFORE evaluation — so an admin cannot inject an
// out-of-schema, oversized, or over-deep context to escape the evaluation resource bounds or bypass FR-002/009.
// A shape/allow-list breach or an unparseable timestamp is refused `validation_error`; a size/depth/field-count
// breach is refused via the SAME `enforceContextBounds` codes (all surfaced by the route as `400 validation_error`).

/** One supplied usage aggregate entry (E016 shape) — a numeric leaf `value` (+ an optional unit label). */
const suppliedUsageEntrySchema = z.object({ value: z.number(), unit: z.string().max(64).optional() }).strict();

/**
 * The STRICT allow-listed supplied-context wire schema (mirrors the OpenAPI `DecisionContext`, additionalProperties
 * false throughout): an out-of-schema field is REJECTED (FR-020). camelCase wire fields; translated below into the
 * internal minimized {@link DecisionContext}. The server-side allow-list — not the caller — is authoritative.
 */
const suppliedContextSchema = z
  .object({
    decisionTimestamp: z.string(),
    plan: z.object({ planId: z.string().max(128), tier: z.string().max(64) }).strict(),
    entitlement: z
      .object({
        entitlementId: z.string().uuid(),
        key: z.string().max(128),
        kind: z.enum(["boolean", "integer_limit", "metered"]),
        baseValue: z.union([z.number(), z.boolean(), z.null()]),
        authoredMaximum: z.union([z.number(), z.null()]).optional(),
        ruleEligible: z.boolean().optional(),
        tiers: z.array(z.number()).optional(),
      })
      .strict(),
    license: z
      .object({
        licenseId: z.union([z.string().uuid(), z.null()]).optional(),
        product: z.string().max(128).optional(),
        customerReference: z.string().max(128).optional(),
        status: z.enum(["active", "suspended", "revoked", "expired"]).optional(),
        expiresAt: z.union([z.string(), z.null()]).optional(),
      })
      .strict()
      .optional(),
    usage: z.record(suppliedUsageEntrySchema).optional(),
  })
  .strict();

/** The resolved, bounded supplied decision context + the entitlement facts a dry-run resolves the decision from. */
export interface SuppliedDecisionContext {
  /** The internal minimized decision context the evaluator sees (identical shape to the real assembled context). */
  context: DecisionContext;
  /** The injected decision timestamp (epoch millis) parsed from the supplied RFC3339 `decisionTimestamp`. */
  decisionTimestampMs: number;
  entitlementId: string;
  entitlementKey: string;
  /** The supplied base plan value for the target entitlement (number/boolean/null). */
  baseValue: number | boolean | null;
  /** The authored per-entitlement bound the effect applier clamps to (absolute cap is layered by the caller). */
  bounds: { ruleMax: number | null; ruleEligible: boolean; ruleTiers: unknown[] | null };
}

/**
 * Validate + bound a dry-run SUPPLIED wire `DecisionContext` and translate it into the internal minimized
 * {@link DecisionContext} (FR-020, INV-9). Rejects an out-of-schema field or an unparseable `decisionTimestamp`
 * with `ContextError("validation_error", …)`; enforces the SAME serialized-size / JSON-depth / field-count caps
 * as the real assembled context (via {@link buildDecisionContext} → {@link enforceContextBounds}, whose
 * `context_too_large` / `context_too_deep` / `context_too_many_fields` codes the route maps to `validation_error`)
 * BEFORE any evaluation. Pure; no DB; a within-bounds supplied context yields a context IDENTICAL to the real path.
 */
export function buildSuppliedContext(raw: unknown, opts: BuildContextOptions = {}): SuppliedDecisionContext {
  const parsed = suppliedContextSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || undefined;
    throw new ContextError("validation_error", `supplied context invalid${field ? `: ${field}` : ""}`);
  }
  const c = parsed.data;
  const ts = Date.parse(c.decisionTimestamp);
  if (!Number.isFinite(ts)) {
    throw new ContextError("validation_error", "decisionTimestamp must be an RFC3339 timestamp");
  }
  const baseValue = c.entitlement.baseValue;
  const entLeaf: number | boolean | undefined =
    typeof baseValue === "number" || typeof baseValue === "boolean" ? baseValue : undefined;
  const usageNumeric: Record<string, unknown> | undefined = c.usage
    ? Object.fromEntries(Object.entries(c.usage).map(([k, v]) => [k, v.value]))
    : undefined;

  const context = buildDecisionContext(
    {
      decisionTimestamp: ts,
      license: c.license
        ? {
            product: c.license.product,
            status: c.license.status,
            expiresAt: c.license.expiresAt ?? undefined,
            customerRef: c.license.customerReference,
          }
        : undefined,
      plan: { tier: c.plan.tier, code: c.plan.planId },
      entitlement: {
        key: c.entitlement.key,
        type: c.entitlement.kind,
        value: entLeaf,
        baseValue: entLeaf,
        ruleMax: c.entitlement.authoredMaximum ?? undefined,
        ruleEligible: c.entitlement.ruleEligible,
        ruleTiers: c.entitlement.tiers,
      },
      usage: usageNumeric,
    },
    opts,
  );

  return {
    context,
    decisionTimestampMs: ts,
    entitlementId: c.entitlement.entitlementId,
    entitlementKey: c.entitlement.key,
    baseValue,
    bounds: {
      ruleMax: c.entitlement.authoredMaximum ?? null,
      ruleEligible: c.entitlement.ruleEligible ?? false,
      ruleTiers: c.entitlement.tiers ?? null,
    },
  };
}
