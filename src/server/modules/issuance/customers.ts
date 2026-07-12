// Customer repository (FR-011/014/019). Pseudonymous recipients with minimal PII (a non-PII `ref` + an
// optional display name/email). Erasure is GDPR-safe: a customer that holds licenses is anonymized (name
// + email nulled, status→anonymized, non-PII ref retained) so its licenses stay interpretable; a
// license-free customer is hard-deleted. Every change is audited — never recording erased PII (FR-014).
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { IssuanceError } from "./index.js";

export interface Customer {
  id: string;
  ref: string;
  name: string | null;
  email: string | null;
  status: "active" | "anonymized";
  createdAt: string;
}

interface Row {
  id: string;
  ref: string;
  name: string | null;
  email: string | null;
  status: "active" | "anonymized";
  created_at: Date;
}

function toCustomer(r: Row): Customer {
  return { id: r.id, ref: r.ref, name: r.name, email: r.email, status: r.status, createdAt: r.created_at.toISOString() };
}

const SELECT = "id, ref, name, email, status, created_at";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/** Register a pseudonymous customer. Duplicate `ref` within the tenant → 409. */
export async function createCustomer(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  input: { ref: string; name?: string | null; email?: string | null },
): Promise<Customer> {
  const id = randomUUID();
  return withTenant(pool, tenantId, async (q): Promise<Customer> => {
    try {
      const r = await q(
        `INSERT INTO customer (id, tenant_id, ref, name, email)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)
         RETURNING ${SELECT}`,
        [id, input.ref, input.name ?? null, input.email ?? null],
      );
      await writeAudit(q, { actor, action: "customer.created", target: id, after: { ref: input.ref } });
      return toCustomer(r.rows[0] as Row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new IssuanceError("duplicate_ref", 409, "a customer with that ref already exists");
      throw e;
    }
  });
}

/** List customers (bounded, not paginated). */
export async function listCustomers(pool: pg.Pool, tenantId: string, cap: number): Promise<Customer[]> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(`SELECT ${SELECT} FROM customer ORDER BY created_at ASC LIMIT $1`, [cap]);
    return (r.rows as Row[]).map(toCustomer);
  });
}

/** Get one customer, or null. */
export async function getCustomer(pool: pg.Pool, tenantId: string, id: string): Promise<Customer | null> {
  return withTenant(pool, tenantId, (q) => getCustomerTx(q, id));
}

async function getCustomerTx(q: TxQuery, id: string): Promise<Customer | null> {
  const r = await q(`SELECT ${SELECT} FROM customer WHERE id = $1`, [id]);
  return r.rowCount ? toCustomer(r.rows[0] as Row) : null;
}

/**
 * GDPR erasure (FR-019). A customer holding licenses is anonymized (PII cleared, ref kept, status
 * anonymized); a license-free customer is hard-deleted. Re-erasing an anonymized customer is a no-op.
 * 404 if unknown. The audit entry records no erased PII.
 */
export async function eraseCustomer(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<void> {
  return withTenant(pool, tenantId, async (q) => {
    const existing = await getCustomerTx(q, id);
    if (!existing) throw new IssuanceError("not_found", 404, "unknown customer");
    if (existing.status === "anonymized") return; // idempotent no-op

    const held = await q("SELECT 1 FROM license WHERE customer_id = $1 LIMIT 1", [id]);
    if (held.rowCount) {
      await q("UPDATE customer SET name = NULL, email = NULL, status = 'anonymized', updated_at = now() WHERE id = $1", [id]);
      await writeAudit(q, { actor, action: "customer.anonymized", target: id });
    } else {
      await q("DELETE FROM customer WHERE id = $1", [id]);
      await writeAudit(q, { actor, action: "customer.deleted", target: id });
    }
  });
}
