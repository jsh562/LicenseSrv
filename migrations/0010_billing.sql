-- E014 billing-driven entitlement automation (FR-001..FR-022). Extends the E002 tenancy substrate, the
-- E007 catalog, the E008 license table, and the E004/E006 keystore-custody precedent (expand-only,
-- sequential after 0009). Three new tenant-owned tables: billing_connection, subscription, billing_event
-- (+ a secret-excluding view). Same tenant-scoped forced-RLS + composite-FK + audit-on-mutation +
-- append-only-ledger pattern as 0007/0008/0009. NO changes to any existing table/column -- the E008
-- license.status enum (active/suspended/revoked) is UNTOUCHED; grace is a billing OVERLAY on subscription.
--
-- Secret custody: the inbound webhook HMAC secret is NEVER plaintext and NEVER returned by any API
-- (FR-015). It is envelope-encrypted at rest (keystore custody, reused from E004) or an opaque secret-ref
-- (<VAR>_FILE / external manager), and is decrypted into memory ONLY to verify a webhook. Unlike the E004
-- Ed25519 signing key (no-read/no-export, Shamir-split, sign-by-handle), this secret MUST be readable
-- server-side on every webhook to recompute the HMAC -- a lower custody tier, same never-returned /
-- FORCE-RLS / excluded-from-projection guarantees. Rotation keeps a second secret for a transition window.
--
-- Idempotency: billing_event UNIQUE (tenant_id, provider, provider_event_id) is the dedup key (FR-003);
-- the row is INSERT ... ON CONFLICT DO NOTHING in the same tx as its side effect -> at-least-once
-- redelivery applies at most once. Append-only (SELECT,INSERT); dead-letter is outcome='deadletter'
-- (FR-020). No card/PAN data is ever stored (FR-018); only minimized, allow-listed metadata,
-- retention-bounded + deletable via the platform prune path (FR-021).

-- 1. billing_connection -- per-tenant provider connection: secret custody + plan map + grace policy.
CREATE TABLE billing_connection (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL REFERENCES tenant(id),
  provider              text        NOT NULL
                          CHECK (provider IN ('stripe','paddle','generic')),  -- adapter discriminator (FR-004)
  status                text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','disabled')),            -- config lifecycle
  signing_secret_ref    bytea       NOT NULL,                    -- CURRENT inbound-HMAC secret, custody-wrapped; NEVER plaintext / NEVER returned (FR-015)
  signing_secret_prev   bytea,                                   -- PREVIOUS secret during the rotation transition window; null outside a rotation (US5-AC2)
  secret_custody_scheme text        NOT NULL,                    -- keystore-aes256gcm-v1 | secretref-file | kms-aws (free text; no CHECK, like signing_key.custody_scheme)
  secret_rotated_at     timestamptz,                             -- start of the transition window (prev accepted while now()-this < app-config window); null if never rotated
  plan_map              jsonb       NOT NULL DEFAULT '{}',       -- provider plan/price id -> {product_id, plan_id}; app-validated vs E007 (a CHECK can't join)
  default_grace_seconds int         NOT NULL DEFAULT 1209600
                          CHECK (default_grace_seconds > 0),     -- sane default grace window (~14d) (FR-011)
  grace_overrides       jsonb       NOT NULL DEFAULT '{}',       -- per-plan grace overrides {plan_key: seconds} (FR-011)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- one connection per provider per tenant; also the natural link key for subscription/billing_event.
  UNIQUE (tenant_id, provider)
);

-- 2. subscription -- external subscription <-> license link + grace OVERLAY (FR-007/008/009/012).
CREATE TABLE subscription (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL REFERENCES tenant(id),
  provider                 text        NOT NULL,                 -- matches its billing_connection
  external_subscription_id text        NOT NULL,                 -- provider subscription id (sub_...); the resolve key
  license_id               uuid        NOT NULL,                 -- the ONE managed license (1:1)
  billing_state            text        NOT NULL DEFAULT 'active'
                             CHECK (billing_state IN ('active','past_due','grace','canceled','refunded')),  -- overlay (FR-007..010)
  grace_expires_at         timestamptz,                          -- auto-suspend deadline; set in past_due/grace (FR-007/008)
  last_applied_event_at    timestamptz,                          -- occurred_at of the last APPLIED event; stale/out-of-order guard (FR-016); monotonic (repo-enforced)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- the link key: one subscription per (tenant, provider, external id).
  CONSTRAINT subscription_external_uniq UNIQUE (tenant_id, provider, external_subscription_id),
  -- 1:1 subscription <-> license: a license is managed by at most one subscription.
  CONSTRAINT subscription_license_uniq  UNIQUE (tenant_id, license_id),
  -- intra-tenant composite FK: a subscription can never link to another tenant's license.
  CONSTRAINT subscription_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id),
  -- intra-tenant composite FK: every subscription belongs to a configured connection (FR-014).
  CONSTRAINT subscription_connection_fk
    FOREIGN KEY (tenant_id, provider)   REFERENCES billing_connection (tenant_id, provider),
  -- grace_expires_at is meaningful only while a grace window runs.
  CONSTRAINT subscription_grace_shape
    CHECK (billing_state IN ('past_due','grace') OR grace_expires_at IS NULL)
);

