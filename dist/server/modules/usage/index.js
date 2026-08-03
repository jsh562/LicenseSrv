import { getEntitlement } from "../catalog/entitlements.js";
import { loadUsageConfig } from "./config.js";
import { registerUsageRoutes } from "./routes.js";
import { UsageRepo } from "./usage-repo.js";
/**
 * A typed usage error carrying the HTTP status + machine code the routes surface as `{code,message,details?}`
 * (mirrors `BillingError`/`LeaseError`). The stable snake_case codes match the usage OpenAPI contract's
 * WHOLE-REQUEST vocabulary: `batch_too_large` (400), `validation_error` (400), `window_too_large` (400),
 * `unauthorized` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429). NOTE: the PER-EVENT
 * rejection codes (`not_found`/`not_metered`/`archived`/`license_inactive`/`stale_event`/`future_event`/
 * `validation_error`) are a SEPARATE, non-HTTP vocabulary reported inside the 200/202 batch summary — a
 * single bad event never fails the batch (AD-008), so they are NOT thrown as a UsageError.
 */
export class UsageError extends Error {
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "UsageError";
    }
}
/**
 * Compose the usage dependencies from the app + AppDeps: the config is resolved LIVE (the same env keys the
 * central AppConfig validates at boot), a fresh {@link UsageRepo} is the shared append/rollup accountant, and
 * `getEntitlement` is the E007 read used to re-resolve each event's metered target within the caller's tenant.
 */
export function buildUsageDeps(_app, deps) {
    return {
        pool: deps.pool,
        config: loadUsageConfig(),
        repo: new UsageRepo(),
        entitlementRead: getEntitlement,
    };
}
/**
 * The module's registration seam (ADR-0005/AD-009). Composes + publishes the usage deps on `app.usage`, then
 * registers the runtime POST /v1/usage ingest plane (US1, `usage.ingest` scope + per-key rate limit). The
 * admin aggregate-query route (US2) and the fail-open rollup + retention workers (US2/US6) layer onto this
 * same seam in the later phases, each reading `app.usage`.
 */
export function registerUsage(app, deps) {
    const usage = buildUsageDeps(app, deps);
    app.decorate("usage", usage);
    registerUsageRoutes(app, usage, deps.apiKeySecret);
}
