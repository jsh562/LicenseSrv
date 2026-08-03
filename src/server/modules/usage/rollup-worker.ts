// Fail-open watermark rollup sweeper (E016, FR-010/018; AD-002/AD-007, HINT-002/HINT-004). A time-driven,
// unref'd, fail-open worker — modeled on the E014 retention / E015 reclaim workers — that folds the
// append-only raw `usage_event` stream into the durable hourly `usage_rollup` aggregate, so the high-write
// ingest path NEVER updates a hot counter (AD-002). Each pass:
//   1. enumerates (privileged, RLS-bypassing — the worker has no request tenant context) the tenants with any
//      raw event whose `ingested_at` is beyond the last-processed watermark `since`;
//   2. re-enters PER TENANT under `withTenant` (forced RLS, so a pass is confined to exactly one tenant,
//      HINT-004) and reads that tenant's raw events with `ingested_at > since` (oldest-first, bounded);
//   3. groups them by `(license, entitlement, hourly bucket)` — INCLUDING already-rolled buckets a late event
//      re-opens (an older `event_time` but a fresh `ingested_at`, FR-012) — and RECOMPUTES each affected
//      bucket from the retained raw via `rollupBucket` (idempotent, reproducible, SC-004);
//   4. audits the pass to a SYNTHETIC system actor (FR-018), never a secret/credential.
// FAIL-OPEN (FR-010): a per-tenant fault is caught + logged and never aborts the others, and the whole sweep
// never throws — a rollup fault must never block the live ingest surface (the on-read fallback keeps the open
// bucket eventually consistent). The watermark advances only as far as is SAFE: if a tenant's batch was
// capped, `since` advances only to that capped tenant's last-processed `ingested_at`, so no tail is skipped
// (re-sweeping an already-rolled bucket is a harmless idempotent recompute).
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { DEFAULT_BUCKET_SECONDS, DEFAULT_ROLLUP_INTERVAL_MS } from "./config.js";
import { bucketStartFor, rollupBucket, type RollupEvent } from "./rollup.js";
import { UsageRepo } from "./usage-repo.js";

/** The synthetic system actor every automatic rollup pass is attributed to (FR-018). */
export const ROLLUP_ACTOR = "usage-rollup-worker";

/** Default per-tenant raw-event cap per sweep (bounds a single pass's transaction; the tail rolls next sweep). */
export const DEFAULT_ROLLUP_MAX_BATCH = 5_000;

