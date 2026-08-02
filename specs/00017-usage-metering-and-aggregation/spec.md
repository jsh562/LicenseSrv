---
feature_branch: "00017-usage-metering-and-aggregation"
created: "2026-07-24"
input: "e016"
spec_type: "product"
spec_maturity: "clarified"
epic_id: "E016"
epic_sources: "{PRD:CAP-011}"
---

# Feature Specification: Usage Metering & Aggregation

**Feature Branch**: `00017-usage-metering-and-aggregation`
**Created**: 2026-07-24
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: clarified
**Epic ID**: E016
**Epic Sources**: {PRD:CAP-011}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The catalog (E007) expresses entitlements only as on/off flags or static integer limits — it cannot express **consumption**: API calls made, gigabytes processed, seat-hours consumed, frames rendered. Vendors who sell usage-metered or consumption-based products therefore have no way to have their licensed applications report usage, no durable accrual of that usage against a license, and nothing for billing (E014) to later true-up against. This feature adds a metered entitlement kind plus an idempotent, high-write usage-event ingestion path that accrues reported usage into a reproducible per-license aggregate — counting a re-reported event exactly once — and exposes that aggregate for querying, strictly separate from pricing and invoicing.

## Scope *(mandatory)*

### Included

- Metered entitlement kind: an operator defines a metered entitlement with a fixed aggregation type and unit on a plan, distinct from E007's boolean/limit entitlements; the aggregation type is immutable once usage exists.
- Idempotent usage-event ingestion: a licensed application reports usage events (single or batch) against a license's metered entitlement carrying a client-supplied idempotency key; the same event reported twice is accrued exactly once; events are append-only.
- Accrual & aggregation: usage accrues by the client-supplied event timestamp into a reproducible aggregate per (license, entitlement, period/time-bucket), using the entitlement's aggregation type, via incremental rollup (not a per-event hot counter).
- Query surface: aggregated usage is queryable per license, per entitlement, and per period; the aggregate is reproducible (identical totals on re-query).
- Late / out-of-order & corrections: late events within the retention window update the correct period; corrections are explicit reversal/negative events (append-only, never mutate prior events); clock-skew bounds reject too-old / future-dated events.
- Optional quota signal: an operator may set an allowance/quota on a metered entitlement; crossing it surfaces a signal (flag + audit) — signal only, it never blocks ingestion or enforces on the client.
- Retention & pruning: raw events + idempotency keys are retained for a bounded, configurable window then pruned (post-rollup); the durable aggregate survives; usage is tenant-scoped, minimized, and GDPR-erasable.
- Rate-limited ingest, tenant isolation, and append-only audit on the metering surface.

### Excluded

- Pricing, rating, invoicing, and true-up billing — E014 consumes the aggregate read-only; this epic never computes price or money (metering ↔ billing boundary).
- Quota **enforcement** / throttling / blocking on the client — this epic only *signals* when a quota is crossed; enforcing a metered limit at runtime is the client's / E013's responsibility.
- Client-side offline usage buffering / sync protocol — the licensed app batches and posts usage online; the SDK's local buffering and retry are a client concern (E003), not this epic.
- Real-time streaming / event-bus ingestion (e.g. Kafka) — the ingest path is a batched REST endpoint on the existing runtime; a streaming transport is a future scale option, not this epic.
- Changing E007's boolean/limit entitlement semantics — the metered kind is additive; existing entitlement types are unchanged.
- Gauge/peak aggregation types (MAX concurrent, LATEST snapshot) — the MVP supports counter aggregations (see FR-008 / the clarification); gauge/peak is a documented extension.

### Edge Cases & Boundaries

- Duplicate event (same idempotency key) → accrued once; re-reporting the same batch adds nothing.
- Event for a non-metered, unknown, archived, or cross-tenant license/entitlement → rejected with a distinct reason, no accrual.
- Event timestamp older than the retention window, or more than the allowed skew in the future → rejected with a distinct reason.
- Late / out-of-order event within the retention window → the affected period's aggregate re-opens and updates correctly.
- Reversal / negative correction event → the aggregate adjusts; prior events are never mutated or deleted.
- Batch with mixed new / duplicate / invalid events → new events accrue, duplicates are no-ops, invalid events are reported per-event; one bad event does not fail the whole batch.
- Batch exceeding the configured size cap → rejected with a distinct reason before any accrual.
- Idempotency key pruned after the retention window → a later re-report is a fresh accrual (cannot resurrect the pruned event) — a documented consequence of bounded dedupe.
- Concurrent ingestion of the same idempotency key from parallel producers → accrued exactly once (unique constraint), never double-counted.
- Attempt to change a metered entitlement's aggregation type / unit after any event exists → refused.
- High-write burst → the ingest endpoint fast-acks and is rate-limited per API key (429 + Retry-After); the rollup worker failing → fail-open, with an on-read fallback for the open bucket (aggregate eventually consistent).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Report usage idempotently and accrue it (Priority: P1) 🎯 MVP

