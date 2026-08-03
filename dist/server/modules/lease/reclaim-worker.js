import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { DEFAULT_SWEEP_MAX_BATCH, DEFAULT_SWEEP_SECONDS } from "./config.js";
import { LeaseRepo } from "./lease-repo.js";
/** The synthetic system actor every automatic reclamation is attributed to (FR-018). */
export const RECLAIM_ACTOR = "lease-reclaim-worker";
const repo = new LeaseRepo();
// The shared per-reason predicate: a live lease whose license state triggers a CONFIGURED `reclaim` policy
// (FR-024). Kept as one string so the tenant enumeration and the per-tenant reclaim can never diverge. The
// defaults (revoke⇒reclaim, suspend/expire⇒timer) mean suspend/expire only match when EXPLICITLY set to
// `reclaim`; a license past `expires_at` is the derived "expired" state (mirrors the acquire fail-closed check).
const POLICY_DUE_PREDICATE = `
  l.status = 'live'
  AND ( (lic.status = 'revoked'   AND lic.lease_policy_on_revoke  = 'reclaim')
     OR (lic.status = 'suspended' AND lic.lease_policy_on_suspend = 'reclaim')
     OR (lic.expires_at IS NOT NULL AND lic.expires_at < now() AND lic.lease_policy_on_expire = 'reclaim') )`;
/**
 * Enumerate the tenants with any live lease due for reclamation — a TTL+grace-lapsed live lease OR a live
 * lease whose license state triggers a configured per-reason `reclaim` policy (revoke/suspend/expire, FR-024).
 * Runs on the privileged (RLS-bypassing) role because the worker has no request tenant context; it reads only
 * distinct tenant ids, never row data — the per-tenant sweep below re-enters under `withTenant` (RLS) to touch
 * actual rows.
 */
async function listTenantsWithDueLeases(pool) {
    return privileged(pool, async (q) => {
        const r = await q(`SELECT DISTINCT l.tenant_id
         FROM lease l
         JOIN license lic ON lic.tenant_id = l.tenant_id AND lic.id = l.license_id
        WHERE l.status = 'live'
          AND ( l.expires_at + make_interval(secs => lic.lease_grace_seconds) < now()
                OR (${POLICY_DUE_PREDICATE}) )`);
        return r.rows.map((x) => x.tenant_id);
    });
}
/**
 * Proactively reclaim up to `maxBatch` LIVE leases whose license state triggers a configured per-reason
 * `reclaim` policy (FR-024), oldest-expired-first — regardless of TTL, so a revoked/suspended/expired
 * license's seats free within the sweep interval. Each reclaimed lease carries the matching reason
 * (`license_revoked` / `license_suspended` / `license_expired`) for the synthetic-actor audit (FR-018), with
 * revoke taking precedence over suspend over expire when several apply. `FOR UPDATE … SKIP LOCKED` keeps
 * concurrent sweeps disjoint and idempotent across runs, and the `status = 'live'` predicate never re-reclaims
 * a row already swept by the grace path in the same transaction.
 */
async function reclaimByPolicy(q, maxBatch) {
    const res = await q(`WITH due AS (
       SELECT l.id,
              CASE
                WHEN lic.status = 'revoked'   AND lic.lease_policy_on_revoke  = 'reclaim' THEN 'license_revoked'
                WHEN lic.status = 'suspended' AND lic.lease_policy_on_suspend = 'reclaim' THEN 'license_suspended'
                ELSE 'license_expired'
              END AS reason
         FROM lease l
         JOIN license lic ON lic.tenant_id = l.tenant_id AND lic.id = l.license_id
        WHERE ${POLICY_DUE_PREDICATE}
        ORDER BY l.expires_at ASC
        LIMIT $1
        FOR UPDATE OF l SKIP LOCKED
     ),
     reclaimed AS (
       UPDATE lease SET status = 'reclaimed', ended_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM due)
        RETURNING id, license_id
     )
     SELECT r.id, r.license_id, d.reason
       FROM reclaimed r JOIN due d ON d.id = r.id`, [maxBatch]);
    return res.rows.map((r) => ({
        id: r.id,
        licenseId: r.license_id,
        reason: r.reason,
    }));
}
/**
 * Run ONE reclaim sweep across every tenant with due leases. Fail-open: a per-tenant fault is caught + logged
 * and never aborts the others, and the whole sweep never throws (a top-level fault — e.g. the tenant
 * enumeration — is caught too), so reclamation can never block the live lease surface (FR-010/SC-008). Returns
 * the total number of leases reclaimed. Both the grace path and the per-reason policy-reclaim path audit each
 * reclamation with the synthetic worker actor + the lease/license id + the matching reason (FR-018).
 */
export async function reclaimSweep(pool, options = {}) {
    const maxBatch = options.maxBatch ?? DEFAULT_SWEEP_MAX_BATCH;
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "reclaim_worker_failed", context, error: err instanceof Error ? err.message : String(err) }, "lease reclaim step failed (fail-open); the live lease surface is unaffected");
        }
        catch {
            /* logging is best-effort */
        }
        options.onError?.(err);
    };
    let reclaimed = 0;
    try {
        const tenantIds = await listTenantsWithDueLeases(pool);
        for (const tenantId of tenantIds) {
            try {
                reclaimed += await withTenant(pool, tenantId, async (q) => {
                    const grace = await repo.sweep(q, { maxBatch });
                    const byPolicy = await reclaimByPolicy(q, maxBatch);
                    for (const l of grace) {
                        await writeAudit(q, { actor: RECLAIM_ACTOR, action: "lease.reclaimed", target: l.id, after: { licenseId: l.licenseId, reason: "ttl_grace" } });
                    }
                    for (const l of byPolicy) {
                        await writeAudit(q, { actor: RECLAIM_ACTOR, action: "lease.reclaimed", target: l.id, after: { licenseId: l.licenseId, reason: l.reason } });
                    }
                    return grace.length + byPolicy.length;
                });
            }
            catch (err) {
                // Per-tenant fail-open: a fault on one tenant never blocks reclamation (or the live surface) elsewhere.
                warn(err, `reclaim sweep for tenant ${tenantId}`);
            }
        }
    }
    catch (err) {
        warn(err, "reclaim sweep");
    }
    return { reclaimed };
}
/** Default cadence (ms) — one reclaim sweep per {@link DEFAULT_SWEEP_SECONDS} (1 minute). */
export const DEFAULT_RECLAIM_WORKER_INTERVAL_MS = DEFAULT_SWEEP_SECONDS * 1_000;
/**
 * Start the time-driven reclaim worker (FR-010). Fail-open and cancelable exactly like the E013 CRL worker:
 * the cadence timer is unref'd (never keeps the process alive), overlapping sweeps are prevented by a running
 * guard, and a fault never propagates. Wire from `main.ts`, tied to `app.close()`.
 */
export function startReclaimWorker(pool, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_RECLAIM_WORKER_INTERVAL_MS;
    let running = false;
    const runOnce = async () => {
        if (running)
            return; // never overlap sweeps
        running = true;
        try {
            await reclaimSweep(pool, options);
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
    return {
        stop: () => clearInterval(timer),
        runOnce,
    };
}
