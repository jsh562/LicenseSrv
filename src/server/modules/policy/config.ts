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

/** The single allowed conflict-resolution policy: highest-priority-wins ONE effect per entitlement (FR-006). */
export type ConflictPolicy = "highest_priority_wins";

/** The resolved deployment-wide policy-rule config. Times are ms/seconds as the field name says; caps are counts/bytes. */
export interface PolicyConfig {
  /** Per-evaluation sandbox timeout in ms; a breach fails closed to the base static decision (FR-009). */
  evalTimeoutMs: number;
  /** Author-time serialized condition size cap (bytes) → `condition_too_large` (FR-009). */
  conditionMaxBytes: number;
  /** Author-time guarded-condition AST-depth cap (FR-009). */
  conditionMaxDepth: number;
  /** Author-time guarded-condition node-count / operator complexity cap (FR-009). */
  conditionMaxComplexity: number;
  /** Decision-context serialized size cap (bytes) — real + dry-run supplied context (FR-004/020). */
  contextMaxBytes: number;
  /** Decision-context JSON-nesting-depth cap (FR-004/020). */
  contextMaxDepth: number;
  /** Decision-context field-count cap (FR-004/020). */
  contextMaxFields: number;
  /** Per-entitlement live (active|preview) rule-set size cap → `rule_set_limit_exceeded` at author time (FR-019). */
  maxRulesPerEntitlement: number;
  /** Per-tenant live (active|preview) rule-set size cap → `rule_set_limit_exceeded` at author time (FR-019). */
  maxRulesPerTenant: number;
  /** Max rules evaluated per issuance; over it → fail-closed for the affected entitlement (FR-019). */
  maxRulesPerIssuance: number;
  /** Absolute per-entitlement authored-max ceiling `rule_max` can never exceed (FR-021). */
  absoluteMaxLimit: number;
  /** Append-only `policy_evaluation` retention window (seconds, ~90d); owner-role prune horizon (FR-014). */
  evaluationRetentionSecs: number;
  /** Conflict-resolution policy — highest-priority-wins one effect per entitlement (FR-006). */
  conflictPolicy: ConflictPolicy;
}

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
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "highest_priority_wins";
/** The only conflict policy the engine implements; an unrecognized env value falls back to it. */
export const ALLOWED_CONFLICT_POLICIES: readonly ConflictPolicy[] = ["highest_priority_wins"];

/** Coerce a positive-int env value, falling back to `dflt` on a missing / non-positive / non-numeric input. */
function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** Coerce a positive (possibly fractional) numeric env value; falls back on a missing / non-positive input. */
function numEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Resolve the conflict-resolution policy: only `highest_priority_wins` is implemented (FR-006). Any other /
 * missing value falls back to the default so the engine can never be configured into an unsupported policy.
 */
export function resolveConflictPolicy(raw: string | undefined): ConflictPolicy {
  return (ALLOWED_CONFLICT_POLICIES as readonly string[]).includes(raw ?? "")
    ? (raw as ConflictPolicy)
    : DEFAULT_CONFLICT_POLICY;
}

/**
 * Load the policy config from the environment, falling back to the documented defaults. Reads the same
 * SCREAMING_SNAKE keys as the central AppConfig. Every cap is a positive-int resolver, the absolute authored-max
 * ceiling is a positive numeric resolver, and the conflict policy is validated against the implemented set.
 * Pure; no I/O; no secret (the engine performs no cryptography — FR-018).
 */
export function loadPolicyConfig(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
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
