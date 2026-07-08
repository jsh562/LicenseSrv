// Plan repository (FR-003/004/012/013). A plan belongs to exactly one product (composite FK) and carries
// the seat limit (max_activations, default 1). Key immutable after creation (FR-018); archive is soft.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { asDuplicateKey, CatalogError } from "./validation.js";

export interface Plan {
  id: string;
  productId: string;
  key: string;
  name: string;
  description: string | null;
  maxActivations: number;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  product_id: string;
  key: string;
  name: string;
  description: string | null;
  max_activations: number;
  status: "active" | "archived";
  created_at: Date;
  updated_at: Date;
}

function toPlan(r: Row): Plan {
  return {
    id: r.id,
    productId: r.product_id,
    key: r.key,
    name: r.name,
    description: r.description,
    maxActivations: r.max_activations,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT = "id, product_id, key, name, description, max_activations, status, created_at, updated_at";

/** Create a plan under a product. 404 if the product is unknown; duplicate key within the product → 409. */
export async function createPlan(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  productId: string,
  input: { key: string; name: string; description?: string | null; maxActivations?: number },
): Promise<Plan> {
  const id = randomUUID();
  return withTenant(pool, tenantId, async (q): Promise<Plan> => {
    const prod = await q("SELECT 1 FROM product WHERE id = $1", [productId]);
    if (!prod.rowCount) throw new CatalogError("not_found", 404, "unknown product");
    try {
      const r = await q(
        `INSERT INTO plan (id, tenant_id, product_id, key, name, description, max_activations)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6)
         RETURNING ${SELECT}`,
        [id, productId, input.key, input.name, input.description ?? null, input.maxActivations ?? 1],
      );
      const row = r.rows[0] as Row;
      await writeAudit(q, { actor, action: "catalog.plan.created", target: id, after: { productId, key: input.key } });
      return toPlan(row);
    } catch (e) {
      asDuplicateKey(e, "a plan with that key already exists in this product");
    }
  });
}

/** List a product's plans; `status` filters active/archived/all (default active-only). Bounded by `cap`. */
export async function listPlans(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  opts: { status?: "active" | "archived" | "all"; cap: number },
): Promise<Plan[]> {
  return withTenant(pool, tenantId, async (q) => {
    const effective = opts.status ?? "active"; // default list is active-only; only `all` returns both
    const filter = effective !== "all" ? "AND status = $2" : "";
    const params = effective !== "all" ? [productId, effective, opts.cap] : [productId, opts.cap];
    const r = await q(
      `SELECT ${SELECT} FROM plan WHERE product_id = $1 ${filter} ORDER BY created_at ASC LIMIT $${params.length}`,
      params,
    );
    return (r.rows as Row[]).map(toPlan);
  });
}

/** Get one plan (with its productId), or null. */
export async function getPlan(pool: pg.Pool, tenantId: string, id: string): Promise<Plan | null> {
  return withTenant(pool, tenantId, (q) => getPlanTx(q, id));
}

async function getPlanTx(q: TxQuery, id: string): Promise<Plan | null> {
  const r = await q(`SELECT ${SELECT} FROM plan WHERE id = $1`, [id]);
  return r.rowCount ? toPlan(r.rows[0] as Row) : null;
}

/** Edit a plan's name/description/maxActivations (key immutable). 404 if unknown; seat<1 rejected by the DB CHECK. */
export async function updatePlan(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  id: string,
  input: { name?: string; description?: string | null; maxActivations?: number },
): Promise<Plan> {
  return withTenant(pool, tenantId, async (q): Promise<Plan> => {
    const existing = await getPlanTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown plan");
    const r = await q(
      `UPDATE plan
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              max_activations = COALESCE($5, max_activations),
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT}`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null, input.maxActivations ?? null],
    );
    await writeAudit(q, { actor, action: "catalog.plan.updated", target: id, before: existing, after: input });
    return toPlan(r.rows[0] as Row);
  });
}

/** Archive a plan (soft-retire). 404 if unknown. */
export async function archivePlan(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<Plan> {
  return withTenant(pool, tenantId, async (q): Promise<Plan> => {
    const existing = await getPlanTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown plan");
    const r = await q(`UPDATE plan SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING ${SELECT}`, [id]);
    await writeAudit(q, { actor, action: "catalog.plan.archived", target: id });
    return toPlan(r.rows[0] as Row);
  });
}
