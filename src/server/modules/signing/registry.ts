// The signing-key registry (TR-003/004/005/006/014). Tenant-scoped CRUD over `signing_key` via the
// E002 tenant repository (withTenant → forced RLS). Key generation wraps the private seed through
// custody before it ever reaches the DB; no plaintext private key is stored or returned (TR-010).
import crypto from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import type { Custody } from "./custody.js";
import { KEYSTORE_SCHEME } from "./custody.js";
import { generateSigningKey } from "./edkeys.js";

export type KeyStatus = "active" | "rotating" | "retired" | "revoked";

/** Public metadata for a signing key — never carries private material (TR-010). */
export interface SigningKeyMetadata {
  keyId: string;
  productId: string;
  algorithm: string;
  publicKey: string; // base64url of the 32-byte public key
  status: KeyStatus;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
}

/** The active-key row the signer needs: public material + the WRAPPED private ref (never plaintext). */
export interface ActiveKey {
  keyId: string;
  publicKey: Buffer;
  privateKeyRef: Buffer;
  custodyScheme: string;
}

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface KeyRow {
  key_id: string;
  product_id: string;
  algorithm: string;
  public_key: Buffer;
  status: KeyStatus;
  valid_from: Date | null;
  valid_until: Date | null;
  created_at: Date;
}

function toMetadata(r: KeyRow): SigningKeyMetadata {
  return {
    keyId: r.key_id,
    productId: r.product_id,
    algorithm: r.algorithm,
    publicKey: b64url(r.public_key),
    status: r.status,
    validFrom: r.valid_from ? r.valid_from.toISOString() : null,
    validUntil: r.valid_until ? r.valid_until.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Provision a per-product Ed25519 key (TR-003). The first key for a product becomes `active`;
 * subsequent provisions land as `rotating` (a later rotate promotes one to active). The private
 * seed is custody-wrapped and the raw seed is wiped before returning.
 */
export async function provisionKey(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  custody: Custody,
  actor: string,
): Promise<SigningKeyMetadata> {
  if (!custody.unlocked) throw new Error("custody locked: cannot provision a key");
  const gen = generateSigningKey();
  const wrapped = custody.wrap(gen.privateSeed);
  gen.privateSeed.fill(0); // wipe the raw seed immediately after wrapping

  return withTenant(pool, tenantId, async (q) => {
    const existing = await q(
      "SELECT 1 FROM signing_key WHERE product_id = $1 AND status = 'active'",
      [productId],
    );
    const status: KeyStatus = (existing.rowCount ?? 0) > 0 ? "rotating" : "active";
    const id = crypto.randomUUID();
    const inserted = await q(
      `INSERT INTO signing_key
         (id, tenant_id, product_id, key_id, algorithm, public_key, status, valid_from,
          private_key_ref, custody_scheme, created_by)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'ed25519', $4, $5, now(),
               $6, $7, NULL)
       RETURNING key_id, product_id, algorithm, public_key, status, valid_from, valid_until, created_at`,
      [id, productId, gen.keyId, gen.publicKey, status, wrapped, KEYSTORE_SCHEME],
    );
    await writeAudit(q, {
      actor,
      action: "signing_key.created",
      target: gen.keyId,
      after: { productId, status },
    });
    return toMetadata(inserted.rows[0] as KeyRow);
  });
}

/** The current active key for a product (TR-006), or null if none. Includes the wrapped private ref. */
export async function activeKey(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
): Promise<ActiveKey | null> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT key_id, public_key, private_key_ref, custody_scheme
         FROM signing_key WHERE product_id = $1 AND status = 'active'`,
      [productId],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0] as {
      key_id: string;
      public_key: Buffer;
      private_key_ref: Buffer;
      custody_scheme: string;
    };
    return {
      keyId: row.key_id,
      publicKey: row.public_key,
      privateKeyRef: row.private_key_ref,
      custodyScheme: row.custody_scheme,
    };
  });
}

/** List all of a product's keys — public metadata only (TR-005/TR-010). */
export async function listKeys(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
): Promise<SigningKeyMetadata[]> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT key_id, product_id, algorithm, public_key, status, valid_from, valid_until, created_at
         FROM signing_key WHERE product_id = $1 ORDER BY created_at`,
      [productId],
    );
    return (r.rows as KeyRow[]).map(toMetadata);
  });
}
