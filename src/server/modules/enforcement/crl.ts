// Signed revocation list (CRL) generation + read (FR-009/022; US4; AD-003/004). The revoked-id SET is
// NOT materialized: it is PROJECTED on demand from `license.status='revoked'` (+ deactivated activations
// per policy) for a (tenant, product) at generation time. Only the SIGNED, byte-stable, VERSIONED artifact
// is stored in `revocation_list`, because a signature is over exact bytes, the `version` must advance
// monotonically (FR-022 anti-downgrade), and the artifact must be re-servable byte-for-byte for CDN caching
// and air-gap file export (FR-010). The signature is a DETACHED Ed25519 signature made through the E004
// signer (Principle I / TR-001 — enforcement never touches the keystore directly), domain-separated
// (`LICSRV-CRL-v1`) from LIC1 tokens. Every read is tenant-scoped under the caller's `withTenant` tx (RLS).
import { randomUUID } from "node:crypto";

import type { TxQuery } from "../../db/client.js";
import { CRL_SIGNING_DOMAIN } from "../signing/signer.js";
import type { Signer } from "../signing/signer.js";
import type { PlanWindows } from "./config.js";

/** The point-in-time snapshot of revoked ids a CRL covers (data-model `revocation_list.revoked_ids`). */
export interface RevokedIds {
  /** Revoked license ids (from `license.status='revoked'`) for the (tenant, product). */
  licenses: string[];
  /** Deactivated/revoked activation ids published for the (tenant, product), where policy includes them. */
  activations: string[];
}

/**
 * The SIGNED subset of the CRL — the detached Ed25519 signature covers EXACTLY the canonical encoding of
 * this document (contract `RevocationList`: `{ version, generatedAt, nextUpdate, revokedIds }`). `productId`
 * is bound implicitly because the CRL is signed by the product's per-product E004 key; `keyId`/`signature`
 * are added around this document, never inside the signed bytes.
 */
export interface CrlDocument {
  version: number;
  generatedAt: string; // ISO-8601
  nextUpdate: string; // ISO-8601
  revokedIds: RevokedIds;
}

/** The stored + served CRL artifact: the signed document plus the product, the signing `keyId`, and the sig. */
export interface RevocationListRecord {
  id: string;
  productId: string;
  version: number;
  generatedAt: string; // ISO-8601
  nextUpdate: string; // ISO-8601
  keyId: string;
  /** Detached Ed25519 signature (base64url) over the canonical CRL document. A PUBLIC artifact, never a key. */
  signature: string;
  revokedIds: RevokedIds;
}

const iso = (unix: number): string => new Date(unix * 1000).toISOString();

/**
 * Deterministically serialize `value` to canonical JSON: object keys are emitted in sorted order and there
 * is NO insignificant whitespace, so the same logical value always yields byte-identical output. Arrays
 * keep their order (the CRL id arrays are sorted by the builder before serialization). This is what makes
 * the CRL signature byte-stable (FR-022) and the JSON + file representations byte-identical (FR-010).
 */
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** Return a copy of `ids` with both id arrays sorted — the stable ordering the canonical encoding depends on. */
function sortRevokedIds(ids: RevokedIds): RevokedIds {
  return { licenses: [...ids.licenses].sort(), activations: [...ids.activations].sort() };
}

/**
 * Build the CANONICAL, byte-stable bytes the CRL signature covers (FR-022). Deterministic: id arrays are
 * sorted and object keys are emitted in a fixed sorted order, so re-encoding the SAME document — whether at
 * generation, at read-back, or on a client — reproduces the exact bytes and the detached signature verifies
 * identically. The signer prepends the `LICSRV-CRL-v1` domain tag before signing (see `signer.ts`).
 */
export function buildCanonicalCrlBytes(doc: CrlDocument): Buffer {
  const normalized: CrlDocument = {
    version: doc.version,
    generatedAt: doc.generatedAt,
    nextUpdate: doc.nextUpdate,
    revokedIds: sortRevokedIds(doc.revokedIds),
  };
  return Buffer.from(canonicalize(normalized), "utf8");
}

/**
 * Serialize the full stored CRL artifact to canonical bytes for serving (FR-010). The JSON and the
 * `?format=file` representations both send EXACTLY these bytes (only the `Content-Type` differs), so the
 * detached `signature` field verifies identically no matter which form a client fetched.
 */
export function serializeCrlArtifact(record: RevocationListRecord): string {
  return canonicalize({
    version: record.version,
    productId: record.productId,
    generatedAt: record.generatedAt,
    nextUpdate: record.nextUpdate,
    keyId: record.keyId,
    signature: record.signature,
    revokedIds: sortRevokedIds(record.revokedIds),
  });
}

/**
 * A client-side ANTI-DOWNGRADE check (FR-022): accept a fetched CRL `version` ONLY if it is strictly newer
 * than the one currently trusted. `currentVersion === null` means the client holds none yet (accept any). A
 * signed-but-OLDER version is silently ignored — an attacker cannot roll a client back to a stale CRL that
 * omits a since-revoked id. Distinct from a signature-invalid CRL (untrusted, FR-023) and an unreachable
 * CRL (fail-open, FR-011).
 */
export function isFresherCrlVersion(currentVersion: number | null, candidateVersion: number): boolean {
  return currentVersion === null || candidateVersion > currentVersion;
}

interface CrlRow {
  id: string;
  product_id: string;
  version: string; // bigint → string over the wire
  generated_at: Date;
  next_update: Date;
  key_id: string;
  signature: string;
  revoked_ids: Partial<RevokedIds> | null;
}

