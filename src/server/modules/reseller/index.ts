// Reseller & white-label tenancy module wiring (E018, {SAD:ADR-0015}, AD-009). Reserves the reseller seam
// AFTER policy (E017) / usage (E016) / lease (E015) — a DISTINCT delegated-cross-tenant-administration +
// per-tenant white-label concern, so no existing module is touched here (the E006 admin onboarding + last-owner
// hooks and the shared `tenant`/`audit_log` reuse land in their own edits in later phases). Composes +
// publishes the reseller deps on `app.reseller`: the RLS pool and the `assertSubtreeMembership` gate seam a
// reseller ACTION path descends through — assert the caller owns the target sub-tenant (downward-only,
// out-of-subtree → 404 no disclosure), then operate under the sub-tenant's OWN `app.current_tenant` scope. It
// NEVER broadens the per-tenant forced-RLS predicate (AD-001/002, HINT-001) and performs NO cryptography
// (presentation-only, Principle I). registerReseller runs AFTER registerPolicy. This scaffold publishes the
// seam only; the config resolver (config.ts), the reseller repo (reseller-repo.ts), the subtree gate +
// scoped descent (gate.ts), the dual-identity audit projection (audit.ts), the branding resolver
// (branding.ts), the domain/email verifier (verify.ts), and the admin routes (routes.ts) layer onto this same
// seam in the Foundational + US phases — this `assertSubtreeMembership` is a typed placeholder they fill.
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AppDeps } from "../../app.js";
import { BrandingRepo } from "./branding.js";
import { loadResellerConfig, type ResellerConfig } from "./config.js";
import { assertSubtreeMembership as gateAssertSubtreeMembership } from "./gate.js";
import { ResellerRepo } from "./reseller-repo.js";
import { registerResellerRoutes } from "./routes.js";
import { DomainVerifier, type DnsResolver, nodeDnsResolver } from "./verify.js";

/**
 * A typed reseller error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `PolicyError`/`UsageError`). The stable snake_case codes match the reseller OpenAPI contract:
 * `validation_error` (400), `unauthorized` (401), `forbidden` (403 RBAC/plane + CSRF), `not_found` (404
 * out-of-scope/cross-tenant — no disclosure), and the 409 set `onboarding_conflict` / `quota_exceeded` /
 * `field_locked` / `not_verified` / `binding_conflict` / `sub_tenants_unresolved` / `reseller_suspended` /
 * `last_owner` / `invalid_state_transition`. NOTE: an out-of-subtree reference fails CLOSED to `not_found`
 * (404) — never `403` — so a reseller can never probe the existence of a sibling/parent/platform tenant
 * (HINT-002).
 */
export class ResellerError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ResellerError";
  }
}

/**
 * The subtree-membership gate seam a reseller ACTION path descends through (AD-001, HINT-001). Given the
 * acting reseller's home tenant and a target sub-tenant, it asserts the reseller OWNS that sub-tenant (a
 * downward-only subtree-membership check) — resolving out-of-subtree references to `not_found` (404, no
 * disclosure) — so the caller may then operate under the sub-tenant's OWN `app.current_tenant` scope WITHOUT
 * broadening the per-tenant forced-RLS predicate (AD-002). A typed placeholder here; gate.ts (T012) fills it.
 */
export type AssertSubtreeMembership = (resellerTenantId: string, subTenantId: string) => Promise<void>;

/**
 * The composed reseller dependencies (the seam the routes/gate/branding/verify consume): the RLS pool and the
 * subtree-membership gate. The Foundational + US phases compose the live config, the reseller repo (incl. the
 * privileged subtree READ), the real gate + scoped descent, the dual-identity audit projection, the per-field
 * branding resolver + locks, and the domain/email verifier onto this same seam.
 */
export interface ResellerDeps {
  pool: pg.Pool;
  /** The shared, tenant-scoped reseller data-access repository (CRUD + status/quota + parent link + subtree reads). */
  repo: ResellerRepo;
  /** The live deployment-wide reseller config (default quota + grace window + trust-signal set + platform branding). */
  config: ResellerConfig;
  /** The subtree-membership gate a reseller ACTION descends through; downward-only, out-of-subtree → 404. */
  assertSubtreeMembership: AssertSubtreeMembership;
  /** The per-tenant white-label branding resolver (branding_profile CRUD + per-field precedence + locks, US2). */
  branding: BrandingRepo;
  /** The domain/email-sender ownership verifier — the `domain_binding` state machine + one-binding-per-host (US5). */
  verifier: DomainVerifier;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The composed reseller seam (published by registerReseller; consumed by the reseller admin routes). */
    reseller?: ResellerDeps;
  }
}

/**
 * Compose the reseller dependencies from the app + AppDeps: the RLS pool, the shared reseller repo, the live
 * deployment-wide config, and the REAL subtree-membership gate (the repo's downward-only, ownership-filtered
 * lookup resolved to `not_found` on any out-of-subtree target, AD-001/002, HINT-001/002). Performs NO
 * cryptography and holds no secret (presentation-only, Principle I).
 */
export function buildResellerDeps(_app: FastifyInstance, deps: AppDeps, dns?: DnsResolver): ResellerDeps {
  const repo = new ResellerRepo(deps.pool);
  const config = loadResellerConfig();
  const branding = new BrandingRepo(deps.pool);
  // The DNS-lookup surface is INJECTED (AD-006): production uses `node:dns/promises`; tests supply a
  // deterministic stub so verification is network-free. Real DNS never runs inside the verifier's logic.
  const verifier = new DomainVerifier(deps.pool, dns ?? nodeDnsResolver());
  return {
    pool: deps.pool,
    repo,
    config,
    // Real gate: asserts the acting reseller owns the target sub-tenant (downward-only); out-of-subtree → 404.
    assertSubtreeMembership: async (resellerTenantId, subTenantId) => {
      await gateAssertSubtreeMembership(repo, resellerTenantId, subTenantId);
    },
    branding,
    verifier,
  };
}

/**
 * The module's registration seam (ADR-0005/AD-009). Composes + publishes the reseller deps on `app.reseller` and
 * registers the reseller + operator admin routes (session+RBAC+CSRF). The per-field branding resolver, the
 * dual-identity append-only audit wiring, and the domain/email verifier layer onto this same seam in later
 * phases, each reading `app.reseller`. registerReseller runs AFTER registerPolicy (see `modules/index.ts`).
 */
export function registerReseller(app: FastifyInstance, deps: AppDeps): void {
  const reseller = buildResellerDeps(app, deps);
  app.decorate("reseller", reseller);
  registerResellerRoutes(app, reseller);
}
