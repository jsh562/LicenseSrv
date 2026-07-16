// Deactivation service (FR-010/011/014). A soft status flip active→deactivated that frees the seat while
// retaining the row for registry history + audit. Idempotent: deactivating an already-deactivated
// activation succeeds without changing the seat count; an unknown activation id → 404 not_found. Used by
// both the app self-service DELETE and the operator/admin reclaim route.
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { ActivationError } from "./index.js";

export interface DeactivateResult {
  id: string;
  status: "deactivated";
}

/**
 * Deactivate one machine's activation, freeing its seat. Idempotent — re-deactivating an
 * already-deactivated activation is a no-op that still returns `deactivated`; the active-seat count never
 * goes negative. 404 not_found when the id is unknown within the tenant (RLS-scoped).
 */
export async function deactivate(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  activationId: string,
): Promise<DeactivateResult> {
  return withTenant(pool, tenantId, async (q): Promise<DeactivateResult> => {
    const cur = await q("SELECT status FROM activation WHERE id = $1", [activationId]);
    if (!cur.rowCount) throw new ActivationError("not_found", 404, "unknown activation");
    const { status } = cur.rows[0] as { status: string };
    if (status === "active") {
      await q(
        "UPDATE activation SET status = 'deactivated', deactivated_at = now(), updated_at = now() WHERE id = $1",
        [activationId],
      );
      await writeAudit(q, { actor, action: "activation.deactivated", target: activationId });
    }
    return { id: activationId, status: "deactivated" };
  });
}
