import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { resolvePlanWindows } from "./config.js";
import { generateCrl, getLatestCrl, projectRevokedIds } from "./crl.js";
const ACTOR = "crl-worker";
/** Default cadence (ms) — one publication sweep per minute. Low enough to propagate a revocation promptly. */
export const DEFAULT_CRL_WORKER_INTERVAL_MS = 60_000;
const sameSet = (a, b) => {
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    return b.every((x) => set.has(x));
};
const sameRevokedIds = (a, b) => sameSet(a.licenses, b.licenses) && sameSet(a.activations, b.activations);
/**
 * Enumerate the tenants that could need a CRL: any with a revoked license, a deactivated activation, or an
 * already-published CRL (so an elapsed `next_update` still gets refreshed). Runs on the privileged
 * (RLS-bypassing) role because the worker has no request tenant context; it only reads distinct tenant ids,
 * never row data — the per-tenant work below re-enters under `withTenant` (RLS) to touch actual rows.
 */
async function listTenantsWithRevocations(pool) {
    return privileged(pool, async (q) => {
        const r = await q(`SELECT DISTINCT tenant_id FROM license WHERE status = 'revoked'
       UNION
       SELECT DISTINCT tenant_id FROM activation WHERE status = 'deactivated'
       UNION
       SELECT DISTINCT tenant_id FROM revocation_list`);
        return r.rows.map((x) => x.tenant_id);
    });
}
/** The candidate products (within the current tenant scope) that could need a CRL — same three sources. */
async function listCandidateProducts(q) {
    const r = await q(`SELECT DISTINCT product_id FROM license WHERE status = 'revoked'
     UNION
     SELECT DISTINCT l.product_id FROM activation a JOIN license l ON l.id = a.license_id WHERE a.status = 'deactivated'
     UNION
     SELECT DISTINCT product_id FROM revocation_list`);
    return r.rows.map((x) => x.product_id);
}
/**
 * Publish (regenerate + audit) the CRL for one (tenant, product) IF it is stale — the revoked set changed
 * or the current version's `next_update` has elapsed. A no-content product with no prior CRL is skipped
 * (nothing to publish). Runs in its OWN `withTenant` tx so one product's fault cannot roll back another's.
 */
async function publishIfStale(pool, tenantId, productId, signer, windows) {
    await withTenant(pool, tenantId, async (q) => {
        const current = await projectRevokedIds(q, productId);
        const latest = await getLatestCrl(q, tenantId, productId);
        const hasContent = current.licenses.length + current.activations.length > 0;
        // Nothing to publish for a product that has no revocations and no prior CRL.
        if (!hasContent && !latest)
            return;
        const changed = latest === null || !sameRevokedIds(latest.revokedIds, current);
        const stale = latest !== null && Date.parse(latest.nextUpdate) <= Date.now();
        if (!changed && !stale)
            return;
        const record = await generateCrl(q, tenantId, productId, signer, windows);
        await writeAudit(q, {
            actor: ACTOR,
            action: "crl.published",
            target: productId,
            after: { version: record.version, licenses: record.revokedIds.licenses.length, activations: record.revokedIds.activations.length },
        });
    });
}
/**
 * Start the CRL publication worker (FR-009). Returns a stop handle. Fail-open and cancelable exactly like
 * the E012 canary: the cadence timer is unref'd, a fault on any tenant/product/sweep is caught + logged and
 * never propagates, and overlapping sweeps are prevented by a running guard. With no signer configured the
 * worker no-ops (a CRL cannot be signed without the E004 key — fail-open, the client's short-token TTL still
 * bounds staleness). `windows` come from the deployment defaults (a CRL is per-product, not per-plan).
 */
export function startCrlWorker(pool, signer, config, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_CRL_WORKER_INTERVAL_MS;
    const windows = resolvePlanWindows(config);
    let running = false;
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "crl_worker_failed", context, error: err instanceof Error ? err.message : String(err) }, "CRL worker step failed (fail-open); the client falls back to short-token-TTL enforcement");
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
            if (!signer)
                return; // no key → cannot sign a CRL; fail-open no-op
            const tenantIds = await listTenantsWithRevocations(pool);
            for (const tenantId of tenantIds) {
                let products;
                try {
                    products = await withTenant(pool, tenantId, (q) => listCandidateProducts(q));
                }
                catch (err) {
                    warn(err, `enumerate products for tenant ${tenantId}`);
                    continue;
                }
                for (const productId of products) {
                    try {
                        await publishIfStale(pool, tenantId, productId, signer, windows);
                    }
                    catch (err) {
                        // Per-product fail-open: a signer fault or a version race on one product never blocks the rest.
                        warn(err, `publish CRL for product ${productId}`);
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
    // Never let the worker keep the process alive — it is best-effort background publication (fail-open).
    if (typeof timer.unref === "function")
        timer.unref();
    if (options.immediate !== false)
        void runOnce();
    return {
        stop: () => clearInterval(timer),
        runOnce,
    };
}
