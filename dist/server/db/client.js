import pg from "pg";
import { assertTenantMatch } from "../observability/isolation-assertion.js";
const { Pool } = pg;
/** The non-owner, non-superuser, NOBYPASSRLS role the app drops to per transaction. */
export const APP_ROLE = "licensesrv_app";
export function makePool(connectionString, max = 8) {
    return new Pool({ connectionString, max });
}
/**
 * Run `fn` inside a transaction scoped to exactly one tenant (TR-001/TR-003).
 *
 * Drops to the non-owner app role (`SET LOCAL ROLE`) so RLS is enforced, and sets the
 * `app.current_tenant` GUC transaction-locally. Both auto-reset on COMMIT/ROLLBACK, so a
 * pooled connection never carries a prior request's tenant context. This is the ONLY place
 * the tenant GUC is set — never query outside it (HINT-003).
 */
export async function withTenant(pool, tenantId, fn) {
    if (!tenantId)
        throw new Error("withTenant: a resolved tenant scope is required (TR-001)");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
        // Tenant-isolation continuous assertion (OR-011, OBJ3): at the single per-tx RLS choke point, compare
        // the authenticated principal's tenant to the GUC just set and signal any mismatch. The assertion is
        // detection/signal ONLY — it compares in-memory identities, issues NO query, NEVER throws, and does
        // not alter withTenant's behavior; RLS remains the authoritative block on the rows themselves.
        assertTenantMatch(tenantId);
        const q = (text, params) => client.query(text, params);
        const result = await fn(q);
        await client.query("COMMIT");
        return result;
    }
    catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
    }
}
/**
 * Run `fn` as the connection's privileged role (RLS-bypassing). Reserved for migrations,
 * the api-key→tenant authentication bootstrap, and explicit, audited platform-admin
 * actions (e.g. provisioning a new tenant). Never used for tenant request handling.
 */
export async function privileged(pool, fn) {
    const client = await pool.connect();
    try {
        const q = (text, params) => client.query(text, params);
        return await fn(q);
    }
    finally {
        client.release();
    }
}
/** Minimum supported PostgreSQL `server_version_num` — 16.4 (TR-014). */
export const MIN_PG_VERSION_NUM = 160004;
/** Assert the connected server meets the minimum supported version (TR-014). */
export async function assertPgVersion(pool, minNum = MIN_PG_VERSION_NUM) {
    const r = await privileged(pool, (q) => q("SHOW server_version_num"));
    const num = Number(r.rows[0].server_version_num);
    if (!Number.isFinite(num) || num < minNum) {
        throw new Error(`PostgreSQL >= ${minNum} required (TR-014); found ${num || "unknown"}`);
    }
    return num;
}
