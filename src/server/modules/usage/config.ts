// Usage-metering configuration + resolvers (E016, FR-004/005/015; ADR-0013). The bounded retention/dedupe
// window (which is ALSO the single stale-event acceptance bound), the future-skew allowance, the FIXED
// hourly rollup grain, the rollup-sweep cadence, the per-API-key ingest rate ceiling + window, the max
// batch cap, and the query-window bucket-count bound are APP CONFIG read LIVE (an operator retunes without
// a migration). SCREAMING_SNAKE env -> camelCase config, mirroring `loadBillingConfig`/`loadLeaseConfig`
// (deployment-wide defaults from the same env keys the central AppConfig reads, `src/server/config/index.ts`).
//
// The batch cap is CLAMPED to the contract ceiling (1000) at load: the OpenAPI ingest schema hard-limits
// `events` to 1000 items, so an operator value above that could never be honoured — clamping keeps the
// resolved cap and the wire contract in lock-step (FR-005). The retention window doubles as the dedupe +
// stale-event bound: a re-report after a key is pruned is a fresh accrual, and an event older than the
// window is a per-event `stale_event` (FR-004/015).

/** The resolved deployment-wide usage-metering config. All windows are seconds unless the name says ms. */
export interface UsageConfig {
  /** Retention/dedupe window (seconds, ~35d); the raw + key prune horizon AND the stale-event bound (FR-004/015). */
  retentionSecs: number;
  /** Allowed future skew of a client `event_time` (seconds, ~5m); beyond it → per-event `future_event` (FR-004). */
  futureSkewSecs: number;
  /** FIXED rollup grain (seconds); 3600 = one UTC hour, matching the DB hourly-bucket CHECK (FR-010, INV-4). */
  bucketSeconds: number;
  /** Fail-open watermark rollup sweep cadence (milliseconds, ~1m) (FR-010). */
  rollupIntervalMs: number;
  /** Per-API-key ingest rate ceiling per window (FR-005). */
  ingestRateMax: number;
  /** The ingest rate-limit window, e.g. "1 minute" (FR-005). */
  ingestRateWindow: string;
  /** Max events per ingest batch; clamped to the contract ceiling {@link MAX_BATCH_CEILING} (FR-005). */
  maxBatch: number;
  /** Query-window span bound in hours (a bucket-count cap); over it → `window_too_large` (FR-011). */
  queryMaxHours: number;
}

// Documented defaults (kept in sync with the Zod defaults in src/server/config/index.ts -- both read the
// same SCREAMING_SNAKE env keys).
export const DEFAULT_RETENTION_SECS = 3_024_000; // 35 days
export const DEFAULT_FUTURE_SKEW_SECS = 300; // 5 minutes
export const DEFAULT_BUCKET_SECONDS = 3_600; // 1 hour (fixed grain)
export const DEFAULT_ROLLUP_INTERVAL_MS = 60_000; // 1 minute
export const DEFAULT_INGEST_RATE_MAX = 600;
export const DEFAULT_INGEST_RATE_WINDOW = "1 minute";
export const DEFAULT_MAX_BATCH = 1_000;
export const DEFAULT_QUERY_MAX_HOURS = 2_160; // 90 days
/** The hard contract ceiling for the batch cap (the OpenAPI `events` maxItems). Config can never exceed it. */
export const MAX_BATCH_CEILING = 1_000;

/** Coerce a positive-int env value, falling back to `dflt` on a missing / non-positive / non-numeric input. */
function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Clamp a requested batch cap into `[1, MAX_BATCH_CEILING]` (FR-005). A non-positive / non-finite request
 * falls back to the documented default; a request above the contract ceiling is capped to it so the resolved
 * limit and the OpenAPI `events` maxItems can never disagree. Pure; no I/O.
 */
export function resolveMaxBatch(requested: number): number {
  const n = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_BATCH;
  return Math.min(n, MAX_BATCH_CEILING);
}

/**
 * Load the usage config from the environment, falling back to the documented defaults. Reads the same
 * SCREAMING_SNAKE keys as the central AppConfig. The batch cap is clamped to the contract ceiling
 * ({@link resolveMaxBatch}); every other value is a positive-int (or the rate window string) resolver.
 */
export function loadUsageConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
  return {
    retentionSecs: intEnv(env.USAGE_RETENTION_SECS, DEFAULT_RETENTION_SECS),
    futureSkewSecs: intEnv(env.USAGE_FUTURE_SKEW_SECS, DEFAULT_FUTURE_SKEW_SECS),
    bucketSeconds: intEnv(env.USAGE_BUCKET_SECONDS, DEFAULT_BUCKET_SECONDS),
    rollupIntervalMs: intEnv(env.USAGE_ROLLUP_INTERVAL_MS, DEFAULT_ROLLUP_INTERVAL_MS),
    ingestRateMax: intEnv(env.USAGE_INGEST_RATE_MAX, DEFAULT_INGEST_RATE_MAX),
    ingestRateWindow: env.USAGE_INGEST_RATE_WINDOW?.trim() || DEFAULT_INGEST_RATE_WINDOW,
    maxBatch: resolveMaxBatch(intEnv(env.USAGE_MAX_BATCH, DEFAULT_MAX_BATCH)),
    queryMaxHours: intEnv(env.USAGE_QUERY_MAX_HOURS, DEFAULT_QUERY_MAX_HOURS),
  };
}
