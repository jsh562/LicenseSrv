---
adr_id: ADR-0013
status: accepted
date: 2026-07-24
tags: [usage-metering, consumption, ingestion, idempotency, append-only, incremental-rollup, watermark, hourly-bucket, reproducible-aggregate, signed-reversal, retention, fail-open-worker, metering-billing-boundary, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00017-usage-metering-and-aggregation/spec.md, specs/00017-usage-metering-and-aggregation/plan.md, specs/00015-billing-driven-entitlement-automation/spec.md, migrations/0010_billing.sql, migrations/0011_leases.sql]
---

# ADR-0013: Usage-Metering Ingestion and Aggregation Model — Idempotent Append-Only Ingest with Watermark-Driven Hourly Rollup and Signed Reversals

## Status

Accepted.

## Context

The catalog (E007) expresses an entitlement only as an on/off flag or a static integer limit: it can say *whether* a capability is enabled and *how many* of something are allowed, but it cannot express **consumption** — API calls made, gigabytes processed, seat-hours burned, frames rendered. Vendors who sell usage-metered or consumption-based products therefore have no way for their licensed applications to report usage, no durable accrual of that usage against a license, and nothing for billing (E014) to later true-up against.

Epic E016 (Usage metering & aggregation, `{PRD:CAP-011}`) adds the consumption dimension. It must let a licensed client report usage in a durable, idempotent, high-write way and have that usage aggregated per license into a reproducible total that billing can consume — **without metering ever computing money**. This is the first time the system ingests a high-volume, client-authored event stream and accrues it, and the shape of that model is system-shaping rather than feature-local:

- **Metered is a NEW, additive entitlement kind.** A metered entitlement carries a fixed aggregation type and unit — a different thing from E007's boolean/limit entitlements, whose semantics stay unchanged. Whether an entitlement means "enabled", "at most N", or "accrue reported usage" is a project-wide invariant, not an implementation detail of one endpoint.
- **Ingestion is a HIGH-WRITE, at-least-once path.** A fleet reporting pre-aggregated batches redelivers on retry and after outages; the correctness heart of metering is counting a re-reported event **exactly once**, durably, without serializing the write path on a hot per-license counter. How the system dedupes, accrues, rolls up, and reproduces the aggregate is a freeze point downstream true-up consumes.
- **The metering ↔ billing boundary is permanent.** Metering accrues and aggregates only; it computes no price, rate, or money. E014 reads the aggregate **read-only** for true-up. This is a hard product/security boundary, not an MVP simplification, so it belongs in the project record alongside the ADR-0011 PCI boundary it complements.

The decision must also stay consistent with what is already committed elsewhere and NOT re-decide it:

- **E007 owns the entitlement model.** The metered kind is a new value added to the E007 `entitlement` type/kind enum with metered-only columns (aggregation type, unit, optional allowance); the existing boolean/limit semantics and the plan-authoring flow are unchanged and purely extended.
- **E008 owns the license.** Usage is reported and aggregated per license; a cross-tenant or unknown license reference resolves to not found. Metering reads the license and its plan's metered entitlements; it does not touch the lifecycle.
- **E005 owns scope/RBAC.** Ingestion is authenticated by a new, least-privilege, tenant- and license-bound API-key scope; the operator query surface uses the console session + RBAC. Metering introduces no new auth core.
- **E014 owns billing.** The idempotent `billing_event` source+id dedupe (`migrations/0010_billing.sql`) and the fail-open retention-worker pattern are already shipped; metering REUSES those patterns rather than inventing new ones, and E014 consumes the metering aggregate read-only.

What this ADR decides: the **usage-metering ingestion + aggregation model** — how usage is reported, deduped, accrued, rolled up, corrected, reproduced, retained, and exposed to billing — as one project-level contract that E016 implements and future consumption/metering work reuses.

## Decision Drivers

