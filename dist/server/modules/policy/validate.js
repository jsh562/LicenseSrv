// Author-time rule validation (E017, FR-002/007/009; ADR-0014, AD-001/AD-002/AD-003, HINT-001/HINT-003, INV-4).
//
// REJECT-BEFORE-PERSIST is the primary safety guarantee (FR-002): a rule is fully validated at author time and,
// if invalid/unsafe/out-of-bounds, is REFUSED with a DISTINCT 400 code and NEVER persisted or evaluated. Four
// distinct codes (the policy OpenAPI contract):
//   - `invalid_condition`     — structural shape: the condition is not a structured-JSON object, an operator node
//                               is not a single-key object, a `var`/`has` path is malformed, or it references a
//                               field OUTSIDE the allow-listed decision-context schema (the author-time type-check
//                               target, FR-004). A free-text expression is refused here (FR-001).
//   - `unsafe_operator`       — the safety-lint boundary: a condition uses an operator NOT on the fixed pure
//                               allow-list (ALLOWED_OPERATORS, reused from condition.ts — the SAME boundary the
//                               evaluator enforces) or a prototype-polluting path segment (`__proto__` etc).
//   - `condition_too_large`   — a resource bound: the serialized condition exceeds the byte cap, or the guarded
//                               AST exceeds the depth / node-count (complexity) cap (FR-009).
//   - `effect_out_of_bounds`  — the effect is malformed OR, run through the SAME trusted `applyEffect` clamp
//                               (effect.ts) against the target entitlement's authored bound, would be refused OR
//                               clamped — a static-literal effect that exceeds the authored maximum / toggles a
//                               non-rule-eligible boolean / selects an undefined tier is REFUSED at author time,
//                               not silently clamped (FR-007, the clamp is defense-in-depth at evaluation, INV-4).
//
// This is a STATIC lint (it needs no decision data): it walks the structured-JSON condition, enforcing the
// operator allow-list + field allow-list + resource bounds, then bounds the effect via the single trusted
// applier. It NEVER uses eval/Function/vm/host and reads no live context (FR-009).
import { ENTITLEMENT_FIELDS, LICENSE_FIELDS, PLAN_FIELDS, } from "./context.js";
import { ALLOWED_OPERATORS, evaluateCondition } from "./condition.js";
import { applyEffect } from "./effect.js";
import { PolicyError } from "./index.js";
/** The built-in decision-context schema (mirrors the sections context.ts assembles: E007/E008/E016 + `now`). */
export const DEFAULT_CONTEXT_SCHEMA = {
    now: "leaf",
    license: LICENSE_FIELDS,
    plan: PLAN_FIELDS,
    entitlement: ENTITLEMENT_FIELDS,
    usage: "any",
};
/** Path segments that could reach the prototype chain — refused as `unsafe_operator` (no prototype pollution). */
const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Defaults kept in sync with the policy config (config.ts): a tight author-time sandbox — the allow-list IS the
// security boundary, so the caps are deliberately small.
const DEFAULT_MAX_BYTES = 8_192;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_COMPLEXITY = 128;
/** Normalize an operator argument into an array (a single non-array arg is a one-element list). */
function asArray(arg) {
    return Array.isArray(arg) ? arg : [arg];
}
/**
 * Validate a `var`/`has` path against the allow-listed context schema (the author-time type-check, FR-004).
 * A prototype-polluting segment is refused (`unsafe_operator`); a root or field absent from the schema is
 * refused (`invalid_condition`).
 */
function lintFieldPath(op, path, schema) {
    const segments = path.split(".");
    for (const seg of segments) {
        if (FORBIDDEN_PATH_KEYS.has(seg)) {
            throw new PolicyError("unsafe_operator", 400, `\`${op}\` path uses a forbidden segment: ${seg}`);
        }
    }
    const root = segments[0];
    const rootSchema = schema[root];
    if (rootSchema === undefined) {
        throw new PolicyError("invalid_condition", 400, `field not in the allow-listed context schema: ${path}`);
    }
    if (rootSchema === "leaf") {
        if (segments.length > 1) {
            throw new PolicyError("invalid_condition", 400, `\`${root}\` is a leaf field, not an object: ${path}`);
        }
        return;
    }
    if (rootSchema === "any")
        return; // dynamic sub-key space (usage.* metered aggregates)
    const field = segments[1];
    if (field === undefined || !rootSchema.includes(field)) {
        throw new PolicyError("invalid_condition", 400, `field not in the allow-listed context schema: ${path}`);
    }
}
/** Lint a `var`/`has` argument: extract + type-check the path; a `var` default is itself a recursively linted node. */
function lintVarArg(op, arg, state) {
    let path;
    if (Array.isArray(arg)) {
        path = arg[0];
        if (arg.length > 1)
            lintNode(arg[1], state); // the has()-guard default alternative is a real node
    }
    else {
        path = arg;
    }
    if (typeof path !== "string" || path === "") {
        throw new PolicyError("invalid_condition", 400, `\`${op}\` requires a non-empty string path`);
    }
    lintFieldPath(op, path, state.schema);
}
/**
 * Statically lint one condition node (mirrors the evaluator's structure in condition.ts, but without data):
 * a literal / array passes through; a single-key object is an allow-listed operator whose argument is linted.
 * Enforces the node-count (complexity) and AST-depth caps as it descends.
 */
