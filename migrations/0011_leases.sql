-- E015 floating & concurrent seat leases (FR-001..FR-026). Extends the E002 tenancy substrate, the E007
-- plan catalog, the E008 license table, and the E009 activation table (expand-only, sequential after
-- 0010_billing.sql). NO changes to any EXISTING column. Adds concurrency config columns on `plan` (E007),
-- snapshots them onto `license` (E008) alongside max_activations, and adds ONE new tenant-owned table:
-- `lease` (a transient concurrency-seat occupancy). Same tenant-scoped forced-RLS + composite-FK +
-- append-only-audit pattern as 0007/0008/0009/0010.
--
-- A lease binds ONE license seat to ONE pseudonymous holder for a bounded, renewable period. The holder is
-- identified ONLY by a salted-hash holder_key derived from a CLIENT-SUPPLIED opaque reference scoped per the
-- plan's concurrency_scope (session|machine|user) -- the raw reference is NEVER stored/logged
-- (FR-001/FR-020/SC-015). Concurrency (max_concurrent) is a NEW dimension INDEPENDENT of the E009 node-lock
-- max_activations (FR-005): absent max_concurrent => floating disabled, acquire fail-closed (SC-019).
--
-- Seat usage = COUNT(*) of LIVE leases for a license; the effective cap is max_concurrent + concurrency_overage
-- (default 0 = hard cap, FR-012). The cap is enforced race-safely IN THE SERVICE LAYER by a per-license
-- pg_advisory_xact_lock(license_id) wrapping count+insert (AD-001) -- a naive `WHERE live_count < cap` check
-- races and OVER-ALLOCATES; NO DB trigger is used. Reclaim<->renew are mutually exclusive via a monotonic
-- `generation` fence + status/expiry predicate on the renew UPDATE (AD-003, FR-011): a late renew after a
-- reclaim matches 0 rows and is rejected. Dead-machine leases are reclaimed by a fail-open time-driven
-- sweeper once expires_at + grace < now (AD-002, FR-010); the same sweep path serves revoke-reclaim (FR-024).
--
-- Retention: lease rows are pseudonymous (holder_key is a salted hash) and GDPR-erasable; released/reclaimed
-- leases are purged by the platform retention path (least-privileged app role has NO DELETE), mirroring the
-- E009 activation / E013 checkin / E014 billing_event retention model.

-- 1. plan (E007) -- expand-only concurrency config. All new columns are additive; existing rows take the
--    defaults (max_concurrent NULL => this plan does NOT sell floating seats -> acquire fail-closed, FR-005).
ALTER TABLE plan
  ADD COLUMN max_concurrent                 int,                             -- concurrency cap (live-lease limit); NULL = floating NOT entitled (FR-005), independent of max_activations
  ADD COLUMN concurrency_scope              text    NOT NULL DEFAULT 'session',  -- seat-counting unit (FR-023): one live lease per (license, holder-key)
  ADD COLUMN concurrency_overage            int     NOT NULL DEFAULT 0,      -- absolute soft-cap allowance above base; 0 = hard cap. effective cap = max_concurrent + overage (FR-012)
  ADD COLUMN concurrency_require_activation boolean NOT NULL DEFAULT false,  -- optional "activated-devices-only" floating gating (FR-025); OFF by default
  ADD COLUMN lease_signed_handle            boolean NOT NULL DEFAULT true,   -- return an E004-signed short-TTL lease handle on acquire/renew (FR-022); per-deployment opt-out
  ADD COLUMN lease_heartbeat_seconds        int     NOT NULL DEFAULT 600,    -- heartbeat/renew cadence, default 10 min (FR-009)
  ADD COLUMN lease_ttl_seconds              int     NOT NULL DEFAULT 1800,   -- lease TTL, default 30 min; expires_at = server_now + this (FR-009)
  ADD COLUMN lease_grace_seconds            int     NOT NULL DEFAULT 300,    -- grace window before reclamation, default 5 min (FR-010)
  ADD COLUMN lease_sweep_seconds            int     NOT NULL DEFAULT 60,     -- reclaim-sweeper interval, default 1 min (FR-010)
  ADD COLUMN lease_policy_on_revoke         text    NOT NULL DEFAULT 'reclaim',  -- live-lease effect on license REVOKE (FR-024): reclaim => proactive; timer => lapse on TTL+grace
  ADD COLUMN lease_policy_on_suspend        text    NOT NULL DEFAULT 'timer',    -- live-lease effect on license SUSPEND (FR-024)
  ADD COLUMN lease_policy_on_expire         text    NOT NULL DEFAULT 'timer';    -- live-lease effect on license EXPIRE  (FR-024)

