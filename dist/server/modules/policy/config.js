// Low-code policy-rule configuration + resolver (E017, FR-004/009/014/019/021; ADR-0014). The sandbox
// resource bounds (per-evaluation timeout; author-time JSON size / AST-depth / complexity caps on the guarded
// condition), the bounded decision-context caps (serialized size / JSON-depth / field-count — FR-004/020, the
// SAME caps a dry-run supplied context is bound against), the three FR-019 cost caps (max rules per
// entitlement + per tenant authored at author time, and max rules evaluated per issuance which fails closed),
// the FR-021 absolute per-entitlement authored-max ceiling (`rule_max` can never exceed it), the FR-014
// append-only `policy_evaluation` retention window, and the conflict-resolution policy are APP CONFIG read LIVE
// (an operator retunes without a migration). SCREAMING_SNAKE env -> camelCase config, mirroring
// `loadUsageConfig`/`loadBillingConfig` (deployment-wide defaults from the same env keys the central AppConfig
// reads, `src/server/config/index.ts`). The engine performs NO cryptography and holds no secret (FR-018).
// Documented defaults (kept in sync with the Zod defaults in src/server/config/index.ts -- both read the same
// SCREAMING_SNAKE env keys). A tight sandbox: a short per-evaluation timeout (issuance stays fast), small
// author-time condition caps (the allow-list IS the security boundary), bounded decision-context caps (also
// the dry-run supplied-context bound), the three FR-019 cost caps, a large-but-finite absolute authored-max
// ceiling, a ~90d audit retention window, and highest-priority-wins conflict resolution.
export const DEFAULT_EVAL_TIMEOUT_MS = 50;
export const DEFAULT_CONDITION_MAX_BYTES = 8_192; // 8 KiB serialized condition
export const DEFAULT_CONDITION_MAX_DEPTH = 16;
export const DEFAULT_CONDITION_MAX_COMPLEXITY = 128; // node-count / operator budget
export const DEFAULT_CONTEXT_MAX_BYTES = 16_384; // 16 KiB serialized context
export const DEFAULT_CONTEXT_MAX_DEPTH = 8;
export const DEFAULT_CONTEXT_MAX_FIELDS = 128;
export const DEFAULT_MAX_RULES_PER_ENTITLEMENT = 50;
export const DEFAULT_MAX_RULES_PER_TENANT = 500;
export const DEFAULT_MAX_RULES_PER_ISSUANCE = 100;
export const DEFAULT_ABSOLUTE_MAX_LIMIT = 1_000_000_000;
export const DEFAULT_EVALUATION_RETENTION_SECS = 7_776_000; // 90 days
export const DEFAULT_CONFLICT_POLICY = "highest_priority_wins";
/** The only conflict policy the engine implements; an unrecognized env value falls back to it. */
export const ALLOWED_CONFLICT_POLICIES = ["highest_priority_wins"];
/** Coerce a positive-int env value, falling back to `dflt` on a missing / non-positive / non-numeric input. */
function intEnv(raw, dflt) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
/** Coerce a positive (possibly fractional) numeric env value; falls back on a missing / non-positive input. */
function numEnv(raw, dflt) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}
/**
 * Resolve the conflict-resolution policy: only `highest_priority_wins` is implemented (FR-006). Any other /
 * missing value falls back to the default so the engine can never be configured into an unsupported policy.
 */
export function resolveConflictPolicy(raw) {
    return ALLOWED_CONFLICT_POLICIES.includes(raw ?? "")
        ? raw
        : DEFAULT_CONFLICT_POLICY;
}
/**
 * Load the policy config from the environment, falling back to the documented defaults. Reads the same
 * SCREAMING_SNAKE keys as the central AppConfig. Every cap is a positive-int resolver, the absolute authored-max
 * ceiling is a positive numeric resolver, and the conflict policy is validated against the implemented set.
 * Pure; no I/O; no secret (the engine performs no cryptography — FR-018).
 */
export function loadPolicyConfig(env = process.env) {
    return {
        evalTimeoutMs: intEnv(env.POLICY_EVAL_TIMEOUT_MS, DEFAULT_EVAL_TIMEOUT_MS),
        conditionMaxBytes: intEnv(env.POLICY_CONDITION_MAX_BYTES, DEFAULT_CONDITION_MAX_BYTES),
        conditionMaxDepth: intEnv(env.POLICY_CONDITION_MAX_DEPTH, DEFAULT_CONDITION_MAX_DEPTH),
        conditionMaxComplexity: intEnv(env.POLICY_CONDITION_MAX_COMPLEXITY, DEFAULT_CONDITION_MAX_COMPLEXITY),
        contextMaxBytes: intEnv(env.POLICY_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_MAX_BYTES),
        contextMaxDepth: intEnv(env.POLICY_CONTEXT_MAX_DEPTH, DEFAULT_CONTEXT_MAX_DEPTH),
        contextMaxFields: intEnv(env.POLICY_CONTEXT_MAX_FIELDS, DEFAULT_CONTEXT_MAX_FIELDS),
        maxRulesPerEntitlement: intEnv(env.POLICY_MAX_RULES_PER_ENTITLEMENT, DEFAULT_MAX_RULES_PER_ENTITLEMENT),
        maxRulesPerTenant: intEnv(env.POLICY_MAX_RULES_PER_TENANT, DEFAULT_MAX_RULES_PER_TENANT),
        maxRulesPerIssuance: intEnv(env.POLICY_MAX_RULES_PER_ISSUANCE, DEFAULT_MAX_RULES_PER_ISSUANCE),
        absoluteMaxLimit: numEnv(env.POLICY_ABSOLUTE_MAX_LIMIT, DEFAULT_ABSOLUTE_MAX_LIMIT),
        evaluationRetentionSecs: intEnv(env.POLICY_EVALUATION_RETENTION_SECS, DEFAULT_EVALUATION_RETENTION_SECS),
        conflictPolicy: resolveConflictPolicy(env.POLICY_CONFLICT_POLICY),
    };
}
