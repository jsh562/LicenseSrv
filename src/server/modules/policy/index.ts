// Low-code policy-rule module wiring (E017, ADR-0014, AD-009). Reserves the policy seam AFTER usage (E016) /
// lease (E015) / billing (E014) — a DISTINCT sandboxed author-time-validated + issuance-time bounded-effect
// concern, so no existing module is touched here (the E008 issuance hook and the E007 catalog authored-max
// governance land in their own modules in later phases). Composes + publishes the policy deps on `app.policy`:
// the RLS pool and the `evaluate` seam the E008 issuance path consumes to adjust the effective entitlement
// definition BEFORE the E004 signer runs — highest-priority-wins ONE bounded effect per entitlement, clamped
// to the authored per-entitlement maximum, deterministic (injected clock), fail-closed + audited. registerPolicy
// runs AFTER registerUsage. This scaffold publishes the seam only; the sandboxed evaluator (condition.ts), the
// bounded context builder (context.ts), the typed effect applier (effect.ts), the author-time validator
// (validate.ts), the rule repo (rule-repo.ts), the admin routes (routes.ts), and the retention worker layer
// onto this same seam in the Foundational + US phases — this `evaluate` is a typed placeholder they fill.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { getEntitlement } from "../catalog/entitlements.js";
import { loadPolicyConfig, type PolicyConfig } from "./config.js";
import {
  evaluatePolicy,
  type EvaluatePolicyInput,
  type EvaluatePolicyResult,
} from "./evaluate.js";
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
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** The issuance-path evaluation seam consumed by E008 (post-processes the effective definition BEFORE sign). */
export type PolicyEvaluate = (input: EvaluatePolicyInput) => Promise<EvaluatePolicyResult>;

/**
 * The composed policy dependencies (the seam the routes/workers/issuance-hook consume): the RLS pool and the
 * issuance-path `evaluate` seam. The Foundational + US phases compose the live config, the sandboxed evaluator,
 * the bounded context builder, the typed effect applier, and the rule repo onto this same seam.
 */
export interface PolicyDeps {
  pool: pg.Pool;
  /** The live deployment-wide policy config (eval bounds + rule-set cost caps + absolute cap + retention). */
  config: PolicyConfig;
  /** The shared, tenant-scoped rule + evaluation-audit repository (CRUD + immutable versioning + live counts). */
  repo: PolicyRuleRepo;
  /** The E007 entitlement read (the effect's authored bound source); injected so a test can stub it. */
  entitlementRead: typeof getEntitlement;
  evaluate: PolicyEvaluate;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The composed policy seam (published by registerPolicy; consumed by the E008 issuance hook + routes). */
    policy?: PolicyDeps;
  }
}

/**
 * Compose the policy dependencies from the app + AppDeps: the RLS pool, the live config, the shared rule repo,
 * the E007 entitlement read, and the REAL highest-priority-wins issuance-path `evaluate` seam (evaluate.ts). The
 * seam adjusts the effective entitlement definition BEFORE the E004 signer runs — deterministic, fail-closed,
 * audited — and performs NO cryptography (FR-008/FR-018).
 */
export function buildPolicyDeps(_app: FastifyInstance, deps: AppDeps): PolicyDeps {
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
export function registerPolicy(app: FastifyInstance, deps: AppDeps): void {
  const policy = buildPolicyDeps(app, deps);
  app.decorate("policy", policy);
  registerPolicyRoutes(app, policy);
}
