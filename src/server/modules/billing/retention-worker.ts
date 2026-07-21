// Billing-event ledger retention prune worker (FR-021/SC-015; ADR-0011). A periodic PLATFORM-OWNER maintenance
// job that ENFORCES the GDPR-bounded ledger retention horizon: it DELETEs `billing_event` rows whose server
// `received_at` predates `now - retention`, where `retention` is the live, operator-tunable horizon CLAMPED to
// stay strictly above the idempotency/anti-replay floor (`IDEMPOTENCY_FLOOR_SECS`) so a still-redeliverable
// event id is NEVER pruned (FR-003/021). The `billing_event` append-only ledger grants the RLS-forced app role
// SELECT/INSERT only (no DELETE), so — exactly like the E013 `pruneExpiredCheckins` check-in prune — the delete
// runs on the schema-OWNER (privileged, RLS-bypassing) connection, never under `withTenant`. FAIL-OPEN and
// cancelable exactly like the E013 CRL worker / the grace + reconcile workers: the cadence timer is unref'd, a
// prune fault is caught + logged and NEVER crashes the app (retention re-fires on the next sweep), and
// overlapping sweeps are prevented by a running guard. Started from main.ts and tied to app.close().
import type pg from "pg";

import { privileged } from "../../db/client.js";
import { type BillingConfig, IDEMPOTENCY_FLOOR_SECS, resolveLedgerRetentionSecs } from "./config.js";
import { pruneBillingEvents } from "./ledger-repo.js";

/** Default cadence (ms) — one retention sweep per hour (retention is a slow-moving GDPR bound, not latency-critical). */
export const DEFAULT_RETENTION_WORKER_INTERVAL_MS = 3_600_000;

/** A minimal structured logger for fail-open warnings + prune-count info (Fastify's `app.log` satisfies it). */
export interface RetentionWorkerLogger {
  warn(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
}

export interface RetentionWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_RETENTION_WORKER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default false (retention is background maintenance, not boot-critical). */
  immediate?: boolean;
  /** Optional structured logger for fail-open warnings. */
  logger?: RetentionWorkerLogger;
  /** Optional per-sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
  /** Injectable clock (epoch seconds); defaults to now. Tests pass a fixed clock for determinism. */
  nowUnix?: () => number;
}

/** A started retention worker. `stop()` cancels the cadence; `runOnce()` runs a single fail-open prune. */
export interface RetentionWorkerHandle {
  /** Cancel the cadence timer. Idempotent and safe to call after a fail-open no-op start. */
  stop(): void;
  /** Run exactly one retention prune now (never rejects — every fault is caught + logged fail-open). */
  runOnce(): Promise<void>;
}

/**
 * Prune the billing-event ledger to its retention horizon ONCE (FR-021). Resolves the live horizon and CLAMPS it
 * strictly above the idempotency floor (`resolveLedgerRetentionSecs`), then re-asserts that invariant defensively
 * before computing the cutoff `nowUnix - retention`: a horizon at/below the floor could prune a live idempotency
 * window, so it fails LOUD here (the worker's `runOnce` catches it fail-open). Runs the DELETE on the schema-OWNER
 * (privileged) connection because the app role has no DELETE grant on the append-only ledger. Returns the deleted
 * count; THROWS on a DB/privilege fault (the caller — the worker — decides fail-open).
 */
export async function pruneBillingLedger(
  pool: pg.Pool,
  config: BillingConfig,
  nowUnix: number,
): Promise<{ deleted: number }> {
  const retentionSecs = resolveLedgerRetentionSecs(config.ledgerRetentionSecs);
  /* v8 ignore next 6 -- defensive: resolveLedgerRetentionSecs already clamps to floor+1, so this guard is
     unreachable; it is a belt-and-braces assert so a future regression can never let the prune horizon dip
     into a still-redeliverable event id's window (FR-003). */
  if (retentionSecs <= IDEMPOTENCY_FLOOR_SECS) {
    throw new Error(
      `billing retention horizon ${retentionSecs}s must stay strictly above the idempotency floor ${IDEMPOTENCY_FLOOR_SECS}s`,
    );
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
export function startBillingRetentionWorker(
  pool: pg.Pool,
  config: BillingConfig,
  options: RetentionWorkerOptions = {},
): RetentionWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_WORKER_INTERVAL_MS;
  const clock = options.nowUnix ?? ((): number => Math.floor(Date.now() / 1000));
  let running = false;

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "retention_worker_failed", context, error: err instanceof Error ? err.message : String(err) },
        "billing retention prune failed (fail-open); it retries on the next sweep",
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
      const { deleted } = await pruneBillingLedger(pool, config, clock());
      if (deleted > 0) {
        options.logger?.info?.({ event: "retention_pruned", deleted }, "pruned aged billing-event ledger rows");
      }
    } catch (err) {
      warn(err, "prune");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  // Never let the worker keep the process alive — it is best-effort background maintenance (fail-open).
  if (typeof timer.unref === "function") timer.unref();
  if (options.immediate === true) void runOnce();

  return { stop: () => clearInterval(timer), runOnce };
}
