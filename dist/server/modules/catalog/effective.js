import { withTenant } from "../../db/client.js";
/** Resolve a plan's effective definition for issuance, or null if the plan is unknown. */
export async function getEffectivePlanDefinition(pool, tenantId, planId) {
    return withTenant(pool, tenantId, async (q) => {
        const planRow = await q(`SELECT p.id AS plan_id, p.product_id, p.status AS plan_status, p.key AS plan_key,
              p.max_activations, pr.key AS product_key
         FROM plan p
         JOIN product pr ON pr.tenant_id = p.tenant_id AND pr.id = p.product_id
        WHERE p.id = $1`, [planId]);
        if (!planRow.rowCount)
            return null;
        const head = planRow.rows[0];
        const entRows = await q(`SELECT e.key, e.type, e.status, pe.bool_value, pe.int_value
         FROM plan_entitlement pe
         JOIN entitlement e ON e.tenant_id = pe.tenant_id AND e.id = pe.entitlement_id
        WHERE pe.plan_id = $1
        ORDER BY e.key ASC`, [planId]);
        const rows = entRows.rows;
        // The effective values expose ACTIVE attachments only; archived attachments are excluded here but
        // reported by key so issuance can fail-closed (FR-005). Catalog reads simply ignore that field.
        const entitlements = rows
            .filter((r) => r.status === "active")
            .map((r) => ({
            key: r.key,
            type: r.type,
            value: r.type === "boolean" ? Boolean(r.bool_value) : Number(r.int_value),
        }));
        const archivedEntitlementKeys = rows.filter((r) => r.status === "archived").map((r) => r.key);
        return {
            planId: head.plan_id,
            productId: head.product_id,
            planStatus: head.plan_status,
            planKey: head.plan_key,
            productKey: head.product_key,
            maxActivations: head.max_activations,
            entitlements,
            archivedEntitlementKeys,
        };
    });
}
