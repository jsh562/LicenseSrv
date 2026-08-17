import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { DEFAULT_EVALUATION_RETENTION_SECS } from "./config.js";
/** The synthetic system actor every automatic policy_evaluation prune is attributed to (FR-014). */
export const POLICY_RETENTION_ACTOR = "policy-retention-worker";
/** Default cadence (ms) — one prune sweep per hour (retention is a slow-moving bound, not latency-critical). */
export const DEFAULT_POLICY_RETENTION_INTERVAL_MS = 3_600_000;
/** Enumerate the tenants with any aged evaluation row (privileged — the worker has no request tenant). */
async function listTenantsWithAgedEvaluations(pool, cutoff) {
    return privileged(pool, async (q) => {
        const r = await q("SELECT DISTINCT tenant_id FROM policy_evaluation WHERE created_at < $1", [cutoff]);
        return r.rows.map((x) => x.tenant_id);
    });
}
/** Prune one tenant's aged `policy_evaluation` rows on the OWNER role (explicit tenant scope, BRIN-backed). */
async function pruneTenant(pool, tenantId, cutoff) {
    return privileged(pool, async (q) => {
        // Delete evaluation rows whose created_at is strictly before the retention cutoff. The BRIN
        // policy_evaluation_prune(created_at) index backs this age scan. Explicit tenant_id predicate → single-tenant.
        const d = await q("DELETE FROM policy_evaluation WHERE tenant_id = $1 AND created_at < $2", [tenantId, cutoff]);
        return d.rowCount ?? 0;
    });
}
/**
 * Run ONE prune sweep across every tenant with aged `policy_evaluation` rows (FR-014). FAIL-OPEN: a per-tenant
 * fault is caught + logged and never aborts the others, and the whole sweep never throws — a prune fault must
 * never block the live issuance/authoring surface. Returns the pruned counts; each tenant's prune is audited to
 * the synthetic actor (FR-014). The append-only audit trail's still-in-window rows survive.
 */
export async function policyRetentionSweep(pool, options = {}) {
    const retentionSecs = options.retentionSecs ?? DEFAULT_EVALUATION_RETENTION_SECS;
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - retentionSecs * 1000);
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "policy_retention_failed", context, error: err instanceof Error ? err.message : String(err) }, "policy_evaluation retention prune failed (fail-open); the live issuance/authoring surface is unaffected");
        }
        catch {
            /* logging is best-effort */
        }
        options.onError?.(err);
    };
    let tenants = 0;
    let evaluations = 0;
    try {
        const tenantIds = await listTenantsWithAgedEvaluations(pool, cutoff);
        for (const tenantId of tenantIds) {
            try {
                const pruned = await pruneTenant(pool, tenantId, cutoff);
                evaluations += pruned;
                if (pruned > 0) {
                    tenants++;
                    // Audit the prune to the synthetic actor (FR-014) — counts only, no secret/credential/PII.
                    await withTenant(pool, tenantId, (q) => writeAudit(q, {
                        actor: POLICY_RETENTION_ACTOR,
                        action: "policy.retention_pruned",
                        after: { evaluations: pruned },
                    })).catch((err) => warn(err, `retention audit for tenant ${tenantId}`));
                }
            }
            catch (err) {
                warn(err, `retention prune for tenant ${tenantId}`);
            }
        }
    }
    catch (err) {
        warn(err, "retention sweep");
    }
    return { tenants, evaluations };
}
/**
 * Start the periodic policy_evaluation retention prune worker (FR-014). Fail-open and cancelable exactly like the
 * E016 usage retention worker / the E014 billing retention worker: the cadence timer is unref'd (never keeps the
 * process alive), overlapping sweeps are prevented by a running guard, and a prune fault is caught + logged and
 * never propagates (it re-fires on the next sweep, never crashing boot or blocking issuance). Wire from `main.ts`,
 * tied to `app.close()`.
 */
export function startPolicyRetentionWorker(pool, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_POLICY_RETENTION_INTERVAL_MS;
    let running = false;
    const runOnce = async () => {
        if (running)
            return; // never overlap sweeps
        running = true;
        try {
            const { tenants, evaluations } = await policyRetentionSweep(pool, {
                retentionSecs: options.retentionSecs,
                logger: options.logger,
                onError: options.onError,
            });
            if (evaluations > 0) {
                options.logger?.info?.({ event: "policy_retention_pruned", tenants, evaluations }, "pruned aged policy_evaluation audit rows (still-in-window trail retained)");
            }
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => void runOnce(), intervalMs);
    if (typeof timer.unref === "function")
        timer.unref();
    if (options.immediate === true)
        void runOnce();
    return { stop: () => clearInterval(timer), runOnce };
}
