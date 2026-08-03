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