ALTER TABLE plan
  ADD CONSTRAINT plan_max_concurrent_valid     CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  ADD CONSTRAINT plan_concurrency_scope_valid  CHECK (concurrency_scope IN ('session','machine','user')),
  ADD CONSTRAINT plan_concurrency_overage_nn   CHECK (concurrency_overage >= 0),
  ADD CONSTRAINT plan_lease_timings_positive   CHECK (lease_heartbeat_seconds > 0 AND lease_ttl_seconds > 0
                                                      AND lease_grace_seconds >= 0 AND lease_sweep_seconds > 0),
  -- FR-009 invariant: TTL >= 3x heartbeat so a single missed heartbeat NEVER reclaims a live seat.
  ADD CONSTRAINT plan_lease_ttl_ge_3x_hb       CHECK (lease_ttl_seconds >= 3 * lease_heartbeat_seconds),
  ADD CONSTRAINT plan_lease_policy_valid       CHECK (lease_policy_on_revoke  IN ('reclaim','timer')
                                                      AND lease_policy_on_suspend IN ('reclaim','timer')
                                                      AND lease_policy_on_expire  IN ('reclaim','timer'));

-- 2. license (E008) -- SNAPSHOT of the plan's concurrency config at ISSUANCE (like max_activations, AD-006),
--    so a later plan edit never mutates an already-issued license's seat behavior. max_concurrent NULL = the
--    license carries no floating entitlement => acquire refused fail-closed (SC-019). (The gating + handle
--    toggles stay plan-level, read live at acquire; only the enforcement-governing values are snapshotted.)
ALTER TABLE license
  ADD COLUMN max_concurrent          int,
  ADD COLUMN concurrency_scope       text NOT NULL DEFAULT 'session',
  ADD COLUMN concurrency_overage     int  NOT NULL DEFAULT 0,
  ADD COLUMN lease_heartbeat_seconds int  NOT NULL DEFAULT 600,
  ADD COLUMN lease_ttl_seconds       int  NOT NULL DEFAULT 1800,
  ADD COLUMN lease_grace_seconds     int  NOT NULL DEFAULT 300,
  ADD COLUMN lease_sweep_seconds     int  NOT NULL DEFAULT 60,
  ADD COLUMN lease_policy_on_revoke  text NOT NULL DEFAULT 'reclaim',
  ADD COLUMN lease_policy_on_suspend text NOT NULL DEFAULT 'timer',
  ADD COLUMN lease_policy_on_expire  text NOT NULL DEFAULT 'timer';

ALTER TABLE license
  ADD CONSTRAINT license_max_concurrent_valid    CHECK (max_concurrent IS NULL OR max_concurrent > 0),
  ADD CONSTRAINT license_concurrency_scope_valid CHECK (concurrency_scope IN ('session','machine','user')),
  ADD CONSTRAINT license_concurrency_overage_nn  CHECK (concurrency_overage >= 0),
  ADD CONSTRAINT license_lease_timings_positive  CHECK (lease_heartbeat_seconds > 0 AND lease_ttl_seconds > 0
                                                        AND lease_grace_seconds >= 0 AND lease_sweep_seconds > 0),
  ADD CONSTRAINT license_lease_ttl_ge_3x_hb      CHECK (lease_ttl_seconds >= 3 * lease_heartbeat_seconds),
  ADD CONSTRAINT license_lease_policy_valid      CHECK (lease_policy_on_revoke  IN ('reclaim','timer')
                                                        AND lease_policy_on_suspend IN ('reclaim','timer')
                                                        AND lease_policy_on_expire  IN ('reclaim','timer'));

