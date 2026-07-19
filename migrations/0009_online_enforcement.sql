-- E013 online enforcement & revocation (FR-001..FR-021). Extends the E002 tenancy substrate, the E008
-- license/plan, and the E009 activation table (expand-only, sequential after 0008). NO changes to any
-- EXISTING column. Adds two additive columns on `activation` (the online last-seen anchor), and two new
-- tenant-owned tables: `checkin` (bounded, TTL-pruned validate/heartbeat anti-replay + idempotent
-- replay) and `revocation_list` (published, signed, versioned per-product CRL metadata). Same
-- tenant-scoped forced-RLS + composite-FK + audit pattern as 0000/0007/0008.
--
-- The revoked-id SET is NOT materialized: it is projected on demand from license.status='revoked'
-- (+ deactivated activations) at generation time. Only the SIGNED, VERSIONED CRL artifact is stored,
-- because a signature is over exact bytes and the version must advance monotonically and be
-- re-servable/air-gap exportable. Per-plan renewal-window / offline-tolerance are APP CONFIG
-- (NEW-CONFIG), read live at renewal time — NOT columns and NOT a new table (see the plan boundary).

-- 1. activation — additive online last-seen anchor (E009 table; existing columns unchanged).
--    NULL on a never-connected activation: the E009 offline credential governs; NOT revoked-by-default
--    (US5/FR-012). last_anchor_at is monotonic non-decreasing — a REPO invariant (guarded UPDATE),
--    NOT a DB trigger (FR-014).
ALTER TABLE activation
  ADD COLUMN last_checkin_at timestamptz,   -- wall time of the last SUCCESSFUL validate/heartbeat (FR-003); NULL = never online
  ADD COLUMN last_anchor_at  timestamptz;   -- highest signed server time stamped into a renewal (FR-014); monotonic non-decreasing (repo-enforced)

-- 2. checkin — BOUNDED, TTL-pruned per-request store for validate/heartbeat anti-replay (FR-008) and
--    idempotent replay-returns-original. One immutable row per accepted request. A nonce need only be
--    remembered while a token minted for it could still be valid (<= the renewal window); beyond that a
--    replay could only reproduce an already-expired token, so it is pruned. Distinct from the E009
--    activation.nonce (one PERMANENT nonce per activation) precisely because check-ins are FREQUENT.
CREATE TABLE checkin (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL REFERENCES tenant(id),
  activation_id uuid        NOT NULL,                       -- the activation being validated/renewed
  nonce         text        NOT NULL,                       -- single-use per-request nonce; anti-replay/idempotency (FR-008)
  outcome       text        NOT NULL
                  CHECK (outcome IN ('renewed','refused')), -- renewal issued vs refused (revoked/suspended/expired/deactivated/...)
  reason        text,                                       -- specific refusal reason when refused; NULL when renewed (also audited, FR-019)
  renewed_token text,                                       -- short-lived token minted on 'renewed', stored ONLY for idempotent replay; NULL on refusal; pruned with the row
  created_at    timestamptz NOT NULL DEFAULT now(),         -- server check-in time = the signed anchor for this beat; drives the TTL purge
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a check-in can never reference another tenant's activation.
  -- ON DELETE NO ACTION: check-in TTL (short) is always shorter than the E009 activation purge (90d),
  -- so a referenced activation is never purged while check-ins remain -> no block/orphan.
  CONSTRAINT checkin_activation_fk
    FOREIGN KEY (tenant_id, activation_id) REFERENCES activation (tenant_id, id),
  -- anti-replay/idempotency store-and-replay: a reused nonce is DB-rejected; a same-request retry
  -- surfaces the violation and the service replays the stored outcome/token (FR-008, SC-010).
  CONSTRAINT checkin_nonce_uniq UNIQUE (tenant_id, nonce),
  -- shape: a renewal carries a token and no reason; a refusal carries a reason and no token.
  CONSTRAINT checkin_outcome_shape CHECK (
    (outcome = 'renewed' AND renewed_token IS NOT NULL AND reason IS NULL)
    OR (outcome = 'refused' AND renewed_token IS NULL AND reason IS NOT NULL)
  )
);

-- Recent check-ins per activation (anchor advance, registry "last seen"); tenant_id-leading.
CREATE INDEX checkin_activation ON checkin (tenant_id, activation_id, created_at DESC);
-- Bounded-retention purge on an append-only, time-ordered table -> BRIN is cheap & ideal for age deletes.
CREATE INDEX checkin_prune ON checkin USING brin (created_at);

-- 3. revocation_list — published, signed, versioned CRL metadata, per (tenant, product). Immutable
--    once signed. revoked_ids is a point-in-time SNAPSHOT projected from license/activation status at
--    generation (not a live join); signature covers the canonical encoding of the artifact.
CREATE TABLE revocation_list (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL REFERENCES tenant(id),
  product_id   uuid        NOT NULL,                        -- CRL is per product (signed by that product's E004 key; verified vs product_keyring)
  version      bigint      NOT NULL,                        -- monotonic per (tenant, product); advances each publication (FR-009, US4-AC1)
  generated_at timestamptz NOT NULL DEFAULT now(),
  next_update  timestamptz NOT NULL,                        -- CRL validity horizon; CDN cache-control aligns to it (FR-010)
  key_id       text        NOT NULL,                        -- E004 signing key id used to sign this CRL
  signature    text        NOT NULL,                        -- detached Ed25519 signature over the canonical CRL document (never a private key)
  revoked_ids  jsonb       NOT NULL,                        -- snapshot content {"licenses":[...],"activations":[...]} projected from status at generation
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a CRL can never bind to another tenant's product.
  CONSTRAINT revocation_list_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id),
  -- one published version per product; also the "latest version" (max version) lookup.
  CONSTRAINT revocation_list_version_uniq UNIQUE (tenant_id, product_id, version),
  -- a CRL's validity horizon is after its generation.
  CONSTRAINT revocation_list_window CHECK (next_update > generated_at)
);

-- RLS: same form as E002 (0002) / E008 (0007) / E009 (0008). Unset GUC -> NULL -> zero rows.
ALTER TABLE checkin         ENABLE ROW LEVEL SECURITY; ALTER TABLE checkin         FORCE ROW LEVEL SECURITY;
ALTER TABLE revocation_list ENABLE ROW LEVEL SECURITY; ALTER TABLE revocation_list FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON checkin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON revocation_list
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only from the app: SELECT + INSERT only. No UPDATE (check-ins and signed CRL versions are
-- immutable), no DELETE (the bounded TTL purge of checkins and superseded CRL versions is the platform
-- owner path -> least-privileged app role, matching E009 retention). The two additive activation
-- columns are covered by E009's existing table-level UPDATE grant.
GRANT SELECT, INSERT ON checkin, revocation_list TO licensesrv_app;