A licensed application reports usage events (typically a pre-aggregated batch) against a license's metered entitlement. Each event carries a client-supplied idempotency key. The server accrues each new event append-only and suppresses duplicates — an event reported twice (a retry, an at-least-once redelivery) is counted exactly once. The endpoint fast-acks so a high-volume client is never blocked.

**Why this priority**: Core value proposition and the correctness heart of metering — without idempotent accrual, retries either double-bill or lose usage, and consumption licensing is untrustworthy. Directly satisfies the epic's "accrues usage" + "reported twice counted once" criteria.

**Independent Test**: Define a SUM meter; report a batch of distinct events; re-report the identical batch; confirm the aggregate reflects each event exactly once (the re-report adds nothing).

**Acceptance Scenarios**:

1. **Given** a license with a metered entitlement, **When** the app reports a batch of distinct usage events with idempotency keys, **Then** each is accrued once and the endpoint fast-acks with a per-batch summary.
2. **Given** events already accrued, **When** the same events (same idempotency keys) are reported again, **Then** they are recognized as duplicates and no additional usage is accrued.
3. **Given** an event referencing a non-metered, unknown, archived, or cross-tenant license/entitlement, **When** it is reported, **Then** it is rejected with a distinct reason and nothing is accrued.
4. **Given** the same idempotency key submitted concurrently by parallel producers, **When** both are processed, **Then** exactly one event is accrued.

### User Story 2 - Query aggregated usage per license (Priority: P1) 🎯 MVP

An operator (and the licensed application) queries how much has been consumed: the accrued aggregate per license, per metered entitlement, and per period. The aggregate is reproducible — querying the same window twice yields identical totals — so it is trustworthy for support, capacity review, and later billing true-up.

**Why this priority**: Accrued usage is worthless if it cannot be read back reliably; the query surface is what makes metering usable and is the contract E014 billing consumes. Satisfies the epic's "aggregated usage is queryable per license" criterion.

**Independent Test**: Report events across two periods; query the per-license aggregate for each period and confirm the totals; re-query and confirm identical totals (reproducible).

**Acceptance Scenarios**:

1. **Given** accrued usage on a license, **When** an operator queries the aggregate per license/entitlement/period, **Then** the correct totals are returned per the entitlement's aggregation type.
2. **Given** the same query issued twice over an unchanged window, **When** both run, **Then** they return identical totals (reproducible aggregate).
3. **Given** two tenants, **When** one queries usage, **Then** no other tenant's usage is visible and a cross-tenant license reference resolves to not found.

### User Story 3 - Define a metered entitlement (Priority: P1) 🎯 MVP

An operator defines a metered entitlement on a plan — choosing its aggregation type (how reported quantities combine: e.g. SUM of quantities, COUNT of events, UNIQUE_COUNT of distinct values) and its unit — so that usage reported against it accrues correctly. A metered entitlement is a distinct kind from boolean and limit entitlements. Once usage exists, the aggregation type and unit are frozen to preserve the meaning of historical data.

**Why this priority**: There is nothing to meter against until a metered entitlement exists; it is the enabling definition for US1/US2 and must be independently correct (the aggregation type determines every downstream total).

**Independent Test**: Define a SUM meter and a COUNT meter; report the same events to each; confirm SUM sums the quantities while COUNT counts the events; then attempt to change an aggregation type after events exist and confirm it is refused.

**Acceptance Scenarios**:

1. **Given** a plan, **When** an operator defines a metered entitlement with an aggregation type and unit, **Then** it is created as a metered kind distinct from boolean/limit entitlements and usage reported against it accrues per that aggregation type.
2. **Given** a metered entitlement with no usage yet, **When** the operator edits its aggregation type or unit, **Then** the edit succeeds; **Given** a metered entitlement with usage, **When** the same edit is attempted, **Then** it is refused with a distinct reason.

### User Story 4 - Handle late, out-of-order, and correction events (Priority: P2)

Usage arrives late and out of order (batched hourly, retried after an outage). The server accrues each event to the period of its client event timestamp — not when it was received — so a late event lands in the correct period as long as it is within the retention window. Beyond the skew bounds (too old, or future-dated) an event is rejected. Corrections are made by reporting explicit reversal/negative events; accrued events are never mutated or deleted.

**Why this priority**: Real fleets report late and need corrections; without event-timestamp accrual and reversals the aggregate drifts from reality. Valuable, but the MVP accrual/query loop (US1–US3) works for in-order reporting without it.

**Independent Test**: Report an event dated to a prior period within the window and confirm that period's aggregate updates; report a future-dated and a too-old event and confirm both are rejected; report a reversal event and confirm the aggregate decreases without any prior event changing.

**Acceptance Scenarios**:

