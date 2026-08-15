// Dual-identity append-only audit projection for reseller actions on a sub-tenant (E018, FR-009; AD-008,
// INV-8). A reseller action is recorded as ONE row in the existing append-only, tamper-evident `audit_log`
// (the app role holds only INSERT/SELECT — no UPDATE/DELETE, so no role can edit or delete an entry). The row
// is written under the SUB-TENANT (target) scope — the reseller ACTION path has already descended into the
// sub-tenant's OWN `app.current_tenant` via `withTenant` (AD-001) — so `tenant_id` is sourced from the live
// GUC and already equals the target sub-tenant. The second identity that scope cannot carry is WHO acted, so
// this projection additionally writes `actor` (the reseller-admin user) and the expand-only `actor_reseller_id`
// (the acting reseller's HOME tenant id). `actor_reseller_id` is stored independently of the mutable
// `tenant.parent_reseller_id`, so the attribution SURVIVES a later sub-tenant transfer. NULL for ordinary
// non-delegated actions. This module performs NO cryptography and holds no secret (presentation-only, Principle I).
import type pg from "pg";

import { type TxQuery, withTenant } from "../../db/client.js";

/**
 * A reseller-action audit entry. The row's `tenant_id` (the TARGET sub-tenant) comes from the live
 * `app.current_tenant` GUC set by the scoped descent — never passed here — so the dual identity is completed by
 * `actor` (the reseller-admin user) + `actorResellerId` (the acting reseller's home tenant; NULL for ordinary
 * non-delegated actions).
 */
export interface ResellerAuditEntry {
  /** The reseller-admin user principal that performed the action. */
  actor: string;
  /** The audited action verb (e.g. `sub_tenant.provision`, `branding.set`). */
  action: string;
  /** The acting reseller's HOME tenant id — the second identity; NULL/undefined for an ordinary non-delegated action. */
  actorResellerId?: string | null;
  /** The action's target object (e.g. an entity id); NULL when not applicable. */
  target?: string | null;
  /** Optional before-state snapshot (serialized to JSON). */
  before?: unknown;
  /** Optional after-state snapshot (serialized to JSON). */
  after?: unknown;
  /** True for a denied escalation / security-relevant event (HINT-002). */
  securityEvent?: boolean;
}

/**
 * The dual-identity projection of a reseller-action audit entry — the ordered positional parameters that back
 * the `audit_log` INSERT (INV-8). `tenant_id` is NOT among them: it is sourced from the live
 * `app.current_tenant` GUC (the target sub-tenant scope). Exported so the projection shape is unit-testable
 * without a live database.
 */
export interface ResellerAuditRow {
  actor: string;
  action: string;
  target: string | null;
  before: string | null;
  after: string | null;
  securityEvent: boolean;
  /** The acting reseller's home tenant id (the second identity); NULL for an ordinary non-delegated action. */
  actorResellerId: string | null;
}

/** The append-only `audit_log` INSERT — `tenant_id` sourced from the live GUC (the target sub-tenant scope). */
export const RESELLER_AUDIT_INSERT_SQL =
  `INSERT INTO audit_log (tenant_id, actor, action, target, before, after, security_event, actor_reseller_id)
     VALUES (current_setting('app.current_tenant')::uuid, $1, $2, $3, $4, $5, $6, $7)`;

/**
 * Project a reseller-action audit entry to its append-only `audit_log` row shape (INV-8). Pure; no I/O.
 * `before`/`after` are JSON-serialized (undefined → NULL); `actorResellerId` defaults to NULL (an ordinary
 * non-delegated action); `securityEvent` defaults to false.
 */
export function projectResellerAuditRow(entry: ResellerAuditEntry): ResellerAuditRow {
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
export async function writeResellerAudit(q: TxQuery, entry: ResellerAuditEntry): Promise<void> {
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
 * A DENIED-ESCALATION security event (FR-005/009, HINT-002, SC-007) — an upward/lateral/IDOR attempt refused at
 * the data-access layer. It is recorded as an append-only, DUAL-IDENTITY `audit_log` row under the ACTING
 * principal's OWN tenant scope: the out-of-subtree target is NOT owned, so there is no legitimate target scope to
 * descend into, and the denied probe belongs in the acting reseller's own tamper-evident trail. `security_event`
 * is forced true; `actorResellerId` carries the second identity (the acting reseller's home tenant, NULL when the
 * actor is not a reseller — e.g. a non-reseller session denied on the reseller plane).
 */
export interface ResellerSecurityEvent {
  /** The tenant scope the event is recorded under — the acting principal's OWN tenant (never the target's). */
  scopeTenantId: string;
  /** The acting principal (reseller-admin / sub-tenant admin) user id — the audit `actor`. */
  actor: string;
  /** The acting reseller's HOME tenant id (the second identity); NULL/undefined when the actor is not a reseller. */
  actorResellerId?: string | null;
  /** The denied-escalation action verb (e.g. `reseller.subtree.denied`, `operator.plane.denied`). */
  action: string;
  /** A NON-secret descriptor of the attempt (a request line); never discloses cross-tenant existence to the target. */
  target?: string | null;
}

/**
 * Append a DUAL-IDENTITY security-event row for a denied escalation (FR-005/009, SC-005/007). Opens the acting
 * principal's OWN tenant scope via `withTenant` — so `tenant_id` comes from that GUC and the row is RLS-consistent
 * and tamper-evident in the acting reseller's own trail — then writes `security_event=true` with
 * `actor_reseller_id` = the acting reseller (the second identity). The append-only grant (SELECT,INSERT only on
 * `audit_log`) means no role can later edit or delete the entry. Performs NO cryptography (Principle I).
 */
export async function recordResellerSecurityEvent(pool: pg.Pool, ev: ResellerSecurityEvent): Promise<void> {
  await withTenant(pool, ev.scopeTenantId, (q) =>
    writeResellerAudit(q, {
      actor: ev.actor,
      action: ev.action,
      actorResellerId: ev.actorResellerId ?? null,
      target: ev.target ?? null,
      securityEvent: true,
    }),
  );
}
