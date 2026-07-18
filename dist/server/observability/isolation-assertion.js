// Tenant-isolation continuous assertion (OR-011, OBJ3, per {SAD:ADR-0009} / ADR-0004). This is the
// DETECTION + SIGNAL half of the P1 SECURITY invariant: at the single `withTenant()` DB choke point
// (HINT-003) it compares the AUTHENTICATED principal's tenant (resolved at the auth seam and carried in
// the per-request AsyncLocalStorage context) against the `app.current_tenant` GUC about to be set for
// the transaction. On any mismatch it emits a dedicated, sampling-INDEPENDENT security signal — a
// labelless Prometheus counter that drives the immediate SEV1 page (OR-012) plus a structured security
// log event for forensics (OR-011). RLS remains the AUTHORITATIVE block; this assertion NEVER performs a
// cross-tenant read (it compares two in-memory identities only) and NEVER throws into `withTenant`.
//
// Fail-open discipline is inverted here relative to the rest of telemetry: the isolation SIGNAL itself
// must NEVER be suppressed. The counter increment (the pageable signal) is synchronous, local to the
// in-process registry, and independent of trace sampling / OTLP export, so a degraded backend can never
// drop it. Only the forensic LOG emission is wrapped fail-open — and only AFTER the counter has fired.
import { Counter } from "prom-client";
import { createLogger } from "./logger.js";
import { registry } from "./metrics.js";
import { getRequestContext } from "./request-context.js";
/** Metric name of the pageable isolation-violation counter (referenced by observability/prometheus/alert-rules.yml). */
export const ISOLATION_VIOLATION_METRIC = "tenant_isolation_violation_total";
/** Default assertion location recorded in the security event when fired from the `withTenant()` choke point. */
export const ASSERTION_LOCATION = "src/server/db/client.ts:withTenant";
/**
 * The labelless isolation-violation counter (OR-011). Registered on the SHARED metrics registry so the
 * dedicated `/metrics` listener exposes it. It carries NO high-cardinality / identity labels
 * (`tenant_id` / `request_id` / `license_key`) per the binding cardinality policy (OR-008, {SAD:ADR-0009});
 * the per-tenant/per-request detail lives in the structured security log event, not on the metric.
 */
const tenantIsolationViolationTotal = new Counter({
    name: ISOLATION_VIOLATION_METRIC,
    help: "Detected tenant-isolation violations (authenticated tenant != app.current_tenant GUC, or a synthetic-canary cross-tenant leak). Drives the immediate SEV1 isolation page; carries no per-tenant/identity labels (OR-008).",
    registers: [registry],
});
/** Accessor for the isolation-violation counter (tests read its value; Phase 6 wires further signals). */
export function getIsolationViolationCounter() {
    return tenantIsolationViolationTotal;
}
/** Build the default security-event logger (structured JSON to stdout — the OR-011 security-log stream). */
function defaultSecurityLogger() {
    return createLogger({ logLevel: "info", logFormat: "json" });
}
// The sink the security event is written to. Overridable (tests capture it; bootstrap may point it at
// `app.log`), but NEVER settable to a no-op that would suppress the signal — passing `undefined` restores
// the default stdout logger rather than silencing it.
let securityLogger = defaultSecurityLogger();
/** Point the security-event log at a specific sink (tests / bootstrap). `undefined` restores the default. */
export function setSecurityLogger(logger) {
    securityLogger = logger ?? defaultSecurityLogger();
}
/**
 * Emit the dedicated isolation security signal (OR-011): increment the pageable counter, then write the
 * structured security log event. The counter fires FIRST and UNCONDITIONALLY — it is the sampling- and
 * export-independent signal that must never be suppressed (OR-014) — so even if the forensic log write
 * fails, the SEV1 page still fires. Both the assertion and the canary route violations through here so
 * they share one signal definition (RR-001).
 */
export function recordIsolationViolation(event) {
    // (1) The pageable signal — synchronous, local, never wrapped in a suppressing catch.
    tenantIsolationViolationTotal.inc();
    // (2) The forensic security log event (OR-011 fields) — fail-open, and only after (1).
    try {
        securityLogger.error({
            event: "tenant_isolation_violation",
            security_event: true,
            request_id: event.requestId,
            authenticated_tenant: event.authenticatedTenant,
            attempted_tenant: event.attemptedTenant,
            assertion_location: event.location,
            source: event.source,
            outcome: event.outcome,
        }, "tenant isolation violation detected");
    }
    catch {
        /* fail-open on the forensic log only: the counter (the pageable signal) already fired above */
    }
}
/**
 * Assert, at the `withTenant()` choke point, that the authenticated principal's tenant equals the tenant
 * GUC being set (OR-011). Compares two IN-MEMORY identities only — it performs NO database query and NO
 * cross-tenant read; RLS remains the authoritative block. On a mismatch it emits the isolation signal
 * (counter + security log). When there is NO authenticated request context (background / privileged /
 * migration / canary paths) or the tenant is not yet resolved, there is nothing to compare, so it stays
 * silent. It NEVER throws — `withTenant`'s behavior and signature are untouched (the assertion only
 * signals; RLS blocks).
 *
 * @param gucTenantId the tenant the transaction is about to scope to via `set_config('app.current_tenant')`.
 */
export function assertTenantMatch(gucTenantId) {
    try {
        const ctx = getRequestContext();
        // No authenticated principal in scope (pre-auth, background worker, canary, migration) → nothing to
        // compare, so nothing to signal. This is the correct silence, not a suppressed violation.
        if (!ctx || ctx.tenantId === undefined)
            return;
        // Same tenant → the invariant holds; the overwhelmingly common path stays silent (no counter, no log).
        if (ctx.tenantId === gucTenantId)
            return;
        // Mismatch: the authenticated tenant differs from the GUC tenant. Signal it. RLS still blocks the
        // actual rows; this records the detection without itself reading another tenant's data.
        recordIsolationViolation({
            requestId: ctx.requestId ?? null,
            authenticatedTenant: ctx.tenantId,
            attemptedTenant: gucTenantId,
            location: ASSERTION_LOCATION,
            source: "assertion",
            outcome: "blocked",
        });
    }
    catch {
        /* the assertion must never throw into withTenant; any violation was already signaled above */
    }
}