- **High-write scalability without hot-row contention (security/correctness-critical)**: the ingest path must fast-ack under a burst and never serialize on a per-license counter UPDATE; the live count is derived asynchronously, not maintained per event.
- **Exactly-once accrual under at-least-once, concurrent redelivery**: a re-reported event — a retry, an at-least-once redelivery, a parallel producer racing the same key — must accrue exactly once, guaranteed within the retention window.
- **Reproducible aggregate (billing-grade)**: an identical query over an unchanged window must return identical totals, and a downstream billing re-run must yield identical totals — so the stored aggregate is the true signed net, not a lossy display value.
- **Correct accrual under late / out-of-order events + corrections**: usage accrues by the client event timestamp (not receipt time), a late event re-opens its period, and corrections are append-only signed reversals that never mutate a prior event.
- **Permanent metering ↔ billing boundary**: metering computes no money; billing-period alignment and pricing live in E014, which reads the aggregate read-only. Billing-cycle knowledge must stay out of metering storage.
- **Bounded storage on the hot path**: raw events and idempotency keys cannot grow forever; a bounded dedupe/retention window plus a fail-open prune worker cap growth, with dedupe guaranteed only within the window (a disclosed consequence).
- **Additive to E007 — do not mutate existing entitlement semantics**: the metered kind is a new enum value + columns; boolean/limit entitlements and the authoring flow are unchanged.
- **Reuse the shipped patterns (Principle III)**: the E014 `billing_event` ON-CONFLICT idempotency and the E014/E015 fail-open worker shape are reused, not re-implemented; least-privilege ingest scope (E005), tenant-scoped forced RLS, append-only audit, and PII minimization are inherited.
- **Multi-tenant isolation + PII minimization (Principles II/III)**: usage is tenant-scoped fail-closed (forced RLS), minimized to references/quantities/dimensions with no PII, and GDPR-erasable.

## Considered Options

### Option A: Idempotent append-only ingest + watermark-driven hourly rollup + signed reversals with a permanent metering↔billing boundary (composite model)

Adopt one metering model with six parts:

1. **A metered entitlement KIND on E007.** Add a `metered` value to the E007 `entitlement` type/kind enum with metered-only columns: a fixed counter aggregation type (SUM of reported quantities / COUNT of events / UNIQUE_COUNT of distinct values), a unit, and an optional allowance/quota. The aggregation type and unit are FROZEN once any usage event exists (edit permitted while empty, refused afterward) to preserve the meaning of historical aggregates. Gauge/peak (MAX/LATEST) is a documented extension, deferred because it needs point-in-time rather than additive-accumulation semantics and would break additive reversal.
2. **At-least-once idempotent ingestion via a dedicated fast-ack batch endpoint.** A new runtime endpoint (separate from the E013 validate/heartbeat surface), authenticated by a new least-privilege `usage.ingest` scope (E005), accepts single or batched events (default cap 1,000/request). Each event carries a client `source` id + idempotency key; dedupe is a UNIQUE `(tenant, source, event_id)` constraint + `INSERT ... ON CONFLICT DO NOTHING` in one transaction — exactly-once accrual with no second store and no pre-SELECT race — mirroring the shipped E014 `billing_event` source+id pattern. The endpoint fast-acks with a per-event batch summary (new accrued, duplicate no-op, invalid rejected); one bad event never fails the batch.
3. **Append-only raw `usage_event` + asynchronous watermark-driven incremental rollup.** Events are stored append-only and never mutated/deleted in normal operation. A watermark-driven worker incrementally rolls raw events into FIXED **hourly** `usage_rollup` buckets per (tenant, license, entitlement, hour) using the entitlement's aggregation type — NO per-event hot counter. Accrual is by the client event timestamp; a late/out-of-order event within the window re-opens and recomputes its hour. "Per period" queries sum hourly buckets over a caller window. The rollup worker is fail-open with an on-read fallback for the still-open bucket, so the aggregate is eventually consistent without ever blocking ingest.
4. **Reference-free signed reversals; TRUE signed net stored; floor-at-zero display.** Corrections are standalone signed-negative usage events that do NOT reference an original event id (fitting pre-aggregated batch clients), adjusting the aggregate append-only without mutating any prior event. `usage_rollup` stores the TRUE signed net — reproducible, and exactly what E014 true-up consumes — while operator query/UI responses floor the displayed value at zero so operators never see negative usage. Never hard-floor storage (lossy/non-reproducible, and it would hide a net-negative correction from billing).
5. **Bounded dedupe/retention window + fail-open prune.** Raw events and idempotency keys are retained for a bounded, configurable window (~35 days) then pruned post-rollup by a time-driven, fail-open worker (owner-role DELETE, synthetic-actor audit); the durable rollup survives. Dedupe is guaranteed only within the window — a re-report after a key is pruned is a fresh accrual and cannot resurrect the pruned event (a disclosed consequence). Usage is tenant-scoped (forced RLS), minimized, and GDPR-erasable.
6. **Strict metering ↔ billing boundary.** Metering accrues and aggregates ONLY; it computes no price, rate, or money. E014 reads the true-signed-net aggregate read-only for true-up (never the floored display), and because the aggregate is reproducible, a billing re-run yields identical totals. Billing-period alignment is applied by E014 at read time, kept out of metering storage.

