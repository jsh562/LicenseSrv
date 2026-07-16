// Activation registry reads (FR-012). Lists a license's activations for the operator console with only
// pseudonymous, non-secret fields — the machine-bound credential and the raw signal hashes are NEVER
// returned here (SC-011). Bounded to the most-recent `cap` rows; the seat summary reflects the TRUE active
// count, not the (possibly truncated) listed rows. Tenant-scoped via RLS.
import type pg from "pg";

import { withTenant, type TxQuery } from "../../db/client.js";
import { ActivationError } from "./index.js";

export interface ActivationSummary {
  id: string;
  machineId: string;
  status: "active" | "deactivated";
  activatedAt: string;
  deactivatedAt: string | null;
  label: string | null;
}

export interface ActivationRegistry {
  activations: ActivationSummary[];
  seatsUsed: number;
  seatLimit: number;
}

interface Row {
  id: string;
  machine_id: string;
  status: "active" | "deactivated";
  activated_at: Date;
  deactivated_at: Date | null;
  label: string | null;
}

async function countActive(q: TxQuery, licenseId: string): Promise<number> {
  const r = await q("SELECT count(*)::int AS n FROM activation WHERE license_id = $1 AND status = 'active'", [licenseId]);
  return (r.rows[0] as { n: number }).n;
}

/**
 * List a license's activations (most-recent first, bounded to `cap`) with the seats-used-vs-limit summary.
 * 404 not_found when the license is unknown within the tenant.
 */
export async function listActivations(
  pool: pg.Pool,
  tenantId: string,
  licenseId: string,
  cap: number,
): Promise<ActivationRegistry> {
  return withTenant(pool, tenantId, async (q): Promise<ActivationRegistry> => {
    const lic = await q("SELECT max_activations FROM license WHERE id = $1", [licenseId]);
    if (!lic.rowCount) throw new ActivationError("not_found", 404, "unknown license");
    const seatLimit = (lic.rows[0] as { max_activations: number }).max_activations;

    const rows = await q(
      `SELECT id, machine_id, status, activated_at, deactivated_at, label
         FROM activation WHERE license_id = $1 ORDER BY activated_at DESC LIMIT $2`,
      [licenseId, cap],
    );
    const activations: ActivationSummary[] = (rows.rows as Row[]).map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      status: r.status,
      activatedAt: r.activated_at.toISOString(),
      deactivatedAt: r.deactivated_at ? r.deactivated_at.toISOString() : null,
      label: r.label,
    }));
    return { activations, seatsUsed: await countActive(q, licenseId), seatLimit };
  });
}
