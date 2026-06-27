-- E002 GDPR erase support (TR-012): a tenant tombstone marking when its personal data was
-- erased, while the tenant row (and its immutable audit events) are preserved. Expand-only.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
