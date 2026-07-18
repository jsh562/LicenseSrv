import { z } from "zod";
import { withTenant } from "../../db/client.js";
import { activate } from "./activate.js";
import { ActivationError } from "./index.js";
const requestEnvelopeSchema = z
    .object({
    formatVersion: z.string(),
    licenseId: z.string().uuid().optional(),
    licenseKey: z.string().min(1).optional(),
    fingerprint: z.object({ signals: z.array(z.string().min(1).max(256)).min(1).max(32) }),
    nonce: z.string().min(32).max(256), // >= 128-bit single-use nonce (FR-020)
    producedAt: z.string().datetime(),
    label: z.string().max(256).nullish(),
})
    .refine((b) => Boolean(b.licenseId) !== Boolean(b.licenseKey), {
    message: "exactly one of licenseId or licenseKey is required",
});
/**
 * Decode + validate a request file (FR-001/007/014/019). The order is fail-closed and distinct-reason:
 * oversize guard (pre-decode) → base64url/JSON decode → formatVersion → structure. Throws an ActivationError
 * whose code the route surfaces + audits; never reaches the seat-consuming step.
 */
export function decodeRequestFile(requestFile, config) {
    // FR-019: oversize / decompression guard BEFORE decoding.
    if (Buffer.byteLength(requestFile, "utf8") > config.airgapMaxRequestBytes) {
        throw new ActivationError("validation_error", 400, "the request file exceeds the maximum size", { reason: "oversize" });
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(requestFile, "base64url").toString("utf8"));
    }
    catch {
        throw new ActivationError("validation_error", 400, "the request file is not a valid base64url envelope");
    }
    // FR-001/014: an unknown/future format version is a distinct refusal, checked before full structure validation.
    const version = parsed.formatVersion;
    if (typeof version !== "string" || version !== config.airgapRequestVersion) {
        throw new ActivationError("unknown_format_version", 400, "unsupported request-file format version", { formatVersion: version });
    }
    const r = requestEnvelopeSchema.safeParse(parsed);
    if (!r.success) {
        throw new ActivationError("validation_error", 400, r.error.issues[0]?.message ?? "invalid request file");
    }
    return r.data;
}
/** Encode a response envelope as the portable base64url(JSON) response file (FR-006/014). */
export function encodeResponseFile(envelope) {
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}
/**
 * Process an air-gap request file end to end (FR-002/003/006/008/021/022/028). Validates the file layer,
 * applies the freshness window to FIRST-sight files only (an already-seen nonce always replays regardless of
 * age, FR-021), calls E009 `activate()` verbatim, and packages the signed credential into a response file.
 * Seat cap, idempotency, K-of-N, tenant isolation, and fail-closed signing are all inherited from `activate()`.
 */
export async function processAirGapRequest(pool, signer, config, tenantId, requestFile) {
    const env = decodeRequestFile(requestFile, config);
    // FR-008/FR-021: the freshness window gates only a not-yet-seen request. An already-processed nonce always
    // replays (or is refused nonce_replayed) via activate(), so freshness and idempotency never contradict.
    const producedAtMs = Date.parse(env.producedAt);
    if (Number.isNaN(producedAtMs))
        throw new ActivationError("validation_error", 400, "invalid producedAt timestamp");
    const alreadySeen = await withTenant(pool, tenantId, async (q) => {
        const r = await q("SELECT 1 FROM activation WHERE nonce = $1", [env.nonce]);
        return (r.rowCount ?? 0) > 0;
    });
    if (!alreadySeen && Date.now() - producedAtMs > config.airgapFreshnessSecs * 1000) {
        throw new ActivationError("stale_request", 400, "the request file is older than the freshness window", {
            producedAt: env.producedAt,
            maxAgeSeconds: config.airgapFreshnessSecs,
        });
    }
    const result = await activate(pool, signer, config, tenantId, {
        licenseId: env.licenseId,
        licenseKey: env.licenseKey,
        signals: env.fingerprint.signals,
        nonce: env.nonce,
        label: env.label ?? null,
    });
    const response = {
        formatVersion: config.airgapResponseVersion,
        activationId: result.id,
        machineBoundKey: result.machineBoundKey, // the signed LIC1 — self-verifying offline (tamper-evidence)
        keyId: null, // the signing key id is embedded in the signed credential; not separately exposed
        expiresAt: null, // authoritative expiry lives in the credential; envelope metadata is informational
        machineId: result.machineId,
    };
    return { responseFile: encodeResponseFile(response), created: result.created, activationId: result.id };
}
