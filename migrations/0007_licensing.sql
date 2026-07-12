-- E008 license issuance & lifecycle (FR-001..FR-019). Extends the E002 tenancy substrate + E007 catalog
-- (expand-only, sequential after 0006). Two new tenant-owned tables: customer, license. Same
-- tenant-scoped forced-RLS + composite-FK + audit pattern as 0000/0006. No changes to existing tables.
-- customer is created first (license FK-references it).

-- 1. customer — tenant-scoped, pseudonymous recipient of licenses (minimal PII, FR-011).
CREATE TABLE customer (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL REFERENCES tenant(id),
  ref        text        NOT NULL,                       -- stable, non-PII pseudonymous label, unique per tenant
  name       text,                                       -- optional minimal PII; nulled on anonymization (FR-019)
  email      text,                                       -- optional minimal PII; nulled on anonymization (FR-019)
  status     text        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','anonymized')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, ref)
);

-- 2. license — tenant-scoped issued license; a point-in-time snapshot signed into a LIC1 token.
CREATE TABLE license (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  product_id      uuid        NOT NULL,
  plan_id         uuid        NOT NULL,
  customer_id     uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','revoked')),   -- lifecycle (FR-007/008/010)
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,                            -- NULL = perpetual (FR-001)
  max_activations int         NOT NULL CHECK (max_activations > 0),       -- SNAPSHOT of the plan seat limit
  entitlements    jsonb       NOT NULL,                   -- SNAPSHOT of the effective entitlements map
  key_id          text,                                   -- E004 signing key id (embedded in the token)
  token_version   int         NOT NULL,
  nonce           text        NOT NULL,
  transfer_count  int         NOT NULL DEFAULT 0 CHECK (transfer_count >= 0),  -- bounded by app transfer limit (FR-009)
  license_token   text        NOT NULL,                   -- the signed LIC1 token (public)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FKs: a license can never bind to another tenant's product/plan/customer.
  CONSTRAINT license_product_fk  FOREIGN KEY (tenant_id, product_id)  REFERENCES product  (tenant_id, id),
  CONSTRAINT license_plan_fk     FOREIGN KEY (tenant_id, plan_id)     REFERENCES plan     (tenant_id, id),
  CONSTRAINT license_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
CREATE INDEX license_customer ON license (tenant_id, customer_id);
CREATE INDEX license_plan     ON license (tenant_id, plan_id);
CREATE INDEX license_status   ON license (tenant_id, status);

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE customer ENABLE ROW LEVEL SECURITY; ALTER TABLE customer FORCE ROW LEVEL SECURITY;
ALTER TABLE license  ENABLE ROW LEVEL SECURITY; ALTER TABLE license  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON license
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer, license TO licensesrv_app;