1. **Given** an event whose client timestamp falls in an earlier still-retained period, **When** it is reported, **Then** that period's aggregate updates to include it.
2. **Given** an event timestamped older than the retention window or more than the allowed skew in the future, **When** it is reported, **Then** it is rejected with a distinct reason and not accrued.
3. **Given** accrued usage, **When** a reversal/negative correction event is reported, **Then** the aggregate adjusts accordingly and no prior event is mutated or deleted.

### User Story 5 - Signal when a quota is crossed (Priority: P2)

An operator may attach an allowance/quota to a metered entitlement (e.g. 10,000 units/period). When accrued usage crosses the allowance, the server surfaces a signal — the aggregate is flagged over-quota and an audit entry is recorded — so the operator can follow up or the vendor can act. Ingestion is never blocked and the client is not throttled; this epic signals, it does not enforce.

**Why this priority**: A useful upsell/ops signal for metered plans, but pure accrual (US1–US3) is fully functional without it, and enforcement deliberately lives elsewhere.

**Independent Test**: Set an allowance on a metered entitlement; accrue usage past it; confirm the aggregate is flagged over-quota and an audit entry is written, while further events still ingest successfully.

**Acceptance Scenarios**:

1. **Given** a metered entitlement with an allowance, **When** accrued usage crosses the allowance, **Then** the aggregate is flagged over-quota and an audit entry is recorded.
2. **Given** usage already over the allowance, **When** more events are reported, **Then** they still ingest and accrue (no block), and the over-quota signal persists.

### User Story 6 - Retain and prune raw usage bounded (Priority: P2)

Raw usage events and their idempotency keys cannot grow forever on a high-write path. The server retains them for a bounded, configurable window, then prunes the raw events and keys once they have been rolled up — the durable per-period aggregate survives pruning. Because dedupe is bounded, a re-report after the key has been pruned is treated as a fresh accrual. Usage data is tenant-scoped, minimized, and erasable on a GDPR request.

**Why this priority**: Operationally necessary for a high-write path at scale, but the accrual/query MVP is correct without pruning in the short term; retention is hardening.

**Independent Test**: Age raw events past the retention window, run the prune, and confirm the raw events + keys are gone while the rollup aggregate is unchanged; confirm a re-report of a pruned event accrues freshly (cannot resurrect the original).

**Acceptance Scenarios**:

