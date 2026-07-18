// Per-plan entitlement values (FR-007/008/009/012, AD-010). The no-code core: attach an entitlement to a
// plan and set its value (boolean on/off, or a non-negative integer limit). The value is validated against
// the entitlement's declared type (a mismatch is a 400). Setting is an idempotent upsert (200 for both
// first attach and later edit); an archived plan/entitlement is frozen for new values (409 archived).
import { randomUUID } from "node:crypto";
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { assertValueMatchesType, CatalogError } from "./validation.js";
/** Map the stored bool/int columns back to the single typed value the API exposes. */
function toValue(type, boolValue, intValue) {
    return type === "boolean" ? Boolean(boolValue) : Number(intValue);
}
/** List a plan's entitlement values (joined to their entitlement key/type). 404 if the plan is unknown. */
export async function listPlanEntitlements(pool, tenantId, planId) {
    return withTenant(pool, tenantId, async (q) => {
        const plan = await q("SELECT 1 FROM plan WHERE id = $1", [planId]);
        if (!plan.rowCount)
            throw new CatalogError("not_found", 404, "unknown plan");
        const r = await q(`SELECT pe.entitlement_id, e.key, e.type, pe.bool_value, pe.int_value
         FROM plan_entitlement pe
         JOIN entitlement e ON e.tenant_id = pe.tenant_id AND e.id = pe.entitlement_id
        WHERE pe.plan_id = $1
        ORDER BY e.key ASC`, [planId]);
        return r.rows.map((row) => ({ entitlementId: row.entitlement_id, key: row.key, type: row.type, value: toValue(row.type, row.bool_value, row.int_value) }));
    });
}
/**
 * Attach an entitlement to a plan (or edit its value) — an idempotent upsert. The value must match the
 * entitlement's type (400 otherwise). Both the plan and the entitlement must be active (409 `archived`
 * for a frozen catalog entry). 404 if either is unknown. Audited as `catalog.value.set`.
 */
export async function setPlanEntitlementValue(pool, tenantId, actor, planId, entitlementId, value) {
    return withTenant(pool, tenantId, async (q) => {
        const plan = await q("SELECT status FROM plan WHERE id = $1", [planId]);
        if (!plan.rowCount)
            throw new CatalogError("not_found", 404, "unknown plan");
        if (plan.rows[0].status !== "active") {
            throw new CatalogError("archived", 409, "cannot set a value on an archived plan");
        }
        const ent = await q("SELECT key, type, status FROM entitlement WHERE id = $1", [entitlementId]);
        if (!ent.rowCount)
            throw new CatalogError("not_found", 404, "unknown entitlement");
        const { key, type, status } = ent.rows[0];
        if (status !== "active")
            throw new CatalogError("archived", 409, "cannot set a value for an archived entitlement");
        const { boolValue, intValue } = assertValueMatchesType(type, value);
        await q(`INSERT INTO plan_entitlement (id, tenant_id, plan_id, entitlement_id, bool_value, int_value)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, plan_id, entitlement_id)
       DO UPDATE SET bool_value = EXCLUDED.bool_value, int_value = EXCLUDED.int_value, updated_at = now()`, [randomUUID(), planId, entitlementId, boolValue, intValue]);
        await writeAudit(q, { actor, action: "catalog.value.set", target: `${planId}/${entitlementId}`, after: { value } });
        return { entitlementId, key, type, value: toValue(type, boolValue, intValue) };
    });
}
/** Remove an entitlement's value from a plan (detach the attachment, never the definition). 404 if absent. */
export async function removePlanEntitlementValue(pool, tenantId, actor, planId, entitlementId) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q("DELETE FROM plan_entitlement WHERE plan_id = $1 AND entitlement_id = $2", [planId, entitlementId]);
        if (!r.rowCount)
            throw new CatalogError("not_found", 404, "no such value on this plan");
        await writeAudit(q, { actor, action: "catalog.value.removed", target: `${planId}/${entitlementId}` });
    });
}
