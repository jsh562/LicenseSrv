// Keyring rotation, revocation, and retirement (TR-007/009/019). Overlapping rotation keeps prior
// keys trusted so already-issued licenses stay verifiable; revocation is terminal (omitted from the
// keyring, never signed with again) but audit-retained. State machine: active → rotating → retired
// → removed; any → revoked. Every lifecycle change is append-only audited (TR-014).
import crypto from "node:crypto";

import type pg from "pg";

import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import type { Custody } from "./custody.js";
import { KEYSTORE_SCHEME } from "./custody.js";
import { generateSigningKey } from "./edkeys.js";
import type { SigningKeyMetadata } from "./registry.js";

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Rotate a product's active key (TR-007): in ONE transaction, demote the current active key to
 * `rotating` (still trusted in the overlap window) and insert the new key as `active`. Because a
 * license signed under the prior key_id keeps verifying via the published keyring, rotation is
 * zero-downtime and needs no reissue.
 */
export async function rotateKey(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  custody: Custody,
  actor: string,
  overlapSeconds = 2_592_000, // TR-019: bounded overlap window (default 30d; operator-configurable via index.ts)
): Promise<SigningKeyMetadata> {
  if (!custody.unlocked) throw new Error("custody locked: cannot rotate");
  const gen = generateSigningKey();
  const wrapped = custody.wrap(gen.privateSeed);
  gen.privateSeed.fill(0);

  return withTenant(pool, tenantId, async (q) => {
    // Demote the prior active key to rotating and BOUND its trust window (TR-019): it stays trusted
    // only until now + overlapSeconds, never open-ended. This keeps the partial-unique (one active)
    // invariant and time-bounds the overlap.
    await q(
      `UPDATE signing_key
          SET status = 'rotating', valid_until = now() + ($2::int * interval '1 second')
        WHERE product_id = $1 AND status = 'active'`,
      [productId, overlapSeconds],
    );
    const id = crypto.randomUUID();
    const inserted = await q(
      `INSERT INTO signing_key
         (id, tenant_id, product_id, key_id, algorithm, public_key, status, valid_from,
          private_key_ref, custody_scheme, created_by)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, 'ed25519', $4, 'active',
               now(), $5, $6, NULL)
       RETURNING key_id, product_id, algorithm, public_key, status, valid_from, valid_until, created_at`,
      [id, productId, gen.keyId, gen.publicKey, wrapped, KEYSTORE_SCHEME],
    );
    await writeAudit(q, {
      actor,
      action: "signing_key.rotated",
      target: gen.keyId,
      after: { productId, newActive: gen.keyId },
    });
    const r = inserted.rows[0] as {
      key_id: string;
      product_id: string;
      algorithm: string;
      public_key: Buffer;
      status: string;
      valid_from: Date | null;
      valid_until: Date | null;
      created_at: Date;
    };
    return {
      keyId: r.key_id,
      productId: r.product_id,
      algorithm: r.algorithm,
      publicKey: b64url(r.public_key),
      status: r.status as SigningKeyMetadata["status"],
      validFrom: r.valid_from ? r.valid_from.toISOString() : null,
      validUntil: r.valid_until ? r.valid_until.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    };
  });
}

/** Revoke a key (TR-009): terminal `revoked` — omitted from the keyring and never signed with again;
 * audit is retained. Recorded as a security event. Returns false if the key_id is unknown. */
export async function revokeKey(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  keyId: string,
  actor: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `UPDATE signing_key SET status = 'revoked', valid_until = now()
         WHERE product_id = $1 AND key_id = $2 AND status <> 'revoked'`,
      [productId, keyId],
    );
    const changed = (r.rowCount ?? 0) > 0;
    if (changed) {
      await recordSecurityEvent(q, {
        actor,
        action: "signing_key.revoked",
        target: keyId,
        after: { productId },
      });
    }
    return changed;
  });
}

/** Retire a superseded (`rotating`) key (TR-019): `rotating` → `retired`. It stays publishable/trusted
 * until explicitly removed, but is no longer the overlap's rotation target. */
export async function retireKey(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  keyId: string,
  actor: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      "UPDATE signing_key SET status = 'retired' WHERE product_id = $1 AND key_id = $2 AND status = 'rotating'",
      [productId, keyId],
    );
    const changed = (r.rowCount ?? 0) > 0;
    if (changed) {
      await writeAudit(q, { actor, action: "signing_key.retired", target: keyId, after: { productId } });
    }
    return changed;
  });
}
