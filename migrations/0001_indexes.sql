-- E002 tenant_id-leading composite indexes (TR-004). Bounds key-selection / scan cost
-- and supports RLS predicate evaluation at scale.

CREATE INDEX IF NOT EXISTS idx_app_user_tenant   ON app_user (tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_role_tenant_user  ON role     (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_tenant    ON api_key  (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts   ON audit_log(tenant_id, ts DESC);
-- Partial index for fast security-event scans (data-model §audit_log).
CREATE INDEX IF NOT EXISTS idx_audit_security_event ON audit_log(tenant_id, ts DESC) WHERE security_event;