- **Pros**: Enables consumption licensing with exactly-once, high-write accrual that scales by avoiding hot-row contention (append-only raw + async watermark rollup, no per-event counter); the aggregate is reproducible and billing-grade (true signed net stored), so E014 true-up re-runs are idempotent; late/out-of-order and corrections are handled correctly (event-timestamp accrual + bucket re-open + append-only signed reversal) without ever mutating history; additive to E007 (boolean/limit unchanged); reuses the shipped E014 `billing_event` idempotency + fail-open retention-worker patterns and the E005 scope / forced-RLS / append-only-audit foundation (Principle III), so no new dedupe store, no new crypto, no new auth core; tenant-isolated and PII-minimized (Principle II); the ingest/rollup/reproduce/retain contract is directly reusable by future metering/consumption work.
- **Cons**: Adds a high-write ingest surface plus TWO fail-open workers (incremental rollup, retention prune) to build, run, and monitor; the aggregate is eventually consistent (an on-read fallback covers the open bucket) rather than synchronously exact; dedupe is guaranteed only within the ~35-day window (a re-report after pruning double-accrues — disclosed); UNIQUE_COUNT needs exact distinct-value tracking per bucket (a side structure or bucket recompute), heavier than SUM/COUNT; fixed hourly buckets are a schema-level commitment (per-period alignment is E014's job at read).

### Option B: Per-event counter UPDATE (synchronous hot-row aggregate)

Maintain the aggregate synchronously by updating a per-(license, entitlement, period) counter row on every ingested event.

- **Pros**: The aggregate is always exact with no rollup worker and no eventual-consistency window; simplest read path (the counter *is* the answer).
- **Cons**: Serializes the high-write path on a single hot row — concurrent producers for the same license contend on the same counter UPDATE, capping ingest throughput and defeating the fast-ack requirement; MVCC row churn/bloat under a burst; a late event still needs recompute logic. The append-only raw + async watermark rollup holds the same totals without hot-row contention and stays reproducible from the retained raw. Rejected.

### Option C: A separate dedupe store fronting the event table

Record each idempotency key in a dedicated dedupe store (or cache), check it, then insert the event on a miss.

- **Pros**: A purpose-built key store; conceptually separates "have I seen this key" from "store the event".
- **Cons**: Adds a second store and an extra round-trip on the hot path, plus a check-then-insert race window and a dual-write consistency problem between the dedupe store and the event table. A single UNIQUE `(tenant, source, event_id)` + `ON CONFLICT DO NOTHING` gives atomic exactly-once accrual against the one source of truth with no extra store — exactly the shipped E014 `billing_event` pattern. Rejected.

### Option D: Billing-aligned or per-entitlement-configurable rollup buckets

Store the aggregate directly in billing-period-aligned (or per-entitlement-configurable) buckets rather than fixed hourly.

- **Pros**: The stored bucket matches the billing period, so true-up reads a single row; no hour-summing at query time.
- **Cons**: Bleeds billing-cycle knowledge into metering storage (breaking the metering↔billing boundary), and configurable/movable period boundaries cause boundary-bleed and re-bucketing complexity when a cycle changes. A FIXED hourly grain is deterministic and reproducible; "per period" sums hourly buckets over a query window and billing-period alignment is applied by E014 at read time, keeping metering free of billing semantics. Rejected.

### Option E: Hard-floor the stored aggregate at zero

Store `max(0, net)` in the aggregate so a reversal can never drive the stored value negative.

- **Pros**: One value serves both display and billing; operators and true-up both see a non-negative number with no floor logic on read.
- **Cons**: Lossy and non-reproducible — flooring at storage time discards the true signed net, so re-querying or recomputing from raw can disagree with the stored value, and a net-negative correction is hidden from E014 true-up (which must see the real net to true-up correctly). Storing the TRUE signed net and flooring only for operator display keeps storage reproducible and billing-honest while operators never see negative usage. Rejected (this was raised as STF-001 and resolved into the model).

### Option F: Ship gauge/peak aggregation (MAX/LATEST) in the MVP

Support gauge/peak types (MAX concurrent, LATEST snapshot) alongside the counter types in the first release.

- **Pros**: Covers "peak concurrent" and "latest reading" metering products immediately.
- **Cons**: Gauge/peak is non-additive (a MAX/LATEST cannot be incrementally summed across buckets) and breaks the additive signed-reversal model the whole rollup+correction design relies on — it needs point-in-time rather than accumulation semantics. Counter-only (SUM/COUNT/UNIQUE_COUNT) keeps one additive, reproducible rollup with well-defined reversals; gauge/peak is a documented extension deferred until its distinct semantics are designed. Rejected for the MVP (deferred, not refused permanently).

### Option G: Piggyback ingestion on the E013 heartbeat transport

Carry usage events on the existing E013 validate/heartbeat runtime surface rather than a dedicated endpoint.

- **Pros**: No new endpoint; reuses an existing client-connected channel.
- **Cons**: Couples the high-write, burst-prone metering path to E013's validation SLAs and rate limits — a metering burst would degrade enforcement latency (and vice versa) — and it cannot carry an independent fast-ack/rate-limit/batch-summary contract. A DEDICATED batch endpoint isolates the high-write path and its own rate limit from E013. Rejected.

### Option H: Reuse the existing validate scope for ingestion authority

Authorize usage reporting with an existing runtime `validate` (or similarly broad) API-key scope instead of a new one.

- **Pros**: No new scope to mint, provision, or document; existing validating clients can report immediately.
- **Cons**: Over-broad — every validating client would silently gain usage-write authority, and the write path could not be revoked independently of validation. A new least-privilege `usage.ingest` scope (tenant- and license-bound) is independently grantable/revocable and keeps validating clients from gaining write-usage authority. Rejected.

## Decision Outcome

Chosen option: **Option A — the composite usage-metering model: a metered E007 entitlement kind + idempotent append-only ingest (dedicated fast-ack `usage.ingest` batch endpoint, UNIQUE `(tenant, source, event_id)` + ON CONFLICT DO NOTHING) + watermark-driven incremental hourly rollup (no hot counter, on-read open-bucket fallback) + reference-free signed reversals (true signed net stored, floor-at-zero display) + bounded ~35d dedupe/retention with a fail-open prune worker + a strict metering↔billing boundary** — because it is the only option that accrues high-write usage exactly-once and reproducibly without hot-row contention, handles late/out-of-order events and corrections without mutating history, stays additive to E007, reuses the shipped E014 idempotency + fail-open-worker patterns and the E005/RLS/audit foundation with no new dedupe store and no money computed. Concretely, the model is fixed as:

1. **Metered entitlement KIND on E007.** A `metered` value on the E007 `entitlement` type/kind enum + metered-only columns (a fixed counter aggregation type SUM/COUNT/UNIQUE_COUNT, a unit, an optional allowance), on the existing catalog admin surface; distinct from boolean/limit (which are UNCHANGED). Aggregation type + unit are FROZEN once any usage event exists. Gauge/peak (MAX/LATEST) is a documented deferred extension.
2. **Idempotent at-least-once ingestion.** A dedicated fast-ack batch endpoint (separate from E013), authenticated by the new least-privilege `usage.ingest` scope (E005, tenant- and license-bound, fail-closed on absence), accepts single/batch (default cap 1,000/request; over-cap rejected pre-accrual). Dedupe is UNIQUE `(tenant, source, event_id)` + `INSERT ... ON CONFLICT DO NOTHING` in one transaction (exactly-once, concurrency-safe, no second store) — the shipped E014 `billing_event` pattern. The batch is per-event-idempotent with a summary; one bad event never fails it. Events reference an unknown/archived/non-metered/cross-tenant license or entitlement are rejected with a distinct reason and accrue nothing.
3. **Append-only raw + async watermark rollup into FIXED hourly buckets.** `usage_event` is append-only (never mutated/deleted in normal operation). A watermark-driven worker incrementally rolls raw events into hourly `usage_rollup` buckets per (tenant, license, entitlement, hour) by the entitlement's aggregation type — NO per-event counter. Accrual is by the client event timestamp; skew bounds reject too-old (> retention) and future-dated (> allowance) events. A late event within the window re-opens/recomputes its hour. "Per period" queries sum hourly buckets over a caller window (billing-period alignment is E014's at read). The rollup worker is fail-open with an on-read fallback for the open bucket (eventually consistent, ingest never blocked).
4. **Reference-free signed reversals; TRUE signed net stored; display floored at zero.** Corrections are standalone signed-negative events (no original-event id required) that adjust the aggregate append-only without mutating any prior event. `usage_rollup` stores the TRUE signed net (reproducible, and what E014 consumes); operator query/UI floors the displayed value at `max(0, net)`. Storage is NEVER hard-floored.
5. **Bounded ~35d dedupe/retention + fail-open prune.** Raw events + idempotency keys are retained for a bounded configurable window (~35d) then pruned post-rollup by a time-driven, fail-open worker (owner-role DELETE, synthetic-actor audit); the durable rollup survives. Dedupe is guaranteed only within the window (a re-report after pruning is a fresh accrual — disclosed). Usage is tenant-scoped (forced RLS, cross-tenant → not found, unset tenant GUC → zero rows), minimized (references/quantities/timestamps/allow-listed dimensions, no PII), and GDPR-erasable.
6. **Strict metering ↔ billing boundary.** Metering computes NO price, rate, or money. E014 reads the true-signed-net aggregate READ-ONLY for true-up (never the floored display); the aggregate's reproducibility makes a billing re-run idempotent. Every ingestion batch, metered-entitlement definition/edit, over-quota signal, reversal, and prune is append-only audited (ingestion attributed to the reporting key/license, workers to a synthetic system actor), with no secret/API key/signing key ever exposed in any response, log, or audit entry.

