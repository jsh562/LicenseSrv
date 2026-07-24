import { privileged } from "../../db/client.js";
import { IDEMPOTENCY_FLOOR_SECS, resolveLedgerRetentionSecs } from "./config.js";
import { pruneBillingEvents } from "./ledger-repo.js";
/** Default cadence (ms) — one retention sweep per hour (retention is a slow-moving GDPR bound, not latency-critical). */
export const DEFAULT_RETENTION_WORKER_INTERVAL_MS = 3_600_000;
/**
 * Prune the billing-event ledger to its retention horizon ONCE (FR-021). Resolves the live horizon and CLAMPS it
 * strictly above the idempotency floor (`resolveLedgerRetentionSecs`), then re-asserts that invariant defensively
 * before computing the cutoff `nowUnix - retention`: a horizon at/below the floor could prune a live idempotency
 * window, so it fails LOUD here (the worker's `runOnce` catches it fail-open). Runs the DELETE on the schema-OWNER
 * (privileged) connection because the app role has no DELETE grant on the append-only ledger. Returns the deleted
 * count; THROWS on a DB/privilege fault (the caller — the worker — decides fail-open).
 */
export async function pruneBillingLedger(pool, config, nowUnix) {
    const retentionSecs = resolveLedgerRetentionSecs(config.ledgerRetentionSecs);
    /* v8 ignore next 6 -- defensive: resolveLedgerRetentionSecs already clamps to floor+1, so this guard is
       unreachable; it is a belt-and-braces assert so a future regression can never let the prune horizon dip
       into a still-redeliverable event id's window (FR-003). */
    if (retentionSecs <= IDEMPOTENCY_FLOOR_SECS) {
        throw new Error(`billing retention horizon ${retentionSecs}s must stay strictly above the idempotency floor ${IDEMPOTENCY_FLOOR_SECS}s`);
    }
    const olderThanUnix = nowUnix - retentionSecs;
    // Owner-privileged: the app role holds SELECT/INSERT-only on billing_event (append-only), so the prune runs
    // RLS-bypassing on the schema-owner connection — matching the E013 pruneExpiredCheckins platform-owner path.
    return privileged(pool, (q) => pruneBillingEvents(q, olderThanUnix));
}
/**
 * Start the periodic ledger-retention prune worker (FR-021/SC-015). Returns a stop handle. Fail-open and
 * cancelable exactly like the E013 CRL worker / the grace + reconcile workers: the cadence timer is unref'd, a
 * prune fault is caught + logged and never propagates (retention re-fires on the next sweep), and overlapping
 * sweeps are prevented by a running guard. Tied to `app.close()` from main.ts.
 */
export function startBillingRetentionWorker(pool, config, options = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_WORKER_INTERVAL_MS;
    const clock = options.nowUnix ?? (() => Math.floor(Date.now() / 1000));
    let running = false;
    const warn = (err, context) => {
        try {
            options.logger?.warn({ event: "retention_worker_failed", context, error: err instanceof Error ? err.message : String(err) }, "billing retention prune failed (fail-open); it retries on the next sweep");
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
            const { deleted } = await pruneBillingLedger(pool, config, clock());
            if (deleted > 0) {
                options.logger?.info?.({ event: "retention_pruned", deleted }, "pruned aged billing-event ledger rows");
            }
        }
        catch (err) {
            warn(err, "prune");
        }
        finally {
            running = false;
        }
    };
    const timer = setInterval(() => void runOnce(), intervalMs);
    // Never let the worker keep the process alive — it is best-effort background maintenance (fail-open).
    if (typeof timer.unref === "function")
        timer.unref();
    if (options.immediate === true)
        void runOnce();
    return { stop: () => clearInterval(timer), runOnce };
}
