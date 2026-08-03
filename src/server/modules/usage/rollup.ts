// Incremental hourly rollup (E016, FR-010/012/013/014; AD-002/AD-004, HINT-002/HINT-003). The rollup
// RECOMPUTES a single affected `(license, entitlement, hour)` bucket FROM the retained raw — it is NOT a
// per-event increment (AD-002): a worker restart, an overlapping sweep, or a re-processed event yields the
// IDENTICAL aggregate (SC-004), and a LATE event (an older `event_time` but a fresh `ingested_at`) simply
// RE-OPENS its already-rolled bucket via the advancing `watermark_ingested_at` (FR-012). The stored
// `usage_rollup.value` is the TRUE SIGNED NET (never hard-floored — the zero-floor is a DISPLAY concern
// applied at query, AD-004/FR-013): so a signed-negative reversal decrements the net and E014 true-up still
// sees a net-negative correction. Per-aggregation net (HINT-002, FR-013):
//   - SUM          → the signed sum of quantities (a negative quantity is a reversal);
//   - COUNT        → the signed sum of the integer quantities (each event contributes its integer count; a
//                    `-1` reversal decrements the event count) — identical arithmetic to SUM on the guarded
//                    integer quantities;
//   - UNIQUE_COUNT → COUNT(*) of the bucket's prune-safe `usage_unique_value` distinct set — MONOTONIC
//                    within a bucket (a reversal cannot retract a distinct value), and EXACT after raw
//                    pruning (SC-020).
// The over-quota flag is DERIVED here (value > allowance on the TRUE net, FR-014, signal-only); the crossing
// AUDIT is US5 (T035). Pure helpers (sumNet/floorDisplay/isOverQuota/hashDimensions) back the T020 rollup-math
// unit tests without a DB; `rollupBucket` performs the tenant-scoped recompute + UPSERT.
import { createHash } from "node:crypto";

import { writeAudit } from "../../audit/index.js";
import type { TxQuery } from "../../db/client.js";
import type { Aggregation } from "./dimension-schema.js";
import type { UsageRepo } from "./usage-repo.js";

/** The append-only audit action recorded on a fresh over-quota crossing (FR-014/SC-009, the authoritative record). */
export const USAGE_OVER_QUOTA_ACTION = "usage.over_quota";

/** The synthetic system actor an over-quota crossing (detected during the rollup recompute) is attributed to (FR-018). */
export const OVER_QUOTA_ACTOR = "usage-rollup-worker";

// --- Pure rollup math (T020) ------------------------------------------------------------------------

/**
 * The TRUE SIGNED NET for a SUM or COUNT bucket: the signed sum of the (already quantity-guarded) event
 * quantities (HINT-002/FR-013). A signed-negative quantity is a reversal that decrements the net — the
 * arithmetic is identical for SUM (any finite signed numeric) and COUNT (non-zero integers). Reproducible:
 * summing the same retained raw always yields the same net (SC-004). Never floored (AD-004).
 */
export function sumNet(quantities: number[]): number {
  return quantities.reduce((acc, q) => acc + q, 0);
}

/**
 * The distinct count for a UNIQUE_COUNT bucket = the number of DISTINCT `value_hash`es (HINT-002). The set is
 * MONOTONIC within a bucket (a value seen once stays counted, never retracted by a reversal, FR-013) and
 * prune-safe, so the count is exact + reproducible even after raw pruning (SC-020).
 */
export function uniqueCount(hashes: Buffer[]): number {
  const seen = new Set<string>();
  for (const h of hashes) seen.add(h.toString("hex"));
  return seen.size;
}

/**
 * The operator-facing DISPLAY floor (FR-013): `max(0, net)` so a viewer never sees negative usage after a
 * reversal. Storage keeps the TRUE signed net (this floor is applied only at query, never persisted, AD-004).
 */
export function floorDisplay(net: number): number {
  return Math.max(0, net);
}

/**
 * Derive the over-quota signal (FR-014): the stored TRUE signed net has crossed the entitlement `allowance`.
 * Evaluated against the true net (NOT the floor-at-zero display). `null` allowance → no quota → never over.
 */
