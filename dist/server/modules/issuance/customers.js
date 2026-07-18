// Customer repository (FR-011/014/019). Pseudonymous recipients with minimal PII (a non-PII `ref` + an
// optional display name/email). Erasure is GDPR-safe: a customer that holds licenses is anonymized (name
// + email nulled, status→anonymized, non-PII ref retained) so its licenses stay interpretable; a
// license-free customer is hard-deleted. Every change is audited — never recording erased PII (FR-014).
import { randomUUID } from "node:crypto";
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { IssuanceError } from "./index.js";
function toCustomer(r) {
    return { id: r.id, ref: r.ref, name: r.name, email: r.email, status: r.status, createdAt: r.created_at.toISOString() };
}
const SELECT = "id, ref, name, email, status, created_at";
function isUniqueViolation(e) {
    return typeof e === "object" && e !== null && e.code === "23505";
}
/** Register a pseudonymous customer. Duplicate `ref` within the tenant → 409. */
export async function createCustomer(pool, tenantId, actor, input) {
    const id = randomUUID();
    return withTenant(pool, tenantId, async (q) => {
        try {
            const r = await q(`INSERT INTO customer (id, tenant_id, ref, name, email)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)
         RETURNING ${SELECT}`, [id, input.ref, input.name ?? null, input.email ?? null]);
            await writeAudit(q, { actor, action: "customer.created", target: id, after: { ref: input.ref } });
            return toCustomer(r.rows[0]);
        }
        catch (e) {
            if (isUniqueViolation(e))
                throw new IssuanceError("duplicate_ref", 409, "a customer with that ref already exists");
            throw e;
        }
    });
}
/** List customers (bounded, not paginated). */
export async function listCustomers(pool, tenantId, cap) {
    return withTenant(pool, tenantId, async (q) => {
        const r = await q(`SELECT ${SELECT} FROM customer ORDER BY created_at ASC LIMIT $1`, [cap]);
        return r.rows.map(toCustomer);
    });
}
/** Get one customer, or null. */
export async function getCustomer(pool, tenantId, id) {
    return withTenant(pool, tenantId, (q) => getCustomerTx(q, id));
}
async function getCustomerTx(q, id) {
    const r = await q(`SELECT ${SELECT} FROM customer WHERE id = $1`, [id]);
    return r.rowCount ? toCustomer(r.rows[0]) : null;
}
/**
 * GDPR erasure (FR-019). A customer holding licenses is anonymized (PII cleared, ref kept, status
 * anonymized); a license-free customer is hard-deleted. Re-erasing an anonymized customer is a no-op.
 * 404 if unknown. The audit entry records no erased PII.
 */
export async function eraseCustomer(pool, tenantId, actor, id) {
    return withTenant(pool, tenantId, async (q) => {
        const existing = await getCustomerTx(q, id);
        if (!existing)
            throw new IssuanceError("not_found", 404, "unknown customer");
        if (existing.status === "anonymized")
            return; // idempotent no-op
        const held = await q("SELECT 1 FROM license WHERE customer_id = $1 LIMIT 1", [id]);
        if (held.rowCount) {
            await q("UPDATE customer SET name = NULL, email = NULL, status = 'anonymized', updated_at = now() WHERE id = $1", [id]);
            await writeAudit(q, { actor, action: "customer.anonymized", target: id });
        }
        else {
            await q("DELETE FROM customer WHERE id = $1", [id]);
            await writeAudit(q, { actor, action: "customer.deleted", target: id });
        }
    });
}
