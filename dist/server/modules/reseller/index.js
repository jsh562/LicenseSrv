import { BrandingRepo } from "./branding.js";
import { loadResellerConfig } from "./config.js";
import { assertSubtreeMembership as gateAssertSubtreeMembership } from "./gate.js";
import { ResellerRepo } from "./reseller-repo.js";
import { registerResellerRoutes } from "./routes.js";
import { DomainVerifier, nodeDnsResolver } from "./verify.js";
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
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "ResellerError";
    }
}
/**
 * Compose the reseller dependencies from the app + AppDeps: the RLS pool, the shared reseller repo, the live
 * deployment-wide config, and the REAL subtree-membership gate (the repo's downward-only, ownership-filtered
 * lookup resolved to `not_found` on any out-of-subtree target, AD-001/002, HINT-001/002). Performs NO
 * cryptography and holds no secret (presentation-only, Principle I).
 */
export function buildResellerDeps(_app, deps, dns) {
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
export function registerReseller(app, deps) {
    const reseller = buildResellerDeps(app, deps);
    app.decorate("reseller", reseller);
    registerResellerRoutes(app, reseller);
}