This ADR fixes the usage-metering ingestion + aggregation MODEL and the permanent metering↔billing boundary. It does NOT re-decide the E007 entitlement semantics (extended additively), the E008 license lifecycle, the E005 scope/RBAC core, or the E014 billing/true-up logic — all of which are reused unchanged.

## Consequences

### Positive

- Consumption licensing is enabled: a licensed client can report usage in a durable, idempotent, high-write way and have it accrued into a reproducible per-license aggregate, closing the gap that E007 boolean/limit entitlements cannot express (CAP-011).
- The high-write path scales by avoiding hot-row contention — append-only raw events + an async watermark-driven rollup collapse many inserts into one incremental recompute, with no per-event counter UPDATE to serialize on.
- Accrual is exactly-once under at-least-once and concurrent redelivery: a UNIQUE `(tenant, source, event_id)` + ON CONFLICT DO NOTHING gives atomic dedupe against a single source of truth (no second store, no check-then-insert race), reusing the shipped E014 `billing_event` pattern.
- The aggregate is reproducible and billing-grade: it stores the TRUE signed net, so an identical re-query returns identical totals and an E014 true-up re-run is idempotent; the floor-at-zero is operator display only and never hides a net-negative correction from billing.
- Late / out-of-order events and corrections are handled without mutating history: event-timestamp accrual + hourly bucket re-open place a late event in the right period, and append-only signed reversals adjust the aggregate without touching any prior event.
- The metering ↔ billing boundary is clean and permanent: metering computes no money, E014 reads the aggregate read-only, and billing-period alignment stays in E014 — mirroring and complementing the ADR-0011 PCI/payment boundary.
- The single security/data foundation is preserved (Principles II/III): the ingest scope reuses E005, tenant isolation reuses forced RLS, corrections/definitions/prunes reuse the append-only audit, and no new crypto is introduced; usage is PII-minimized and GDPR-erasable.

