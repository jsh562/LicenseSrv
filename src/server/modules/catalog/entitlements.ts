// Entitlement repository (FR-005/006/012/013). Defines the gated features plans grant. The key is the
// canonical feature key embedded in E001 signed tokens — immutable after creation (FR-018). The type is
// fixed once any plan references the entitlement (FR-006): a type change on a referenced entitlement is
// refused (409 entitlement_type_locked), so a license in the field never loses its gate.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import {
  asDuplicateKey,
  assertMeteredShape,
  CatalogError,
  type EntitlementKind,
  type MeteredAggregation,
  type MeteredDefinition,
} from "./validation.js";

export interface Entitlement {
  id: string;
  key: string;
  name: string;
  type: EntitlementKind;
  description: string | null;
  status: "active" | "archived";
  /** The metered aggregation type (E016 FR-008); null for boolean/integer_limit kinds. */
  aggregation: MeteredAggregation | null;
  /** The metered unit label; null for non-metered. */
  unit: string | null;
  /** The optional metered allowance/quota (signal-only, FR-014); null = no quota / non-metered. */
  allowance: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  key: string;
  name: string;
  type: EntitlementKind;
  description: string | null;
  status: "active" | "archived";
  aggregation: MeteredAggregation | null;
  unit: string | null;
  allowance: string | null; // numeric over the wire
  created_at: Date;
  updated_at: Date;
}

