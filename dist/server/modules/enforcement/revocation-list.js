import { withTenant } from "../../db/client.js";
import { getLatestCrl, serializeCrlArtifact } from "./crl.js";
import { EnforcementError } from "./index.js";
const contentTypeFor = (format) => format === "file" ? "application/octet-stream" : "application/json";
/**
 * True when the client's `If-None-Match` matches the current strong `etag` (or is `*`). Tolerates a
 * comma-separated list and the weak-validator (`W/`) prefix, per RFC 9110 conditional-request semantics.
 */
function etagMatches(ifNoneMatch, etag) {
    const value = ifNoneMatch.trim();
    if (value === "*")
        return true;
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
export async function getRevocationList(pool, tenantId, productId, opts = {}) {
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
