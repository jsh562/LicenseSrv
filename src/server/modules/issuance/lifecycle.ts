// License lifecycle state machine (FR-007/008/009/010/014). Each action loads the license FOR UPDATE in
// one tenant transaction, validates the transition, updates, and audits. Transitions: active↔suspended;
// active/suspended→revoked (terminal). Revoke is idempotent. Transfer reassigns the customer within the
// per-license transfer limit. Any invalid transition is refused (409 invalid_transition), license unchanged.
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { IssuanceError } from "./index.js";
import { type License, LICENSE_SELECT, mapLicenseRow } from "./licenses.js";

interface StatusRow {
  status: "active" | "suspended" | "revoked";
  transfer_count: number;
}

/** Load a license's status + transfer count under a row lock, or 404. */
async function lockLicense(q: TxQuery, id: string): Promise<StatusRow> {
  const r = await q("SELECT status, transfer_count FROM license WHERE id = $1 FOR UPDATE", [id]);
  if (!r.rowCount) throw new IssuanceError("not_found", 404, "unknown license");
  return r.rows[0] as StatusRow;
}

async function updateReturning(q: TxQuery, id: string, set: string, params: unknown[]): Promise<License> {
  const r = await q(`UPDATE license SET ${set}, updated_at = now() WHERE id = $1 RETURNING ${LICENSE_SELECT}`, [id, ...params]);
  return mapLicenseRow(r.rows[0]);
}

/** Revoke a license (terminal). Idempotent: revoking a revoked license is a no-op. */
export async function revokeLicense(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<License> {
  return withTenant(pool, tenantId, async (q): Promise<License> => {
    const cur = await lockLicense(q, id);
    if (cur.status === "revoked") {
      return mapLicenseRow((await q(`SELECT ${LICENSE_SELECT} FROM license WHERE id = $1`, [id])).rows[0]);
    }
    const license = await updateReturning(q, id, "status = 'revoked'", []);
    await writeAudit(q, { actor, action: "license.revoked", target: id });
    return license;
  });
}

/** Suspend an active license. Refused (409) if not active. */
export async function suspendLicense(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<License> {
  return withTenant(pool, tenantId, async (q): Promise<License> => {
    const cur = await lockLicense(q, id);
    if (cur.status !== "active") throw new IssuanceError("invalid_transition", 409, "only an active license can be suspended");
    const license = await updateReturning(q, id, "status = 'suspended'", []);
    await writeAudit(q, { actor, action: "license.suspended", target: id });
    return license;
  });
}

/** Reinstate a suspended license to active. Refused (409) if not suspended. */
export async function reinstateLicense(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<License> {
  return withTenant(pool, tenantId, async (q): Promise<License> => {
    const cur = await lockLicense(q, id);
    if (cur.status !== "suspended") throw new IssuanceError("invalid_transition", 409, "only a suspended license can be reinstated");
    const license = await updateReturning(q, id, "status = 'active'", []);
    await writeAudit(q, { actor, action: "license.reinstated", target: id });
    return license;
  });
}

/**
 * Transfer a license to a different customer. Refused (409 invalid_transition) if revoked; refused (409
 * transfer_limit_exceeded) at the limit; 404 if the target customer is unknown.
 */
export async function transferLicense(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  id: string,
  transferLimit: number,
  newCustomerId: string,
): Promise<License> {
  return withTenant(pool, tenantId, async (q): Promise<License> => {
    const cur = await lockLicense(q, id);
    if (cur.status === "revoked") throw new IssuanceError("invalid_transition", 409, "a revoked license cannot be transferred");
    if (cur.transfer_count >= transferLimit) {
      throw new IssuanceError("transfer_limit_exceeded", 409, `the transfer limit (${transferLimit}) has been reached`);
    }
    const target = await q("SELECT 1 FROM customer WHERE id = $1", [newCustomerId]);
    if (!target.rowCount) throw new IssuanceError("not_found", 404, "unknown target customer");

    const license = await updateReturning(q, id, "customer_id = $2, transfer_count = transfer_count + 1", [newCustomerId]);
    await writeAudit(q, { actor, action: "license.transferred", target: id, after: { customerId: newCustomerId } });
    return license;
  });
}
