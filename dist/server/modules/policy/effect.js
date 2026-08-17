// Closed typed effect applier (E017, FR-003/007; ADR-0014, AD-002/AD-003, HINT-003, INV-4).
//
// A rule NEVER mutates state: it returns a closed typed effect DESCRIPTOR `{kind, target, value}` and this
// TRUSTED applier resolves the bounded value the issuance snapshot will carry (FR-003). The effect surface is a
// closed union of exactly three kinds, each bound to the E007 authored per-entitlement bound (AD-003):
//   - adjust_limit  → CLAMPED to the authored `rule_max` ceiling (and any absolute cap), floored at 0. A rule
//                     MAY lift above the base plan value up to `rule_max`, but the clamp guarantees it can never
//                     exceed the authored maximum (FR-007, SC-004/015). No authored `rule_max` → refused.
//   - toggle_boolean → applied ONLY where the entitlement is `rule_eligible` (the plan defines reachable states,
//                     FR-003); otherwise refused.
//   - select_tier   → resolved ONLY to a NUMERIC value present in the plan-defined numeric `rule_tiers`;
//                     otherwise refused. A tier is always a finite number so the selected value flows through the
//                     signed snapshot's `Record<string, boolean | number>` numeric branch (Principle I, SC-014).
// This is the EVALUATION-TIME defense-in-depth clamp (an over-bound effect is ALSO refused at author time in
// validate.ts, FR-002). A refusal returns `{applied:false, reason}` so the caller fails closed (base decision).
/**
 * Resolve the effective upper ceiling for an `adjust_limit` effect (FR-007, INV-4, SC-015).
 *
 * The AUTHORED per-entitlement `rule_max` IS the required ceiling: with NO authored `rule_max` there is no
 * ceiling and the effect MUST be refused (→ `no_rule_max`) — the absolute cap is NOT an applier fallback. The
 * `absoluteMax` is the catalog-layer governance bound on what `rule_max` may be SET to (FR-021); on the applier
 * path it only ever serves as defense-in-depth, tightening a PRESENT `rule_max`. So: no finite `ruleMax` → null
 * (refused); a present `ruleMax` → `min(ruleMax, absoluteMax)` when the absolute cap is finite, else `ruleMax`.
 */
function resolveCeiling(bounds) {
    if (typeof bounds.ruleMax !== "number" || !Number.isFinite(bounds.ruleMax))
        return null;
    if (typeof bounds.absoluteMax === "number" && Number.isFinite(bounds.absoluteMax)) {
        return Math.min(bounds.ruleMax, bounds.absoluteMax);
    }
    return bounds.ruleMax;
}
/** Whether a finite-number tier value is present in the plan-defined numeric `rule_tiers` (numeric equality). */
function tierAllowed(value, tiers) {
    if (!Array.isArray(tiers))
        return false;
    return tiers.some((t) => typeof t === "number" && Number.isFinite(t) && t === value);
}
/**
 * Apply a closed typed effect descriptor within the authored per-entitlement bound (FR-003/007, INV-4). Returns
 * the bounded value to enforce (`applied:true`, with `clamped` set when an adjust_limit was reduced to the
 * ceiling) or a fail-closed refusal (`applied:false, reason`). Pure; the SINGLE trusted evaluation-time applier.
 */
export function applyEffect(effect, bounds) {
    const { kind, target, value } = effect;
    switch (kind) {
        case "adjust_limit": {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return { applied: false, kind, target, reason: "invalid_value" };
            }
            const ceiling = resolveCeiling(bounds);
            if (ceiling === null) {
                // No authored maximum → a rule cannot raise/adjust this limit; fail closed to the base decision.
                return { applied: false, kind, target, reason: "no_rule_max" };
            }
            const bounded = Math.max(0, Math.min(value, ceiling));
            return { applied: true, kind, target, value: bounded, clamped: bounded !== value };
        }
        case "toggle_boolean": {
            if (typeof value !== "boolean") {
                return { applied: false, kind, target, reason: "invalid_value" };
            }
            if (bounds.ruleEligible !== true) {
                return { applied: false, kind, target, reason: "not_rule_eligible" };
            }
            return { applied: true, kind, target, value, clamped: false };
        }
        case "select_tier": {
            // A tier is a NUMERIC option (the plan-defined `rule_tiers` are numbers) so the selected value flows
            // through the signed snapshot's numeric branch — a non-number is refused (Principle I, SC-014).
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return { applied: false, kind, target, reason: "invalid_value" };
            }
            if (!tierAllowed(value, bounds.ruleTiers)) {
                return { applied: false, kind, target, reason: "tier_not_defined" };
            }
            return { applied: true, kind, target, value, clamped: false };
        }
        default: {
            // Exhaustive: an unknown kind is refused (fail closed) rather than throwing on the issuance path.
            const unknownKind = kind;
            return { applied: false, kind: unknownKind, target, reason: "unknown_kind" };
        }
    }
}