### Negative

- Adds operational surface: a high-write ingest endpoint plus TWO fail-open workers — incremental rollup and retention prune — that must be run, monitored, and kept fail-open.
- The aggregate is eventually consistent rather than synchronously exact: the still-open hourly bucket relies on an on-read fallback until the rollup worker catches up (bounded and disclosed; the fallback keeps totals reproducible).
- Dedupe is guaranteed only within the bounded ~35-day window: a re-report after its idempotency key is pruned double-accrues (a disclosed, documented consequence of bounded dedupe on a high-write path).
- UNIQUE_COUNT requires exact distinct-value tracking per bucket (a distinct-value side structure or bucket recompute), heavier and more storage-intensive than the additive SUM/COUNT — flagged for the DBA.
- Fixed hourly bucketing is a schema-level commitment: "per period" totals are summed at query time and billing-period alignment is deferred to E014's read path (an intentional boundary cost, not a limitation of the totals).

### Neutral

- Gauge/peak aggregation types (MAX concurrent, LATEST snapshot) are a documented DEFERRED extension, not a permanent exclusion — they need point-in-time rather than additive-accumulation semantics and would break additive reversal, so they wait until that distinct model is designed.
- The dedupe/retention window (~35d), the clock-skew future allowance, the hourly bucket + rollup interval, the ingest rate-limit threshold, and the max batch size (default 1,000/request) are operator policy/config choices within this model, not separate architectural decisions.
- The client's obligation to batch/pre-aggregate and post usage online, and any SDK-side local buffering/retry, are a client concern (E003) aligned with the honest-client posture; this decision governs the server ingest/accrual contract, not client transport.
- The optional per-entitlement allowance/quota is a SIGNAL only (over-quota flag + audit); it never blocks ingestion or enforces on the client — runtime enforcement of a metered limit stays the client's/E013's responsibility.
- The overage that E015 meters to the audit log under a soft concurrency cap (ADR-0012) is a candidate input for consumption true-up consumed through this metering aggregate, not a separate decision here.

