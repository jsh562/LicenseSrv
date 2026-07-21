// License repository (FR-001..006/012/013/017). Issue snapshots the plan's effective definition (E007),
// builds the E001 claims, and signs via the E004 signer to mint a LIC1 token — all before the row is
// inserted, so a signer fault leaves NO license (fail-closed 503). The license is a point-in-time snapshot
// (entitlements + seat limit copied at issue); later catalog edits never change it (FR-006). The signed
// token (public) is returned only on issue + the /key read; the signing key is never exposed.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { getEffectivePlanDefinition } from "../catalog/effective.js";
import type { Signer } from "../signing/signer.js";
import { SignerError } from "../signing/signer.js";
import { buildClaims, toEntitlementMap } from "./claims.js";
import { IssuanceError } from "./index.js";

export type LicenseStatus = "active" | "suspended" | "revoked";

export interface License {
  id: string;
  productId: string;
  planId: string;
  customerId: string;
  status: LicenseStatus;
  issuedAt: string;
  expiresAt: string | null;
  maxActivations: number;
  entitlements: Record<string, boolean | number>;
  keyId: string | null;
  transferCount: number;
}

export interface IssuedLicense extends License {
  /** The signed LIC1 token — returned ONLY here (issue) and via GET .../key. Never the signing key. */
  licenseKey: string;
}

interface Row {
  id: string;
  product_id: string;
  plan_id: string;
  customer_id: string;
  status: LicenseStatus;
  issued_at: Date;
  expires_at: Date | null;
  max_activations: number;
  entitlements: Record<string, boolean | number>;
  key_id: string | null;
  transfer_count: number;
}

function toLicense(r: Row): License {
  return {
    id: r.id,
    productId: r.product_id,
    planId: r.plan_id,
    customerId: r.customer_id,
    status: r.status,
    issuedAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    maxActivations: r.max_activations,
    entitlements: r.entitlements,
    keyId: r.key_id,
    transferCount: r.transfer_count,
  };
}

export const LICENSE_SELECT =
  "id, product_id, plan_id, customer_id, status, issued_at, expires_at, max_activations, entitlements, key_id, transfer_count";
const SELECT = LICENSE_SELECT;

/** Map a raw license row (selected with LICENSE_SELECT) to the camelCase License. */
export function mapLicenseRow(row: unknown): License {
  return toLicense(row as Row);
}

/**
 * Issue a signed license under an active plan for a customer. Snapshots the effective plan definition,
 * signs the claims (503 signer_unavailable with no license on any signer fault), and stores the license.
 * 404 unknown plan/customer; 409 plan_not_issuable for an archived plan.
 *
 * TX-COMPOSABLE SEAM (E014, HINT-002): an OPTIONAL `q?: TxQuery` lets a caller run the customer check and
 * the license INSERT + audit INSIDE its own transaction — so a billing-driven provision commits the new
 * license atomically with the idempotency-claim ledger row and the subscription link (true exactly-once).
 * When `q` is omitted the behaviour is identical to before (self-managed `withTenant` transactions), so
 * every existing caller/test is unaffected. The effective-plan read and the signer call stay outside the tx
 * (a read of catalog rows the tx never mutates; the signer must not hold a DB transaction open).
 */