function toEntitlement(r: Row): Entitlement {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    type: r.type,
    description: r.description,
    status: r.status,
    aggregation: r.aggregation,
    unit: r.unit,
    allowance: r.allowance === null ? null : Number(r.allowance),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT = "id, key, name, type, description, status, aggregation, unit, allowance, created_at, updated_at";

/** The optional metered authoring fields (present only for a `metered` kind). */
interface MeteredInput {
  aggregation?: unknown;
  unit?: unknown;
  allowance?: unknown;
}

/** True if any plan_entitlement references this entitlement (→ key/type are locked). */
export async function isReferenced(q: TxQuery, entitlementId: string): Promise<boolean> {
  const r = await q("SELECT 1 FROM plan_entitlement WHERE entitlement_id = $1 LIMIT 1", [entitlementId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * True if ANY usage_event has been accrued for this metered entitlement (E016 FR-009). Once true, the
 * entitlement's aggregation type + unit are FROZEN to preserve the meaning of historical aggregates — a
 * subsequent aggregation/unit/type edit is refused `aggregation_frozen`. A DB CHECK cannot join `usage_event`,
 * so the freeze is enforced here (mirrors the `entitlement_type_locked` service-layer guard, data-model INV-8).
 */
export async function hasUsage(q: TxQuery, entitlementId: string): Promise<boolean> {
  const r = await q("SELECT 1 FROM usage_event WHERE entitlement_id = $1 LIMIT 1", [entitlementId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Create an entitlement of the given kind. Duplicate key within the tenant → 409. For a `metered` kind, the
 * aggregation/unit/allowance are validated (counter-only; unit required; allowance optional) via
 * `assertMeteredShape` and persisted into the metered-only columns; a boolean/integer_limit kind leaves those
 * columns NULL (the DB `entitlement_metered_shape` CHECK enforces the IFF-metered invariant, FR-008).
 */
export async function createEntitlement(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  input: { key: string; name: string; type: EntitlementKind; description?: string | null } & MeteredInput,
): Promise<Entitlement> {
  const id = randomUUID();
  const metered = input.type === "metered" ? assertMeteredShape(input) : null;
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    try {
      const r = await q(
        `INSERT INTO entitlement (id, tenant_id, key, name, type, description, aggregation, unit, allowance)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${SELECT}`,
        [
          id,
          input.key,
          input.name,
          input.type,
          input.description ?? null,
          metered?.aggregation ?? null,
          metered?.unit ?? null,
          metered?.allowance ?? null,
        ],
      );
      const row = r.rows[0] as Row;
      await writeAudit(q, {
        actor,
        action: "catalog.entitlement.created",
        target: id,
        after: metered
          ? { key: input.key, type: input.type, aggregation: metered.aggregation, unit: metered.unit }
          : { key: input.key, type: input.type },
      });
      return toEntitlement(row);
    } catch (e) {
      asDuplicateKey(e, "an entitlement with that key already exists");
    }
  });
}

/** List entitlements; `status` filters active/archived/all (default active-only). Bounded by `cap`. */
export async function listEntitlements(
  pool: pg.Pool,
  tenantId: string,
  opts: { status?: "active" | "archived" | "all"; cap: number },
): Promise<Entitlement[]> {
  return withTenant(pool, tenantId, async (q) => {
    const effective = opts.status ?? "active"; // default list is active-only; only `all` returns both
    const where = effective !== "all" ? "WHERE status = $1" : "";
    const params = effective !== "all" ? [effective, opts.cap] : [opts.cap];
    const r = await q(`SELECT ${SELECT} FROM entitlement ${where} ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return (r.rows as Row[]).map(toEntitlement);
  });
}

/** Get one entitlement, or null. */
export async function getEntitlement(pool: pg.Pool, tenantId: string, id: string): Promise<Entitlement | null> {
  return withTenant(pool, tenantId, (q) => getEntitlementTx(q, id));
}

async function getEntitlementTx(q: TxQuery, id: string): Promise<Entitlement | null> {
  const r = await q(`SELECT ${SELECT} FROM entitlement WHERE id = $1`, [id]);
  return r.rowCount ? toEntitlement(r.rows[0] as Row) : null;
}

/**
 * Edit an entitlement's name/description, its type, and (for a metered kind) its aggregation/unit/allowance.
 * Key is immutable (FR-018). A type change is only allowed while the entitlement is unreferenced (FR-006) —
 * otherwise 409 `entitlement_type_locked`. FREEZE-ON-USAGE (FR-009/SC-006): once ANY usage_event exists for a
 * metered entitlement, its aggregation, unit, and (metered→other) type are FROZEN — such an edit is refused
 * 409 `aggregation_frozen` to preserve the meaning of historical aggregates; the allowance (a signal-only
 * quota, FR-014) stays editable. Metered columns are re-validated via `assertMeteredShape` so an edit can
 * never leave a metered row structurally invalid. 404 if unknown.
 */
export async function updateEntitlement(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    type?: EntitlementKind;
    aggregation?: MeteredAggregation;
    unit?: string;
    allowance?: number | null;
  },
): Promise<Entitlement> {
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    const existing = await getEntitlementTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown entitlement");

    const finalType: EntitlementKind = input.type ?? existing.type;

    // FREEZE-ON-USAGE (FR-009): a metered entitlement with any accrued usage cannot change its aggregation,
    // unit, or kind — refuse `aggregation_frozen` (the allowance stays mutable, signal-only FR-014).
    if (existing.type === "metered") {
      const aggChanged = input.aggregation !== undefined && input.aggregation !== existing.aggregation;
      const unitChanged = input.unit !== undefined && input.unit !== existing.unit;
      const typeChanged = input.type !== undefined && input.type !== existing.type;
      if ((aggChanged || unitChanged || typeChanged) && (await hasUsage(q, id))) {
        throw new CatalogError(
          "aggregation_frozen",
          409,
          "a metered entitlement's aggregation and unit are frozen once usage exists",
        );
      }
    }

    if (input.type !== undefined && input.type !== existing.type) {
      // Lock the referencing set to serialize against a concurrent value attach (FR-006).
      const ref = await q("SELECT 1 FROM plan_entitlement WHERE entitlement_id = $1 LIMIT 1 FOR UPDATE", [id]);
      if (ref.rowCount) {
        throw new CatalogError("entitlement_type_locked", 409, "cannot change the type of a referenced entitlement");
      }
    }

    // Re-derive the metered-only columns for the FINAL kind (merging the edit over the existing values); a
    // non-metered final kind clears them all (the DB shape CHECK requires metered cols set IFF type='metered').
    let metered: MeteredDefinition | null = null;
    if (finalType === "metered") {
      metered = assertMeteredShape({
        aggregation: input.aggregation !== undefined ? input.aggregation : existing.aggregation,
        unit: input.unit !== undefined ? input.unit : existing.unit,
        allowance: input.allowance !== undefined ? input.allowance : existing.allowance,
      });
    }

    const r = await q(
      `UPDATE entitlement
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              type = $5,
              aggregation = $6,
              unit = $7,
              allowance = $8,
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT}`,
      [
        id,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        finalType,
        metered?.aggregation ?? null,
        metered?.unit ?? null,
        metered?.allowance ?? null,
      ],
    );
    await writeAudit(q, { actor, action: "catalog.entitlement.updated", target: id, before: existing, after: input });
    return toEntitlement(r.rows[0] as Row);
  });
}

/** Archive an entitlement (soft-retire). 404 if unknown. */
export async function archiveEntitlement(pool: pg.Pool, tenantId: string, actor: string, id: string): Promise<Entitlement> {
  return withTenant(pool, tenantId, async (q): Promise<Entitlement> => {
    const existing = await getEntitlementTx(q, id);
    if (!existing) throw new CatalogError("not_found", 404, "unknown entitlement");
    const r = await q(`UPDATE entitlement SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING ${SELECT}`, [id]);
    await writeAudit(q, { actor, action: "catalog.entitlement.archived", target: id });
    return toEntitlement(r.rows[0] as Row);
  });
}
