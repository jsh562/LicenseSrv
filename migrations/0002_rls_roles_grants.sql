-- E002 RLS, non-owner app role, and grants (TR-002, TR-008).
-- The application drops to licensesrv_app per transaction (SET LOCAL ROLE) so RLS applies;
-- the role is non-superuser and NOBYPASSRLS, so it can never bypass the policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'licensesrv_app') THEN
    CREATE ROLE licensesrv_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Enable + FORCE RLS on every tenant-owned table (owners are subject to RLS too).
ALTER TABLE tenant    ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant    FORCE ROW LEVEL SECURITY;
ALTER TABLE app_user  ENABLE ROW LEVEL SECURITY; ALTER TABLE app_user  FORCE ROW LEVEL SECURITY;
ALTER TABLE role      ENABLE ROW LEVEL SECURITY; ALTER TABLE role      FORCE ROW LEVEL SECURITY;
ALTER TABLE api_key   ENABLE ROW LEVEL SECURITY; ALTER TABLE api_key   FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Policies: an unset GUC -> NULL -> zero rows, so unscoped access is refused, not unscoped.
CREATE POLICY tenant_isolation ON tenant
  USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON role
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON api_key
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grants: app role gets DML on tenant tables; audit_log is INSERT/SELECT only (append-only).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, app_user, role, api_key TO licensesrv_app;
GRANT SELECT, INSERT ON audit_log TO licensesrv_app;
-- (No UPDATE/DELETE grant on audit_log -> append-only at the privilege layer.)