-- 3. lease -- tenant-scoped, transient concurrency-seat occupancy. ONE live lease = ONE consumed seat.
CREATE TABLE lease (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL REFERENCES tenant(id),
  license_id        uuid        NOT NULL,
  holder_key        bytea       NOT NULL,                      -- salted HASH of a client-supplied opaque holder reference, scoped per concurrency_scope (FR-001/023); raw ref NEVER stored (SC-015)
  concurrency_scope text        NOT NULL,                      -- scope snapshot in force when acquired (session|machine|user); self-describing for audit/registry
  status            text        NOT NULL DEFAULT 'live'
                      CHECK (status IN ('live','released','reclaimed')),  -- seat lifecycle: live (holds a seat) -> released (graceful/force) | reclaimed (sweeper/revoke)
  acquired_at       timestamptz NOT NULL DEFAULT now(),        -- first bind time; unchanged by renew
  last_renewed_at   timestamptz NOT NULL DEFAULT now(),        -- server time of the last successful renew/heartbeat (FR-007)
  expires_at        timestamptz NOT NULL,                      -- SERVER-computed seat expiry = last_renewed_at + ttl (FR-009); client wall clock is NEVER trusted
  generation        bigint      NOT NULL DEFAULT 0,            -- monotonic fence; bumped on each renew; renew guarded by generation match => a stale renew after reclaim hits 0 rows (AD-003/FR-011)
  overage           boolean     NOT NULL DEFAULT false,        -- true if admitted ABOVE the base cap under a soft cap; the AUTHORITATIVE meter is the append-only audit entry (FR-013)
  activation_id     uuid,                                      -- OPTIONAL informational node-lock activation reference (FR-025); NULL by default (concurrency independent of node-lock)
  nonce             text        NOT NULL,                      -- single-use client-supplied acquire idempotency/anti-replay token (FR-014); a replay returns the ORIGINAL lease
  handle_key_id     text,                                      -- OPAQUE E004 signing-key id of the lease handle (public; NEVER the private key/secret, SC-015); NULL under plain-authorization (FR-022)
  ended_at          timestamptz,                               -- set when status leaves 'live' (release or reclaim); drives the retention prune
  updated_at        timestamptz NOT NULL DEFAULT now(),        -- bumped on every edit (renew, release, reclaim)
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a lease can never bind to another tenant's license. ON DELETE NO ACTION
  -- (FR-021): a license with any lease can NOT be hard-deleted; leases end by soft transition, never cascade.
  CONSTRAINT lease_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id) ON DELETE NO ACTION,
  -- OPTIONAL intra-tenant composite FK to the INFORMATIONAL node-lock activation (FR-025). MATCH SIMPLE: a
  -- NULL activation_id is unconstrained. ON DELETE NO ACTION for codebase uniformity (activations are
  -- soft-deactivated, never hard-deleted; retention prunes in dependency order). SET NULL would be an
  -- acceptable alternative since the reference is purely informational.
  CONSTRAINT lease_activation_fk
    FOREIGN KEY (tenant_id, activation_id) REFERENCES activation (tenant_id, id) ON DELETE NO ACTION,
  -- anti-replay/idempotency store-and-replay (FR-014, SC-011): a reused acquire token is DB-rejected so no
  -- replay forges a second seat; a same-request retry surfaces the violation and replays the ORIGINAL lease.
  CONSTRAINT lease_nonce_uniq UNIQUE (tenant_id, nonce),
  CONSTRAINT lease_generation_nonneg CHECK (generation >= 0),
  CONSTRAINT lease_scope_valid       CHECK (concurrency_scope IN ('session','machine','user')),
  -- shape: a live lease has no end time; a terminal (released/reclaimed) lease records one.
  CONSTRAINT lease_ended_shape CHECK (
    (status = 'live' AND ended_at IS NULL) OR (status <> 'live' AND ended_at IS NOT NULL))
);

-- At most ONE live lease per (license, holder-key): the seat-uniqueness invariant (FR-023, Key Entities).
-- Partial (WHERE status='live') so an idempotent re-acquire by the SAME holder cannot double a seat, while a
-- re-acquire AFTER release/reclaim is still allowed (terminal rows are not constrained). Mirrors E009's
-- activation_one_active. NOTE: this bounds the SAME holder; the AGGREGATE cap (count <= effective cap) is the
-- service-layer advisory-lock count+insert (AD-001), not this index.
CREATE UNIQUE INDEX lease_one_live
  ON lease (tenant_id, license_id, holder_key)
  WHERE status = 'live';

-- Live-seat count (COUNT(*) ... WHERE status='live') + per-license registry reads (FR-015) via the
-- (tenant_id, license_id) prefix. Tenant_id-leading, matching the RLS predicate; E002 convention.
CREATE INDEX lease_seat ON lease (tenant_id, license_id, status);

-- Reclaim-sweeper predicate (FR-010): scan LIVE leases whose expires_at (+ grace) has lapsed. A PARTIAL
-- btree on the hot, small live set keyed by expiry serves the range scan far better than a full/BRIN scan.
CREATE INDEX lease_reclaim ON lease (tenant_id, expires_at) WHERE status = 'live';

-- Age-based retention prune of TERMINAL (released/reclaimed) leases -> BRIN on the time-ordered end column,
-- matching E013 checkin_prune / E014 billing_event_prune.
CREATE INDEX lease_prune ON lease USING brin (ended_at);

-- RLS: same form as E002 (0002) / E008 (0007) / E009 (0008) / E014 (0010). Unset GUC -> NULL -> zero rows
-- (refuse unscoped access); cross-tenant lease reference resolves to not found (FR-019/SC-012).
ALTER TABLE lease ENABLE ROW LEVEL SECURITY; ALTER TABLE lease FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON lease
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- No DELETE grant: a lease ends by a soft status flip (release/reclaim are UPDATEs, not DELETEs), exactly
-- like E009 activation. Bounded/GDPR deletion of terminal, pseudonymous lease rows is the platform
-- retention/erase path (owner role), NOT the least-privileged app role. The additive plan/license columns
-- are covered by E007/E008's existing table-level grants (no new grant needed).
GRANT SELECT, INSERT, UPDATE ON lease TO licensesrv_app;
