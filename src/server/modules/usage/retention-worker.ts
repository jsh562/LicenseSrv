// Usage retention/prune + GDPR-erase worker (E016, FR-015/016/018; AD-007, HINT-004). A time-driven, unref'd,
// FAIL-OPEN, OWNER-ROLE maintenance job — modeled on the E014 billing retention worker / E015 reclaim worker —
// that bounds the high-write raw usage stream so `usage_event` + its idempotency keys cannot grow forever, while
// the DURABLE `usage_rollup` + `usage_unique_value` aggregates SURVIVE the prune (INV-6/SC-010). The app role
// holds SELECT/INSERT-only on the usage tables (NO DELETE), so — exactly like the E013 `pruneExpiredCheckins`
// platform-owner path — the DELETEs run on the schema-OWNER (privileged, RLS-bypassing) connection, and each is
// scoped by an EXPLICIT per-tenant `tenant_id` predicate so no statement ever spans more than one tenant
// (HINT-004). Every prune/erase is audited to a SYNTHETIC system actor (FR-018), no secret/credential.
//
// RETENTION BY THE EVENT-TIMESTAMP ACCEPTANCE BOUND (FR-015): retention is measured by the SAME event-timestamp
// bound as acceptance (FR-004/FR-012). A raw event (with its idempotency key and any distinct-set working row)
// is pruned only once its BUCKET is CLOSED — older than the acceptance window so no further still-acceptable
// late event can land in it. We therefore prune everything strictly BEFORE the first still-OPEN bucket
// (`bucketStartFor(now - retention)`): the bucket straddling the cutoff stays intact, so a still-acceptable late
// event NEVER targets a partially-pruned bucket. On close, a bucket's aggregate — including a UNIQUE_COUNT
// distinct count — is already FINAL in `usage_rollup`, so pruning the closed bucket's `usage_unique_value`
// working rows keeps distinct-set storage bounded to the open window without ever under-counting (SC-020).
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { DEFAULT_BUCKET_SECONDS, DEFAULT_RETENTION_SECS } from "./config.js";
import { bucketStartFor } from "./rollup.js";

/** The synthetic system actor every automatic prune / GDPR erase is attributed to (FR-018). */
export const USAGE_RETENTION_ACTOR = "usage-retention-worker";

/** Default cadence (ms) — one prune sweep per hour (retention is a slow-moving bound, not latency-critical). */
export const DEFAULT_USAGE_RETENTION_INTERVAL_MS = 3_600_000;

