import type pg from "pg";

import { writeAudit } from "../audit/index.js";
import { privileged, withTenant } from "./client.js";

export interface TenantExport {
  users: unknown[];
  apiKeys: unknown[];
  auditCount: number;
}

/** Export a tenant's data on request (TR-012, GDPR). Tenant-scoped via RLS. */
export async function exportTenant(pool: pg.Pool, tenantId: string): Promise<TenantExport> {
  return withTenant(pool, tenantId, async (q) => {
    const users = (await q("SELECT id, email_hash, created_at FROM app_user", [])).rows;
    const apiKeys = (await q("SELECT id, scopes, status, created_at FROM api_key", [])).rows;
    const auditCount = (
      (await q("SELECT count(*)::int AS n FROM audit_log", [])).rows[0] as { n: number }
    ).n;
    return { users, apiKeys, auditCount };
  });
}

/**
 * Erase a tenant's personal data (TR-012, GDPR). Deletes the live PII-bearing tables
 * (roles, api keys, users) in FK-safe order while preserving the immutable audit event
 * records, and records the erasure itself as an audit event.
 */
export async function eraseTenantPersonalData(pool: pg.Pool, tenantId: string): Promise<void> {
  await withTenant(pool, tenantId, async (q) => {
    await q("DELETE FROM role", []);
    await q("DELETE FROM api_key", []);
    await q("DELETE FROM app_user", []);
    await writeAudit(q, { actor: "platform-admin", action: "tenant.personal_data_erased" });
  });

  // Audit rows are append-only for the app role, so payload redaction + the tenant tombstone
  // are explicit, privileged (owner) operations: the audit *event* records (actor/action/ts)
  // are preserved, while any PII-bearing before/after/target payloads are redacted.
  await privileged(pool, async (q) => {
    await q("UPDATE audit_log SET before = NULL, after = NULL, target = NULL WHERE tenant_id = $1", [
      tenantId,
    ]);
    await q("UPDATE tenant SET deleted_at = now() WHERE id = $1", [tenantId]);
  });
}
