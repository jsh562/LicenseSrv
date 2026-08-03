import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { DEFAULT_BUCKET_SECONDS, DEFAULT_RETENTION_SECS } from "./config.js";
import { bucketStartFor } from "./rollup.js";
/** The synthetic system actor every automatic prune / GDPR erase is attributed to (FR-018). */
export const USAGE_RETENTION_ACTOR = "usage-retention-worker";
/** Default cadence (ms) — one prune sweep per hour (retention is a slow-moving bound, not latency-critical). */
export const DEFAULT_USAGE_RETENTION_INTERVAL_MS = 3_600_000;
/** Enumerate the tenants with any closed-bucket raw event (privileged — the worker has no request tenant). */
async function listTenantsWithClosedRaw(pool, firstOpenBucket) {
    return privileged(pool, async (q) => {
        const r = await q("SELECT DISTINCT tenant_id FROM usage_event WHERE event_time < $1", [firstOpenBucket]);
        return r.rows.map((x) => x.tenant_id);
    });
}
/** Prune one tenant's closed-bucket raw + distinct-set working rows on the OWNER role (explicit tenant scope). */
async function pruneTenant(pool, tenantId, firstOpenBucket) {
    return privileged(pool, async (q) => {
        // Prune raw events whose event_time is strictly before the first still-open bucket (their bucket is CLOSED,
        // so no partial bucket is touched, FR-015). The durable usage_rollup aggregate is NOT touched (INV-6).
        const de = await q("DELETE FROM usage_event WHERE tenant_id = $1 AND event_time < $2", [tenantId, firstOpenBucket]);
        // Prune the closed buckets' distinct-set working rows — their UNIQUE_COUNT is already FINAL in usage_rollup,
        // so distinct-set storage stays bounded to the open window without ever under-counting (SC-020).
        const du = await q("DELETE FROM usage_unique_value WHERE tenant_id = $1 AND bucket < $2", [tenantId, firstOpenBucket]);
        return { events: de.rowCount ?? 0, uniqueValues: du.rowCount ?? 0 };
    });
}
/**
 * Run ONE prune sweep across every tenant with closed-bucket raw (FR-015). FAIL-OPEN: a per-tenant fault is
 * caught + logged and never aborts the others, and the whole sweep never throws — a prune fault must never
 * block the live ingest surface. Returns the pruned counts; each tenant's prune is audited to the synthetic
 * actor (FR-018), and the durable usage_rollup + usage_unique_value aggregates for still-open buckets survive.
 */
export async function retentionSweep(pool, options = {}) {
    const retentionSecs = options.retentionSecs ?? DEFAULT_RETENTION_SECS;
    const bucketSeconds = options.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;
    const now = options.now ?? new Date();
    // The first still-OPEN bucket: everything strictly before it is CLOSED (past the acceptance window). Pruning
    // by this aligned boundary (not the raw cutoff) guarantees the straddling bucket is never partially pruned.
    const cutoff = new Date(now.getTime() - retentionSecs * 1000);
    const firstOpenBucket = bucketStartFor(cutoff, bucketSeconds);
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "usage_retention_failed", context, error: err instanceof Error ? err.message : String(err) }, "usage retention prune failed (fail-open); the live ingest surface is unaffected");
        }
        catch {
            /* logging is best-effort */
        }
        options.onError?.(err);
    };
    let tenants = 0;
    let events = 0;
    let uniqueValues = 0;
    try {
        const tenantIds = await listTenantsWithClosedRaw(pool, firstOpenBucket);
        for (const tenantId of tenantIds) {
            try {
                const r = await pruneTenant(pool, tenantId, firstOpenBucket);
                events += r.events;
                uniqueValues += r.uniqueValues;
                if (r.events > 0 || r.uniqueValues > 0) {
                    tenants++;
                    // Audit the prune to the synthetic actor (FR-018) — counts only, no secret/credential/dimension.
                    await withTenant(pool, tenantId, (q) => writeAudit(q, {
                        actor: USAGE_RETENTION_ACTOR,
                        action: "usage.retention_pruned",
                        after: { events: r.events, uniqueValues: r.uniqueValues },
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
    return { tenants, events, uniqueValues };
}
/**
 * GDPR-erase a tenant's usage across ALL THREE usage tables (FR-016/SC-013). Owner-role, tenant-scoped by an
 * EXPLICIT `tenant_id` predicate (never a tenant-agnostic bulk statement, HINT-004): removes that tenant's
 * `usage_event` (raw + idempotency keys), `usage_rollup` (durable aggregate), and `usage_unique_value`
 * (distinct-set side). Audited to the synthetic actor (FR-018). Idempotent — a re-run erases zero rows. Wired
 * into the platform GDPR path (`src/server/db/gdpr.ts`) alongside the E014 billing erasure.
 */
export async function eraseTenantUsage(pool, tenantId) {
    const erased = await privileged(pool, async (q) => {
        const de = await q("DELETE FROM usage_event WHERE tenant_id = $1", [tenantId]);
        const dr = await q("DELETE FROM usage_rollup WHERE tenant_id = $1", [tenantId]);
        const du = await q("DELETE FROM usage_unique_value WHERE tenant_id = $1", [tenantId]);
        return { events: de.rowCount ?? 0, rollups: dr.rowCount ?? 0, uniqueValues: du.rowCount ?? 0 };
    });
    // Audit the erasure to the synthetic actor (counts only, no PII). Best-effort — a tombstoned tenant's audit
    // payload may be redacted later by the platform GDPR path; the erasure event record itself is preserved.
    await withTenant(pool, tenantId, (q) => writeAudit(q, { actor: USAGE_RETENTION_ACTOR, action: "usage.erased", after: erased })).catch(() => undefined);
    return erased;
}
/**
 * Start the periodic usage-retention prune worker (FR-015). Fail-open and cancelable exactly like the E014
 * billing retention worker / E015 reclaim worker: the cadence timer is unref'd (never keeps the process
 * alive), overlapping sweeps are prevented by a running guard, and a prune fault is caught + logged and never
 * propagates (it re-fires on the next sweep, never crashing boot or blocking ingest). Wire from `main.ts`,
 * tied to `app.close()`.
 */
export function startUsageRetentionWorker(pool, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_USAGE_RETENTION_INTERVAL_MS;
    let running = false;
    const runOnce = async () => {
        if (running)
            return; // never overlap sweeps
        running = true;
        try {
            const { tenants, events, uniqueValues } = await retentionSweep(pool, {
                retentionSecs: options.retentionSecs,
                bucketSeconds: options.bucketSeconds,
                logger: options.logger,
                onError: options.onError,
            });
            if (events > 0 || uniqueValues > 0) {
                options.logger?.info?.({ event: "usage_retention_pruned", tenants, events, uniqueValues }, "pruned aged raw usage events + closed-bucket distinct-set rows (durable aggregate retained)");
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
