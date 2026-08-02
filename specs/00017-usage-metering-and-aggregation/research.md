# Research Report — Usage Metering & Aggregation

**Context**: Best practices for usage-metered entitlements with idempotent, high-write usage-event ingestion and aggregation in a multi-tenant Node/TS + PostgreSQL 16 license server (offline-first, online control plane). Feeds story priorities, acceptance criteria, and pre-identified edge cases for E016 (accrue/aggregate only; billing true-up is E014). Consumes usage from activated (E009) / online-validated (E013) clients.

## 1. Metered entitlement models
Metered entitlements fix an aggregation up front: counter/sum types (SUM total units, COUNT events, UNIQUE_COUNT distinct) accumulate; gauge/peak types (MAX peak concurrent, LATEST snapshot) reflect a moment. This differs from boolean (feature on/off) and static-limit entitlements (fixed cap checked at activation, E007). Quota/allowance = a limit layered over metering (throttle/flag at threshold); pure metering only accrues. Usage accrues per license × entitlement × period; aggregation type is immutable once events exist (changing it corrupts historical meaning).
Src: openmeter (aggregation taxonomy), stripe (metered vs static accrual).

## 2. Idempotent high-write ingestion
Exactly-once delivery is impossible; use at-least-once + idempotent processing (report-twice-dedupe beats underreporting). Key design: client-supplied stable id scoped by source (CloudEvents `source`+`id`) so retries collapse and parallel producers don't collide. For Postgres, a single INSERT with a UNIQUE constraint on `(tenant, source, event_id)` + `ON CONFLICT DO NOTHING` gives atomic single-round-trip dedupe — simpler and more consistent than a separate dedupe store (mirrors the E014 billing_event idempotency pattern already in this codebase). Bound the dedupe window.
Src: openmeter (32-day window), stripe (client identifier + idempotent replay).

## 3. PostgreSQL aggregation strategy
Prefer append-only raw events + periodic incremental rollup over updating a per-license counter on every write — a single hot counter row causes lock contention. Time-bucket rollups (hour/day → period) recomputed incrementally by a watermark (max-processed timestamp) collapse many inserts into one recompute. Vanilla PG16 (no TimescaleDB): append-only raw table (BRIN/time index), incremental rollup into `usage_rollup(license, entitlement, bucket)`, serve reads from the rollup. Keep raw for a bounded retention window (replay/audit), prune post-rollup (mirrors E014's retention worker).
Src: citusdata (incremental rollup by watermark), mergify (avoid hot-row/MV contention).

## 4. Metering edge cases & correctness
Late/out-of-order events are normal — accrue by client-supplied event timestamp, not receipt time, and re-open the affected bucket. Bound clock skew (reject timestamps > retention past or > few min future). Dedup window must exceed the max retry/reordering horizon. Corrections via explicit negative/reversal events (append-only, never mutate accrued events). Normalize units at ingest. Idempotency keys retained only for the dedup window then pruned. Support bounded backfill/replay within the window; a closed period needs a defined late-event grace policy.
Src: openmeter (dedup window, late events), stripe (timestamp bounds, grace).

## 5. Reporting-source & auth
Activated (E009)/validated (E013) clients should BATCH/pre-aggregate usage and post to a DEDICATED ingest endpoint rather than piggyback on heartbeat (decouples metering from renewal; high volume needs a batch path). Single-event posts suit low volume. Scope reporting to a tenant- and license-bound, ingest-only API credential (least privilege). Rate-limit the write endpoint per credential; accept-then-async-process to shed load. Enforce tenant isolation on every row (license/entitlement must belong to the caller's tenant). Reuses this codebase's scoped-API-key + @fastify/rate-limit + forced-RLS pattern.
Src: stripe (batch vs single, pre-aggregation), stripe meter-event (dedicated surface).

## 6. Metering ↔ billing boundary
Keep metering (accrue/aggregate) strictly separate from rating/invoicing (E014). Meter events are aggregated asynchronously, independent of invoice generation. E016 owns the durable, reproducible aggregate; E014 later reads it for true-up (read-only). Expose stable query surfaces: per-license, per-entitlement, per-period aggregate (+ grouping). Aggregates must be reproducible so a billing re-run yields identical totals. This epic never computes price/money.
Src: stripe (metering aggregated separately from invoicing), openmeter (query surfaces).

## Summary
Model each metered entitlement by a fixed, immutable aggregation type (counter/sum vs gauge/peak) distinct from boolean/limit entitlements (E007). Ingest at-least-once with client-supplied idempotency keys deduped by a unique index + `ON CONFLICT DO NOTHING` over a bounded window (mirror E014 billing_event); accrue append-only raw events on client event-timestamp and roll up incrementally into time-bucketed tables to dodge hot-row contention. Bound clock skew, handle late/out-of-order via bucket re-open and reversal (never mutate), scope ingest to tenant-bound rate-limited keys on a dedicated batch endpoint, and keep the reproducible aggregate strictly read-only for E014 true-up.

## Existing code to reconcile against
Entitlement model: `src/server/modules/catalog/` (`entitlements.ts`, `values.ts`, `effective.ts`, `validation.ts`) — E007 defines entitlements per plan; E016 adds a metered entitlement kind. Reporting source: `src/server/modules/enforcement/` (E013 validate/heartbeat) + `src/server/modules/activation/` (E009). Idempotency + retention worker precedent: `src/server/modules/billing/` (E014 `ledger-repo` ON CONFLICT + retention-worker). Reuse forced-RLS + `withTenant` + scoped API key + `@fastify/rate-limit`.

## Sources
| URL | Topic |
|-----|-------|
| openmeter.io/docs/metering/guides/creating-meters | 1,6 |
| docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api | 1,4,5,6 |
| openmeter.io/blog/usage-deduplication | 2,4 |
| docs.stripe.com/api/billing/meter-event | 2,5 |
| citusdata.com/blog/2018/06/14/scalable-incremental-data-aggregation | 3 |
| mergify.com/blog/two-counters-instead-of-a-materialized-view | 3 |
