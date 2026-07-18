import { withTenant } from "../../db/client.js";
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Build the JWKS keyring for a product from the trusted-keys view (RLS-scoped). */
export async function buildKeyring(pool, tenantId, productId) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q(`SELECT key_id, public_key, valid_from, valid_until
         FROM product_keyring WHERE product_id = $1
        ORDER BY valid_from NULLS FIRST, key_id`, [productId]);
        const rows = r.rows;
        return {
            keys: rows.map((row) => ({
                kid: row.key_id,
                kty: "OKP",
                crv: "Ed25519",
                alg: "EdDSA",
                x: b64url(row.public_key),
                valid_from: row.valid_from ? row.valid_from.toISOString() : null,
                valid_until: row.valid_until ? row.valid_until.toISOString() : null,
            })),
        };
    });
}
