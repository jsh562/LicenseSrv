// Reseller data-access repository (E018, FR-002/003/004/005/017; AD-002/AD-003, HINT-001). The shared,
// stateless data-access surface the gate, lifecycle, and routes compose. It is deliberately split across the
// TWO — and ONLY two — seams the isolation model allows (data-model.md "isolation crux", INV-1/2):
//
//   * RESELLER-OWN, TENANT-SCOPED reads/writes (the `reseller` 1:1 side-table) run under the reseller's OWN
//     `app.current_tenant` via `withTenant`, so forced RLS scopes them to exactly that reseller tenant. The
//     `reseller` row's WITH CHECK (`tenant_id = app.current_tenant`) means the write can only ever touch the
//     acting tenant's own row — never another reseller's.
//   * The SUBTREE READ ("list my sub-tenants") and the operator PARENT-LINK writes are cross-tenant and run on
//     the RLS-bypassing `privileged` platform-admin seam (the same audited seam E002 uses for tenant
//     provisioning). They filter `tenant.parent_reseller_id = :reseller`. This NEVER broadens the per-tenant
//     `tenant_isolation` predicate (which is `id = app.current_tenant` on `tenant`, so a reseller session can
//     only ever see its OWN tenant row, not its sub-tenants) — AD-002, HINT-001. The caller MUST have already
//     asserted the acting principal owns `resellerTenantId` (session tenant == the reseller, admin/owner role)
//     BEFORE invoking a subtree read; this repo trusts that assertion and does not re-authenticate.
//
// The sub-tenant projection is METADATA-ONLY (id/slug/name/parent/tombstone/created_at) — a reseller never sees
// a sub-tenant's license/usage/activation data (FR-017); the `tenant` table structurally holds no such columns.
// Performs NO cryptography and holds no secret (presentation-only, Principle I).
import type pg from "pg";

import { privileged, withTenant } from "../../db/client.js";

/** A reseller's lifecycle state (data-model.md; `reseller.status` CHECK). */
export type ResellerStatus = "active" | "suspended" | "offboarding";

