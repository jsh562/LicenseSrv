# Data Model — Usage Metering & Aggregation (E016)

**Feature**: `00017-usage-metering-and-aggregation` | **Migration**: `0012_usage_metering.sql` (sequential after `0011_leases.sql`) | **Storage**: PostgreSQL 16, raw SQL (no ORM)

Derives from `spec.md` (Key Entities, FR-001..FR-021, SC-001..SC-021, Clarifications 2026-07-24) and `plan.md` (AD-001..009, HINT-001..005). Mirrors the shipped E014 `billing_event` idempotency/retention pattern (`migrations/0010_billing.sql`) and the E015 `lease` forced-RLS/composite-FK pattern (`migrations/0011_leases.sql`): tenant-scoped `ENABLE + FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy on `current_setting('app.current_tenant', true)`, composite `(tenant_id, x)` FKs `ON DELETE NO ACTION`, tenant_id-leading indexes, and least-privilege grants to the non-owner `licensesrv_app` role (append-only for raw events — NO app `DELETE`; prune/erase run on the owner role).

## Overview

Three new tenant-owned tables plus an expand-only extension of the E007 `entitlement`:

| Object | Kind | Purpose |
|--------|------|---------|
| `usage_event` | new table (append-only raw) | Idempotent raw usage records; deduped by `(tenant, source, event_id)`; signed `quantity` (negative = reversal); pruned after the retention window. |
| `usage_rollup` | new table (durable aggregate) | Reproducible per-`(license, entitlement, hour)` accrual; stores the TRUE signed net `value` + `event_count` + `over_quota` + a processed `watermark`; survives raw pruning. |
| `usage_unique_value` | new table (durable distinct-set side) | Exact, prune-safe distinct-value set per bucket that backs `UNIQUE_COUNT` (HINT-002). |
| `entitlement` (E007) | expand-only ALTER | Adds a `metered` value to the `type` CHECK + metered-only columns (`aggregation`, `unit`, `allowance`). |

Nothing existing is mutated: the E007 `boolean` / `integer_limit` entitlement semantics, the E008 `license`, and every prior table/column are untouched (additive migration, matching the 0010/0011 expand-only discipline).

## Entity Descriptions

### 1. `usage_event` (append-only raw, tenant-scoped, FORCED RLS)

An append-only raw record that a licensed application reported some consumption (Key Entities / FR-001..FR-004). One row per accrued event. Attributes:

- `id` — surrogate uuid; `PRIMARY KEY (tenant_id, id)` (codebase convention).
- `tenant_id` — owning tenant; the RLS predicate column.
- `license_id`, `entitlement_id` — the targeted license + metered entitlement (composite intra-tenant FKs, `ON DELETE NO ACTION`, FR-006/FR-017).
- `source` — client-supplied producer identifier (CloudEvents `source`); half of the idempotency scope so independent producers never collide (FR-002).
- `event_id` — client-supplied idempotency key; the other half of the dedupe scope.
- `event_time` — CLIENT-supplied event timestamp; usage accrues to the hour-bucket of this value, not of receipt (FR-004/FR-010).
- `quantity` — SIGNED `numeric`; a negative value is a reversal/correction (AD-004, FR-013). Not floored in storage.
- `dimensions` — `jsonb`; server-schema-validated, allow-listed, minimized, NO PII (FR-016, HINT-005). Defaulted `{}`.
- `ingested_at` — server receive time; drives the retention prune AND the rollup watermark sweep.

**Idempotency**: `UNIQUE (tenant_id, source, event_id)` + the ingest path's `INSERT ... ON CONFLICT DO NOTHING` gives atomic, single-round-trip, exactly-once accrual even under a concurrent-producer race (AD-001, FR-002, SC-001/SC-002/SC-015 — mirrors `billing_event_idem_uniq`). Dedupe is guaranteed only within the retention window (FR-015): a re-report after the key is pruned is a fresh accrual.

**Append-only**: grants are `SELECT, INSERT` only — no app `UPDATE`/`DELETE`. Corrections are new signed-negative events (FR-003/FR-013); removal is the owner-role retention prune (FR-015) or GDPR erasure (FR-016).

### 2. `usage_rollup` (durable aggregate, tenant-scoped, FORCED RLS)

The durable, reproducible accrual per `(tenant, license, entitlement, hourly bucket)` (Key Entities / FR-010/FR-011). One row per bucket. Attributes:

- `id` — surrogate uuid; `PRIMARY KEY (tenant_id, id)`.
- `tenant_id`, `license_id`, `entitlement_id` — the aggregated dimension (composite intra-tenant FKs, `ON DELETE NO ACTION`).
- `bucket` — `timestamptz` truncated to the HOUR (fixed grain, AD-003); CHECK enforces UTC hour-truncation. "Per period" queries (FR-011) sum buckets over a caller window; billing-cycle alignment is applied by E014 at read (metering↔billing boundary).
- `agg_type` — `sum | count | unique_count` (CHECK); self-describing snapshot of the entitlement's aggregation so a query/read need not join (SC-005).
- `value` — `numeric`, the TRUE SIGNED NET accrued value (AD-004, FR-013/FR-020/SC-017). NOT hard-floored — flooring at zero is a display/query concern (see Reversal note). This is what E014 true-up consumes.
- `event_count` — `bigint`, count of raw events folded into the bucket (backs `COUNT` and reproducibility diagnostics).
- `over_quota` — `boolean`, set when accrued usage crossed the entitlement `allowance` (FR-014, signal-only; an audit entry is the authoritative record, not a block).
- `watermark_ingested_at` — the MAX `ingested_at` of any raw event folded into this bucket. Makes the incremental rollup idempotent and lets a late event RE-OPEN and recompute an already-rolled bucket (AD-002/HINT-002, FR-012).
- `created_at`, `updated_at`.

**Uniqueness**: `UNIQUE (tenant_id, license_id, entitlement_id, bucket)` — one durable row per bucket; the rollup worker UPSERTs (grants `SELECT, INSERT, UPDATE`). Survives raw-event pruning (the aggregate is the durable artifact, FR-015/SC-010).

### 3. `usage_unique_value` (durable distinct-set side, tenant-scoped, FORCED RLS)

Backs the `UNIQUE_COUNT` aggregation exactly and prune-safely (HINT-002). **Chosen over bucket-recompute-from-raw** because: (a) exact distinct count must survive raw-event pruning — recompute-from-raw would silently under-count once the raw rows are gone, breaking reproducibility (SC-004) and E014 true-up (SC-014); (b) a durable, append-only distinct set is idempotent under redelivery and late events (an already-seen value is a no-op via `ON CONFLICT DO NOTHING`); (c) it keeps the hot rollup recompute O(new values) instead of O(all raw in bucket). Attributes:

- `id` — surrogate uuid; `PRIMARY KEY (tenant_id, id)`.
- `tenant_id`, `license_id`, `entitlement_id`, `bucket` — the same aggregation dimension as `usage_rollup`.
- `value_hash` — `bytea`, a stable hash of the distinct dimension value being counted (bounded width; the raw value is not needed once hashed, aiding minimization).
- `first_ingested_at` — `ingested_at` of the first event that introduced this distinct value (diagnostic / prune-ordering).

`UNIQUE (tenant_id, license_id, entitlement_id, bucket, value_hash)` makes an already-seen distinct value a no-op; `UNIQUE_COUNT` for a bucket = `COUNT(*)` of its rows. Grants `SELECT, INSERT` (the rollup worker inserts distinct values; it is a durable aggregate — pruned/erased only by the owner role, never by the app). NOTE (service-layer): `UNIQUE_COUNT` distinct sets are monotonic within a bucket; a signed reversal is well-defined for `SUM`/`COUNT` but does NOT retract a distinct value (a value seen once stays counted) — documented behavior, consistent with counter-only MVP scope (FR-008).

### 4. `entitlement` (E007) — expand-only metered extension

Adds the `metered` kind and its metered-only columns to the existing `entitlement` (real column today: `type text NOT NULL CHECK (type IN ('boolean','integer_limit'))`, from `0006_catalog.sql`; the auto-named check is `entitlement_type_check`). Expand-only — existing `boolean`/`integer_limit` rows and their `plan_entitlement` value columns are unchanged (FR-008, AD-005).

- Re-defines the `type` CHECK to `IN ('boolean','integer_limit','metered')`.
- `aggregation` — `sum | count | unique_count` (CHECK), NULL for non-metered (counter-only MVP; gauge/peak deferred, FR-008).
- `unit` — free-text unit label, NULL for non-metered.
- `allowance` — optional per-entitlement quota (`numeric >= 0`), NULL = no quota; signal-only (FR-014).
- Shape CHECK: the metered-only columns are set IFF `type = 'metered'`.

**Freeze-on-usage (FR-009) is SERVICE-LAYER, not DDL**: a metered entitlement that has any `usage_event` cannot change its `aggregation`/`unit` (mirrors the existing `entitlement_type_locked` guard in `catalog/entitlements.ts`, which serializes on the referencing set). A DB CHECK cannot join `usage_event` to enforce this — the catalog edit path checks `EXISTS (SELECT 1 FROM usage_event WHERE tenant_id/entitlement_id ...)` and refuses with a distinct reason (SC-006). Noted here; not triggered in DDL.

## Migration DDL — `migrations/0012_usage_metering.sql`

```sql
-- E016 usage metering — idempotent usage ingestion + reproducible aggregation (FR-001..FR-021).
-- Extends the E002 tenancy substrate, the E007 catalog `entitlement` (E007), and the E008 `license`
-- (expand-only, sequential after 0011_leases.sql). NO changes to any EXISTING column: the E007
-- boolean/integer_limit entitlement semantics and their plan_entitlement value columns are UNTOUCHED --
-- `metered` is an ADDITIVE third kind. Adds three tenant-owned tables: usage_event (append-only raw,
-- idempotent), usage_rollup (durable per-hour aggregate), usage_unique_value (durable distinct-set side
-- for UNIQUE_COUNT). Same tenant-scoped forced-RLS + composite-FK + append-only-ledger pattern as
-- 0006/0007/0008/0009/0010/0011.
--
-- Idempotency (AD-001, FR-002): usage_event UNIQUE (tenant_id, source, event_id) is the dedupe key; the
-- ingest path is a single batch INSERT ... ON CONFLICT DO NOTHING (mirrors billing_event_idem_uniq) so
-- at-least-once redelivery and parallel producers accrue exactly once. Dedupe is guaranteed only within
-- the retention window (FR-015).
--
-- Aggregation (AD-002/003, FR-010): append-only raw + a watermark-driven async rollup into fixed HOURLY
-- usage_rollup buckets (NO per-event hot counter). usage_rollup.value stores the TRUE SIGNED NET (AD-004,
-- FR-013/FR-020): a reversal is a signed-negative event; storage is never hard-floored (the zero-floor is
-- an operator-facing DISPLAY concern applied at query, so E014 true-up still sees a net-negative
-- correction, SC-017). A late/out-of-order event re-opens its bucket via watermark_ingested_at (FR-012).
--
-- Retention/GDPR (FR-015/016): raw usage_event rows + their idempotency keys are pruned after the bounded
-- window by a fail-open, owner-role worker (the app role has NO DELETE grant); the durable usage_rollup +
-- usage_unique_value aggregates SURVIVE the prune. A tenant GDPR erasure (owner role) removes that
-- tenant's usage_event + usage_rollup + usage_unique_value. Usage is minimized: only license/entitlement
-- refs, signed quantities, timestamps, and server-schema-validated allow-listed dimensions (no PII).