function lintNode(node, state) {
    state.ops += 1;
    if (state.ops > state.maxComplexity) {
        throw new PolicyError("condition_too_large", 400, "condition exceeds the complexity budget");
    }
    if (node === null || typeof node !== "object")
        return; // literal (string/number/boolean/null)
    if (Array.isArray(node)) {
        for (const child of node)
            lintNode(child, state);
        return;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
        throw new PolicyError("invalid_condition", 400, "an operator node must be a single-key object");
    }
    const op = keys[0];
    if (!ALLOWED_OPERATORS.has(op)) {
        throw new PolicyError("unsafe_operator", 400, `operator not allowed: ${op}`);
    }
    state.depth += 1;
    if (state.depth > state.maxDepth) {
        throw new PolicyError("condition_too_large", 400, "condition exceeds the maximum AST depth");
    }
    const arg = node[op];
    if (op === "var" || op === "has") {
        lintVarArg(op, arg, state);
    }
    else {
        for (const child of asArray(arg))
            lintNode(child, state);
    }
    state.depth -= 1;
}
/** Validate the structured-JSON condition: object shape → byte cap → operator/field/depth/complexity walk. */
function validateCondition(condition, opts) {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
        throw new PolicyError("invalid_condition", 400, "condition must be a structured-JSON object");
    }
    let serialized;
    try {
        serialized = JSON.stringify(condition);
    }
    catch {
        serialized = undefined;
    }
    if (serialized === undefined) {
        throw new PolicyError("invalid_condition", 400, "condition is not serializable JSON");
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
        throw new PolicyError("condition_too_large", 400, `condition exceeds ${maxBytes} bytes`);
    }
    const state = {
        depth: 0,
        ops: 0,
        maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxComplexity: opts.maxComplexity ?? DEFAULT_MAX_COMPLEXITY,
        schema: opts.contextSchema ?? DEFAULT_CONTEXT_SCHEMA,
    };
    lintNode(condition, state);
}
/**
 * Validate the closed typed effect against the target entitlement's authored bound (FR-003/007, INV-4). A
 * malformed descriptor is refused; then the SAME trusted `applyEffect` clamp (effect.ts) decides — a static
 * literal that WOULD be clamped or refused is REFUSED at author time (`effect_out_of_bounds`), so an over-bound
 * effect never persists (the evaluation-time clamp remains as defense-in-depth).
 */
function validateEffect(effect, bounds) {
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) {
        throw new PolicyError("effect_out_of_bounds", 400, "effect must be a typed descriptor object");
    }
    const e = effect;
    const kind = e.kind;
    if (kind !== "adjust_limit" && kind !== "toggle_boolean" && kind !== "select_tier") {
        throw new PolicyError("effect_out_of_bounds", 400, `unknown effect kind: ${String(kind)}`);
    }
    if (typeof e.target !== "string" || e.target === "") {
        throw new PolicyError("effect_out_of_bounds", 400, "effect target must be a non-empty string");
    }
    if (kind === "select_tier") {
        // A select_tier tier is a NUMERIC option end-to-end (Principle I / SC-014): the selected value must be a
        // finite number and the plan-defined `rule_tiers` must all be finite numbers, so the selection flows through
        // the signed snapshot's numeric branch. A non-numeric value / tier list is refused at author time (FR-007).
        if (typeof e.value !== "number" || !Number.isFinite(e.value)) {
            throw new PolicyError("effect_out_of_bounds", 400, "a select_tier value must be a finite number", {
                reason: "invalid_value",
            });
        }
        const tiers = bounds.ruleTiers;
        if (Array.isArray(tiers) && !tiers.every((t) => typeof t === "number" && Number.isFinite(t))) {
            throw new PolicyError("effect_out_of_bounds", 400, "select_tier rule_tiers must all be finite numbers", {
                reason: "invalid_tiers",
            });
        }
    }
    const descriptor = { kind: kind, target: e.target, value: e.value };
    const result = applyEffect(descriptor, bounds);
    if (!result.applied) {
        throw new PolicyError("effect_out_of_bounds", 400, `effect refused: ${result.reason}`, {
            reason: result.reason,
        });
    }
    if (result.clamped) {
        // A static-literal effect exceeding the authored ceiling is an authoring error — refuse it before persist
        // rather than silently clamp (FR-007: refused at author time; the evaluation clamp is defense-in-depth).
        throw new PolicyError("effect_out_of_bounds", 400, "effect exceeds the authored maximum", {
            reason: "over_ceiling",
        });
    }
}
/**
 * Validate a rule at author time BEFORE persisting it (FR-002): structural shape + operator allow-list +
 * context-field type-check + resource bounds on the condition, then the effect bound via the single trusted
 * applier. Throws a {@link PolicyError} with a DISTINCT 400 code (`invalid_condition` / `unsafe_operator` /
 * `condition_too_large` / `effect_out_of_bounds`) on the first failure; returns normally when the rule is a
 * well-formed, safe, in-bounds candidate. Pure — no DB, no eval, no live context (FR-009).
 */