1. **Given** raw events older than the retention window that have been rolled up, **When** the prune runs, **Then** the raw events and their idempotency keys are removed and the aggregate is unchanged.
2. **Given** a tenant GDPR-erasure request, **When** it is processed, **Then** that tenant's usage events and aggregates are erased.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a licensed application report usage events — single or as a batch — against a license's metered entitlement via a DEDICATED runtime ingest endpoint (separate from the E013 validate/heartbeat surface), authenticated by a new ingest-only API-key scope `usage.ingest` (E005) that is tenant- and license-bound, rejecting fail-closed any call lacking that scope.
- **FR-002**: System MUST require each usage event to carry a client-supplied `source` identifier and an idempotency key, and MUST accrue each key at most once per `(tenant, source)` — a unique constraint on `(tenant, source, idempotency_key)` + insert-on-conflict-do-nothing, mirroring the E014 `billing_event` source+id pattern so independent producers mint keys without cross-source collision; a re-report of the same key succeeds without accruing a second time. Dedupe is guaranteed only within the retention window (FR-015).
- **FR-003**: System MUST store usage events append-only and MUST NOT mutate or delete an accrued event as part of normal operation — corrections are made via explicit reversal/negative events (FR-013), and removal happens only via retention pruning (FR-015) or GDPR erasure (FR-016).
- **FR-004**: System MUST accrue each event by its client-supplied event timestamp (not receipt time) and MUST bound clock skew — rejecting, with a distinct reason, any event timestamped older than the retention window or more than a configured allowance into the future.
- **FR-005**: System MUST treat ingestion as a high-write, fast-ack path (accept-then-aggregate) and MUST rate-limit it per API key, returning `429 rate_limited` + `Retry-After` above a configured threshold, with a configured maximum batch size (default 1,000 events per request; a larger batch is rejected with a distinct reason before any accrual).
- **FR-006**: System MUST reject an event that references an unknown, archived, non-metered, or cross-tenant license or entitlement with a distinct reason and accrue nothing for it.
- **FR-007**: System MUST process a batch per-event-idempotently: new events accrue, duplicates are no-ops, and invalid events are reported individually in a per-batch summary — a single bad event MUST NOT fail the whole batch.
- **FR-008**: System MUST let an operator define a metered entitlement, modeled as a new `metered` value ADDED to the E007 `entitlement` type/kind enum with metered-only columns (aggregation type, unit, optional allowance) on the existing catalog admin surface — a kind distinct from E007's boolean/limit entitlements. The MVP aggregation set is COUNTER-ONLY — SUM (of reported quantities), COUNT (of events), and UNIQUE_COUNT (of distinct values); gauge/peak types (MAX concurrent, LATEST snapshot) are a documented extension (Excluded), deferred because they need point-in-time rather than additive-accumulation semantics and would break additive reversal.
- **FR-009**: System MUST freeze a metered entitlement's aggregation type and unit once any usage event exists for it — an edit is permitted while no usage exists and refused (distinct reason) afterward — to preserve the meaning of historical aggregates.
- **FR-010**: System MUST accrue usage into a durable, reproducible aggregate per (license, entitlement, time-bucket) using the entitlement's aggregation type, via incremental rollup keyed by a processed-watermark rather than a per-event counter update, to avoid hot-row write contention. The storage grain is a FIXED hourly time-bucket; "per period" queries (FR-011) roll up hourly buckets over a caller-supplied window, and billing-period alignment is applied by E014 at read time (kept out of metering storage per the metering↔billing boundary). The rollup MUST be idempotent under worker restarts, overlapping sweeps, and event re-processing: because each affected bucket is RECOMPUTED from the retained raw events (not incrementally counted) and keyed by `watermark_ingested_at` (the MAX ingested_at folded in), a restart or a re-run over the same events yields the IDENTICAL aggregate with no double-count, and concurrent late events resolving the same already-rolled bucket converge to a single reproducible recompute (no lost update).
- **FR-011**: System MUST expose a query surface returning aggregated usage per license, per entitlement, and per period/time-window, and the returned aggregate MUST be reproducible — an identical query over an unchanged window returns identical totals. This reproducibility is QUERY-STABILITY of the durable stored rollup (the same durable aggregate is returned on every re-query, including AFTER raw-event pruning) — distinct from the in-window recompute-from-raw of FR-010; billing true-up (FR-020) relies on this durable query-stability, not on raw events that may already be pruned.
- **FR-012**: System MUST correctly update the affected period's aggregate when a late or out-of-order event (within the retention window) is reported, by re-opening/recomputing that time-bucket. The retention window is the SINGLE governing bound on acceptance: an event whose event timestamp is older than the retention window is rejected `stale_event` (FR-004) EVEN IF its target time-bucket has not yet been rolled up — an as-yet-unrolled bucket does not extend acceptance beyond the window.
- **FR-013**: System MUST support corrections via explicit reversal/negative usage events — a standalone signed-negative event that does NOT need to reference an original event id (fitting pre-aggregated batch clients) — that adjust the aggregate append-only, without mutating or deleting any prior event. The stored aggregate retains the TRUE signed net (reproducible, and what E014 true-up consumes), while query/UI responses floor the displayed value at zero so **viewer-role** operators never see negative usage (an elevated admin — or the E014/app internal read — may read the true signed net per FR-020). Reversal semantics are aggregation-type specific and well-defined for reproducibility: for SUM a signed-negative quantity decrements the stored net; for COUNT each event contributes its integer quantity (normally `+1` per occurrence) and a signed reversal decrements the event count by its integer reversal count (e.g. a `-1` removes one previously counted event); for UNIQUE_COUNT the distinct set is MONOTONIC within a bucket — a distinct value, once seen, is NEVER retracted by a reversal (so a UNIQUE_COUNT quantity is a positive integer and a negative/zero/non-integer UNIQUE_COUNT quantity is rejected per-event `validation_error`, consistent with the counter-only MVP).
- **FR-014**: System MUST support an optional per-entitlement allowance/quota that, when accrued usage crosses it, surfaces a signal — flagging the aggregate over-quota and recording an audit entry — WITHOUT blocking ingestion or throttling the client (signal only; enforcement is out of scope). The crossing is evaluated against the stored TRUE signed net (not the floor-at-zero display). The append-only AUDIT ENTRY is the authoritative, durable record of a crossing; the `over_quota` flag is a DERIVED convenience recomputable from the rollup (net vs allowance). Once usage is already over the allowance, further events still ingest and accrue and the flag remains set (no additional block); a later reversal that drops the net back below the allowance clears the derived flag while the historical crossing audit entry is retained.
- **FR-015**: System MUST retain raw usage events and idempotency keys for a bounded, configurable window and prune them (post-rollup) via a time-driven, fail-open worker, leaving the durable rollup aggregate intact; a re-report after a key is pruned is a fresh accrual and MUST NOT resurrect the pruned event. Retention is measured by the same event-timestamp bound as acceptance (FR-004/FR-012): a raw event (with its idempotency key and any distinct-set working row for a CLOSED bucket) is pruned only once its bucket is older than the acceptance window, so a still-acceptable late event never targets a partially-pruned bucket. When a bucket CLOSES (ages beyond the acceptance window so no further late event can land in it), its aggregate — including a UNIQUE_COUNT distinct count — is FINAL in the durable rollup, and the distinct-set working rows for that closed bucket are pruned with the raw, keeping distinct-set storage bounded to the open window (reconciling the unbounded-growth risk).
- **FR-016**: System MUST keep usage data tenant-scoped and minimized — storing only license/entitlement references, quantities, event timestamps, and client-supplied dimensions, with no PII beyond those references — and MUST make a tenant's usage events and aggregates erasable on a GDPR request. Client-supplied `dimensions` MUST be validated at ingest against a server-side allow-list schema (bounded key set, scalar values only, size caps); an event whose `dimensions` violate that schema is REJECTED per-event with a distinct `validation_error` reason — never silently dropped, truncated, or stored — so PII cannot leak into free-form dimensions.
- **FR-017**: System MUST isolate usage by tenant, fail-closed (forced RLS on the usage tables): an actor or API key from one tenant can neither ingest for, read, nor see another tenant's usage, and a cross-tenant license/entitlement reference resolves to not found.
- **FR-018**: System MUST record an append-only audit entry for each ingestion batch (summary), metered-entitlement definition/edit, over-quota signal, reversal, and retention prune — attributing ingestion to the reporting API key/license and worker actions (rollup, prune) to a synthetic system actor — without secrets or credentials.
- **FR-019**: System MUST never expose a secret, API key, or signing key in any usage response, log, or audit entry; query responses carry only aggregate values and dimensions.
- **FR-020**: System MUST expose the aggregate as read-only to downstream billing true-up (E014) and MUST NOT compute price, rate, or money — metering accrues and aggregates only; the aggregate MUST be reproducible so a billing re-run yields identical totals. Billing true-up consumes the TRUE signed net stored value — NOT the operator-facing floor-at-zero display (FR-013) — so a net-negative correction remains fully visible to true-up. Access to the un-floored TRUE signed net MUST be bounded: it is available only to the E014/billing internal read path, the licensed app's self-read of its own bound license, and an ELEVATED operator role (admin or higher). A plain `viewer` only ever receives the floor-at-zero display (`max(0, net)`) and NEVER sees negative usage (reconciling FR-013); a `viewer` request for the raw signed net is refused fail-closed (insufficient role).
- **FR-021**: System MUST fail-closed on license lifecycle state at ingest — an event targeting a license (or reported by an API key bound to a license) that is NOT in an active state (e.g. expired, suspended, revoked, or otherwise inactive) is REJECTED per-event with a distinct reason (`license_inactive`) and accrues nothing, mirroring how the E013 validate path refuses a non-active license. This is in addition to the unknown/archived/non-metered/cross-tenant per-event refusals (FR-006) and the scope fail-closed refusal (FR-001), so ingest never accrues against a license that is not currently active. Per-event refusal precedence is deterministic so a client receives one unambiguous distinct reason: `not_found` (unknown/cross-tenant license or entitlement) > `not_metered` (entitlement not a metered kind) > `archived` (archived license/entitlement, FR-006) > `license_inactive` (non-active lifecycle) > `stale_event`/`future_event` (skew) > `validation_error` (dimension/quantity).

