import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { suspendLicense } from "../issuance/lifecycle.js";
/** The synthetic system actor recorded on a time-driven auto-suspend (FR-013 — not a human, no event id). */
export const GRACE_WORKER_ACTOR = "billing-grace-worker";
/** Default cadence (ms) — one grace-expiry sweep per minute (matches the CRL worker cadence). */
export const DEFAULT_GRACE_WORKER_INTERVAL_MS = 60_000;
/** Enumerate the tenants with at least one subscription whose grace window has elapsed (privileged read). */
async function listTenantsWithElapsedGrace(pool) {
    return privileged(pool, async (q) => {
        const r = await q(`SELECT DISTINCT tenant_id FROM subscription
        WHERE billing_state IN ('past_due','grace') AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()`);
        return r.rows.map((x) => x.tenant_id);
    });
}
/** The elapsed-grace subscriptions within the current tenant scope (the partial `subscription_grace` index). */
async function listElapsedSubscriptions(q) {
    const r = await q(`SELECT id, license_id FROM subscription
      WHERE billing_state IN ('past_due','grace') AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()
      ORDER BY grace_expires_at ASC`);
    return r.rows.map((x) => ({ id: x.id, licenseId: x.license_id }));
}
/**
 * Auto-suspend one elapsed-grace subscription in its OWN tenant transaction (so one subscription's fault
 * cannot roll back another's). Re-locks the subscription FOR UPDATE and re-checks the grace window inside the
 * tx (a recovering payment between the sweep list and here re-cleared it → skip). Drives E008 `suspend` when
 * the license is still `active`, advances `billing_state → canceled` + clears `grace_expires_at` WITHOUT
 * touching `last_applied_event_at` (a time-driven suspend must not poison the event recency anchor, FR-016),
 * and audits with the synthetic actor + subscription id.
 */
async function suspendElapsed(pool, tenantId, subscriptionId) {
    await withTenant(pool, tenantId, async (q) => {
        const locked = await q(`SELECT license_id FROM subscription
        WHERE id = $1 AND billing_state IN ('past_due','grace')
          AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()
        FOR UPDATE`, [subscriptionId]);
        if (!locked.rowCount)
            return; // recovered / already advanced between the sweep list and the lock
        const licenseId = locked.rows[0].license_id;
        const lic = await q("SELECT status FROM license WHERE id = $1 FOR UPDATE", [licenseId]);
        if (!lic.rowCount)
            return;
        const status = lic.rows[0].status;
        if (status === "revoked")
            return; // terminal — never drive a revoked license
        if (status === "active")
            await suspendLicense(pool, tenantId, GRACE_WORKER_ACTOR, licenseId, q); // E008 (in-tx)
        // Advance the overlay to canceled + clear grace WITHOUT touching last_applied_event_at (time-driven).
        await q("UPDATE subscription SET billing_state = 'canceled', grace_expires_at = NULL, updated_at = now() WHERE id = $1", [subscriptionId]);
        await writeAudit(q, {
            actor: GRACE_WORKER_ACTOR,
            action: "billing.auto_suspended",
            target: licenseId,
            after: { subscriptionId },
        });
    });
}
/**
 * Start the grace-expiry auto-suspend worker (FR-008). Returns a stop handle. Fail-open and cancelable
 * exactly like the E013 CRL worker: the cadence timer is unref'd, a fault on any tenant/subscription/sweep is
 * caught + logged and never propagates, and overlapping sweeps are prevented by a running guard.
 */
export function startGraceWorker(pool, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_GRACE_WORKER_INTERVAL_MS;
    let running = false;
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "grace_worker_failed", context, error: err instanceof Error ? err.message : String(err) }, "grace worker step failed (fail-open); auto-suspend retries on the next sweep");
        }
        catch {
            /* logging is best-effort */
        }
        options.onError?.(err);
    };
    const runOnce = async () => {
        if (running)
            return; // never overlap sweeps
        running = true;
        try {
            const tenantIds = await listTenantsWithElapsedGrace(pool);
            for (const tenantId of tenantIds) {
                let subs;
                try {
                    subs = await withTenant(pool, tenantId, (q) => listElapsedSubscriptions(q));
                }
                catch (err) {
                    warn(err, `enumerate elapsed grace for tenant ${tenantId}`);
                    continue;
                }
                for (const sub of subs) {
                    try {
                        await suspendElapsed(pool, tenantId, sub.id);
                    }
                    catch (err) {
                        // Per-subscription fail-open: a lock/transition race on one never blocks the rest.
                        warn(err, `auto-suspend subscription ${sub.id}`);
                    }
                }
            }
        }
        catch (err) {
            warn(err, "sweep");
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => void runOnce(), intervalMs);
    // Never let the worker keep the process alive — it is best-effort background enforcement (fail-open).
    if (typeof timer.unref === "function")
        timer.unref();
    if (options.immediate !== false)
        void runOnce();
    return {
        stop: () => clearInterval(timer),
        runOnce,
    };
}
