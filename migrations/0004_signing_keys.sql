-- E004 signing-key registry (TR-004, TR-005). Extends the E002 tenancy substrate (expand-only,
-- sequential after 0000..0003). One new tenant-owned table + a derived public keyring view.
-- No plaintext private key is ever stored: private_key_ref holds a wrapped blob (keystore) or an
-- opaque backend handle (KMS/PKCS#11); custody_scheme names the wrapping (TR-001/TR-010).

CREATE TABLE signing_key (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  product_id      uuid        NOT NULL,                    -- FK -> product (E007-deferred; IP-007)
  key_id          text        NOT NULL,                    -- version id stamped into every token
  algorithm       text        NOT NULL DEFAULT 'ed25519',
  public_key      bytea       NOT NULL,                    -- 32-byte Ed25519 public key
  status          text        NOT NULL
                    CHECK (status IN ('active', 'rotating', 'retired', 'revoked')),
  valid_from      timestamptz,
  valid_until     timestamptz,                             -- null = open-ended (TR-008/TR-019)
  private_key_ref bytea,                                   -- wrapped blob | handle | null (never plaintext)
  custody_scheme  text        NOT NULL,                    -- e.g. keystore-aes256gcm-v1 | kms-aws | pkcs11
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT signing_key_created_by_fk
    FOREIGN KEY (tenant_id, created_by) REFERENCES app_user (tenant_id, id),
  -- Guard: an ed25519 public key is exactly 32 bytes.
  CONSTRAINT signing_key_ed25519_len
    CHECK (algorithm <> 'ed25519' OR octet_length(public_key) = 32)
);

-- key_id is unique per product; exactly one active key per product (partial unique, TR-006/TR-015).
CREATE UNIQUE INDEX signing_key_kid_uniq   ON signing_key (tenant_id, product_id, key_id);
CREATE UNIQUE INDEX signing_key_one_active ON signing_key (tenant_id, product_id) WHERE status = 'active';
-- tenant_id-leading lookup for keyring scans / active-key selection / listing.
CREATE INDEX signing_key_lookup ON signing_key (tenant_id, product_id, status);

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE signing_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_key FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signing_key
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON signing_key TO licensesrv_app;

-- Public keyring: only trusted keys (active + rotating + retired), public material only.
-- security_invoker so the view honours the caller's app.current_tenant under RLS (TR-008/TR-019).
CREATE VIEW product_keyring
  WITH (security_invoker = true) AS
  SELECT tenant_id, product_id, key_id, algorithm, public_key, valid_from, valid_until, status
    FROM signing_key
   WHERE status IN ('active', 'rotating', 'retired');
GRANT SELECT ON product_keyring TO licensesrv_app;
