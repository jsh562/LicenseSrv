import { getEntitlement } from "../catalog/entitlements.js";
import { loadPolicyConfig } from "./config.js";
import { evaluatePolicy, } from "./evaluate.js";
import { PolicyRuleRepo } from "./rule-repo.js";
import { registerPolicyRoutes } from "./routes.js";
/**
 * A typed policy error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `UsageError`/`BillingError`). The stable snake_case codes match the policy OpenAPI contract:
 * `invalid_condition` / `unsafe_operator` / `effect_out_of_bounds` / `condition_too_large` /
 * `rule_set_limit_exceeded` / `validation_error` (400), `unauthorized` (401), `forbidden` (403),
 * `not_found` (404), `invalid_state_transition` (409). NOTE: an evaluation-time failure at issuance is NOT
 * thrown as a PolicyError — it fails closed to the base static decision and is audited (no HTTP error, FR-010).
 */
export class PolicyError extends Error {
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "PolicyError";
    }
}
/**
 * Compose the policy dependencies from the app + AppDeps: the RLS pool, the live config, the shared rule repo,
 * the E007 entitlement read, and the REAL highest-priority-wins issuance-path `evaluate` seam (evaluate.ts). The
 * seam adjusts the effective entitlement definition BEFORE the E004 signer runs — deterministic, fail-closed,
 * audited — and performs NO cryptography (FR-008/FR-018).
 */
export function buildPolicyDeps(_app, deps) {
    const config = loadPolicyConfig();
    const repo = new PolicyRuleRepo();
    return {
        pool: deps.pool,
        config,
        repo,
        entitlementRead: getEntitlement,
        evaluate: (input) => evaluatePolicy({ pool: deps.pool, repo, config }, input),
    };
}
/**
 * The module's registration seam (ADR-0005/AD-009). Composes + publishes the policy deps on `app.policy`. The
 * admin rule CRUD / status / dry-run routes (US phases), the E008 issuance hook, and the fail-open
 * `policy_evaluation` retention worker layer onto this same seam later, each reading `app.policy`.
 */
export function registerPolicy(app, deps) {
    const policy = buildPolicyDeps(app, deps);
    app.decorate("policy", policy);
    registerPolicyRoutes(app, policy);
}
