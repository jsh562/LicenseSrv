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
  // ids + status are consumed by E008 issuance (token claims, signer key lookup, archived-plan guard);
  // the *Key fields are the human keys returned to catalog callers.
  planId: string;
  productId: string;
  planStatus: "active" | "archived";
  planKey: string;
  productKey: string;
  maxActivations: number;
  entitlements: EffectiveEntitlement[];
  // Keys of entitlements ATTACHED to the plan whose definition is archived — excluded from `entitlements`
  // (active-only) but surfaced so issuance can refuse (FR-005 archived_entitlement); empty for catalog reads.
  archivedEntitlementKeys: string[];
}

/** Resolve a plan's effective definition for issuance, or null if the plan is unknown. */
export async function getEffectivePlanDefinition(
  pool: pg.Pool,
  tenantId: string,
  planId: string,
): Promise<EffectivePlanDefinition | null> {
  return withTenant(pool, tenantId, async (q) => {
    const planRow = await q(
      `SELECT p.id AS plan_id, p.product_id, p.status AS plan_status, p.key AS plan_key,
              p.max_activations, pr.key AS product_key
         FROM plan p
         JOIN product pr ON pr.tenant_id = p.tenant_id AND pr.id = p.product_id
        WHERE p.id = $1`,
      [planId],
    );
    if (!planRow.rowCount) return null;
    const head = planRow.rows[0] as {
      plan_id: string;
      product_id: string;
      plan_status: "active" | "archived";
      plan_key: string;
      max_activations: number;
      product_key: string;
    };

    const entRows = await q(
      `SELECT e.key, e.type, e.status, pe.bool_value, pe.int_value
         FROM plan_entitlement pe
         JOIN entitlement e ON e.tenant_id = pe.tenant_id AND e.id = pe.entitlement_id
        WHERE pe.plan_id = $1
        ORDER BY e.key ASC`,
      [planId],
    );
    const rows = entRows.rows as {
      key: string;
      type: EntitlementType;
      status: "active" | "archived";
      bool_value: boolean | null;
      int_value: number | null;
    }[];
    // The effective values expose ACTIVE attachments only; archived attachments are excluded here but
    // reported by key so issuance can fail-closed (FR-005). Catalog reads simply ignore that field.
    const entitlements: EffectiveEntitlement[] = rows
      .filter((r) => r.status === "active")
      .map((r) => ({
        key: r.key,
        type: r.type,
        value: r.type === "boolean" ? Boolean(r.bool_value) : Number(r.int_value),
      }));
    const archivedEntitlementKeys = rows.filter((r) => r.status === "archived").map((r) => r.key);

    return {
      planId: head.plan_id,
      productId: head.product_id,
      planStatus: head.plan_status,
      planKey: head.plan_key,
      productKey: head.product_key,
      maxActivations: head.max_activations,
      entitlements,
      archivedEntitlementKeys,
    };
  });
}