-- =====================================================================================================
-- 1. entitlement (E007) — expand-only metered kind. Existing boolean/integer_limit rows unchanged.
-- =====================================================================================================
-- Re-define the type CHECK to admit the additive `metered` kind (the 0006 inline check auto-named
-- entitlement_type_check). Counter-only MVP: gauge/peak (MAX/LATEST) deferred (FR-008).
ALTER TABLE entitlement DROP CONSTRAINT entitlement_type_check;
ALTER TABLE entitlement
  ADD CONSTRAINT entitlement_type_check CHECK (type IN ('boolean','integer_limit','metered'));

ALTER TABLE entitlement
  ADD COLUMN aggregation text,     -- metered aggregation: sum | count | unique_count; NULL for non-metered (FR-008)
  ADD COLUMN unit        text,     -- metered unit label (e.g. 'calls','GB','seat-hours'); NULL for non-metered
  ADD COLUMN allowance   numeric;  -- OPTIONAL per-entitlement quota; NULL = no quota; signal-only (FR-014)

ALTER TABLE entitlement
  ADD CONSTRAINT entitlement_aggregation_valid
    CHECK (aggregation IS NULL OR aggregation IN ('sum','count','unique_count')),
  ADD CONSTRAINT entitlement_allowance_nonneg
    CHECK (allowance IS NULL OR allowance >= 0),
  -- metered-only columns are set IFF type='metered'; non-metered rows carry none of them (FR-008).
  -- (allowance stays optional even when metered -> not required in the metered branch.)
  ADD CONSTRAINT entitlement_metered_shape CHECK (
    (type =  'metered' AND aggregation IS NOT NULL AND unit IS NOT NULL) OR
    (type <> 'metered' AND aggregation IS NULL     AND unit IS NULL AND allowance IS NULL));
