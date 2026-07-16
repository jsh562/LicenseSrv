-- E009 machine activation & seat enforcement (FR-001..FR-024). Extends the E002 tenancy substrate and
-- the E008 license table (expand-only, sequential after 0007). One new tenant-owned table: activation.
-- Same tenant-scoped forced-RLS + composite-FK + audit pattern as 0000_init.sql / 0007_licensing.sql.
-- No changes to existing tables.
--
-- An activation binds ONE license to ONE machine. The machine is identified ONLY by salted hashes
-- (canonical machine_id + the N per-signal hashes) — NEVER raw hardware identifiers (FR-006/SC-011).
-- Seat usage = COUNT(*) of ACTIVE activations for a license; the cap is license.max_activations
-- (snapshotted at issuance, E008). The cap is enforced race-safely IN THE SERVICE LAYER by taking
-- SELECT ... FOR UPDATE on the license row before count+insert — the schema supports it; NO DB trigger
-- is used. K-of-N drift tolerance (default 3-of-5) is computed over signal_hashes in the service layer.

-- 1. activation — tenant-scoped binding of one license to a drift-tolerant machine fingerprint.
CREATE TABLE activation (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL REFERENCES tenant(id),
  license_id          uuid        NOT NULL,
  machine_id          text        NOT NULL,                      -- salted hash of the full sorted signal set = canonical machine identity (FR-006); NOT a raw id
  signal_hashes       text[]      NOT NULL,                      -- the N per-signal salted hashes -> token `fp`; K-of-N overlap match (FR-005). Hashes only, never raw ids (SC-011)
  fp_min              int         NOT NULL,                      -- the K threshold -> token `fpk` (default 3-of-5); bound into the credential (FR-005)
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','deactivated')),  -- seat lifecycle (FR-010/011)
  nonce               text        NOT NULL,                      -- single-use activation request nonce; anti-replay/idempotency (FR-009)
  machine_bound_token text,                                      -- re-signed LIC1 credential returned on activation (FR-007); public, verifies offline. Null between seat-claim and sign within the same tx
  label               text,                                      -- optional client pseudonymous hostname/nickname; minimal, erasable data (nulled on GDPR erase)
  activated_at        timestamptz NOT NULL DEFAULT now(),        -- first bind time; unchanged by refresh
  updated_at          timestamptz NOT NULL DEFAULT now(),        -- bumped on every edit (refresh, deactivate)
  deactivated_at      timestamptz,                               -- set when status flips to 'deactivated' (FR-010)
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: an activation can never bind to another tenant's license.
  -- ON DELETE NO ACTION (Postgres default): backstops hard-delete of a license that still has activations.
  CONSTRAINT activation_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id),
  -- nonce anti-replay/idempotency (store-and-replay): a reused nonce is DB-rejected so no replay can
  -- forge a second activation/seat; a same-request retry surfaces the violation and replays the result (FR-009, SC-010).
  CONSTRAINT activation_nonce_uniq UNIQUE (tenant_id, nonce),
  -- K (fp_min) must be in [1, N]: at least one signal, never demanding more matches than signals bound.
  CONSTRAINT activation_fp_min_valid CHECK (fp_min > 0 AND fp_min <= cardinality(signal_hashes))
);

-- At most ONE active activation per (license, machine): the seat-uniqueness invariant (Key Entities).
-- Partial (WHERE status='active') so idempotent re-activation of the SAME machine cannot double the seat,
-- while reactivation AFTER deactivation is still allowed (deactivated rows are not constrained).
CREATE UNIQUE INDEX activation_one_active
  ON activation (tenant_id, license_id, machine_id)
  WHERE status = 'active';

-- Seat count (COUNT(*) ... WHERE status='active') AND per-license registry reads (via the (tenant_id,
-- license_id) prefix). Tenant_id-leading, matching the RLS predicate; E002 convention.
CREATE INDEX activation_seat ON activation (tenant_id, license_id, status);

-- RLS: same form as E002 (0002) / E008 (0007). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE activation ENABLE ROW LEVEL SECURITY; ALTER TABLE activation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activation
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- No DELETE grant: deactivation is a soft status flip (seat reclamation is UPDATE, not DELETE).
-- GDPR erasure nulls the erasable `label`; the salted hashes are pseudonymous by construction, and
-- bounded deletion is handled by the platform retention/erase path (not the app role's DML).
GRANT SELECT, INSERT, UPDATE ON activation TO licensesrv_app;
