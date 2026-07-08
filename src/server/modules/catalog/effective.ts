// Effective plan definition (FR-014/016, AD-006/AD-010) — the read model E008 license issuance consumes
// and snapshots at issue time. It resolves a plan to its product key, seat limit, and the literal values
// of its ACTIVE entitlement attachments (archived entitlements are excluded). An archived plan still
// resolves (a read), so already-issued licenses stay interpretable. Static values only — no dynamic
// policy logic (that is E017).
import type pg from "pg";

import { withTenant } from "../../db/client.js";
import type { EntitlementType } from "./validation.js";

export interface EffectiveEntitlement {
  key: string;
  type: EntitlementType;
  value: boolean | number;
}

export interface EffectivePlanDefinition {
  planKey: string;
  productKey: string;
  maxActivations: number;
  entitlements: EffectiveEntitlement[];
}

/** Resolve a plan's effective definition for issuance, or null if the plan is unknown. */
export async function getEffectivePlanDefinition(
  pool: pg.Pool,
  tenantId: string,
  planId: string,
): Promise<EffectivePlanDefinition | null> {
  return withTenant(pool, tenantId, async (q) => {
    const planRow = await q(
      `SELECT p.key AS plan_key, p.max_activations, pr.key AS product_key
         FROM plan p
         JOIN product pr ON pr.tenant_id = p.tenant_id AND pr.id = p.product_id
        WHERE p.id = $1`,
      [planId],
    );
    if (!planRow.rowCount) return null;
    const head = planRow.rows[0] as { plan_key: string; max_activations: number; product_key: string };

    const entRows = await q(
      `SELECT e.key, e.type, pe.bool_value, pe.int_value
         FROM plan_entitlement pe
         JOIN entitlement e ON e.tenant_id = pe.tenant_id AND e.id = pe.entitlement_id
        WHERE pe.plan_id = $1 AND e.status = 'active'
        ORDER BY e.key ASC`,
      [planId],
    );
    const entitlements: EffectiveEntitlement[] = (
      entRows.rows as { key: string; type: EntitlementType; bool_value: boolean | null; int_value: number | null }[]
    ).map((r) => ({
      key: r.key,
      type: r.type,
      value: r.type === "boolean" ? Boolean(r.bool_value) : Number(r.int_value),
    }));

    return { planKey: head.plan_key, productKey: head.product_key, maxActivations: head.max_activations, entitlements };
  });
}