### Key Entities *(include for product or technical specs if feature involves data)*

- **Usage event** *(new)*: an append-only raw record that a licensed application reported some consumption. Attributes: owning tenant, the license and metered entitlement it targets, a client-supplied `source` id + idempotency key (unique per `(tenant, source)`), the client event timestamp, a signed numeric quantity (negative for a reversal), optional client-supplied dimensions (minimized, no PII), and ingested-at. Invariant: at most one accrued event per `(tenant, source, idempotency key)`; events are never mutated, only appended, pruned, or GDPR-erased.
- **Usage aggregate / rollup** *(new)*: the durable, reproducible accrual per (tenant, license, entitlement, hourly time-bucket), holding the aggregated value per the entitlement's aggregation type plus a processed-watermark and an optional over-quota flag. Stores the TRUE signed net (floored at zero only for display, FR-013). Reproducible in two senses: RECOMPUTE-reproducible from the retained raw events while within the retention window (FR-010), and QUERY-STABLE thereafter — the durable stored value is returned identically on every re-query and survives raw-event pruning (what E014 true-up consumes); "per period" totals roll up hourly buckets over a query window.
- **Metered entitlement** *(extends E007 `entitlement`)*: a new `metered` value on the E007 `entitlement` type/kind enum, carrying a fixed counter aggregation type (SUM/COUNT/UNIQUE_COUNT; gauge/peak deferred, FR-008), a unit, and an optional allowance/quota, on the existing catalog admin surface. Distinct from boolean/limit entitlements; aggregation type + unit are immutable once usage exists.
- **License** (E008, consumed): usage is reported and aggregated per license; the license and its plan's metered entitlements scope what may be reported. A cross-tenant or unknown license reference resolves to not found.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Usage reporting is an **online** capability: the licensed application (activated via E009 / validated via E013) can reach the ingest endpoint and batches/pre-aggregates events client-side; the SDK's local buffering and retry are out of scope (E003).
- Metered entitlements extend the E007 entitlement model additively (a new kind alongside boolean/limit); this epic does not change existing entitlement semantics or the plan-authoring flow beyond adding the metered kind.
- Ingestion is authenticated by a scoped, tenant- and license-bound runtime API key (E005); the operator usage-query surface uses the console session + RBAC (E005), consistent with E009/E013/E014.
- The idempotency key is client-supplied and stable across retries (source + id), mirroring the E014 `billing_event` dedupe already in this codebase.
- Aggregates are reproducible so a downstream billing true-up (E014) re-run yields identical totals; E014 consumes the aggregate read-only and this epic computes no money.

