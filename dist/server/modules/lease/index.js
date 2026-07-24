import { withTenant } from "../../db/client.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import { loadLeaseConfig } from "./config.js";
import { LeaseRepo } from "./lease-repo.js";
import { registerLeaseRoutes } from "./routes.js";
/**
 * A typed lease error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `ActivationError`/`BillingError`/`EnforcementError`). The stable snake_case codes match the lease
 * OpenAPI contract: `no_concurrency_entitlement` (403), `license_not_active` (409), `seat_capacity_exhausted`
 * (409), `activation_required` (409), `lease_not_renewable` (409), `signer_unavailable` (503), etc.
 */
export class LeaseError extends Error {
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "LeaseError";
    }
}
/** The default {@link ActivationRead}: reads the `activation` table under RLS for the given tenant. */
export const defaultActivationRead = (pool, tenantId, activationId) => withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT id, license_id, status FROM activation WHERE id = $1", [activationId]);
    if (!r.rowCount)
        return null;
    const row = r.rows[0];
    return { id: row.id, licenseId: row.license_id, status: row.status };
});
/**
 * Compose the lease dependencies from the app + AppDeps: `app.signer` is published by registerSigning (may be
 * undefined in a deployment not yet signing), `getEffectivePlanDefinition` is the E007 read, the config is
 * resolved LIVE (the same env keys the central AppConfig validates at boot), and a fresh {@link LeaseRepo} is
 * the shared race-safe accountant.
 */
export function buildLeaseDeps(app, deps) {
    return {
        pool: deps.pool,
        signer: app.signer,
        effective: getEffectivePlanDefinition,
        activationRead: defaultActivationRead,
        repo: new LeaseRepo(),
        config: loadLeaseConfig(),
    };
}
/**
 * The module's registration seam (ADR-0005/AD-008). Composes + publishes the lease deps on `app.lease`. The
 * runtime acquire/renew/release routes (US1/US2), the admin registry/force-release routes (US5), and the
 * fail-open reclaim worker (US3) layer onto this same seam, each reading `app.lease`.
 */
export function registerLease(app, deps) {
    const lease = buildLeaseDeps(app, deps);
    app.decorate("lease", lease);
    // Mount the /v1 runtime lease routes (acquire/renew/release) — API key + `lease` scope + rate limit (US1/US2).
    registerLeaseRoutes(app, lease, deps.apiKeySecret);
}
