-- E002 foundational tenancy schema (TR-005). Applied by the advisory-locked runner as the
-- owner/superuser; the application connects as the non-owner role created in 0002.
-- NOTE: table "user" is a reserved word in Postgres, so the user entity is "app_user".

CREATE TABLE IF NOT EXISTS tenant (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
  id         uuid NOT NULL,
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  email_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email_hash)
);

CREATE TABLE IF NOT EXISTS role (
  id         uuid NOT NULL,
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner','admin','viewer')),
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id),
  UNIQUE (tenant_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS api_key (
  id         uuid NOT NULL,
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  key_hash   text NOT NULL UNIQUE,
  scopes     text[] NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- created_by constrained intra-tenant (cannot reference a user in another tenant).
  FOREIGN KEY (tenant_id, created_by) REFERENCES app_user(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  actor          text NOT NULL,
  action         text NOT NULL,
  target         text,
  before         jsonb,
  after          jsonb,
  security_event boolean NOT NULL DEFAULT false,
  ts             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
