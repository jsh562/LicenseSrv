import { privileged, withTenant } from "../../db/client.js";
const RESELLER_COLUMNS = "tenant_id, status, sub_tenant_quota, offboarding_started_at, created_at, updated_at";
const SUB_TENANT_COLUMNS = "id, slug, name, parent_reseller_id, deleted_at, created_at";
function mapReseller(row) {
    return {
        tenantId: row.tenant_id,
        status: row.status,
        subTenantQuota: Number(row.sub_tenant_quota),
        offboardingStartedAt: row.offboarding_started_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function mapResellerWithMeta(row) {
    return {
        reseller: mapReseller(row),
        displayName: row.display_name,
        subTenantCount: Number(row.sub_tenant_count),
    };
}
function mapSubTenant(row) {
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        parentResellerId: row.parent_reseller_id,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
    };
}
/**
 * The shared reseller data-access repository. Stateless — every method is driven by the pool + explicit ids, so
 * one instance is safely shared across requests/workers (mirrors {@link import("../usage/usage-repo.js")}).
 */
export class ResellerRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    // --- Reseller 1:1 side-table CRUD — the reseller's OWN tenant scope (forced RLS, INV-1) ---------------
    /**
     * Create the `reseller` side-table row for a tenant that is BECOMING a reseller, under that tenant's OWN
     * scope (AD-003). `tenant_id` is taken from the GUC (never a bound param) so the WITH CHECK guarantees the
     * row can only be the acting tenant's own. `subTenantQuota` is the platform-default supplied by onboarding
     * (no DB default — FR-003/010). A new reseller starts `active` (no offboarding anchor).
     */
    async createReseller(tenantId, p) {
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota)
         VALUES (current_setting('app.current_tenant')::uuid, 'active', $1)
         RETURNING ${RESELLER_COLUMNS}`, [p.subTenantQuota]);
            return mapReseller(r.rows[0]);
        });
    }
    /** Read a reseller row under its own tenant scope; null if the tenant is not a reseller. */
    async getReseller(tenantId) {
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`SELECT ${RESELLER_COLUMNS} FROM reseller
          WHERE tenant_id = current_setting('app.current_tenant')::uuid`);
            return r.rowCount ? mapReseller(r.rows[0]) : null;
        });
    }
    /**
     * Set a reseller's lifecycle status, keeping the `reseller_offboarding_shape` CHECK satisfied in ONE UPDATE
     * (data-model.md, FR-011/012): moving to `offboarding` sets a STABLE grace anchor once (`COALESCE`, so a
     * re-issued offboard keeps the original start), and any non-offboarding status clears the anchor. Runs under
     * the reseller's own scope. Returns null if the tenant is not a reseller (no row updated).
     */
    async setStatus(tenantId, status) {
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`UPDATE reseller SET
           status = $1,
           offboarding_started_at =
             CASE WHEN $1 = 'offboarding' THEN COALESCE(offboarding_started_at, now()) ELSE NULL END,
           updated_at = now()
         WHERE tenant_id = current_setting('app.current_tenant')::uuid
         RETURNING ${RESELLER_COLUMNS}`, [status]);
            return r.rowCount ? mapReseller(r.rows[0]) : null;
        });
    }
    /**
     * Set a reseller's HARD sub-tenant quota (operator-only authority enforced at the route, FR-003). Runs under
     * the reseller's own scope. Returns null if the tenant is not a reseller.
     */
    async setQuota(tenantId, subTenantQuota) {
        return withTenant(this.pool, tenantId, async (q) => {
            const r = await q(`UPDATE reseller SET sub_tenant_quota = $1, updated_at = now()
          WHERE tenant_id = current_setting('app.current_tenant')::uuid
          RETURNING ${RESELLER_COLUMNS}`, [subTenantQuota]);
            return r.rowCount ? mapReseller(r.rows[0]) : null;
        });
    }
    // --- The tenant.parent_reseller_id link — a cross-tenant OPERATOR action (privileged seam, AD-002) ----
    /**
     * Link a sub-tenant UP to its managing reseller (onboarding/provision or an operator transfer, FR-001/015).
     * A cross-tenant operator write on the `tenant` table — the `tenant` RLS predicate is `id = app.current_tenant`,
     * so a reseller session could never write another tenant's row; this runs on the audited `privileged` seam,
     * NOT under any tenant session, and NEVER by widening a predicate. The self-ref FK + `<> id` CHECK guard the
     * schema; the one-level rule (a reseller must not itself carry a parent) is enforced by the lifecycle layer.
     */
    async setParentReseller(subTenantId, resellerTenantId) {
        await privileged(this.pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerTenantId, subTenantId]));
    }
    /** Clear a sub-tenant's reseller link — reassign-to-direct-platform (operator transfer, FR-015). Privileged. */
    async clearParentReseller(subTenantId) {
        await privileged(this.pool, (q) => q("UPDATE tenant SET parent_reseller_id = NULL WHERE id = $1", [subTenantId]));
    }
    /**
     * Read a tenant's managing-reseller link (its `parent_reseller_id`), METADATA-ONLY (FR-017) — the single
     * scalar the plane gate needs to tell a sub-tenant (linked) from a direct-platform/operator tenant (NULL).
     * Returns `null` for a direct-platform tenant, a reseller tenant (a reseller carries no parent), or an
     * unknown id. Read on the `privileged` seam because the `tenant` RLS predicate would scope a session to its
     * OWN row only; this is a metadata read, never a broadening of the per-tenant predicate (AD-002, HINT-001).
     */
    async getParentResellerId(tenantId) {
        return privileged(this.pool, async (q) => {
            const r = await q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [tenantId]);
            return r.rowCount ? r.rows[0].parent_reseller_id : null;
        });
    }
    // --- Subtree reads — the audited privileged seam, ownership pre-asserted by the caller (AD-002) -------
    /**
     * List a reseller's OWN sub-tenants ("my customers"), METADATA-ONLY (FR-002/017), bounded + deterministic.
     * Runs on the `privileged` seam filtered by `parent_reseller_id = :reseller` — the one audited cross-tenant
     * read path — AFTER the caller has asserted ownership of `resellerTenantId`. It does NOT broaden the
     * per-tenant RLS predicate (HINT-001). Ordered `(created_at, id)` so the page is stable/reproducible.
     */
    async listSubTenants(resellerTenantId, p) {
        return privileged(this.pool, async (q) => {
            const r = await q(`SELECT ${SUB_TENANT_COLUMNS} FROM tenant
          WHERE parent_reseller_id = $1
          ORDER BY created_at ASC, id ASC
          LIMIT $2 OFFSET $3`, [resellerTenantId, p.limit, p.offset ?? 0]);
            return r.rows.map(mapSubTenant);
        });
    }
    /**
     * Count a reseller's LIVE (non-tombstoned) sub-tenants — the quota denominator (FR-003). Privileged seam,
     * ownership pre-asserted by the caller. Excludes soft-deleted tenants so a tombstoned sub-tenant frees quota.
     */
    async countSubTenants(resellerTenantId) {
        return privileged(this.pool, async (q) => {
            const r = await q(`SELECT count(*)::int AS n FROM tenant
          WHERE parent_reseller_id = $1 AND deleted_at IS NULL`, [resellerTenantId]);
            return r.rows[0].n;
        });
    }
    /**
     * Fetch ONE of a reseller's own sub-tenants, METADATA-ONLY, DOWNWARD-ONLY (FR-004/017, HINT-002). The
     * `parent_reseller_id = :reseller` filter is the isolation-crux: an out-of-subtree target (a sibling's
     * customer, a parent, the platform, or an IDOR-by-id) simply matches ZERO rows and returns null — the caller
     * maps that to 404 with NO existence disclosure, never 403. Privileged seam; ownership pre-asserted by the
     * caller. This is the single lookup the subtree-membership gate builds on.
     */
    async getSubTenant(resellerTenantId, subTenantId) {
        return privileged(this.pool, async (q) => {
            const r = await q(`SELECT ${SUB_TENANT_COLUMNS} FROM tenant
          WHERE id = $1 AND parent_reseller_id = $2`, [subTenantId, resellerTenantId]);
            return r.rowCount ? mapSubTenant(r.rows[0]) : null;
        });
    }
    // --- Operator-plane reads — cross-tenant reseller metadata via the audited privileged seam (AD-002) ---
    /** The reseller columns joined with `tenant.name` + a live sub-tenant count, for operator list/detail. */
    static RESELLER_META_SELECT = `SELECT r.tenant_id, r.status, r.sub_tenant_quota, r.offboarding_started_at, r.created_at, r.updated_at,
            t.name AS display_name,
            (SELECT count(*)::int FROM tenant st
              WHERE st.parent_reseller_id = r.tenant_id AND st.deleted_at IS NULL) AS sub_tenant_count
       FROM reseller r JOIN tenant t ON t.id = r.tenant_id`;
    /**
     * Fetch ONE reseller with its display name + live sub-tenant count (operator plane, FR-001/003/010). Runs on
     * the `privileged` seam — the operator is the platform actor above all resellers. Null if the id is not a
     * reseller (the caller maps that to `404 not_found`).
     */
    async getResellerWithMeta(resellerTenantId) {
        return privileged(this.pool, async (q) => {
            const r = await q(`${ResellerRepo.RESELLER_META_SELECT} WHERE r.tenant_id = $1`, [resellerTenantId]);
            return r.rowCount
                ? mapResellerWithMeta(r.rows[0])
                : null;
        });
    }
    /**
     * List all resellers on the platform (operator plane, FR-001/010), optionally narrowed by lifecycle status,
     * DETERMINISTICALLY ordered by `display_name` then `tenant_id` and bounded by `limit`. Cross-tenant read on
     * the `privileged` seam — the operator reads across all resellers, not a tenant session (AD-002).
     */
    async listResellersWithMeta(p) {
        return privileged(this.pool, async (q) => {
            const where = p.status ? "WHERE r.status = $3" : "";
            const params = p.status
                ? [p.limit, p.offset ?? 0, p.status]
                : [p.limit, p.offset ?? 0];
            const r = await q(`${ResellerRepo.RESELLER_META_SELECT}
         ${where}
         ORDER BY t.name ASC, r.tenant_id ASC
         LIMIT $1 OFFSET $2`, params);
            return r.rows.map(mapResellerWithMeta);
        });
    }
}