export function validateRule(input, opts = {}) {
    validateCondition(input.condition, opts);
    validateEffect(input.effect, input.bounds);
}
/**
 * Author-time rule-set SIZE cap (FR-019, INV-7): before persisting a NEW LIVE (active|preview) rule, reject when
 * the resulting live rule set would exceed the configured per-ENTITLEMENT or per-TENANT maximum — so an unbounded
 * rule set can never slow/DoS the issuance/signing path. A current count already AT the cap means adding one more
 * exceeds it, so the check is `>=`. Throws `PolicyError("rule_set_limit_exceeded", 400, …, {limit, actual, scope})`
 * (the per-entitlement scope is checked first). Pure; no DB — the caller supplies the RLS-scoped live counts.
 */
export function assertRuleSetWithinCaps(counts, caps) {
    if (counts.entitlementLive >= caps.maxRulesPerEntitlement) {
        throw new PolicyError("rule_set_limit_exceeded", 400, "the entitlement's live rule set is at its configured maximum", { limit: caps.maxRulesPerEntitlement, actual: counts.entitlementLive + 1, scope: "entitlement" });
    }
    if (counts.tenantLive >= caps.maxRulesPerTenant) {
        throw new PolicyError("rule_set_limit_exceeded", 400, "the tenant's live rule set is at its configured maximum", { limit: caps.maxRulesPerTenant, actual: counts.tenantLive + 1, scope: "tenant" });
    }
}
/** True when a condition node (or any descendant) references the decision context via `var`/`has` (data-dependent). */
function referencesContext(node) {
    if (node === null || typeof node !== "object")
        return false;
    if (Array.isArray(node))
        return node.some(referencesContext);
    const keys = Object.keys(node);
    if (keys.length === 1) {
        const op = keys[0];
        if (op === "var" || op === "has")
            return true;
    }
    return Object.values(node).some(referencesContext);
}
/**
 * Whether a condition is UNCONDITIONAL — a constant tautology that matches regardless of the decision context
 * (e.g. `true`, `{"==":[1,1]}`). It references NO context field (`var`/`has`) and constant-folds to `true` through
 * the SAME sandboxed evaluator (an empty context; the injected `now=0` is the only ambient value). A condition
 * that throws or references context is NOT unconditional (conservatively → false, so the lint never over-warns).
 */
function isUnconditional(condition) {
    if (referencesContext(condition))
        return false;
    try {
        return evaluateCondition(condition, {}, { now: 0 }) === true;
    }
    catch {
        return false;
    }
}
/**
 * Author-time overlap / unreachable-rule lint (US6, FR-006, SC-010). Compares the candidate rule against the
 * tenant's existing LIVE (active|preview) rules for the SAME target entitlement and returns NON-BLOCKING warnings:
 *   - `unreachable_rule` — an existing UNCONDITIONAL rule at a STRICTLY HIGHER priority always fires first, so the
 *     candidate can NEVER win (it is shadowed);
 *   - `overlapping_rule` — an existing rule shares the candidate's EXACT priority, so precedence between them hinges
 *     ONLY on the stable `(rule_key, version)` tiebreak (a likely-unintended overlap the author should retune).
 * Deterministic + pure (no DB); the caller supplies the RLS-scoped live peer set. Warnings never block a persist.
 */
export function lintRuleConflicts(input, existingLive) {
    const warnings = [];
    for (const peer of existingLive) {
        if (input.ruleKey !== undefined && peer.ruleKey === input.ruleKey)
            continue; // never lint a rule against itself
        if (peer.priority > input.priority && isUnconditional(peer.condition)) {
            warnings.push({
                code: "unreachable_rule",
                message: `unreachable: the higher-priority always-matching rule ${peer.ruleKey} (v${peer.version}, priority ${peer.priority}) always wins first`,
                ruleKey: peer.ruleKey,
                version: peer.version,
                priority: peer.priority,
            });
            continue;
        }
        if (peer.priority === input.priority) {
            warnings.push({
                code: "overlapping_rule",
                message: `overlapping: rule ${peer.ruleKey} (v${peer.version}) shares priority ${peer.priority} on this entitlement; precedence relies on the (rule_key, version) tiebreak`,
                ruleKey: peer.ruleKey,
                version: peer.version,
                priority: peer.priority,
            });
        }
    }
    return warnings;
}
