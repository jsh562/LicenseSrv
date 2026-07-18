// Synthetic tenant-isolation canary (OR-012, OBJ3). A background worker that, at a configurable cadence
// (default ~60 s), attempts a KNOWN cross-tenant access against the live control plane using DEDICATED
// reserved synthetic tenant fixtures (NEVER real customer tenants/data) and validates that RLS blocks it
// end-to-end. Two outcomes are classified DISTINCTLY:
//
//   - BREACH  — the cross-tenant attempt was NOT blocked (data leaked). This is the pageable outcome: it
//               increments the shared isolation-violation counter (the SEV1 page path, OR-011/012).
//   - PROBE-FAILURE — the probe could not complete (infra/transport error). This is NOT a breach and MUST
//               NOT trigger the isolation page; it only feeds the dead-man's switch (`canary_up` /
//               `canary_last_success_timestamp_seconds`) so a silently-dead canary is still noticed.
//
// The worker is FAIL-OPEN and CANCELABLE: a probe failure never crashes the app, and the interval timer
// is unref'd so it never keeps the process alive. The probe fn and clock are injectable so unit/integration
// tests exercise a single run deterministically without waiting a full cadence.
import { Gauge } from "prom-client";
import { withTenant } from "../db/client.js";
import { recordIsolationViolation } from "./isolation-assertion.js";
import { registry } from "./metrics.js";
/** Default canary cadence (ms) — one probe per minute, per OR-012. */
export const DEFAULT_CANARY_INTERVAL_MS = 60_000;
/** Where the canary records a detected breach in the security event. */
export const CANARY_LOCATION = "src/server/observability/canary.ts:crossTenantProbe";
/**
 * Canary health / dead-man's-switch gauge: 1 when the last probe EXECUTED to completion (regardless of
 * blocked vs. breach), 0 when the last probe FAILED to execute. This is the liveness signal, NOT the
 * breach signal — a breach is reported via the isolation-violation counter, not by flipping this to 0.
 */
const canaryUp = new Gauge({
    name: "canary_up",
    help: "Tenant-isolation canary liveness: 1 = last probe executed to completion, 0 = probe execution failed (dead-man's switch). Distinct from the breach signal (tenant_isolation_violation_total).",
    registers: [registry],
});
/** Unix timestamp (seconds) of the last canary probe that executed to completion — feeds the staleness dead-man's switch. */
const canaryLastSuccess = new Gauge({
    name: "canary_last_success_timestamp_seconds",
    help: "Unix timestamp (seconds) of the last tenant-isolation canary probe that executed to completion. Staleness relative to the cadence signals a dead canary.",
    registers: [registry],
});
/** Accessor for the canary liveness gauge (tests inspect its value). */
export function getCanaryUpGauge() {
    return canaryUp;
}
/** Accessor for the canary last-success-timestamp gauge (tests inspect its value). */
export function getCanaryLastSuccessGauge() {
    return canaryLastSuccess;
}
/**
 * Build the standard cross-tenant probe against a real pool: scope a transaction to `scopedTenant` and try
 * to read `targetTenant`'s own `tenant` row. A well-behaved RLS makes that row invisible → 0 rows →
 * `blocked`; ANY visible row means isolation failed → `breach`. Both synthetic tenants MUST be provisioned
 * (reserved fixtures, never real customers) so the probe reads a KNOWN-existing cross-tenant row and thus
 * distinguishes "hidden by RLS" from "does not exist". A query/transport error propagates (→ dead-man's
 * switch), never a false `blocked`.
 */
export function makeCrossTenantProbe(cfg) {
    return async () => {
        const visibleRows = await withTenant(cfg.pool, cfg.scopedTenant, async (q) => {
            const r = await q("SELECT count(*)::int AS n FROM tenant WHERE id = $1", [cfg.targetTenant]);
            return r.rows[0].n;
        });
        return {
            outcome: visibleRows > 0 ? "breach" : "blocked",
            scopedTenant: cfg.scopedTenant,
            targetTenant: cfg.targetTenant,
        };
    };
}
/**
 * Start the synthetic isolation canary (OR-012). Returns a stop handle. Fail-open and cancelable: the
 * cadence timer is unref'd (never keeps the process alive), a probe execution failure never throws out of
 * the worker, and `stop()` cleanly cancels it. A BREACH pages via the shared isolation counter; a probe
 * FAILURE only trips the dead-man's switch — the two never cross.
 */
export function startCanary(opts) {
    const intervalMs = opts.intervalMs ?? DEFAULT_CANARY_INTERVAL_MS;
    const clock = opts.clock ?? Date.now;
    const runOnce = async () => {
        try {
            const result = await opts.probe();
            if (result.outcome === "breach") {
                // Cross-tenant access was NOT blocked → a genuine leak → the pageable isolation signal (OR-011/012).
                const event = {
                    requestId: null,
                    authenticatedTenant: result.scopedTenant ?? null,
                    attemptedTenant: result.targetTenant ?? "unknown",
                    location: CANARY_LOCATION,
                    source: "canary",
                    outcome: "not_blocked",
                };
                recordIsolationViolation(event);
            }
            // The probe COMPLETED (blocked or breach) → the canary is alive → refresh the dead-man's switch.
            canaryUp.set(1);
            canaryLastSuccess.set(Math.floor(clock() / 1000));
        }
        catch (err) {
            // Probe EXECUTION failure (infra/transport). Classified DISTINCTLY from a breach: it MUST NOT page
            // isolation — it only trips the dead-man's switch so a broken/silent canary is noticed (OR-012).
            canaryUp.set(0);
            try {
                opts.logger?.warn({ event: "canary_probe_failed", error: err instanceof Error ? err.message : String(err) }, "tenant-isolation canary probe failed to execute (dead-man's switch); NOT an isolation breach");
            }
            catch {
                /* logging is best-effort */
            }
            opts.onError?.(err);
        }
    };
    const timer = setInterval(() => void runOnce(), intervalMs);
    // Never let the canary keep the process alive — it is best-effort background telemetry (fail-open).
    if (typeof timer.unref === "function")
        timer.unref();
    if (opts.immediate !== false)
        void runOnce();
    return {
        stop: () => clearInterval(timer),
        runOnce,
    };
}
