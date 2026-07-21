import { getEffectivePlanDefinition } from "../catalog/effective.js";
import { loadBillingConfig } from "./config.js";
import { noopProviderFetch } from "./reconcile-worker.js";
import { registerBillingRoutes } from "./routes.js";
/**
 * A typed billing error carrying the HTTP status + machine code the routes surface as `{code,message,
 * details?}` (mirrors `IssuanceError`/`EnforcementError`). NOTE: a billing NO-OP (duplicate/dead-letter/
 * stale) is NOT an error -- it is a `200` ack with an `outcome`. This class is only for genuine protocol
 * faults: `invalid_signature` (401), `stale_timestamp` (400), `connection_not_found` (404), etc.
 */
export class BillingError extends Error {
    code;
    status;
    details;
    constructor(code, status, message, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = "BillingError";
    }
}
/**
 * Compose the billing dependencies from the app + AppDeps: `app.signer` / `app.custody` are published by
 * registerSigning (may be undefined in a deployment not yet signing), `getEffectivePlanDefinition` is the
 * E007 read, and the config is resolved LIVE (boot fail-fast on a bad env value via the central AppConfig).
 */
export function buildBillingDeps(app, deps) {
    return {
        pool: deps.pool,
        signer: app.signer,
        custody: app.custody,
        effective: getEffectivePlanDefinition,
        config: loadBillingConfig(),
        providerFetch: noopProviderFetch,
    };
}
/**
 * The module's registration seam (ADR-0005). Composes + publishes the billing deps, then registers the
 * webhook INGESTION plane (US1). The admin connection/registry/reconcile routes (US5/US6) and the grace/
 * reconcile workers (US3/US6) layer onto this same seam, each reading `app.billing`.
 */
export function registerBilling(app, deps) {
    const billing = buildBillingDeps(app, deps);
    app.decorate("billing", billing);
    registerBillingRoutes(app, billing);
}
