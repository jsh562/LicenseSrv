// Product repository (FR-001/002/012/013). Tenant-scoped CRUD + soft archive, every mutation audited in
// the same transaction. The key is set at creation and never editable (FR-018); archiving a product
// cascades to its plans (FR-013, SC-008). Duplicate keys within a tenant surface as a 409.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { asDuplicateKey, CatalogError } from "./validation.js";

export interface Product {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  created_at: Date;
  updated_at: Date;
}

function toProduct(r: Row): Product {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT = "id, key, name, description, status, created_at, updated_at";

/** Create a product. Duplicate key within the tenant → 409. */
export async function createProduct(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  input: { key: string; name: string; description?: string | null },
): Promise<Product> {
  const id = randomUUID();
  return withTenant(pool, tenantId, async (q): Promise<Product> => {
    try {
      const r = await q(
        `INSERT INTO product (id, tenant_id, key, name, description)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)
         RETURNING ${SELECT}`,
        [id, input.key, input.name, input.description ?? null],
      );
      const row = r.rows[0] as Row;
      await writeAudit(q, { actor, action: "catalog.product.created", target: id, after: { key: input.key, name: input.name } });
      return toProduct(row);
    } catch (e) {
      asDuplicateKey(e, "a product with that key already exists");
    }
  });
}

/** List products; `status` filters active/archived/all (default active-only). Bounded by `cap` (AD-009). */
export async function listProducts(
  pool: pg.Pool,
  tenantId: string,
  opts: { status?: "active" | "archived" | "all"; cap: number },
): Promise<Product[]> {
  return withTenant(pool, tenantId, async (q) => {
    const effective = opts.status ?? "active"; // default list is active-only; only `all` returns both
    const where = effective !== "all" ? "WHERE status = $1" : "";
    const params = effective !== "all" ? [effective, opts.cap] : [opts.cap];
    const r = await q(`SELECT ${SELECT} FROM product ${where} ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return (r.rows as Row[]).map(toProduct);
  });
}

/** Get one product, or null. */
export async function getProduct(pool: pg.Pool, tenantId: string, id: string): Promise<Product | null> {
  return withTenant(pool, tenantId, (q) => getProductTx(q, id));
}

async function getProductTx(q: TxQuery, id: string): Promise<Product | null> {
  const r = await q(`SELECT ${SELECT} FROM product WHERE id = $1`, [id]);
  return r.rowCount ? toProduct(r.rows[0] as Row) : null;
}

/** Edit a product's name/description (key immutable, FR-018). 404 if unknown. */
export async function updateProduct(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  id: string,
  input: { name?: string; description?: string | null },
): Promise<Product> {
  return withTenant(pool, tenantId, async (q): Promise<Product> => {
    const existing = await getProductTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown product");
    const r = await q(
      `UPDATE product
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT}`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null],
    );
    await writeAudit(q, { actor, action: "catalog.product.updated", target: id, before: existing, after: input });
    return toProduct(r.rows[0] as Row);
  });
}

/** Archive a product (soft-retire) and cascade the archive to its plans (FR-013, SC-008). 404 if unknown. */
export async function archiveProduct(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<Product> {
  return withTenant(pool, tenantId, async (q): Promise<Product> => {
    const existing = await getProductTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown product");
    await q("UPDATE plan SET status = 'archived', updated_at = now() WHERE product_id = $1 AND status = 'active'", [id]);
    const r = await q(`UPDATE product SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING ${SELECT}`, [id]);
    await writeAudit(q, { actor, action: "catalog.product.archived", target: id });
    return toProduct(r.rows[0] as Row);
  });
}
