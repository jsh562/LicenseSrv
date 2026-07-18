import { privileged } from "../db/client.js";
import { hmacKey } from "../db/hash.js";
/**
 * Resolve a raw API key to its tenant + capability scopes (TR-009). This is the one
 * legitimate pre-tenant (cross-tenant) lookup — keyed by the globally-unique `key_hash` —
 * performed via the privileged connection. Everything after authentication is tenant-scoped.
 */
export async function resolveApiKey(pool, rawKey, secret) {
    const keyHash = hmacKey(rawKey, secret);
    return privileged(pool, async (q) => {
        const r = await q("SELECT tenant_id, scopes FROM api_key WHERE key_hash = $1 AND status = 'active'", [keyHash]);
        if ((r.rowCount ?? 0) === 0)
            return null;
        const row = r.rows[0];
        return { tenantId: row.tenant_id, scopes: row.scopes };
    });
}
