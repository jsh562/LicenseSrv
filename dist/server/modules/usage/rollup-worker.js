import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { DEFAULT_BUCKET_SECONDS, DEFAULT_ROLLUP_INTERVAL_MS } from "./config.js";
import { bucketStartFor, rollupBucket } from "./rollup.js";
import { UsageRepo } from "./usage-repo.js";
/** The synthetic system actor every automatic rollup pass is attributed to (FR-018). */
export const ROLLUP_ACTOR = "usage-rollup-worker";
/** Default per-tenant raw-event cap per sweep (bounds a single pass's transaction; the tail rolls next sweep). */
export const DEFAULT_ROLLUP_MAX_BATCH = 5_000;
const repo = new UsageRepo();
/** Enumerate the tenants with any raw event beyond the watermark (privileged — no request tenant context). */
async function listTenantsWithRawSince(pool, since) {
    return privileged(pool, async (q) => {
        const r = await q("SELECT DISTINCT tenant_id FROM usage_event WHERE ingested_at > $1", [since]);
        return r.rows.map((x) => x.tenant_id);
    });
}
/** Read the aggregation + allowance for a set of entitlement ids within the caller's tenant (RLS). */
async function readEntitlementMeta(q, ids) {
    const out = new Map();
    if (ids.length === 0)
        return out;
    const r = await q("SELECT id, aggregation, allowance FROM entitlement WHERE id = ANY($1::uuid[])", [ids]);
    for (const row of r.rows) {
        out.set(row.id, { aggregation: row.aggregation, allowance: row.allowance === null ? null : Number(row.allowance) });
    }
    return out;
}
/**
 * Roll up ONE tenant's raw stream beyond `since` (already inside `withTenant`, forced RLS). Reads the bounded
 * oldest-first raw batch, groups it by `(license, entitlement, bucket)`, recomputes each affected bucket from
 * the retained raw, and audits the pass to the synthetic actor. Returns the folded event count, the distinct
 * bucket count, the max `ingested_at` folded, and whether the batch was capped (so the caller can advance the
 * watermark safely without skipping a tail).
 */
async function rollupTenant(q, since, bucketSeconds, maxBatch) {
    const raw = await repo.selectRawSince(q, since, maxBatch);
    if (raw.length === 0)
        return { processed: 0, buckets: 0, maxIngestedAt: since, capped: false };
    const meta = await readEntitlementMeta(q, [...new Set(raw.map((e) => e.entitlementId))]);
    // Group by (license, entitlement, bucket) — a late event's older bucket is grouped here too (FR-012).
    const groups = new Map();
    let maxIngestedAt = since;
    for (const e of raw) {
        if (e.ingestedAt > maxIngestedAt)
            maxIngestedAt = e.ingestedAt;
        const bucketStart = bucketStartFor(e.eventTime, bucketSeconds);
        const key = `${e.licenseId}|${e.entitlementId}|${bucketStart.getTime()}`;
        let g = groups.get(key);
        if (!g) {
            g = { licenseId: e.licenseId, entitlementId: e.entitlementId, bucketStart, events: [] };
            groups.set(key, g);
        }
        g.events.push({ dimensions: e.dimensions, ingestedAt: e.ingestedAt });
    }
    let buckets = 0;
    for (const g of groups.values()) {
        const m = meta.get(g.entitlementId);
        // A non-metered / unknown entitlement (aggregation NULL) can never have valid raw here, but guard anyway.
        if (!m || m.aggregation === null)
            continue;
        await rollupBucket(q, repo, {
            licenseId: g.licenseId,
            entitlementId: g.entitlementId,
            bucketStart: g.bucketStart,
            bucketSeconds,
            aggType: m.aggregation,
            allowance: m.allowance,
            events: g.events,
        });
        buckets++;
    }
    // FR-018: audit the rollup pass to the synthetic system actor — counts only, no secret/credential/dimension.
    await writeAudit(q, {
        actor: ROLLUP_ACTOR,
        action: "usage.rollup",
        after: { processed: raw.length, buckets },
    });
    return { processed: raw.length, buckets, maxIngestedAt, capped: raw.length >= maxBatch };
}
/**
 * Run ONE rollup sweep across every tenant with raw events beyond the watermark (FR-010). Fail-open: a
 * per-tenant fault is caught + logged and never aborts the others, and the whole sweep never throws (a
 * top-level fault — e.g. the tenant enumeration — is caught too), so a rollup fault can never block the live
 * ingest surface. Returns the folded/bucket counts and the SAFE advanced watermark to feed the next sweep:
 * the max `ingested_at` folded, but clamped to the least-progressed CAPPED tenant so no tail is skipped
 * (re-folding an already-rolled bucket is a harmless idempotent recompute, SC-004).
 */
export async function rollupSweep(pool, options = {}) {
    const since = options.since ?? new Date(0);
    const bucketSeconds = options.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;
    const maxBatch = options.maxBatch ?? DEFAULT_ROLLUP_MAX_BATCH;
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "rollup_worker_failed", context, error: err instanceof Error ? err.message : String(err) }, "usage rollup step failed (fail-open); the live ingest surface is unaffected");
        }
        catch {
            /* logging is best-effort */
        }
        options.onError?.(err);
    };
    let processed = 0;
    let buckets = 0;
    let globalMax = since;
    let cappedMin = null;
    try {
        const tenantIds = await listTenantsWithRawSince(pool, since);
        for (const tenantId of tenantIds) {
            try {
                const r = await withTenant(pool, tenantId, (q) => rollupTenant(q, since, bucketSeconds, maxBatch));
                processed += r.processed;
                buckets += r.buckets;
                if (r.maxIngestedAt > globalMax)
                    globalMax = r.maxIngestedAt;
                if (r.capped && (cappedMin === null || r.maxIngestedAt < cappedMin))
                    cappedMin = r.maxIngestedAt;
            }
            catch (err) {
                // Per-tenant fail-open: a fault on one tenant never blocks rollup (or the live surface) elsewhere.
                warn(err, `rollup sweep for tenant ${tenantId}`);
            }
        }
    }
    catch (err) {
        warn(err, "rollup sweep");
    }
    // Advance the watermark to the max folded ingested_at, but never past a capped tenant's last-processed row.
    const nextSince = cappedMin ?? globalMax;
    return { processed, buckets, since: nextSince };
}
/**
 * Start the time-driven watermark rollup worker (FR-010). Fail-open and cancelable exactly like the E015
 * reclaim / E014 retention workers: the cadence timer is unref'd (never keeps the process alive), overlapping
 * sweeps are prevented by a running guard, and a fault never propagates. The watermark advances across sweeps
 * so each pass folds only fresh raw; a restart resets it to the epoch and re-folds idempotently (no
 * double-count, SC-004). Wire from `main.ts`, tied to `app.close()`.
 */
export function startRollupWorker(pool, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_ROLLUP_INTERVAL_MS;
    let since = options.since ?? new Date(0);
    let running = false;
    const runOnce = async () => {
        if (running)
            return; // never overlap sweeps
        running = true;
        try {
            const result = await rollupSweep(pool, { ...options, since });
            since = result.since;
            if (result.buckets > 0) {
                options.logger?.info?.({ event: "usage_rolled_up", processed: result.processed, buckets: result.buckets }, "usage rollup swept fresh raw into the durable aggregate");
            }
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => void runOnce(), intervalMs);
    if (typeof timer.unref === "function")
        timer.unref();
    if (options.immediate !== false)
        void runOnce();
    return { stop: () => clearInterval(timer), runOnce, watermark: () => since };
}
