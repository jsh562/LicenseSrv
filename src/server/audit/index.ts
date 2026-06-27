import type { TxQuery } from "../db/client.js";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  securityEvent?: boolean;
}

/**
 * Append a record to the append-only audit log within the current tenant transaction
 * (TR-008). `tenant_id` is taken from the transaction-local GUC, so the audit write is
 * atomic with the mutation and scoped to the same tenant. The audit table grants the app
 * role only INSERT/SELECT, so it can never be updated or deleted.
 */
export async function writeAudit(q: TxQuery, entry: AuditEntry): Promise<void> {
  await q(
    `INSERT INTO audit_log (tenant_id, actor, action, target, before, after, security_event)
     VALUES (current_setting('app.current_tenant')::uuid, $1, $2, $3, $4, $5, $6)`,
    [
      entry.actor,
      entry.action,
      entry.target ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.securityEvent ?? false,
    ],
  );
}

/** Record a cross-tenant / authorization denial as an auditable security event (TR-011). */
export async function recordSecurityEvent(
  q: TxQuery,
  entry: Omit<AuditEntry, "securityEvent">,
): Promise<void> {
  await writeAudit(q, { ...entry, securityEvent: true });
}
