// Grace-expiry auto-suspend worker (FR-008/013; AD-003/006, HINT-003/005). A TIME-driven scheduled job:
// it finds subscriptions whose grace window has ELAPSED (`billing_state ∈ {past_due, grace}` AND
// `grace_expires_at <= now()`) and drives the linked license `active → suspended` via the E008 suspend
// service — even if NO further webhook ever arrives (grace expiry is time-driven, not webhook-driven). Grace
// is an OVERLAY: the E008 `license.status` enum is untouched; only the subscription `billing_state` advances
// to `canceled` and clears `grace_expires_at`. The mutation is audited with a SYNTHETIC system actor + the
// subscription id (NO provider event id — the trigger is the clock, FR-013). FAIL-OPEN exactly like the E013
// CRL worker: the cadence timer is unref'd, a fault on one tenant/subscription never aborts the rest, and no
// fault ever throws out of the worker or crashes the app (recovery from `suspended` is still allowed later).
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { suspendLicense } from "../issuance/lifecycle.js";

/** The synthetic system actor recorded on a time-driven auto-suspend (FR-013 — not a human, no event id). */
export const GRACE_WORKER_ACTOR = "billing-grace-worker";

/** Default cadence (ms) — one grace-expiry sweep per minute (matches the CRL worker cadence). */
export const DEFAULT_GRACE_WORKER_INTERVAL_MS = 60_000;

/** A minimal structured logger for fail-open warnings (Fastify's `app.log` satisfies it). */
export interface GraceWorkerLogger {
  warn(obj: object, msg?: string): void;
}

export interface GraceWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_GRACE_WORKER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default true. Tests pass false and drive `runOnce` deterministically. */
  immediate?: boolean;
  /** Optional structured logger for fail-open warnings. */
  logger?: GraceWorkerLogger;
  /** Optional hook invoked with the error on a per-tenant/per-subscription/sweep failure (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** A started grace worker. `stop()` cancels the cadence; `runOnce()` runs a single sweep (used by tests). */
export interface GraceWorkerHandle {
  /** Cancel the cadence timer. Idempotent and safe to call after a fail-open no-op start. */
  stop(): void;
  /** Run exactly one grace-expiry sweep now (never rejects — every fault is caught + logged fail-open). */
  runOnce(): Promise<void>;
}

/** Enumerate the tenants with at least one subscription whose grace window has elapsed (privileged read). */
async function listTenantsWithElapsedGrace(pool: pg.Pool): Promise<string[]> {
  return privileged(pool, async (q) => {
    const r = await q(
      `SELECT DISTINCT tenant_id FROM subscription
        WHERE billing_state IN ('past_due','grace') AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()`,
    );
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/** The elapsed-grace subscriptions within the current tenant scope (the partial `subscription_grace` index). */
async function listElapsedSubscriptions(q: TxQuery): Promise<{ id: string; licenseId: string }[]> {
  const r = await q(
    `SELECT id, license_id FROM subscription
      WHERE billing_state IN ('past_due','grace') AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()
      ORDER BY grace_expires_at ASC`,
  );
  return (r.rows as { id: string; license_id: string }[]).map((x) => ({ id: x.id, licenseId: x.license_id }));
}

/**
 * Auto-suspend one elapsed-grace subscription in its OWN tenant transaction (so one subscription's fault
 * cannot roll back another's). Re-locks the subscription FOR UPDATE and re-checks the grace window inside the
 * tx (a recovering payment between the sweep list and here re-cleared it → skip). Drives E008 `suspend` when
 * the license is still `active`, advances `billing_state → canceled` + clears `grace_expires_at` WITHOUT
 * touching `last_applied_event_at` (a time-driven suspend must not poison the event recency anchor, FR-016),
 * and audits with the synthetic actor + subscription id.
 */
async function suspendElapsed(pool: pg.Pool, tenantId: string, subscriptionId: string): Promise<void> {
  await withTenant(pool, tenantId, async (q) => {
    const locked = await q(
      `SELECT license_id FROM subscription
        WHERE id = $1 AND billing_state IN ('past_due','grace')
          AND grace_expires_at IS NOT NULL AND grace_expires_at <= now()
        FOR UPDATE`,
      [subscriptionId],
    );
    if (!locked.rowCount) return; // recovered / already advanced between the sweep list and the lock
    const licenseId = (locked.rows[0] as { license_id: string }).license_id;

    const lic = await q("SELECT status FROM license WHERE id = $1 FOR UPDATE", [licenseId]);
    if (!lic.rowCount) return;
    const status = (lic.rows[0] as { status: string }).status;
    if (status === "revoked") return; // terminal — never drive a revoked license
    if (status === "active") await suspendLicense(pool, tenantId, GRACE_WORKER_ACTOR, licenseId, q); // E008 (in-tx)

    // Advance the overlay to canceled + clear grace WITHOUT touching last_applied_event_at (time-driven).
    await q(
      "UPDATE subscription SET billing_state = 'canceled', grace_expires_at = NULL, updated_at = now() WHERE id = $1",
      [subscriptionId],
    );
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
export function startGraceWorker(pool: pg.Pool, options: GraceWorkerOptions = {}): GraceWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_GRACE_WORKER_INTERVAL_MS;
  let running = false;

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "grace_worker_failed", context, error: err instanceof Error ? err.message : String(err) },
        "grace worker step failed (fail-open); auto-suspend retries on the next sweep",
      );
    } catch {
      /* logging is best-effort */
    }
    options.onError?.(err);
  };

  const runOnce = async (): Promise<void> => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      const tenantIds = await listTenantsWithElapsedGrace(pool);
      for (const tenantId of tenantIds) {
        let subs: { id: string; licenseId: string }[];
        try {
          subs = await withTenant(pool, tenantId, (q) => listElapsedSubscriptions(q));
        } catch (err) {
          warn(err, `enumerate elapsed grace for tenant ${tenantId}`);
          continue;
        }
        for (const sub of subs) {
          try {
            await suspendElapsed(pool, tenantId, sub.id);
          } catch (err) {
            // Per-subscription fail-open: a lock/transition race on one never blocks the rest.
            warn(err, `auto-suspend subscription ${sub.id}`);
          }
        }
      }
    } catch (err) {
      warn(err, "sweep");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  // Never let the worker keep the process alive — it is best-effort background enforcement (fail-open).
  if (typeof timer.unref === "function") timer.unref();

  if (options.immediate !== false) void runOnce();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
