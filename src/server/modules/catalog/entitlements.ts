// Entitlement repository (FR-005/006/012/013). Defines the gated features plans grant. The key is the
// canonical feature key embedded in E001 signed tokens — immutable after creation (FR-018). The type is
// fixed once any plan references the entitlement (FR-006): a type change on a referenced entitlement is
// refused (409 entitlement_type_locked), so a license in the field never loses its gate.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { asDuplicateKey, CatalogError, type EntitlementType } from "./validation.js";

export interface Entitlement {
  id: string;
  key: string;
  name: string;
  type: EntitlementType;
  description: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  key: string;
  name: string;
  type: EntitlementType;
  description: string | null;
  status: "active" | "archived";
  created_at: Date;
  updated_at: Date;
}

function toEntitlement(r: Row): Entitlement {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    type: r.type,
    description: r.description,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT = "id, key, name, type, description, status, created_at, updated_at";

/** True if any plan_entitlement references this entitlement (→ key/type are locked). */
export async function isReferenced(q: TxQuery, entitlementId: string): Promise<boolean> {
  const r = await q("SELECT 1 FROM plan_entitlement WHERE entitlement_id = $1 LIMIT 1", [entitlementId]);
  return (r.rowCount ?? 0) > 0;
}

/** Create an entitlement of the given type. Duplicate key within the tenant → 409. */
export async function createEntitlement(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  input: { key: string; name: string; type: EntitlementType; description?: string | null },
): Promise<Entitlement> {
  const id = randomUUID();
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    try {
      const r = await q(
        `INSERT INTO entitlement (id, tenant_id, key, name, type, description)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5)
         RETURNING ${SELECT}`,
        [id, input.key, input.name, input.type, input.description ?? null],
      );
      const row = r.rows[0] as Row;
      await writeAudit(q, { actor, action: "catalog.entitlement.created", target: id, after: { key: input.key, type: input.type } });
      return toEntitlement(row);
    } catch (e) {
      asDuplicateKey(e, "an entitlement with that key already exists");
    }
  });
}

/** List entitlements; `status` filters active/archived/all (default active-only). Bounded by `cap`. */
export async function listEntitlements(
  pool: pg.Pool,
  tenantId: string,
  opts: { status?: "active" | "archived" | "all"; cap: number },
): Promise<Entitlement[]> {
  return withTenant(pool, tenantId, async (q) => {
    const effective = opts.status ?? "active"; // default list is active-only; only `all` returns both
    const where = effective !== "all" ? "WHERE status = $1" : "";
    const params = effective !== "all" ? [effective, opts.cap] : [opts.cap];
    const r = await q(`SELECT ${SELECT} FROM entitlement ${where} ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return (r.rows as Row[]).map(toEntitlement);
  });
}

/** Get one entitlement, or null. */
export async function getEntitlement(pool: pg.Pool, tenantId: string, id: string): Promise<Entitlement | null> {
  return withTenant(pool, tenantId, (q) => getEntitlementTx(q, id));
}

async function getEntitlementTx(q: TxQuery, id: string): Promise<Entitlement | null> {
  const r = await q(`SELECT ${SELECT} FROM entitlement WHERE id = $1`, [id]);
  return r.rowCount ? toEntitlement(r.rows[0] as Row) : null;
}

/**
 * Edit an entitlement's name/description, and optionally its type. Key is immutable (FR-018). A type
 * change is only allowed while the entitlement is unreferenced (FR-006) — otherwise 409. 404 if unknown.
 */
export async function updateEntitlement(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  id: string,
  input: { name?: string; description?: string | null; type?: EntitlementType },
): Promise<Entitlement> {
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    const existing = await getEntitlementTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown entitlement");

    if (input.type !== undefined && input.type !== existing.type) {
      // Lock the referencing set to serialize against a concurrent value attach (FR-006).
      const ref = await q("SELECT 1 FROM plan_entitlement WHERE entitlement_id = $1 LIMIT 1 FOR UPDATE", [id]);
      if (ref.rowCount) {
        throw new CatalogError("entitlement_type_locked", 409, "cannot change the type of a referenced entitlement");
      }
    }

    const r = await q(
      `UPDATE entitlement
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              type = COALESCE($5, type),
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT}`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null, input.type ?? null],
    );
    await writeAudit(q, { actor, action: "catalog.entitlement.updated", target: id, before: existing, after: input });
    return toEntitlement(r.rows[0] as Row);
  });
}

/** Archive an entitlement (soft-retire). 404 if unknown. */
export async function archiveEntitlement(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<Entitlement> {
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    const existing = await getEntitlementTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown entitlement");
    const r = await q(`UPDATE entitlement SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING ${SELECT}`, [id]);
    await writeAudit(q, { actor, action: "catalog.entitlement.archived", target: id });
    return toEntitlement(r.rows[0] as Row);
  });
}