export function isOverQuota(net: number, allowance: number | null): boolean {
  return allowance !== null && net > allowance;
}

/** Canonical, key-sorted encoding of a scalar dimensions map so an identical map always hashes identically. */
function canonicalDimensions(dimensions: Record<string, unknown>): string {
  const keys = Object.keys(dimensions ?? {}).sort();
  return JSON.stringify(keys.map((k) => [k, (dimensions ?? {})[k]]));
}

/**
 * A stable SHA-256 `value_hash` (bytea) of an event's distinct dimension tuple, backing UNIQUE_COUNT
 * (HINT-002). Two events with the SAME dimensions hash identically (counted once); distinct dimensions are
 * distinct values. Deterministic (canonical key order) so the distinct set — and the count — is reproducible.
 */
export function hashDimensions(dimensions: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalDimensions(dimensions)).digest();
}

/** Truncate a client `event_time` to its FIXED bucket start (UTC-hour for the default 3600s grain, INV-4). */
export function bucketStartFor(eventTime: Date, bucketSeconds: number): Date {
  const ms = bucketSeconds * 1000;
  return new Date(Math.floor(eventTime.getTime() / ms) * ms);
}

// --- Late / out-of-order acceptance bound (T033, FR-004/FR-012) -------------------------------------

/** The acceptance classification of a client `event_time` against the SINGLE retention-window bound. */
export type AcceptanceStatus = "ok" | "stale" | "future";

/**
 * Classify a client `event_time` against the SINGLE acceptance bound (FR-012). The retention window is the ONLY
 * governing bound on acceptance: an event older than `now - retentionSecs` is `stale` EVEN IF its target hourly
 * bucket has not yet been rolled up — an as-yet-unrolled bucket NEVER extends acceptance beyond the window (so a
 * late event that would land in an old-but-unrolled bucket is still rejected once it ages past retention). An
 * event more than `futureSkewSecs` ahead of `now` is `future`; anything in `[now - retention, now + skew]` is
 * `ok`. This predicate is co-located with the rollup so the ingest ACCEPT gate and the sweep's late-event
 * bucket RE-OPEN (an older `event_time` re-opening an already-rolled bucket, FR-012) share ONE definition of
 * "still within the window" — the accept gate and the re-open can never disagree about the acceptance horizon.
 */
export function classifyAcceptance(
  eventTime: Date,
  now: Date,
  cfg: { retentionSecs: number; futureSkewSecs: number },
): AcceptanceStatus {
  const t = eventTime.getTime();
  if (t < now.getTime() - cfg.retentionSecs * 1000) return "stale";
  if (t > now.getTime() + cfg.futureSkewSecs * 1000) return "future";
  return "ok";
}

// --- Bucket recompute (T023) ------------------------------------------------------------------------

/** One swept raw event as the rollup needs it (its distinct dimensions + its ingest time for the watermark). */
export interface RollupEvent {
  dimensions: Record<string, unknown>;
  ingestedAt: Date;
}

/** The inputs to recompute one durable `(license, entitlement, bucket)` rollup row. */
export interface RollupBucketInput {
  licenseId: string;
  entitlementId: string;
  /** The FIXED hourly bucket start (UTC-truncated); the DB CHECK enforces the whole-hour grain (INV-4). */
  bucketStart: Date;
  /** The rollup grain in seconds (3600 = one UTC hour); bounds the recompute window on `event_time`. */
  bucketSeconds: number;
  aggType: Aggregation;
  /** The entitlement's optional quota; drives the derived over-quota flag (FR-014). `null` = no quota. */
  allowance: number | null;
  /** The swept raw events that landed in THIS bucket (drives UNIQUE_COUNT hashes + the batch watermark). */
  events: RollupEvent[];
}

/** The recomputed bucket aggregate (true signed net + folded count + derived over-quota + advanced watermark). */
export interface RollupBucketResult {
  value: number;
  eventCount: number;
  overQuota: boolean;
  watermarkIngestedAt: Date;
}

