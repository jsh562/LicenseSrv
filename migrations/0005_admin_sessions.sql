-- E005 admin console: human credentials + sessions (FR-001/003/007/017/018). Extends the E002
-- tenancy substrate (expand-only, sequential after 0004). ALTERs app_user with credential + lockout
-- columns and adds the admin_session table. No plaintext password or raw session token is ever
-- stored: password_hash is a scrypt hash, token_hash is a SHA-256 of the opaque cookie token.

-- Human-credential + status + lockout columns on the existing E002 app_user (additive, backward-compatible).
ALTER TABLE app_user ADD COLUMN password_hash      text;                                   -- scrypt; NULL = invited/SSO-only
ALTER TABLE app_user ADD COLUMN status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('invited', 'active', 'deactivated'));               -- FR-006/007
ALTER TABLE app_user ADD COLUMN failed_login_count int  NOT NULL DEFAULT 0;                  -- FR-018
ALTER TABLE app_user ADD COLUMN locked_until       timestamptz;                             -- FR-018

-- Server-side sessions (FR-001/003). The raw token lives only in the cookie; we persist only its hash.
CREATE TABLE admin_session (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL REFERENCES tenant(id),
  user_id      uuid        NOT NULL,
  token_hash   text        NOT NULL UNIQUE,        -- SHA-256 of the opaque cookie token (global pre-tenant lookup)
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,                        -- sign-out / revocation
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a session can never bind to another tenant's user.
  CONSTRAINT admin_session_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);

-- tenant_id-leading index for a user's own-session listing; token_hash already UNIQUE for the auth lookup.
CREATE INDEX admin_session_user ON admin_session (tenant_id, user_id);

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access). The auth-time
-- lookup by token_hash is a privileged pre-tenant bootstrap (mirrors resolveApiKey); tenant-scoped
-- session listing goes through RLS.
ALTER TABLE admin_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_session FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_session
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_session TO licensesrv_app;