## Links

- specs/00017-usage-metering-and-aggregation/spec.md — E016 (FR-001..FR-020, US1..US6, SC-001..SC-017); the idempotent ingest, watermark hourly rollup, reproducible aggregate, signed-reversal, retention, and metering↔billing-boundary requirements this ADR fixes the model for.
- specs/00017-usage-metering-and-aggregation/plan.md — the feature-local tradeoffs AD-001..AD-009 (dedupe, aggregation strategy, rollup grain/period, reversal & floor, metered-entitlement modeling, ingest transport & auth, retention & prune, batch semantics, module placement) that instantiate this project-level model.
- migrations/0010_billing.sql — the shipped E014 `billing_event` source+id idempotency (`UNIQUE` + INSERT ... ON CONFLICT DO NOTHING) this model mirrors for exactly-once ingest accrual.
- migrations/0011_leases.sql — the highest existing migration; the new `0012_usage_metering.sql` (usage_event + usage_rollup + entitlement metered columns) lands sequentially after it.
- specs/00015-billing-driven-entitlement-automation/spec.md — E014 billing/true-up, the read-only consumer of the true-signed-net metering aggregate; metering computes no money.
- ADR-0011 (Billing-Webhook Integration and the External-Event → License-Lifecycle Model) — the billing integration this model complements; it reuses ADR-0011's idempotency and retention-worker patterns and mirrors its permanent payment/PCI boundary with the metering↔billing boundary.
- ADR-0012 (Floating and Concurrent-Seat Leasing Model) — the soft-cap overage E015 meters to the audit log is a candidate true-up input consumed via this metering aggregate.
- ADR-0004 (Multi-Tenancy Isolation Model) — the tenant-scoping (forced RLS, cross-tenant → not found) the usage tables inherit.
- ADR-0005 (Architecture Style — Modular Monolith) — the module seams the new `usage` module and its rollup + retention workers slot into.
- PRD CAP-011 (usage metering & aggregation); the E007 entitlement model this ADR extends, the E008 license and E005 scope/RBAC it consumes, and the E009/E013 clients that are the reporting sources; project-instructions.md Principle II (multi-tenant isolation + RBAC) and Principle III (single security core, fully audited).