/**
 * RECOMPUTE + UPSERT one hourly bucket from the retained raw (AD-002, FR-010). Idempotent + reproducible: the
 * bucket is recomputed from raw (not incremented), so a re-run over the same events overwrites the SAME row
 * with the SAME totals (no double-count, SC-004), and a late event re-opens the bucket by raising the
 * watermark (FR-012). SUM/COUNT read the signed SUM of the bucket's raw quantities; UNIQUE_COUNT folds the
 * swept batch's distinct `value_hash`es into the prune-safe `usage_unique_value` set (ON CONFLICT DO NOTHING)
 * and takes COUNT(*) of that bucket's distinct rows. The over-quota flag is derived on the TRUE net (FR-014).
 * Runs under the caller's tenant tx `q` (forced RLS); the crossing audit is US5.
 */
export async function rollupBucket(
  q: TxQuery,
  repo: UsageRepo,
  input: RollupBucketInput,
): Promise<RollupBucketResult> {
  const { licenseId, entitlementId, bucketStart, bucketSeconds, aggType, allowance, events } = input;

  // The signed SUM + folded event count + MAX ingested_at of ALL retained raw in the bucket window (a
  // full recompute — reproducible + idempotent regardless of how many sweeps have touched the bucket).
  const agg = await repo.aggregateBucketRaw(q, { licenseId, entitlementId, bucketStart, bucketSeconds });

  let value: number;
  if (aggType === "unique_count") {
    // Fold the swept batch's distinct hashes into the monotonic, prune-safe distinct set, then COUNT(*) it.
    const valueHashes = events.map((e) => hashDimensions(e.dimensions));
    await repo.insertUniqueValues(q, { licenseId, entitlementId, bucket: bucketStart, valueHashes });
    value = await repo.countUniqueValues(q, { licenseId, entitlementId, bucket: bucketStart });
  } else {
    // SUM + COUNT are both the signed sum of the guarded quantities (COUNT's quantities are integers).
    value = agg.value;
  }

  // Advance the watermark to the MAX ingested_at folded in. aggregateBucketRaw returns the DB max; fall back
  // to the swept batch's max only if the (retained-raw) recompute somehow saw no rows (defensive).
  const batchMax = events.reduce((m, e) => (e.ingestedAt > m ? e.ingestedAt : m), new Date(0));
  const watermarkIngestedAt = agg.watermarkIngestedAt ?? batchMax;
  const overQuota = isOverQuota(value, allowance);

  // OVER-QUOTA CROSSING (T035, FR-014, signal-only). Evaluate the crossing against the TRUE signed net (never
  // the floor-at-zero display) and read the bucket's PRIOR over_quota so a FRESH crossing (was-not-over →
  // now-over) writes exactly ONE append-only crossing audit — the authoritative, durable record (SC-009). The
  // over_quota flag itself is DERIVED (recomputed each sweep): a re-sweep of an already-over bucket re-audits
  // nothing (prev is already true), and a reversal that drops the net below the allowance CLEARS the flag (the
  // upsert overwrites over_quota to false) while the historical crossing audit is RETAINED (append-only). This
  // NEVER blocks ingest — the rollup is the async sweep, not the hot ingest path.
  const prev = await q(
    "SELECT over_quota FROM usage_rollup WHERE license_id = $1 AND entitlement_id = $2 AND bucket = $3",
    [licenseId, entitlementId, bucketStart],
  );
  const prevOverQuota = prev.rowCount ? (prev.rows[0] as { over_quota: boolean }).over_quota : false;

  await repo.upsertRollup(q, {
    licenseId,
    entitlementId,
    bucket: bucketStart,
    aggType,
    value,
    eventCount: agg.eventCount,
    overQuota,
    watermarkIngestedAt,
  });

  if (overQuota && !prevOverQuota) {
    await writeAudit(q, {
      actor: OVER_QUOTA_ACTOR,
      action: USAGE_OVER_QUOTA_ACTION,
      target: entitlementId,
      after: { licenseId, entitlementId, bucket: bucketStart.toISOString(), value, allowance },
    });
  }

  return { value, eventCount: agg.eventCount, overQuota, watermarkIngestedAt };
}
