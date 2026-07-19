// CRL fetch handler (FR-010; US4). Serves the signed, versioned CRL for a (tenant, product): the LATEST
// published version by default (or a specific one), JSON by default and the SAME canonical signed bytes as
// an octet-stream download under `?format=file` (air-gap import). Caching aligns to `next_update`: `ETag`
// carries the version, `Cache-Control`/`Expires` bound the validity horizon, and a matching `If-None-Match`
// short-circuits to `304`. Tenant-scoped under `withTenant` (RLS): an unknown/cross-tenant product or an
// absent version yields no row → `404 revocation_list_not_found` (the client fails OPEN, FR-011).
import type pg from "pg";

import { withTenant } from "../../db/client.js";
import { getLatestCrl, serializeCrlArtifact } from "./crl.js";
import { EnforcementError } from "./index.js";

/** The representation of the served CRL: JSON (default) or the byte-identical air-gap file. */
export type CrlFormat = "json" | "file";

export interface GetRevocationListOptions {
  /** A specific version to fetch; omit for the latest (`max(version)`). */
  version?: number;
  /** `json` (default, `application/json`) or `file` (`application/octet-stream`, air-gap download). */
  format?: CrlFormat;
  /** The caller's `If-None-Match` header, if any — a match on the current ETag returns `304`. */
  ifNoneMatch?: string | null;
}

/**
 * The everything-the-route-needs result of a CRL fetch. `status` is `200` (serve `body`) or `304` (the
 * caller's cached copy is current; `body` is `null`). The caching headers are ALWAYS present so a `304`
 * still refreshes them. `contentType` reflects the requested `format`; for a `304` it is advisory only.
 */
export interface RevocationListResponse {
  status: 200 | 304;
  /** The canonical serialized artifact bytes (identical for json + file); `null` on `304`. */
  body: string | null;
  /** The CRL version (drives the `ETag` and the file-download name). */
  version: number;
  /** Strong validator carrying the version, e.g. `"v42"`. */
  etag: string;
  /** `public, max-age=<seconds-until-next_update>` (clamped to ≥ 0). */
  cacheControl: string;
  /** Absolute cache expiry (HTTP-date) equal to the CRL's `next_update`. */
  expires: string;
  /** `application/json` (json) or `application/octet-stream` (file). */
  contentType: string;
}

const contentTypeFor = (format: CrlFormat | undefined): string =>
  format === "file" ? "application/octet-stream" : "application/json";

/**
 * True when the client's `If-None-Match` matches the current strong `etag` (or is `*`). Tolerates a
 * comma-separated list and the weak-validator (`W/`) prefix, per RFC 9110 conditional-request semantics.
 */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const value = ifNoneMatch.trim();
  if (value === "*") return true;
  return value
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === etag || t === `W/${etag}`);
}

/**
 * Fetch the signed CRL for `(tenantId, productId)` with caching + conditional-GET support (FR-010). Reads
 * the latest (or specified) version under RLS; a miss throws `EnforcementError('revocation_list_not_found',
 * 404)` (the route maps it to `404`; the client fails OPEN). Otherwise computes `ETag`/`Cache-Control`/
 * `Expires` from `next_update` and — on a matching `If-None-Match` — returns `304` with no body. The `body`
 * (json + file) is the SAME canonical serialization, so the detached signature verifies identically either way.
 */
export async function getRevocationList(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  opts: GetRevocationListOptions = {},
): Promise<RevocationListResponse> {
  const record = await withTenant(pool, tenantId, (q) => getLatestCrl(q, tenantId, productId, opts.version));
  if (!record) {
    throw new EnforcementError("revocation_list_not_found", 404, "no revocation list published for this product", { productId });
  }

  const etag = `"v${record.version}"`;
  const nextUpdateMs = Date.parse(record.nextUpdate);
  const maxAge = Math.max(0, Math.floor((nextUpdateMs - Date.now()) / 1000));
  const cacheControl = `public, max-age=${maxAge}`;
  const expires = new Date(nextUpdateMs).toUTCString();
  const contentType = contentTypeFor(opts.format);

  if (opts.ifNoneMatch && etagMatches(opts.ifNoneMatch, etag)) {
    return { status: 304, body: null, version: record.version, etag, cacheControl, expires, contentType };
  }

  return {
    status: 200,
    body: serializeCrlArtifact(record),
    version: record.version,
    etag,
    cacheControl,
    expires,
    contentType,
  };
}
