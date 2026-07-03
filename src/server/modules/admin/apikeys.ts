// Runtime API-key lifecycle for the admin console (FR-009/010/014, AD-007). Keys are the machine
// credentials the E002 auth path resolves (resolveApiKey): the console mints, lists (metadata only),
// rotates, and revokes them. The raw secret is HMAC'd (never stored) and returned exactly ONCE, at
// creation/rotation — a later read can only surface metadata, never the secret.
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import type { Scope } from "../../auth/rbac.js";
import { withTenant } from "../../db/client.js";
import { hmacKey } from "../../db/hash.js";

/** Human-recognizable, high-entropy key: a `lsk_` prefix over 32 random url-safe bytes. */
export function generateApiKeySecret(): string {
  return `lsk_${randomBytes(32).toString("base64url")}`;
}

export interface ApiKeyMeta {
  id: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: Date;
  revokedAt: Date | null;
}

/** A newly-minted key — the ONLY time `secret` is ever returned. */
export interface NewApiKey {
  id: string;
  secret: string;
  scopes: string[];
}

/** Create an active API key with the given scopes; returns the raw secret once. */
export async function createApiKey(
  pool: pg.Pool,
  secret: string,
  tenantId: string,
  actor: string,
  scopes: Scope[],
): Promise<NewApiKey> {
  const id = randomUUID();
  const raw = generateApiKeySecret();
  await withTenant(pool, tenantId, async (q) => {
    await q(
      `INSERT INTO api_key (id, tenant_id, key_hash, scopes, status, created_by)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'active', $4)`,
      [id, hmacKey(raw, secret), scopes, actor],
    );
    await writeAudit(q, { actor, action: "apikey.created", target: id, after: { scopes } });
  });
  return { id, secret: raw, scopes };
}

/**
 * Rotate a key: mint a replacement carrying the same scopes and revoke the old one atomically. The
 * old secret stops authenticating immediately; the new secret is returned once. Null if unknown.
 */
export async function rotateApiKey(
  pool: pg.Pool,
  secret: string,
  tenantId: string,
  actor: string,
  keyId: string,
): Promise<NewApiKey | null> {
  return withTenant(pool, tenantId, async (q): Promise<NewApiKey | null> => {
    const old = await q("SELECT scopes FROM api_key WHERE id = $1 FOR UPDATE", [keyId]);
    if (!old.rowCount) return null;
    const scopes = (old.rows[0] as { scopes: Scope[] }).scopes;

    await q("UPDATE api_key SET status = 'revoked', revoked_at = now() WHERE id = $1", [keyId]);

    const newId = randomUUID();
    const raw = generateApiKeySecret();
    await q(
      `INSERT INTO api_key (id, tenant_id, key_hash, scopes, status, created_by)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'active', $4)`,
      [newId, hmacKey(raw, secret), scopes, actor],
    );
    await writeAudit(q, { actor, action: "apikey.rotated", target: keyId, after: { replacedBy: newId } });
    return { id: newId, secret: raw, scopes };
  });
}

/** Revoke a key. True if an active key was revoked; false if unknown or already revoked. */
export async function revokeApiKey(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  keyId: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      "UPDATE api_key SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'",
      [keyId],
    );
    if (r.rowCount) {
      await writeAudit(q, { actor, action: "apikey.revoked", target: keyId });
      return true;
    }
    return false;
  });
}

/** List key metadata (never the secret or its hash). */
export async function listApiKeys(pool: pg.Pool, tenantId: string): Promise<ApiKeyMeta[]> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT id, scopes, status, created_at, revoked_at
         FROM api_key ORDER BY created_at DESC`,
      [],
    );
    return (r.rows as {
      id: string;
      scopes: string[];
      status: "active" | "revoked";
      created_at: Date;
      revoked_at: Date | null;
    }[]).map((x) => ({
      id: x.id,
      scopes: x.scopes,
      status: x.status,
      createdAt: x.created_at,
      revokedAt: x.revoked_at,
    }));
  });
}