export async function issueLicense(
  pool: pg.Pool,
  signer: Signer | undefined,
  tenantId: string,
  actor: string,
  input: { planId: string; customerId: string; expiresAt?: string | null },
  q?: TxQuery,
): Promise<IssuedLicense> {
  const eff = await getEffectivePlanDefinition(pool, tenantId, input.planId);
  if (!eff) throw new IssuanceError("not_found", 404, "unknown plan");
  if (eff.planStatus !== "active") throw new IssuanceError("plan_not_issuable", 409, "the plan is archived and cannot be issued");
  // FR-005: refuse if the plan references an archived entitlement (would silently drop it from the snapshot).
  if (eff.archivedEntitlementKeys.length > 0) {
    throw new IssuanceError("plan_not_issuable", 409, `the plan references an archived entitlement (${eff.archivedEntitlementKeys.join(", ")})`);
  }

  const customer = q
    ? await q("SELECT status FROM customer WHERE id = $1", [input.customerId])
    : await withTenant(pool, tenantId, (qq) => qq("SELECT status FROM customer WHERE id = $1", [input.customerId]));
  if (!customer.rowCount) throw new IssuanceError("not_found", 404, "unknown customer");
  // FR-019: an erased (anonymized) customer must not receive new licenses.
  if ((customer.rows[0] as { status: string }).status !== "active") {
    throw new IssuanceError("customer_anonymized", 409, "the customer has been erased and cannot receive new licenses");
  }

  if (!signer) throw new IssuanceError("signer_unavailable", 503, "no signer is configured");

  const licenseId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtUnix = input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : null;
  const entMap = toEntitlementMap(eff.entitlements);
  const claims = buildClaims({
    licenseId,
    productId: eff.productId,
    planId: input.planId,
    customerId: input.customerId,
    issuedAt,
    expiresAt: expiresAtUnix,
    maxActivations: eff.maxActivations,
    entitlements: entMap,
  });

  let token: string;
  try {
    token = await signer.sign(tenantId, claims); // conformance-verified before return; stamps key_id
  } catch (e) {
    if (e instanceof SignerError) throw new IssuanceError("signer_unavailable", 503, `signer unavailable (${e.failure})`);
    throw e;
  }

  const doInsert = async (qq: TxQuery): Promise<License> => {
    let r;
    try {
      r = await qq(
        `INSERT INTO license
           (id, tenant_id, product_id, plan_id, customer_id, issued_at, expires_at, max_activations,
            entitlements, token_version, nonce, license_token)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10, $11)
         RETURNING ${SELECT}`,
        [
          licenseId,
          eff.productId,
          input.planId,
          input.customerId,
          issuedAt,
          expiresAtUnix ? new Date(expiresAtUnix * 1000) : null,
          eff.maxActivations,
          JSON.stringify(entMap),
          claims.tokenVersion,
          claims.nonce,
          token,
        ],
      );
    } catch (e) {
      // A plan/customer concurrently removed between the checks and this insert → a clean 404, not a 500.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23503") {
        throw new IssuanceError("not_found", 404, "the plan or customer no longer exists");
      }
      throw e;
    }
    await writeAudit(qq, { actor, action: "license.issued", target: licenseId, after: { planId: input.planId, customerId: input.customerId } });
    return toLicense(r.rows[0] as Row);
  };
  const license = q ? await doInsert(q) : await withTenant(pool, tenantId, doInsert);

  return { ...license, licenseKey: token };
}

/** List licenses (bounded), optionally filtered by status / customer / plan. */
export async function listLicenses(
  pool: pg.Pool,
  tenantId: string,
  filters: { status?: LicenseStatus; customerId?: string; planId?: string; cap: number },
): Promise<License[]> {
  return withTenant(pool, tenantId, async (q) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filters.customerId) {
      params.push(filters.customerId);
      clauses.push(`customer_id = $${params.length}`);
    }
    if (filters.planId) {
      params.push(filters.planId);
      clauses.push(`plan_id = $${params.length}`);
    }
    params.push(filters.cap);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await q(`SELECT ${SELECT} FROM license ${where} ORDER BY issued_at DESC LIMIT $${params.length}`, params);
    return (r.rows as Row[]).map(toLicense);
  });
}

/** Get one license's metadata (no token), or null. */
export async function getLicense(pool: pg.Pool, tenantId: string, id: string): Promise<License | null> {
  return withTenant(pool, tenantId, (q) => getLicenseTx(q, id));
}

async function getLicenseTx(q: TxQuery, id: string): Promise<License | null> {
  const r = await q(`SELECT ${SELECT} FROM license WHERE id = $1`, [id]);
  return r.rowCount ? toLicense(r.rows[0] as Row) : null;
}

/** Retrieve a license's signed key (the public LIC1 token), or null if unknown. */
export async function getLicenseKey(pool: pg.Pool, tenantId: string, id: string): Promise<string | null> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT license_token FROM license WHERE id = $1", [id]);
    return r.rowCount ? (r.rows[0] as { license_token: string }).license_token : null;
  });
}