/** The reseller 1:1 side-table row (camelCase projection of `reseller`). */
export interface ResellerRow {
  tenantId: string;
  status: ResellerStatus;
  /** HARD cap on sub-tenants; only the operator may raise it (FR-003). */
  subTenantQuota: number;
  /** Stable grace anchor — present iff `status='offboarding'` (`reseller_offboarding_shape` CHECK, FR-012). */
  offboardingStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A sub-tenant as a reseller may see it — METADATA-ONLY (FR-017). NO license/usage/activation field is ever
 * projected (nor does the `tenant` table carry one). `parentResellerId` is included so callers can confirm the
 * downward-only link; a tombstoned sub-tenant carries a non-null `deletedAt`.
 */
export interface SubTenantRow {
  id: string;
  slug: string;
  name: string | null;
  parentResellerId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

/**
 * The minimal subtree-membership surface the gate (`gate.ts`) depends on. `ResellerRepo` implements it; the
 * gate types against this narrow interface so its ownership/downward-only logic is unit-testable with a stub.
 */
export interface SubtreeMembershipRepo {
  getSubTenant(resellerTenantId: string, subTenantId: string): Promise<SubTenantRow | null>;
}

/**
 * A reseller row joined with the presentation metadata the OPERATOR plane needs (FR-001/003/010): the
 * reseller's `displayName` (its `tenant.name`) and its current live `subTenantCount`. Read cross-tenant on
 * the audited `privileged` seam — the operator is the platform actor above all resellers (AD-002).
 */
export interface ResellerWithMeta {
  reseller: ResellerRow;
  displayName: string | null;
  subTenantCount: number;
}

const RESELLER_COLUMNS =
  "tenant_id, status, sub_tenant_quota, offboarding_started_at, created_at, updated_at";
const SUB_TENANT_COLUMNS = "id, slug, name, parent_reseller_id, deleted_at, created_at";

interface ResellerRow_ {
  tenant_id: string;
  status: ResellerStatus;
  sub_tenant_quota: number;
  offboarding_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SubTenantRow_ {
  id: string;
  slug: string;
  name: string | null;
  parent_reseller_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

function mapReseller(row: ResellerRow_): ResellerRow {
  return {
    tenantId: row.tenant_id,
    status: row.status,
    subTenantQuota: Number(row.sub_tenant_quota),
    offboardingStartedAt: row.offboarding_started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResellerWithMeta(row: ResellerRow_ & { display_name: string | null; sub_tenant_count: number }): ResellerWithMeta {
  return {
    reseller: mapReseller(row),
    displayName: row.display_name,
    subTenantCount: Number(row.sub_tenant_count),
  };
}

function mapSubTenant(row: SubTenantRow_): SubTenantRow {
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
export class ResellerRepo implements SubtreeMembershipRepo {
  constructor(private readonly pool: pg.Pool) {}

  // --- Reseller 1:1 side-table CRUD — the reseller's OWN tenant scope (forced RLS, INV-1) ---------------

  /**
   * Create the `reseller` side-table row for a tenant that is BECOMING a reseller, under that tenant's OWN
   * scope (AD-003). `tenant_id` is taken from the GUC (never a bound param) so the WITH CHECK guarantees the
   * row can only be the acting tenant's own. `subTenantQuota` is the platform-default supplied by onboarding
   * (no DB default — FR-003/010). A new reseller starts `active` (no offboarding anchor).
   */
  async createReseller(
    tenantId: string,
    p: { subTenantQuota: number },
  ): Promise<ResellerRow> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `INSERT INTO reseller (tenant_id, status, sub_tenant_quota)
         VALUES (current_setting('app.current_tenant')::uuid, 'active', $1)
         RETURNING ${RESELLER_COLUMNS}`,
        [p.subTenantQuota],
      );
      return mapReseller(r.rows[0] as ResellerRow_);
    });
  }

  /** Read a reseller row under its own tenant scope; null if the tenant is not a reseller. */
  async getReseller(tenantId: string): Promise<ResellerRow | null> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `SELECT ${RESELLER_COLUMNS} FROM reseller
          WHERE tenant_id = current_setting('app.current_tenant')::uuid`,
      );
      return r.rowCount ? mapReseller(r.rows[0] as ResellerRow_) : null;
    });
  }

  /**
   * Set a reseller's lifecycle status, keeping the `reseller_offboarding_shape` CHECK satisfied in ONE UPDATE
   * (data-model.md, FR-011/012): moving to `offboarding` sets a STABLE grace anchor once (`COALESCE`, so a
   * re-issued offboard keeps the original start), and any non-offboarding status clears the anchor. Runs under
   * the reseller's own scope. Returns null if the tenant is not a reseller (no row updated).
   */
  async setStatus(tenantId: string, status: ResellerStatus): Promise<ResellerRow | null> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `UPDATE reseller SET
           status = $1,
           offboarding_started_at =
             CASE WHEN $1 = 'offboarding' THEN COALESCE(offboarding_started_at, now()) ELSE NULL END,
           updated_at = now()
         WHERE tenant_id = current_setting('app.current_tenant')::uuid
         RETURNING ${RESELLER_COLUMNS}`,
        [status],
      );
      return r.rowCount ? mapReseller(r.rows[0] as ResellerRow_) : null;
    });
  }

  /**
   * Set a reseller's HARD sub-tenant quota (operator-only authority enforced at the route, FR-003). Runs under
   * the reseller's own scope. Returns null if the tenant is not a reseller.
   */
  async setQuota(tenantId: string, subTenantQuota: number): Promise<ResellerRow | null> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `UPDATE reseller SET sub_tenant_quota = $1, updated_at = now()
          WHERE tenant_id = current_setting('app.current_tenant')::uuid
          RETURNING ${RESELLER_COLUMNS}`,
        [subTenantQuota],
      );
      return r.rowCount ? mapReseller(r.rows[0] as ResellerRow_) : null;
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
  async setParentReseller(subTenantId: string, resellerTenantId: string): Promise<void> {
    await privileged(this.pool, (q) =>
      q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerTenantId, subTenantId]),
    );
  }

  /** Clear a sub-tenant's reseller link — reassign-to-direct-platform (operator transfer, FR-015). Privileged. */
  async clearParentReseller(subTenantId: string): Promise<void> {
    await privileged(this.pool, (q) =>
      q("UPDATE tenant SET parent_reseller_id = NULL WHERE id = $1", [subTenantId]),
    );
  }

  /**
   * Read a tenant's managing-reseller link (its `parent_reseller_id`), METADATA-ONLY (FR-017) — the single
   * scalar the plane gate needs to tell a sub-tenant (linked) from a direct-platform/operator tenant (NULL).
   * Returns `null` for a direct-platform tenant, a reseller tenant (a reseller carries no parent), or an
   * unknown id. Read on the `privileged` seam because the `tenant` RLS predicate would scope a session to its
   * OWN row only; this is a metadata read, never a broadening of the per-tenant predicate (AD-002, HINT-001).
   */
  async getParentResellerId(tenantId: string): Promise<string | null> {
    return privileged(this.pool, async (q) => {
      const r = await q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [tenantId]);
      return r.rowCount ? (r.rows[0] as { parent_reseller_id: string | null }).parent_reseller_id : null;
    });
  }

  // --- Subtree reads — the audited privileged seam, ownership pre-asserted by the caller (AD-002) -------

  /**
   * List a reseller's OWN sub-tenants ("my customers"), METADATA-ONLY (FR-002/017), bounded + deterministic.
   * Runs on the `privileged` seam filtered by `parent_reseller_id = :reseller` — the one audited cross-tenant
   * read path — AFTER the caller has asserted ownership of `resellerTenantId`. It does NOT broaden the
   * per-tenant RLS predicate (HINT-001). Ordered `(created_at, id)` so the page is stable/reproducible.
   */
  async listSubTenants(
    resellerTenantId: string,
    p: { limit: number; offset?: number },
  ): Promise<SubTenantRow[]> {
    return privileged(this.pool, async (q) => {
      const r = await q(
        `SELECT ${SUB_TENANT_COLUMNS} FROM tenant
          WHERE parent_reseller_id = $1
          ORDER BY created_at ASC, id ASC
          LIMIT $2 OFFSET $3`,
        [resellerTenantId, p.limit, p.offset ?? 0],
      );
      return (r.rows as SubTenantRow_[]).map(mapSubTenant);
    });
  }

  /**
   * Count a reseller's LIVE (non-tombstoned) sub-tenants — the quota denominator (FR-003). Privileged seam,
   * ownership pre-asserted by the caller. Excludes soft-deleted tenants so a tombstoned sub-tenant frees quota.
   */
  async countSubTenants(resellerTenantId: string): Promise<number> {
    return privileged(this.pool, async (q) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM tenant
          WHERE parent_reseller_id = $1 AND deleted_at IS NULL`,
        [resellerTenantId],
      );
      return (r.rows[0] as { n: number }).n;
    });
  }

  /**
   * Fetch ONE of a reseller's own sub-tenants, METADATA-ONLY, DOWNWARD-ONLY (FR-004/017, HINT-002). The
   * `parent_reseller_id = :reseller` filter is the isolation-crux: an out-of-subtree target (a sibling's
   * customer, a parent, the platform, or an IDOR-by-id) simply matches ZERO rows and returns null — the caller
   * maps that to 404 with NO existence disclosure, never 403. Privileged seam; ownership pre-asserted by the
   * caller. This is the single lookup the subtree-membership gate builds on.
   */
  async getSubTenant(resellerTenantId: string, subTenantId: string): Promise<SubTenantRow | null> {
    return privileged(this.pool, async (q) => {
      const r = await q(
        `SELECT ${SUB_TENANT_COLUMNS} FROM tenant
          WHERE id = $1 AND parent_reseller_id = $2`,
        [subTenantId, resellerTenantId],
      );
      return r.rowCount ? mapSubTenant(r.rows[0] as SubTenantRow_) : null;
    });
  }

  // --- Operator-plane reads — cross-tenant reseller metadata via the audited privileged seam (AD-002) ---

  /** The reseller columns joined with `tenant.name` + a live sub-tenant count, for operator list/detail. */
  private static readonly RESELLER_META_SELECT =
    `SELECT r.tenant_id, r.status, r.sub_tenant_quota, r.offboarding_started_at, r.created_at, r.updated_at,
            t.name AS display_name,
            (SELECT count(*)::int FROM tenant st
              WHERE st.parent_reseller_id = r.tenant_id AND st.deleted_at IS NULL) AS sub_tenant_count
       FROM reseller r JOIN tenant t ON t.id = r.tenant_id`;

  /**
   * Fetch ONE reseller with its display name + live sub-tenant count (operator plane, FR-001/003/010). Runs on
   * the `privileged` seam — the operator is the platform actor above all resellers. Null if the id is not a
   * reseller (the caller maps that to `404 not_found`).
   */
  async getResellerWithMeta(resellerTenantId: string): Promise<ResellerWithMeta | null> {
    return privileged(this.pool, async (q) => {
      const r = await q(`${ResellerRepo.RESELLER_META_SELECT} WHERE r.tenant_id = $1`, [resellerTenantId]);
      return r.rowCount
        ? mapResellerWithMeta(r.rows[0] as ResellerRow_ & { display_name: string | null; sub_tenant_count: number })
        : null;
    });
  }

  /**
   * List all resellers on the platform (operator plane, FR-001/010), optionally narrowed by lifecycle status,
   * DETERMINISTICALLY ordered by `display_name` then `tenant_id` and bounded by `limit`. Cross-tenant read on
   * the `privileged` seam — the operator reads across all resellers, not a tenant session (AD-002).
   */
  async listResellersWithMeta(
    p: { status?: ResellerStatus; limit: number; offset?: number },
  ): Promise<ResellerWithMeta[]> {
    return privileged(this.pool, async (q) => {
      const where = p.status ? "WHERE r.status = $3" : "";
      const params: unknown[] = p.status
        ? [p.limit, p.offset ?? 0, p.status]
        : [p.limit, p.offset ?? 0];
      const r = await q(
        `${ResellerRepo.RESELLER_META_SELECT}
         ${where}
         ORDER BY t.name ASC, r.tenant_id ASC
         LIMIT $1 OFFSET $2`,
        params,
      );
      return (r.rows as (ResellerRow_ & { display_name: string | null; sub_tenant_count: number })[]).map(
        mapResellerWithMeta,
      );
    });
  }
}