/** A minimal structured logger for fail-open warnings (Fastify's `app.log` satisfies it). */
export interface RollupWorkerLogger {
  warn(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
}

/** Options for a single {@link rollupSweep}. */
export interface RollupSweepOptions {
  /** Only fold raw events with `ingested_at > since` (the watermark). Defaults to the epoch (full recompute). */
  since?: Date;
  /** The FIXED rollup grain in seconds (3600 = one UTC hour). Defaults to {@link DEFAULT_BUCKET_SECONDS}. */
  bucketSeconds?: number;
  /** Bounded raw events folded per tenant per pass; the tail rolls on the next sweep. */
  maxBatch?: number;
  /** Optional structured logger for fail-open warnings. */
  logger?: RollupWorkerLogger;
  /** Optional per-tenant / sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** The outcome of one full sweep across all due tenants. */
export interface RollupSweepResult {
  /** Raw events folded across all tenants this pass. */
  processed: number;
  /** Distinct `(license, entitlement, bucket)` rollup rows recomputed this pass. */
  buckets: number;
  /** The advanced watermark — the SAFE high-water mark to pass as `since` to the next sweep. */
  since: Date;
}

/** One entitlement's rollup-relevant metadata (its aggregation type + optional quota). */
interface EntitlementMeta {
  aggregation: "sum" | "count" | "unique_count" | null;
  allowance: number | null;
}

const repo = new UsageRepo();

/** Enumerate the tenants with any raw event beyond the watermark (privileged — no request tenant context). */
async function listTenantsWithRawSince(pool: pg.Pool, since: Date): Promise<string[]> {
  return privileged(pool, async (q) => {
    const r = await q("SELECT DISTINCT tenant_id FROM usage_event WHERE ingested_at > $1", [since]);
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/** Read the aggregation + allowance for a set of entitlement ids within the caller's tenant (RLS). */
async function readEntitlementMeta(q: TxQuery, ids: string[]): Promise<Map<string, EntitlementMeta>> {
  const out = new Map<string, EntitlementMeta>();
  if (ids.length === 0) return out;
  const r = await q("SELECT id, aggregation, allowance FROM entitlement WHERE id = ANY($1::uuid[])", [ids]);
  for (const row of r.rows as { id: string; aggregation: EntitlementMeta["aggregation"]; allowance: string | null }[]) {
    out.set(row.id, { aggregation: row.aggregation, allowance: row.allowance === null ? null : Number(row.allowance) });
  }
  return out;
}

/** A grouped affected bucket: its identity + the swept events that landed in it. */
interface BucketGroup {
  licenseId: string;
  entitlementId: string;
  bucketStart: Date;
  events: RollupEvent[];
}

/**
 * Roll up ONE tenant's raw stream beyond `since` (already inside `withTenant`, forced RLS). Reads the bounded
 * oldest-first raw batch, groups it by `(license, entitlement, bucket)`, recomputes each affected bucket from
 * the retained raw, and audits the pass to the synthetic actor. Returns the folded event count, the distinct
 * bucket count, the max `ingested_at` folded, and whether the batch was capped (so the caller can advance the
 * watermark safely without skipping a tail).
 */
async function rollupTenant(
  q: TxQuery,
  since: Date,
  bucketSeconds: number,
  maxBatch: number,
): Promise<{ processed: number; buckets: number; maxIngestedAt: Date; capped: boolean }> {
  const raw = await repo.selectRawSince(q, since, maxBatch);
  if (raw.length === 0) return { processed: 0, buckets: 0, maxIngestedAt: since, capped: false };

  const meta = await readEntitlementMeta(q, [...new Set(raw.map((e) => e.entitlementId))]);

  // Group by (license, entitlement, bucket) — a late event's older bucket is grouped here too (FR-012).
  const groups = new Map<string, BucketGroup>();
  let maxIngestedAt = since;
  for (const e of raw) {
    if (e.ingestedAt > maxIngestedAt) maxIngestedAt = e.ingestedAt;
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
    if (!m || m.aggregation === null) continue;
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
export async function rollupSweep(pool: pg.Pool, options: RollupSweepOptions = {}): Promise<RollupSweepResult> {
  const since = options.since ?? new Date(0);
  const bucketSeconds = options.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;
  const maxBatch = options.maxBatch ?? DEFAULT_ROLLUP_MAX_BATCH;
  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "rollup_worker_failed", context, error: err instanceof Error ? err.message : String(err) },
        "usage rollup step failed (fail-open); the live ingest surface is unaffected",
      );
    } catch {
      /* logging is best-effort */
    }
    options.onError?.(err);
  };

  let processed = 0;
  let buckets = 0;
  let globalMax = since;
  let cappedMin: Date | null = null;

  try {
    const tenantIds = await listTenantsWithRawSince(pool, since);
    for (const tenantId of tenantIds) {
      try {
        const r = await withTenant(pool, tenantId, (q) => rollupTenant(q, since, bucketSeconds, maxBatch));
        processed += r.processed;
        buckets += r.buckets;
        if (r.maxIngestedAt > globalMax) globalMax = r.maxIngestedAt;
        if (r.capped && (cappedMin === null || r.maxIngestedAt < cappedMin)) cappedMin = r.maxIngestedAt;
      } catch (err) {
        // Per-tenant fail-open: a fault on one tenant never blocks rollup (or the live surface) elsewhere.
        warn(err, `rollup sweep for tenant ${tenantId}`);
      }
    }
  } catch (err) {
    warn(err, "rollup sweep");
  }

  // Advance the watermark to the max folded ingested_at, but never past a capped tenant's last-processed row.
  const nextSince = cappedMin ?? globalMax;
  return { processed, buckets, since: nextSince };
}

/** Options for the periodic rollup worker (extends the per-sweep options with cadence + immediate). */
export interface RollupWorkerOptions extends Omit<RollupSweepOptions, "since"> {
  /** Cadence in ms; defaults to {@link DEFAULT_ROLLUP_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default true. Tests pass false and drive `runOnce` deterministically. */
  immediate?: boolean;
  /** The initial watermark; defaults to the epoch (a full recompute on first sweep). */
  since?: Date;
}

/** A started rollup worker. `stop()` cancels the cadence; `runOnce()` runs a single fail-open sweep. */
export interface RollupWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
  /** The current watermark (advances after each sweep); exposed for diagnostics/tests. */
  watermark(): Date;
}

/**
 * Start the time-driven watermark rollup worker (FR-010). Fail-open and cancelable exactly like the E015
 * reclaim / E014 retention workers: the cadence timer is unref'd (never keeps the process alive), overlapping
 * sweeps are prevented by a running guard, and a fault never propagates. The watermark advances across sweeps
 * so each pass folds only fresh raw; a restart resets it to the epoch and re-folds idempotently (no
 * double-count, SC-004). Wire from `main.ts`, tied to `app.close()`.
 */
export function startRollupWorker(pool: pg.Pool, options: RollupWorkerOptions = {}): RollupWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_ROLLUP_INTERVAL_MS;
  let since = options.since ?? new Date(0);
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      const result = await rollupSweep(pool, { ...options, since });
      since = result.since;
      if (result.buckets > 0) {
        options.logger?.info?.(
          { event: "usage_rolled_up", processed: result.processed, buckets: result.buckets },
          "usage rollup swept fresh raw into the durable aggregate",
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (options.immediate !== false) void runOnce();

  return { stop: () => clearInterval(timer), runOnce, watermark: () => since };
}
