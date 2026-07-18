import { writeAudit } from "../audit/index.js";
import { privileged, withTenant } from "./client.js";
/** Provision a tenant — an explicit, audited platform-admin (cross-tenant) action. */
export async function provisionTenant(pool, tenant) {
    await privileged(pool, async (q) => {
        await q("INSERT INTO tenant (id, slug, name) VALUES ($1, $2, $3)", [
            tenant.id,
            tenant.slug,
            tenant.name ?? null,
        ]);
        await q(`INSERT INTO audit_log (tenant_id, actor, action, target, security_event)
       VALUES ($1::uuid, 'platform-admin', 'tenant.provisioned', $1::text, false)`, [tenant.id]);
    });
}
export async function createUser(pool, tenantId, user, actor) {
    await withTenant(pool, tenantId, async (q) => {
        await q(`INSERT INTO app_user (id, tenant_id, email_hash)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2)`, [user.id, user.emailHash]);
        await writeAudit(q, { actor, action: "user.created", target: user.id });
    });
}
export async function createApiKey(pool, tenantId, key, actor) {
    await withTenant(pool, tenantId, async (q) => {
        await q(`INSERT INTO api_key (id, tenant_id, key_hash, scopes, created_by)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)`, [key.id, key.keyHash, key.scopes, key.createdBy ?? null]);
        await writeAudit(q, { actor, action: "apikey.created", target: key.id });
    });
}
export async function listUsers(pool, tenantId) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q("SELECT id, email_hash FROM app_user ORDER BY created_at", []);
        return r.rows;
    });
}
export async function countAudit(pool, tenantId) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q("SELECT count(*)::int AS n FROM audit_log", []);
        return r.rows[0].n;
    });
}
