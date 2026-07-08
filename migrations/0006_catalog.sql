-- E007 no-code licensing catalog (FR-001..FR-016). Extends the E002 tenancy substrate
-- (expand-only, sequential after 0005). Four new tenant-owned tables: product, plan,
-- entitlement, plan_entitlement. Same tenant-scoped forced-RLS + composite-FK + audit
-- pattern as 0000_init.sql / 0004_signing_keys.sql. No changes to existing tables.

-- 1. product — tenant-scoped catalog root.
CREATE TABLE product (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL REFERENCES tenant(id),
  key         text        NOT NULL,                      -- stable key, unique per tenant (FR-002)
  name        text        NOT NULL,
  description text,
  status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),  -- soft-retire (FR-013)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);

-- 2. plan — belongs to one product; carries the seat limit.
CREATE TABLE plan (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  product_id      uuid        NOT NULL,
  key             text        NOT NULL,                   -- unique per product (FR-003)
  name            text        NOT NULL,
  description     text,
  max_activations int         NOT NULL DEFAULT 1
                    CHECK (max_activations > 0),          -- seat limit, default 1 (FR-004)
  status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a plan can never bind to another tenant's product.
  CONSTRAINT plan_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id),
  UNIQUE (tenant_id, product_id, key)
);

-- 3. entitlement — tenant-scoped feature definition; key embeds into E001 signed tokens.
CREATE TABLE entitlement (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL REFERENCES tenant(id),
  key         text        NOT NULL,                       -- unique per tenant; token feature key (FR-005)
  name        text        NOT NULL,
  type        text        NOT NULL
                CHECK (type IN ('boolean','integer_limit')),
  description text,
  status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);

-- 4. plan_entitlement — per-plan value binding a plan to an entitlement.
CREATE TABLE plan_entitlement (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL REFERENCES tenant(id),
  plan_id        uuid        NOT NULL,
  entitlement_id uuid        NOT NULL,
  bool_value     boolean,                                 -- set iff entitlement.type='boolean'
  int_value      int,                                     -- set iff entitlement.type='integer_limit'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT plan_entitlement_plan_fk
    FOREIGN KEY (tenant_id, plan_id)        REFERENCES plan        (tenant_id, id),
  CONSTRAINT plan_entitlement_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id),
  UNIQUE (tenant_id, plan_id, entitlement_id),
  -- Exactly one value column set. Cross-row agreement with entitlement.type
  -- (bool <-> 'boolean', int <-> 'integer_limit') is enforced in the app layer (a CHECK can't join).
  CONSTRAINT plan_entitlement_one_value  CHECK (num_nonnulls(bool_value, int_value) = 1),
  CONSTRAINT plan_entitlement_int_nonneg CHECK (int_value IS NULL OR int_value >= 0)
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
CREATE INDEX plan_product                 ON plan             (tenant_id, product_id);
CREATE INDEX plan_entitlement_plan        ON plan_entitlement (tenant_id, plan_id);
CREATE INDEX plan_entitlement_entitlement ON plan_entitlement (tenant_id, entitlement_id);

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE product          ENABLE ROW LEVEL SECURITY; ALTER TABLE product          FORCE ROW LEVEL SECURITY;
ALTER TABLE plan             ENABLE ROW LEVEL SECURITY; ALTER TABLE plan             FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement      ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement      FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_entitlement ENABLE ROW LEVEL SECURITY; ALTER TABLE plan_entitlement FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON plan
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON entitlement
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON plan_entitlement
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON product, plan, entitlement, plan_entitlement TO licensesrv_app;
