import { withTenant } from "../../db/client.js";
/** The append-only `audit_log` INSERT — `tenant_id` sourced from the live GUC (the target sub-tenant scope). */
export const RESELLER_AUDIT_INSERT_SQL = `INSERT INTO audit_log (tenant_id, actor, action, target, before, after, security_event, actor_reseller_id)
     VALUES (current_setting('app.current_tenant')::uuid, $1, $2, $3, $4, $5, $6, $7)`;
/**
 * Project a reseller-action audit entry to its append-only `audit_log` row shape (INV-8). Pure; no I/O.
 * `before`/`after` are JSON-serialized (undefined → NULL); `actorResellerId` defaults to NULL (an ordinary
 * non-delegated action); `securityEvent` defaults to false.
 */
export function projectResellerAuditRow(entry) {
    return {
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? null,
        before: entry.before === undefined ? null : JSON.stringify(entry.before),
        after: entry.after === undefined ? null : JSON.stringify(entry.after),
        securityEvent: entry.securityEvent ?? false,
        actorResellerId: entry.actorResellerId ?? null,
    };
}
/**
 * Append a DUAL-IDENTITY reseller-action row to the append-only `audit_log` within the current sub-tenant
 * transaction (FR-009, AD-008, INV-8). `tenant_id` is taken from the transaction-local `app.current_tenant`
 * GUC (the TARGET sub-tenant scope the scoped descent set), so the audit write is atomic with the mutation and
 * scoped to the same sub-tenant. `actor` is the reseller-admin user and `actor_reseller_id` is the acting
 * reseller's home tenant (NULL for an ordinary non-delegated action) — the two identities the target scope
 * cannot itself carry. The table grants the app role only INSERT/SELECT, so the entry can never be updated or
 * deleted (tamper-evident).
 */
export async function writeResellerAudit(q, entry) {
    const row = projectResellerAuditRow(entry);
    await q(RESELLER_AUDIT_INSERT_SQL, [
        row.actor,
        row.action,
        row.target,
        row.before,
        row.after,
        row.securityEvent,
        row.actorResellerId,
    ]);
}
/**
 * Append a DUAL-IDENTITY security-event row for a denied escalation (FR-005/009, SC-005/007). Opens the acting
 * principal's OWN tenant scope via `withTenant` — so `tenant_id` comes from that GUC and the row is RLS-consistent
 * and tamper-evident in the acting reseller's own trail — then writes `security_event=true` with
 * `actor_reseller_id` = the acting reseller (the second identity). The append-only grant (SELECT,INSERT only on
 * `audit_log`) means no role can later edit or delete the entry. Performs NO cryptography (Principle I).
 */
export async function recordResellerSecurityEvent(pool, ev) {
    await withTenant(pool, ev.scopeTenantId, (q) => writeResellerAudit(q, {
        actor: ev.actor,
        action: ev.action,
        actorResellerId: ev.actorResellerId ?? null,
        target: ev.target ?? null,
        securityEvent: true,
    }));
}