const CRL_COLUMNS = "id, product_id, version, generated_at, next_update, key_id, signature, revoked_ids";

function mapCrlRow(row: unknown): RevocationListRecord {
  const r = row as CrlRow;
  return {
    id: r.id,
    productId: r.product_id,
    version: Number(r.version),
    generatedAt: r.generated_at.toISOString(),
    nextUpdate: r.next_update.toISOString(),
    keyId: r.key_id,
    signature: r.signature,
    revokedIds: {
      licenses: r.revoked_ids?.licenses ?? [],
      activations: r.revoked_ids?.activations ?? [],
    },
  };
}

/**
 * PROJECT the revoked-id set for a (tenant, product) on demand (AD-003): revoked licenses from
 * `license.status='revoked'`, plus deactivated activations for that product (per policy). Ordered by id so
 * the projection is deterministic; the canonical builder re-sorts regardless. Tenant-scoped: `q` is a
 * `withTenant` tx, so RLS confines both reads to the caller's tenant.
 */
export async function projectRevokedIds(q: TxQuery, productId: string): Promise<RevokedIds> {
  const licRes = await q(
    `SELECT id FROM license WHERE product_id = $1 AND status = 'revoked' ORDER BY id`,
    [productId],
  );
  const actRes = await q(
    `SELECT a.id
       FROM activation a
       JOIN license l ON l.id = a.license_id
      WHERE l.product_id = $1 AND a.status = 'deactivated'
      ORDER BY a.id`,
    [productId],
  );
  return {
    licenses: (licRes.rows as { id: string }[]).map((r) => r.id),
    activations: (actRes.rows as { id: string }[]).map((r) => r.id),
  };
}

/**
 * Generate, sign, and store a new signed CRL version for a (tenant, product) (FR-009/022). Runs inside the
 * caller's `withTenant` tx (`q`): projects the revoked-id set, computes `version = max(existing)+1` per
 * (tenant, product) IN the tx (strictly monotonic — FR-022 anti-downgrade), sets `next_update = now +
 * crlNextUpdateSecs`, builds the byte-stable canonical document, and detached-signs it via the E004 signer
 * (`LICSRV-CRL-v1` domain, Principle I — no direct keystore access). `generated_at`/`next_update` are stamped
 * from the tx clock and stored EXACTLY as signed, so a read-back re-verifies byte-for-byte. Returns the
 * stored artifact. The unique `(tenant, product, version)` constraint guarantees a concurrent generation
 * cannot duplicate a version (the loser's tx aborts and is retried on the next cadence).
 */
export async function generateCrl(
  q: TxQuery,
  tenantId: string,
  productId: string,
  signer: Signer,
  windows: PlanWindows,
): Promise<RevocationListRecord> {
  // The generation instant is the tx clock (constant within the tx) — the SAME value is signed and stored.
  const nowRes = await q("SELECT extract(epoch FROM now())::double precision AS now");
  const generatedAtUnix = Math.floor((nowRes.rows[0] as { now: number }).now);
  const nextUpdateUnix = generatedAtUnix + windows.crlNextUpdateSecs;

  const revokedIds = await projectRevokedIds(q, productId);

  // version = max(existing)+1 per (tenant, product), computed IN the tx → strictly monotonic (FR-022).
  const verRes = await q(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM revocation_list WHERE product_id = $1`,
    [productId],
  );
  const version = Number((verRes.rows[0] as { next: string }).next);

  const doc: CrlDocument = {
    version,
    generatedAt: iso(generatedAtUnix),
    nextUpdate: iso(nextUpdateUnix),
    revokedIds,
  };
  const canonicalBytes = buildCanonicalCrlBytes(doc);

  // Sign via the E004 signer — domain-separated from LIC1 tokens; the private key never crosses this boundary.
  const { signature, keyId } = await signer.signDetached(tenantId, productId, CRL_SIGNING_DOMAIN, canonicalBytes);

  const id = randomUUID();
  const inserted = await q(
    `INSERT INTO revocation_list
       (id, tenant_id, product_id, version, generated_at, next_update, key_id, signature, revoked_ids)
     VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, to_timestamp($4), to_timestamp($5), $6, $7, $8)
     RETURNING ${CRL_COLUMNS}`,
    [id, productId, version, generatedAtUnix, nextUpdateUnix, keyId, signature, JSON.stringify(sortRevokedIds(revokedIds))],
  );
  return mapCrlRow(inserted.rows[0]);
}

/**
 * Read a stored CRL artifact for a (tenant, product): the LATEST published version (`max(version)`) by
 * default, or a specific `version`. Returns `null` when none exists — the caller maps that to `404`
 * (`revocation_list_not_found`) and the client fails OPEN (FR-011). Tenant-scoped via `q` (RLS), so an
 * unknown or cross-tenant product simply resolves to zero rows → `null` (FR-018, never `403`).
 */
export async function getLatestCrl(
  q: TxQuery,
  tenantId: string,
  productId: string,
  version?: number,
): Promise<RevocationListRecord | null> {
  const res =
    version != null
      ? await q(`SELECT ${CRL_COLUMNS} FROM revocation_list WHERE product_id = $1 AND version = $2`, [productId, version])
      : await q(`SELECT ${CRL_COLUMNS} FROM revocation_list WHERE product_id = $1 ORDER BY version DESC LIMIT 1`, [productId]);
  if (!res.rowCount) return null;
  return mapCrlRow(res.rows[0]);
}