-- NOTE (FR-009, service-layer): once any usage_event exists for a metered entitlement, its aggregation/
-- unit are FROZEN. A DB CHECK cannot join usage_event; the catalog edit path enforces the freeze (mirrors
-- the existing entitlement_type_locked guard) and refuses with a distinct reason. Not triggered in DDL.

-- =====================================================================================================
-- 2. usage_event — tenant-scoped, append-only raw usage. Idempotent by (tenant, source, event_id).
-- =====================================================================================================
CREATE TABLE usage_event (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL REFERENCES tenant(id),
  license_id     uuid        NOT NULL,                    -- targeted license (composite FK below)
  entitlement_id uuid        NOT NULL,                    -- targeted metered entitlement (composite FK below)
  source         text        NOT NULL,                    -- client producer id; idempotency scope half (FR-002)
  event_id       text        NOT NULL,                    -- client idempotency key; idempotency scope half (FR-002)
  event_time     timestamptz NOT NULL,                    -- CLIENT event timestamp; accrual bucket key (FR-004/010)
  quantity       numeric     NOT NULL,                    -- SIGNED; negative = reversal/correction (AD-004/FR-013)
  dimensions     jsonb       NOT NULL DEFAULT '{}',       -- server-schema-validated, allow-listed, minimized, NO PII (FR-016/HINT-005)
  ingested_at    timestamptz NOT NULL DEFAULT now(),      -- server receive time; drives prune + rollup watermark
  PRIMARY KEY (tenant_id, id),
  -- IDEMPOTENCY dedupe (FR-002, AD-001): at most one accrued event per (tenant, source, event_id);
  -- INSERT ... ON CONFLICT DO NOTHING => at-least-once redelivery + concurrent producers accrue once.
  CONSTRAINT usage_event_idem_uniq UNIQUE (tenant_id, source, event_id),
  -- intra-tenant composite FK: an event can never target another tenant's license (FR-006/017). ON DELETE
  -- NO ACTION: a license with any usage_event cannot be hard-deleted; raw rows are removed only by the
  -- owner-role retention prune / GDPR erase (never cascade).
  CONSTRAINT usage_event_license_fk
    FOREIGN KEY (tenant_id, license_id)     REFERENCES license     (tenant_id, id) ON DELETE NO ACTION,
  -- intra-tenant composite FK: an event can never target another tenant's entitlement (FR-006/017).
  CONSTRAINT usage_event_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- 3. usage_rollup — tenant-scoped durable aggregate per (license, entitlement, HOURLY bucket).
-- =====================================================================================================
CREATE TABLE usage_rollup (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL REFERENCES tenant(id),
  license_id            uuid        NOT NULL,
  entitlement_id        uuid        NOT NULL,
  bucket                timestamptz NOT NULL,                -- FIXED hourly grain, UTC-truncated (AD-003)
  agg_type              text        NOT NULL
                          CHECK (agg_type IN ('sum','count','unique_count')),  -- self-describing (SC-005)
  value                 numeric     NOT NULL DEFAULT 0,      -- TRUE SIGNED NET; NOT floored (AD-004/FR-013/020)
  event_count           bigint      NOT NULL DEFAULT 0,      -- raw events folded in; backs COUNT + diagnostics
  over_quota            boolean     NOT NULL DEFAULT false,  -- crossed entitlement.allowance; signal-only (FR-014)
  watermark_ingested_at timestamptz NOT NULL,               -- MAX ingested_at folded in; idempotent re-open (AD-002/FR-012)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- one durable rollup row per (license, entitlement, hour); the rollup worker UPSERTs on this key.
  CONSTRAINT usage_rollup_key_uniq UNIQUE (tenant_id, license_id, entitlement_id, bucket),
  -- bucket MUST be a whole UTC hour (reproducible fixed grain, AD-003). The 3-arg date_trunc(field,
  -- timestamptz, zone) is IMMUTABLE (unlike the TimeZone-dependent 2-arg form), so it is CHECK-safe.
  CONSTRAINT usage_rollup_bucket_hourly CHECK (bucket = date_trunc('hour', bucket, 'UTC')),
  CONSTRAINT usage_rollup_event_count_nonneg CHECK (event_count >= 0),
  -- intra-tenant composite FKs (FR-017); ON DELETE NO ACTION for codebase uniformity.
  CONSTRAINT usage_rollup_license_fk
    FOREIGN KEY (tenant_id, license_id)     REFERENCES license     (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT usage_rollup_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- 4. usage_unique_value — tenant-scoped durable distinct-value set backing UNIQUE_COUNT (HINT-002).
-- =====================================================================================================
CREATE TABLE usage_unique_value (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL REFERENCES tenant(id),
  license_id        uuid        NOT NULL,
  entitlement_id    uuid        NOT NULL,
  bucket            timestamptz NOT NULL,                    -- same hourly grain as usage_rollup
  value_hash        bytea       NOT NULL,                    -- stable hash of the distinct dimension value (bounded; minimized)
  first_ingested_at timestamptz NOT NULL DEFAULT now(),      -- ingested_at of the first event introducing this value
  PRIMARY KEY (tenant_id, id),
  -- an already-seen distinct value in a bucket is a no-op (INSERT ... ON CONFLICT DO NOTHING); the exact
  -- UNIQUE_COUNT for a bucket = COUNT(*) of its rows. Durable + prune-safe (survives raw pruning).
  CONSTRAINT usage_unique_value_uniq
    UNIQUE (tenant_id, license_id, entitlement_id, bucket, value_hash),
  CONSTRAINT usage_unique_value_bucket_hourly CHECK (bucket = date_trunc('hour', bucket, 'UTC')),
  CONSTRAINT usage_unique_value_license_fk
    FOREIGN KEY (tenant_id, license_id)     REFERENCES license     (tenant_id, id) ON DELETE NO ACTION,
  CONSTRAINT usage_unique_value_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
-- =====================================================================================================
-- Rollup-scan: the worker (and any reproduce-from-raw check) reads a bucket's raw by (license,
-- entitlement) ordered by event_time. Covers late-event re-open recompute (FR-010/012).
CREATE INDEX usage_event_rollup ON usage_event (tenant_id, license_id, entitlement_id, event_time);
-- Age-based retention prune (FR-015) AND the rollup watermark sweep (events with ingested_at beyond the
-- last-processed marker) -> BRIN on the time-ordered ingest column, matching billing_event_prune /
-- lease_prune. High-write append keeps ingested_at physically correlated, so BRIN is compact + fast.
CREATE INDEX usage_event_prune ON usage_event USING brin (ingested_at);

-- Operator "which rollups are over quota" scan (FR-014); partial on the small flagged set.
CREATE INDEX usage_rollup_over_quota ON usage_rollup (tenant_id, license_id, entitlement_id)
  WHERE over_quota;
-- (Per license/entitlement/window queries (FR-011) are served by usage_rollup_key_uniq's leading
-- (tenant_id, license_id, entitlement_id, bucket) columns -- a range scan on bucket; no extra index.)

-- =====================================================================================================
-- RLS: same form as E002 (0002) / E007 (0006) / E008 (0007) / E014 (0010) / E015 (0011).
-- Unset GUC -> NULL -> zero rows (refuse unscoped access, SC-012); cross-tenant ref -> not found (FR-017).
-- =====================================================================================================
ALTER TABLE usage_event        ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_event        FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_rollup       ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_rollup       FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_unique_value ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_unique_value FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON usage_event
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON usage_rollup
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON usage_unique_value
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =====================================================================================================
-- Grants (least-privilege, non-owner licensesrv_app role).
-- =====================================================================================================
-- usage_event: APPEND-ONLY (SELECT, INSERT) -- no app UPDATE/DELETE. Corrections are new signed events
--   (FR-003/013); the retention prune + GDPR erase run on the OWNER role, not the app role (FR-015/016).
GRANT SELECT, INSERT         ON usage_event        TO licensesrv_app;
-- usage_rollup: the rollup worker UPSERTs (SELECT, INSERT, UPDATE); it is durable (no app DELETE -- GDPR
--   erase is owner-role).
GRANT SELECT, INSERT, UPDATE ON usage_rollup       TO licensesrv_app;
-- usage_unique_value: the rollup worker inserts distinct values (SELECT, INSERT); durable + prune-safe
--   (no app DELETE -- GDPR erase is owner-role).
GRANT SELECT, INSERT         ON usage_unique_value TO licensesrv_app;
-- The additive entitlement columns are covered by E007's existing table-level grant (no new grant needed).
```

## ER Diagram

```mermaid
erDiagram
    tenant ||--o{ entitlement : owns
    tenant ||--o{ license : owns
    tenant ||--o{ usage_event : owns
    tenant ||--o{ usage_rollup : owns
    tenant ||--o{ usage_unique_value : owns

    entitlement ||--o{ usage_event : "metered target"
    license     ||--o{ usage_event : "accrues to"
    entitlement ||--o{ usage_rollup : "aggregated by type"
    license     ||--o{ usage_rollup : "accrued per"
    entitlement ||--o{ usage_unique_value : "distinct set for UNIQUE_COUNT"
    license     ||--o{ usage_unique_value : "per license"

    usage_event }o..|| usage_rollup : "rolled up (async, watermark) into"
    usage_event }o..o| usage_unique_value : "distinct value folded into"

    entitlement {
        uuid   id PK
        uuid   tenant_id PK_FK
        text   type "boolean|integer_limit|metered (+metered)"
        text   aggregation "sum|count|unique_count (metered)"
        text   unit "metered only"
        numeric allowance "optional quota (metered)"
    }
    usage_event {
        uuid    id PK
        uuid    tenant_id PK_FK
        uuid    license_id FK
        uuid    entitlement_id FK
        text    source "idempotency scope"
        text    event_id "idempotency key"
        timestamptz event_time "client; accrual bucket"
        numeric quantity "SIGNED; neg = reversal"
        jsonb   dimensions "allow-listed, no PII"
        timestamptz ingested_at "prune + watermark"
    }
    usage_rollup {
        uuid    id PK
        uuid    tenant_id PK_FK
        uuid    license_id FK
        uuid    entitlement_id FK
        timestamptz bucket "hourly UTC"
        text    agg_type
        numeric value "TRUE signed net"
        bigint  event_count
        boolean over_quota
        timestamptz watermark_ingested_at
    }
    usage_unique_value {
        uuid    id PK
        uuid    tenant_id PK_FK
        uuid    license_id FK
        uuid    entitlement_id FK
        timestamptz bucket
        bytea   value_hash
        timestamptz first_ingested_at
    }
```

## Rollup / Watermark + Late-Event Re-Open Flow

Incremental, watermark-driven rollup (AD-002/HINT-002, FR-010/FR-012) — no per-event hot counter:

1. **Ingest (fast-ack, FR-005)**: a batch `INSERT ... ON CONFLICT (tenant_id, source, event_id) DO NOTHING RETURNING id` appends new raw `usage_event` rows; `RETURNING` rows are new accruals, absent = duplicate no-ops (per-event summary, HINT-001). No aggregate is touched on the hot path.
2. **Sweep**: the fail-open rollup worker (owner-independent app role) selects raw events with `ingested_at > ` the last global sweep marker (served by the `usage_event_prune` BRIN). This naturally includes LATE events — a late event has an older `event_time` (older bucket) but a fresh `ingested_at`, so the sweep picks it up.
3. **Group by bucket**: each swept event maps to `bucket = date_trunc('hour', event_time, 'UTC')`. The set of DISTINCT affected buckets — including already-rolled ones a late event reopens — is recomputed.
4. **Recompute each affected bucket** from the retained raw within the window and UPSERT `usage_rollup` on `(tenant, license, entitlement, bucket)`:
   - `sum` → `SUM(quantity)` (signed);
   - `count` → `SUM(sign-aware count)` / `COUNT(*)` net of reversals per policy;
   - `unique_count` → INSERT the batch's distinct `value_hash`es into `usage_unique_value` (`ON CONFLICT DO NOTHING`), then `value = COUNT(*)` of that bucket's `usage_unique_value` rows.
   - set `event_count`, `over_quota = (value > entitlement.allowance)` (when `allowance` is non-NULL; a fresh crossing writes an audit entry, FR-014), and `watermark_ingested_at = MAX(ingested_at)` folded in.
5. **Idempotent re-open**: because a bucket is RECOMPUTED from raw (not incremented), reprocessing the same events is a no-op — the rollup is reproducible (SC-004) and a late event correctly updates the right bucket (SC-007/FR-012). `watermark_ingested_at` records how far a bucket has advanced.
6. **On-read fallback (fail-open, FR-005)**: if the worker is behind, a query MAY compute the still-open bucket on the fly from raw so reads are eventually consistent without ever blocking ingest. This never changes stored totals, so reproducibility holds.

## Reversal-Net + Display-Floor Note (AD-004, FR-013/FR-020, SC-017)

- A correction is a standalone signed-NEGATIVE `usage_event` (reference-free — it need not cite an original event id, fitting pre-aggregated batch clients). Prior events are NEVER mutated or deleted (append-only, FR-003).
- `usage_rollup.value` stores the **TRUE SIGNED NET** — it is NOT hard-floored in storage (a hard floor would be lossy and non-reproducible).
- The operator query/UI response applies `max(0, value)` so operators never see negative usage (display-only floor).
- The E014 billing true-up read path returns the **true signed net** (a distinct read / explicit `raw=true`), so a net-negative correction stays fully visible to true-up (STF-001 resolution). Metering computes NO price/money (FR-020).

## Invariants

- **INV-1 (idempotency)**: at most one accrued `usage_event` per `(tenant_id, source, event_id)` (`usage_event_idem_uniq`) — guaranteed within the retention window (FR-002/FR-015; SC-001/SC-015).
- **INV-2 (append-only raw)**: `usage_event` is never updated/deleted by the app (grants `SELECT, INSERT`); corrections are new signed events; removal is owner-role prune/erase (FR-003).
- **INV-3 (tenant isolation)**: every usage table is FORCE-RLS on `app.current_tenant`; an unset GUC yields zero rows; a cross-tenant license/entitlement reference resolves to not found (FR-017/SC-012). Composite `(tenant_id, x)` FKs make a cross-tenant reference structurally impossible.
- **INV-4 (fixed hourly grain)**: `usage_rollup.bucket` / `usage_unique_value.bucket` are whole UTC hours (`bucket = date_trunc('hour', bucket, 'UTC')`); one rollup row per `(tenant, license, entitlement, bucket)` (AD-003).
- **INV-5 (reproducible true-net)**: `usage_rollup.value` is the true signed net, recomputable from retained raw within the window; identical on re-query (SC-004); floored only for display (SC-017).
- **INV-6 (aggregate survives prune)**: pruning raw `usage_event` + idempotency keys leaves `usage_rollup` + `usage_unique_value` intact (FR-015/SC-010); a re-report after key pruning is a fresh accrual (cannot resurrect the pruned event).
- **INV-7 (metered shape)**: `aggregation`/`unit` are set IFF `type='metered'`; `aggregation ∈ {sum,count,unique_count}`; `allowance` optional and `>= 0` (FR-008/FR-014).
- **INV-8 (freeze-on-usage, service-layer)**: a metered entitlement with any `usage_event` cannot change `aggregation`/`unit` (FR-009/SC-006) — enforced in the catalog edit path (a CHECK cannot join), noted not triggered in DDL.
- **INV-9 (minimization / no PII)**: `dimensions` is server-schema-validated + allow-listed; usage stores only license/entitlement refs, signed quantities, timestamps, and dimensions — no PII, no secrets (FR-016/FR-019/SC-013); tenant usage is GDPR-erasable (owner role over usage_event + usage_rollup + usage_unique_value).

## Retention & GDPR (FR-015 / FR-016)

- Raw `usage_event` rows and their idempotency keys are retained for a bounded, configurable window (default ~35 days) then pruned POST-ROLLUP by a fail-open, time-driven worker on the OWNER role (the app role has NO `DELETE` grant) — mirroring the E014 `billing_event` / E015 `lease` retention pattern (BRIN `usage_event_prune` on `ingested_at`).
- The durable `usage_rollup` + `usage_unique_value` aggregates SURVIVE the prune (SC-010); dedupe is only guaranteed within the window (a later re-report of a pruned key is a fresh accrual).
- A tenant GDPR-erasure (owner role) removes that tenant's `usage_event`, `usage_rollup`, AND `usage_unique_value` rows.
- Every ingest batch (summary), metered-entitlement definition/edit, over-quota signal, reversal, and prune is recorded in the append-only `audit_log` (worker actions attributed to a synthetic system actor), with no secrets/credentials (FR-018/FR-019).

## Data Model Summary

| Entity | Key Fields | Relationships | Notes |
|--------|-----------|---------------|-------|
| `usage_event` | `PK (tenant_id, id)`; `UNIQUE (tenant_id, source, event_id)`; `event_time`, `quantity` (signed), `dimensions` jsonb, `ingested_at` | FK `(tenant_id, license_id)→license`, `(tenant_id, entitlement_id)→entitlement` (both `ON DELETE NO ACTION`) | Append-only raw; ON CONFLICT DO NOTHING dedupe (AD-001); grants SELECT/INSERT only; FORCED RLS; pruned by owner after window; BRIN(ingested_at) for prune+watermark; btree (tenant,license,entitlement,event_time) for rollup scan. |
| `usage_rollup` | `PK (tenant_id, id)`; `UNIQUE (tenant_id, license_id, entitlement_id, bucket)`; `agg_type`, `value` (true signed net), `event_count`, `over_quota`, `watermark_ingested_at` | FK `(tenant_id, license_id)→license`, `(tenant_id, entitlement_id)→entitlement` (`ON DELETE NO ACTION`) | Durable per-hour aggregate; worker UPSERTs (grants SELECT/INSERT/UPDATE); FORCED RLS; hourly UTC bucket CHECK; value NOT floored (display floors at zero, true-net to E014); survives raw prune. |
| `usage_unique_value` | `PK (tenant_id, id)`; `UNIQUE (tenant_id, license_id, entitlement_id, bucket, value_hash)`; `first_ingested_at` | FK `(tenant_id, license_id)→license`, `(tenant_id, entitlement_id)→entitlement` (`ON DELETE NO ACTION`) | Exact, prune-safe distinct set backing UNIQUE_COUNT (HINT-002); grants SELECT/INSERT; FORCED RLS; UNIQUE_COUNT = COUNT(*) per bucket; durable; distinct set monotonic within a bucket. |
| `entitlement` (E007, extended) | existing `PK (tenant_id, id)`, `UNIQUE (tenant_id, key)`; new `type='metered'`, `aggregation`, `unit`, `allowance` | existing FKs; referenced by `usage_event`/`usage_rollup`/`usage_unique_value` | Expand-only; `type` CHECK adds `metered`; metered-only cols set IFF metered; freeze aggregation/unit on usage is SERVICE-LAYER (FR-009); existing boolean/integer_limit unchanged. |
