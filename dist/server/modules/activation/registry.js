import { withTenant } from "../../db/client.js";
import { ActivationError } from "./index.js";
async function countActive(q, licenseId) {
    const r = await q("SELECT count(*)::int AS n FROM activation WHERE license_id = $1 AND status = 'active'", [licenseId]);
    return r.rows[0].n;
}
/**
 * List a license's activations (most-recent first, bounded to `cap`) with the seats-used-vs-limit summary.
 * 404 not_found when the license is unknown within the tenant.
 */
export async function listActivations(pool, tenantId, licenseId, cap) {
    return withTenant(pool, tenantId, async (q) => {
        const lic = await q("SELECT max_activations FROM license WHERE id = $1", [licenseId]);
        if (!lic.rowCount)
            throw new ActivationError("not_found", 404, "unknown license");
        const seatLimit = lic.rows[0].max_activations;
        const rows = await q(`SELECT id, machine_id, status, activated_at, deactivated_at, label
         FROM activation WHERE license_id = $1 ORDER BY activated_at DESC LIMIT $2`, [licenseId, cap]);
        const activations = rows.rows.map((r) => ({
            id: r.id,
            machineId: r.machine_id,
            status: r.status,
            activatedAt: r.activated_at.toISOString(),
            deactivatedAt: r.deactivated_at ? r.deactivated_at.toISOString() : null,
            label: r.label,
        }));
        return { activations, seatsUsed: await countActive(q, licenseId), seatLimit };
    });
}
