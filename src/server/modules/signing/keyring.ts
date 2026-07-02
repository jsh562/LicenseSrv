// Public keyring publication (TR-008/TR-019, IP-005). Projects the `product_keyring` view (trusted
// keys only: active + rotating + retired; revoked omitted) into a JWKS set for out-of-band verifier
// pinning. Public material only — no `d` (private) member ever. `valid_from` is inclusive,
// `valid_until` exclusive (null = open-ended), mapping 1:1 to the core's `KeyEntry` window.
import type pg from "pg";

import { withTenant } from "../../db/client.js";

/** One JWKS entry for an Ed25519 public key (RFC 8037 OKP), plus the trust window. */
export interface KeyringKey {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  alg: "EdDSA";
  x: string; // base64url of the 32-byte public key (public material only)
  valid_from: string | null;
  valid_until: string | null;
}

export interface Keyring {
  keys: KeyringKey[];
}

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Build the JWKS keyring for a product from the trusted-keys view (RLS-scoped). */
export async function buildKeyring(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
): Promise<Keyring> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT key_id, public_key, valid_from, valid_until
         FROM product_keyring WHERE product_id = $1
        ORDER BY valid_from NULLS FIRST, key_id`,
      [productId],
    );
    const rows = r.rows as {
      key_id: string;
      public_key: Buffer;
      valid_from: Date | null;
      valid_until: Date | null;
    }[];
    return {
      keys: rows.map((row) => ({
        kid: row.key_id,
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        alg: "EdDSA" as const,
        x: b64url(row.public_key),
        valid_from: row.valid_from ? row.valid_from.toISOString() : null,
        valid_until: row.valid_until ? row.valid_until.toISOString() : null,
      })),
    };
  });
}