### Risks

- **Hot-row write contention** *(likelihood: medium, impact: high)*: updating a per-license counter on every event would serialize the high-write path — mitigated by append-only raw events + asynchronous incremental rollup keyed by a watermark (no per-event counter update), proven by a high-write test.
- **Unbounded raw-event / idempotency-key growth** *(likelihood: high, impact: medium)*: retaining every event and key forever would exhaust storage — mitigated by the bounded dedupe/retention window + a fail-open prune worker (FR-015), with the documented consequence that dedupe is only guaranteed within the window.
- **Aggregate drift under late / out-of-order / reversal events** *(likelihood: medium, impact: high)*: accruing by receipt time or mutating events in place would corrupt period totals — mitigated by event-timestamp accrual, bucket re-open, append-only reversals, and a reproducible rollup, proven by tests.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `usage_event` (append-only raw) and `usage_rollup`/`usage_aggregate` (durable per-period accrual).
- `NEW-API` — a DEDICATED usage ingest REST endpoint (single + batch, new `usage.ingest` scope, rate-limited, fast-ack, per-batch summary) and an aggregate query REST (operator console + app), plus metered-entitlement definition on the E007 catalog admin surface.
- `NEW-UI` — operator "Usage" view (per-license/entitlement aggregate, over-quota flag) within the Licensing/Catalog area.
- `MIGRATION` — new `usage_event` + `usage_rollup` tables (tenant-scoped, forced RLS, append-only, unique `(tenant, source, idempotency_key)`, hourly time-bucket index); add a `metered` value to the E007 `entitlement` type/kind enum plus metered-only columns (aggregation type, unit, optional allowance). Sequential migration after `0011_leases.sql`.
- `NEW-WORKER` — an incremental usage-rollup worker (watermark-driven) and a retention/prune worker (fail-open, time-driven, synthetic-actor audit), mirroring the E014 grace/reconcile/retention worker pattern.
- `NEW-CONFIG` — dedupe/retention window (default 35 days, configurable; idempotency scope `(tenant, source, key)`), clock-skew future allowance, FIXED hourly rollup bucket + rollup interval, ingest rate-limit threshold, and maximum batch size (default 1,000/request).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A usage event reported twice with the same idempotency key is accrued exactly once.
- **SC-002** [US1]: A batch of N distinct events accrues N; re-reporting the identical batch accrues nothing further.
- **SC-003** [US1]: An event for an unknown, archived, non-metered, or cross-tenant license/entitlement is rejected with a distinct reason and accrues nothing.
- **SC-004** [US2]: Aggregated usage is queryable per license (and per entitlement/period), and an identical query over an unchanged window returns identical totals (reproducible).
- **SC-005** [US3]: An operator defines a metered entitlement with an aggregation type and unit, and usage accrues per that type (SUM sums quantities, COUNT counts events, UNIQUE_COUNT counts distinct values).
- **SC-006** [US3]: Editing a metered entitlement's aggregation type/unit succeeds while no usage exists and is refused with a distinct reason once usage exists.
- **SC-007** [US4]: An event accrues to the period of its client event timestamp; a late event within the retention window updates the correct period; a too-old or future-dated event is rejected.
- **SC-008** [US4]: A reversal/negative correction event on a SUM or COUNT meter adjusts the aggregate without mutating or deleting any prior event (a UNIQUE_COUNT meter's distinct set is monotonic — a negative UNIQUE_COUNT quantity is rejected per FR-013).
- **SC-009** [US5]: Crossing a metered entitlement's allowance flags the aggregate over-quota and writes an audit entry, while further events still ingest and accrue (no block); a later reversal that drops the net below the allowance clears the derived flag while the historical crossing audit entry is retained.
- **SC-010** [US6]: Raw events and idempotency keys older than the retention window are pruned while the rollup aggregate is unchanged; a re-report after pruning is a fresh accrual.
- **SC-011** [US1]: The ingest endpoint fast-acks and is rate-limited per API key (429 + Retry-After) under a high-write burst.
- **SC-012** [US2]: An actor or API key from one tenant cannot ingest for, read, or see another tenant's usage; a cross-tenant reference resolves to not found; an unset tenant GUC yields zero rows on the usage tables.
- **SC-013** [US6]: No usage record, response, log, or audit entry exposes a raw credential or PII beyond license/entitlement/dimension references; a tenant's usage is GDPR-erasable.
- **SC-014** [US2]: The aggregate is consumable read-only by billing true-up (E014), and this epic computes no price, rate, or money.
- **SC-015** [US1]: Concurrent ingestion of the same `(source, idempotency key)` from parallel producers accrues exactly once (no double-count under a race).
- **SC-016** [US1]: A report call whose API key lacks the `usage.ingest` scope is refused fail-closed, and nothing is accrued.
- **SC-017** [US4]: After a reversal, the stored aggregate retains the true signed net (identical on re-query, and what E014 consumes) while the query/UI response floors the displayed value at zero.
- **SC-018** [US1]: An event whose target license (or reporting API key) is inactive — expired, suspended, or revoked — is rejected per-event with a distinct reason and accrues nothing, even when the `usage.ingest` scope is present.
- **SC-019** [US2]: The un-floored true signed net is returned only to the E014/app internal read path or an elevated operator role (admin or higher); a plain `viewer` receives only the floor-at-zero display, and a `viewer` request for the raw signed net is refused.
- **SC-020** [US6]: After raw events are pruned, a UNIQUE_COUNT meter's aggregate remains exact and reproducible — a bucket's distinct count is finalized durably before its raw events are pruned, so a pruned raw event cannot silently under-count distinct values, and UNIQUE_COUNT is identical on re-query post-prune.
- **SC-021** [US6]: Each FR-018 event type — ingestion batch, metered-entitlement definition/edit, over-quota crossing, reversal, and retention prune — emits an append-only audit entry, with rollup/prune worker actions attributed to a synthetic system actor.

## Clarifications

### Session 2026-07-24

- Q: MVP aggregation-type set (FR-008)? → A: Counter-only — SUM / COUNT / UNIQUE_COUNT; gauge/peak (MAX/LATEST) deferred as a documented extension (single additive reproducible rollup; reversals well-defined).
- Q: Ingest transport? → A: A dedicated batched REST ingest endpoint, separate from E013 validate/heartbeat (isolated high-write fast-ack path + independent rate limit + per-batch summary).
- Q: Ingest auth scope? → A: A new ingest-only API-key scope `usage.ingest`, tenant- and license-bound (least-privilege; independently revocable; validating clients gain no write-usage authority).
- Q: Reversal semantics? → A: Reference-free signed-negative events (no original-event id required); the stored aggregate keeps the TRUE signed net (reproducible, consumed by E014) while query/UI floors the displayed value at zero.
- Q: Time-bucket granularity + period anchoring? → A: A FIXED hourly storage bucket; "per period" queries roll up hourly buckets over a caller window; billing-period alignment applied by E014 at read, not in metering storage. *[applied default]*
- Q: Idempotency-key uniqueness scope + retention window? → A: Unique on `(tenant, source, idempotency_key)` (mirrors E014 source+id; independent producers don't collide), 35-day dedupe/retention window (default, configurable); reconciles the FR-002 vs Key-Entities wording. *[applied default]*
- Q: How is the metered kind modeled on E007? → A: Extend the E007 `entitlement` type/kind enum with a `metered` value + metered-only columns (aggregation type, unit, allowance) on the existing catalog admin surface (one authoring flow; freeze rule colocated). *[applied default]*
- Q: Max batch size cap? → A: Default 1,000 events per request, configurable; an over-cap batch is rejected with a distinct reason before any accrual. *[applied default]*

## Stress-Test Findings

### Session 2026-07-24

- **STF-001** (severity: LOW, category: consistency) [RESOLVED inline]: The Q reversal resolution (FR-013) floors the aggregate at zero for display, but FR-011/FR-020 "expose the aggregate to E014" could be read as E014 receiving the floored value — which would hide a net-negative correction from billing true-up. Affected: FR-013, FR-020, SC-017. **Given** a bucket whose net is negative after a reversal, **When** E014 reads the aggregate for true-up, **Then** it must see the TRUE signed net, not the zero-floored display. **Resolution**: clarified FR-020 that true-up consumes the true signed net stored value while the floor is operator-facing display only; SC-017 already asserts both halves.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Metered entitlement | An entitlement whose value accrues from reported usage, defined by a fixed aggregation type and unit; distinct from boolean/limit entitlements. |
| Usage event | An append-only raw record that a licensed app consumed some quantity of a metered entitlement, carrying a client idempotency key and event timestamp. |
| Aggregation type | How reported quantities combine into an aggregate: counter (SUM/COUNT/UNIQUE_COUNT) or gauge/peak (MAX/LATEST); immutable once usage exists. |
| Idempotency key | A client-supplied stable identifier that makes an event accrue at most once, so retries/redeliveries are counted a single time. |
| Aggregate / rollup | The durable, reproducible accrued value per license/entitlement/period, computed from raw events by incremental rollup. |
| Time-bucket / period | The window (e.g. hour/day/billing period) into which usage is bucketed for rollup and query. |
| Reversal event | An explicit negative/correction usage event that adjusts the aggregate append-only, without mutating prior events. |
| Quota / allowance | An optional per-entitlement limit that, when crossed, surfaces a signal (flag + audit) — signal only, not enforced by this epic. |
| Retention / dedupe window | The bounded period for which raw events + idempotency keys are kept (dedupe guaranteed) before pruning. |

## Compliance Check

**Verdict**: PASS-WITH-NOTES — governance-clean; no CRITICAL project-instructions violation. Non-blocking items to carry into Planning.
**Checked against**: project-instructions.md v1.2.0, AGENTS.md. **Date**: 2026-07-24.

### Non-negotiables verified

- **Principle I (Offline-first verification; signing key never exposed)**: PASS. Metering is an online control-plane capability (Assumptions) that adds no offline-verification path and does not weaken Principle I; it introduces no new crypto and no signer involvement. FR-019 forbids exposing any secret / API key / signing key in any usage response, log, or audit entry; FR-018 audits without secrets or credentials; FR-020 computes no money.
- **Principle II (Multi-tenant isolation + RBAC)**: PASS. FR-001 (scoped runtime API key, fail-closed on missing scope), FR-017 (forced RLS on the usage tables, tenant isolation fail-closed, cross-tenant reference → not found), FR-006 (unknown/archived/non-metered/cross-tenant reference rejected), operator query behind console session + RBAC (Assumptions); verified by SC-012 (unset tenant GUC → zero rows).
- **Principle III (Single security core + append-only audit)**: PASS. FR-003 stores usage events append-only (no mutate/delete in normal operation); FR-018 records an append-only audit entry for ingestion batch, metered-entitlement definition/edit, over-quota signal, reversal, and prune, attributing ingestion to the reporting API key/license and worker actions to a synthetic system actor; no per-language crypto reimplementation (feature does not touch the verifier core).
- **PII minimization**: PASS. FR-016 keeps usage data tenant-scoped and minimized (only license/entitlement references, quantities, timestamps, client dimensions — no PII) and GDPR-erasable; SC-013 verifies no credential or PII beyond those references is exposed and that a tenant's usage is erasable.
- **Anti-replay + idempotency + rate limiting**: PASS. FR-002 requires a client-supplied idempotency key accrued at most once per `(tenant, source)` (unique constraint + insert-on-conflict-do-nothing), mirroring the shipped E014 `billing_event` dedupe (`billing_event_idem_uniq UNIQUE` + INSERT ... ON CONFLICT DO NOTHING in `migrations/0010_billing.sql`); FR-005 rate-limits per API key with `429 rate_limited` + `Retry-After` and a configured maximum batch size; verified by SC-001 / SC-011 / SC-015.
- **Payment/billing boundary**: PASS. FR-020 exposes the aggregate read-only to E014 true-up and computes no price, rate, or money; the Excluded scope removes pricing/rating/invoicing/true-up; no card/PAN data is introduced; SC-014 verifies.
- **Raw-SQL / no-ORM / migration-ordering / src-layout conventions**: PASS. Highest existing migration confirmed `0011_leases.sql`, so the MIGRATION signal's "sequential after `0011_leases.sql`" lands in the free slot `0012` — no ordering conflict; no ORM introduced (consistent with node-postgres raw-SQL migrations); implementation HOW correctly deferred to Plan.

### Must-reconcile before / during Planning (non-blocking)

- FR-008 aggregation set was RESOLVED in Clarify (Session 2026-07-24): counter-only (SUM/COUNT/UNIQUE_COUNT); gauge/peak deferred. Marker cleared. Also resolved: dedicated ingest endpoint, `usage.ingest` scope, reference-free signed reversal (true-net stored, floor-at-zero display), fixed hourly bucket, `(tenant, source, key)` idempotency + ~35d window, E007 enum extension, 1,000-event batch cap.
- Reserve migration `0012_*.sql` at Plan time and re-verify no parallel in-flight epic has claimed `0012` before authoring the schema.
- FR-016 client-supplied dimensions are free-form; Plan MUST enforce a server-side dimension schema / validation so PII cannot leak into dimensions, keeping the PII-minimization guarantee (SC-013) enforceable rather than advisory.
- FR-005 fail-open rollup (on-read fallback for the open bucket) and FR-015 fail-open prune worker MUST preserve reproducibility (SC-004) and append-only audit completeness (FR-018, synthetic-actor attribution); Plan should confirm the eventually-consistent path never yields non-reproducible totals.