/** A minimal structured logger for fail-open warnings + prune-count info (Fastify's `app.log` satisfies it). */
export interface UsageRetentionLogger {
  warn(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
}

/** Options for a single {@link retentionSweep}. */
export interface RetentionSweepOptions {
  /** Retention window in seconds; defaults to {@link DEFAULT_RETENTION_SECS} (~35d). */
  retentionSecs?: number;
  /** The FIXED bucket grain in seconds (3600 = one UTC hour); defaults to {@link DEFAULT_BUCKET_SECONDS}. */
  bucketSeconds?: number;
  /** Injectable clock; defaults to now. Tests pass a fixed instant for determinism. */
  now?: Date;
  /** Optional structured logger for fail-open warnings. */
  logger?: UsageRetentionLogger;
  /** Optional per-tenant / sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** The outcome of one full prune sweep across all due tenants. */
export interface RetentionSweepResult {
  /** Tenants whose closed-bucket raw was pruned this pass. */
  tenants: number;
  /** Raw `usage_event` rows pruned across all tenants. */
  events: number;
  /** Closed-bucket `usage_unique_value` working rows pruned across all tenants. */
  uniqueValues: number;
}

/** The counts erased for one tenant by {@link eraseTenantUsage}. */
export interface TenantUsageErasure {
  events: number;
  rollups: number;
  uniqueValues: number;
}

/** Enumerate the tenants with any closed-bucket raw event (privileged — the worker has no request tenant). */
async function listTenantsWithClosedRaw(pool: pg.Pool, firstOpenBucket: Date): Promise<string[]> {
  return privileged(pool, async (q) => {
    const r = await q("SELECT DISTINCT tenant_id FROM usage_event WHERE event_time < $1", [firstOpenBucket]);
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/** Prune one tenant's closed-bucket raw + distinct-set working rows on the OWNER role (explicit tenant scope). */
async function pruneTenant(
  pool: pg.Pool,
  tenantId: string,
  firstOpenBucket: Date,
): Promise<{ events: number; uniqueValues: number }> {
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
export async function retentionSweep(pool: pg.Pool, options: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
  const retentionSecs = options.retentionSecs ?? DEFAULT_RETENTION_SECS;
  const bucketSeconds = options.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;
  const now = options.now ?? new Date();
  // The first still-OPEN bucket: everything strictly before it is CLOSED (past the acceptance window). Pruning
  // by this aligned boundary (not the raw cutoff) guarantees the straddling bucket is never partially pruned.
  const cutoff = new Date(now.getTime() - retentionSecs * 1000);
  const firstOpenBucket = bucketStartFor(cutoff, bucketSeconds);

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "usage_retention_failed", context, error: err instanceof Error ? err.message : String(err) },
        "usage retention prune failed (fail-open); the live ingest surface is unaffected",
      );
    } catch {
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
          await withTenant(pool, tenantId, (q: TxQuery) =>
            writeAudit(q, {
              actor: USAGE_RETENTION_ACTOR,
              action: "usage.retention_pruned",
              after: { events: r.events, uniqueValues: r.uniqueValues },
            }),
          ).catch((err) => warn(err, `retention audit for tenant ${tenantId}`));
        }
      } catch (err) {
        warn(err, `retention prune for tenant ${tenantId}`);
      }
    }
  } catch (err) {
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
export async function eraseTenantUsage(pool: pg.Pool, tenantId: string): Promise<TenantUsageErasure> {
  const erased = await privileged(pool, async (q): Promise<TenantUsageErasure> => {
    const de = await q("DELETE FROM usage_event WHERE tenant_id = $1", [tenantId]);
    const dr = await q("DELETE FROM usage_rollup WHERE tenant_id = $1", [tenantId]);
    const du = await q("DELETE FROM usage_unique_value WHERE tenant_id = $1", [tenantId]);
    return { events: de.rowCount ?? 0, rollups: dr.rowCount ?? 0, uniqueValues: du.rowCount ?? 0 };
  });
  // Audit the erasure to the synthetic actor (counts only, no PII). Best-effort — a tombstoned tenant's audit
  // payload may be redacted later by the platform GDPR path; the erasure event record itself is preserved.
  await withTenant(pool, tenantId, (q: TxQuery) =>
    writeAudit(q, { actor: USAGE_RETENTION_ACTOR, action: "usage.erased", after: erased }),
  ).catch(() => undefined);
  return erased;
}

/** Options for the periodic usage-retention worker (cadence + immediate + the sweep tuning). */
export interface UsageRetentionWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_USAGE_RETENTION_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default false (retention is background maintenance, not boot-critical). */
  immediate?: boolean;
  /** Retention window in seconds (from the live usage config). */
  retentionSecs?: number;
  /** The FIXED bucket grain in seconds (from the live usage config). */
  bucketSeconds?: number;
  /** Optional structured logger for fail-open warnings + prune-count info. */
  logger?: UsageRetentionLogger;
  /** Optional per-sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** A started usage-retention worker. `stop()` cancels the cadence; `runOnce()` runs a single fail-open prune. */
export interface UsageRetentionWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

/**
 * Start the periodic usage-retention prune worker (FR-015). Fail-open and cancelable exactly like the E014
 * billing retention worker / E015 reclaim worker: the cadence timer is unref'd (never keeps the process
 * alive), overlapping sweeps are prevented by a running guard, and a prune fault is caught + logged and never
 * propagates (it re-fires on the next sweep, never crashing boot or blocking ingest). Wire from `main.ts`,
 * tied to `app.close()`.
 */
export function startUsageRetentionWorker(
  pool: pg.Pool,
  options: UsageRetentionWorkerOptions = {},
): UsageRetentionWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_USAGE_RETENTION_INTERVAL_MS;
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      const { tenants, events, uniqueValues } = await retentionSweep(pool, {
        retentionSecs: options.retentionSecs,
        bucketSeconds: options.bucketSeconds,
        logger: options.logger,
        onError: options.onError,
      });
      if (events > 0 || uniqueValues > 0) {
        options.logger?.info?.(
          { event: "usage_retention_pruned", tenants, events, uniqueValues },
          "pruned aged raw usage events + closed-bucket distinct-set rows (durable aggregate retained)",
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (options.immediate === true) void runOnce();

  return { stop: () => clearInterval(timer), runOnce };
}