-- 3. billing_event -- per-tenant, append-only, signature-verified webhook ledger + idempotency dedup.
CREATE TABLE billing_event (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL REFERENCES tenant(id),
  provider          text        NOT NULL,
  provider_event_id text        NOT NULL,                        -- provider event id (evt_...); the idempotency key
  type              text        NOT NULL,                        -- canonical/normalized event type (adapter output, FR-004)
  subscription_id   uuid,                                        -- resolved subscription; NULL when unmapped -> dead-letter (FR-020)
  occurred_at       timestamptz NOT NULL,                        -- provider event timestamp; ordering + recency guard (FR-016)
  received_at       timestamptz NOT NULL DEFAULT now(),          -- server receive/ack time; drives the retention prune
  outcome           text        NOT NULL
                      CHECK (outcome IN ('applied','deadletter','rejected')),  -- FR-003/016/020 (duplicate is never stored -- the UNIQUE forbids a 2nd row)
  reason            text,                                        -- dead-letter/reject reason; null when applied
  payload_summary   jsonb,                                       -- MINIMIZED, allow-listed metadata ONLY; NO card/PAN/PII (FR-018/021); app-enforced allow-list
  PRIMARY KEY (tenant_id, id),
  -- IDEMPOTENCY dedup (FR-003): at most one ledger row per provider event; INSERT ... ON CONFLICT DO
  -- NOTHING in the same tx as the side effect => at-least-once redelivery applies exactly once.
  CONSTRAINT billing_event_idem_uniq UNIQUE (tenant_id, provider, provider_event_id),
  -- resolved event references a same-tenant subscription; NULL (MATCH SIMPLE) = unmapped dead-letter.
  CONSTRAINT billing_event_subscription_fk
    FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscription (tenant_id, id),
  -- every persisted event was verified against a configured connection's secret.
  CONSTRAINT billing_event_connection_fk
    FOREIGN KEY (tenant_id, provider) REFERENCES billing_connection (tenant_id, provider),
  -- shape: applied carries no reason; deadletter/rejected carry one (duplicate is never stored -> the unique).
  CONSTRAINT billing_event_outcome_reason
    CHECK ((outcome = 'applied' AND reason IS NULL) OR (outcome <> 'applied' AND reason IS NOT NULL))
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
CREATE INDEX subscription_grace ON subscription (tenant_id, grace_expires_at)
  WHERE grace_expires_at IS NOT NULL;                             -- scheduled auto-suspend sweep (FR-008)
CREATE INDEX subscription_state ON subscription (tenant_id, billing_state);  -- reconciliation scans (FR-017)
CREATE INDEX billing_event_subscription ON billing_event (tenant_id, subscription_id, occurred_at DESC);  -- per-sub trail + ordering (FR-013/016)
CREATE INDEX billing_event_deadletter ON billing_event (tenant_id, received_at)
  WHERE outcome = 'deadletter';                                  -- operator dead-letter queue (FR-020)
CREATE INDEX billing_event_prune ON billing_event USING brin (received_at);  -- age-based retention prune (FR-021)

-- RLS: same form as E002 (0002) / E008 (0007) / E009 (0008) / E013 (0009). Unset GUC -> NULL -> zero rows.
ALTER TABLE billing_connection ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription       ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription       FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_event      ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_event      FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON billing_connection
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON subscription
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON billing_event
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only ledger for billing_event (SELECT,INSERT). billing_connection is fully mutable (configure /
-- rotate secret / disconnect); subscription mutates for state/grace transitions but is retained (no DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_connection TO licensesrv_app;
GRANT SELECT, INSERT, UPDATE         ON subscription       TO licensesrv_app;
GRANT SELECT, INSERT                 ON billing_event      TO licensesrv_app;

-- Secret-excluding read view (the product_keyring pattern): NEVER projects the secret refs (FR-015/SC-007).
CREATE VIEW billing_connection_public
  WITH (security_invoker = true) AS
  SELECT tenant_id, id, provider, status, secret_custody_scheme, secret_rotated_at,
         plan_map, default_grace_seconds, grace_overrides, created_at, updated_at
    FROM billing_connection;
GRANT SELECT ON billing_connection_public TO licensesrv_app;
