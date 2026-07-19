// The enforcement RUNTIME plane (/v1, the licensed app). Mirrors the E009 activation /v1 surface: the
// app.ts API-key context (`req.tenant`) gated on the `validate` scope (distinct from E009's `activate`),
// rate-limited per API key (FR-021), Zod body validation, and the project `{code,message,details?}` error
// model. REFUSAL SEMANTICS (AD-001): a non-valid verdict is a `200` + `verdict` (mapped by validateOnline),
// NOT an error; only genuine faults (validation 400 / auth 401/403 / not-found 404 / nonce_replayed 409 /
// rate_limited 429 / signer_unavailable 503) use the error model. US1 registers POST /v1/validate here; US3
// (heartbeat) and US4 (revocation-list) layer onto this same seam.
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { resolveApiKey } from "../../auth/apikey.js";
import { recordSecurityEvent } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { heartbeatRenew } from "./heartbeat.js";
import { EnforcementError } from "./index.js";
import { getRevocationList } from "./revocation-list.js";
import { validateOnline } from "./validate.js";
const ACTOR = "enforcement-api";
function err(reply, status, code, message, details) {
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    return reply.code(status).send(body);
}
const validation = (r, m = "invalid request") => err(r, 400, "validation_error", m);
/**
 * Run a handler, mapping a thrown EnforcementError to its HTTP status; other errors propagate (→ 500). A
 * client-side denial (status < 500) is passed to `onDenied` first so the route can audit the refused fault
 * (FR-019) — the business transaction has already rolled back, so this runs in its own fresh transaction.
 * NOTE: enforcement REFUSALS are not errors (they are 200 + verdict, AD-001) and never reach here.
 */
async function guard(reply, fn, onDenied) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof EnforcementError) {
            if (onDenied && e.status < 500)
                await onDenied(e).catch(() => undefined);
            return err(reply, e.status, e.code, e.message, e.details);
        }
        throw e;
    }
}
/** Runtime preHandler: the app.ts API-key context must be present and carry the `validate` scope (FR-018). */
function requireValidateScope(req, reply) {
    if (!req.tenant) {
        void err(reply, 401, "unauthorized", "missing tenant context");
        return false;
    }
    if (!req.tenant.scopes.includes("validate")) {
        void err(reply, 403, "forbidden", "the validate scope is required", { requiredScope: "validate" });
        return false;
    }
    return true;
}
const signalHash = z.string().min(1).max(256);
// Shared validate/heartbeat body (contract EnforcementRequest): identify by activationId and/or the E009
// machineBoundKey (at least one), optional machine-signal proof, and a single-use nonce (>= 32 chars →
// >= 128-bit in any encoding, FR-008; mirrors the activation surface).
const validateSchema = z
    .object({
    activationId: z.string().uuid().optional(),
    machineBoundKey: z.string().min(1).max(8192).optional(),
    fingerprint: z.object({ signals: z.array(signalHash).min(1).max(32) }).optional(),
    nonce: z.string().min(32).max(256),
})
    .refine((b) => Boolean(b.activationId) || Boolean(b.machineBoundKey), {
    message: "provide at least one of activationId or machineBoundKey",
});
// CRL fetch query (contract GET /v1/revocation-list): the REQUIRED per-product `productId`, an optional
// specific `version`, and the `json|file` representation selector. Query values arrive as strings → coerce
// `version` to a positive integer.
const crlQuerySchema = z.object({
    productId: z.string().uuid(),
    version: z.coerce.number().int().positive().optional(),
    format: z.enum(["json", "file"]).optional(),
});
/** Map the internal EnforcementResult to the contract wire body — omits the internal `reason` and absent optionals. */
function toWire(r) {
    const body = {
        verdict: r.verdict,
        serverTime: r.serverTime,
        stalenessWindow: r.stalenessWindow,
    };
    if (r.shortLivedToken !== undefined)
        body.shortLivedToken = r.shortLivedToken;
    if (r.renewAfter !== undefined)
        body.renewAfter = r.renewAfter;
    if (r.expiresAt !== undefined)
        body.expiresAt = r.expiresAt;
    return body;
}
/** The rate-limit key: the caller's API key (per-key limiting, FR-021), falling back to the client IP. */
function apiKeyKey(req) {
    const raw = req.headers["x-api-key"];
    return typeof raw === "string" ? raw : req.ip;
}
/** Best-effort audit of a rate-limited request as a security event (FR-021). Never throws into the plugin. */
async function auditRateLimited(pool, secret, req) {
    const raw = req.headers["x-api-key"];
    if (typeof raw !== "string")
        return;
    const ctx = await resolveApiKey(pool, raw, secret);
    if (!ctx)
        return;
    await withTenant(pool, ctx.tenantId, (q) => recordSecurityEvent(q, { actor: ACTOR, action: "enforcement.rate_limited", target: `${req.method} ${req.url}` }));
}
/** Register the enforcement /v1 runtime plane (validate scope + rate limit). US1: POST /v1/validate; US3: POST /v1/heartbeat. */
export function registerEnforcementRoutes(app, pool, deps) {
    const { config, signer } = deps;
    // Both validate and heartbeat are the SAME enforcement query — identical auth, `validate` scope, Zod body,
    // and 200-verdict mapping — so ONE handler factory serves both, parameterized by the runner (validateOnline
    // vs heartbeatRenew). A non-valid verdict is a 200 (AD-001); only genuine faults use the error model.
    const handler = (run) => async (req, reply) => {
        if (!requireValidateScope(req, reply))
            return reply;
        const tenantId = req.tenant.tenantId;
        const b = validateSchema.safeParse(req.body);
        if (!b.success)
            return validation(reply, b.error.issues[0]?.message ?? "invalid enforcement payload");
        return guard(reply, async () => {
            const result = await run(pool, signer, config, tenantId, {
                activationId: b.data.activationId,
                machineBoundKey: b.data.machineBoundKey,
                signals: b.data.fingerprint?.signals,
                nonce: b.data.nonce,
            });
            return reply.code(200).send(toWire(result));
        }, 
        // FR-019: audit every genuine refused fault (nonce_replayed, cross-tenant not-found) — reason code
        // only, never the nonce/token. Enforcement verdicts are 200 and audited inside the runner.
        (e) => withTenant(pool, tenantId, (q) => recordSecurityEvent(q, { actor: ACTOR, action: "enforcement.denied", target: e.code })));
    };
    // --- Runtime plane (/v1): API key + validate scope + rate limit ------------------------------------
    void app.register(async (scope) => {
        await scope.register(rateLimit, {
            global: false,
            // The plugin THROWS this object, so it must carry `statusCode` for Fastify to answer 429 (not 500).
            errorResponseBuilder: (_req, ctx) => ({
                statusCode: 429,
                error: "Too Many Requests",
                code: "rate_limited",
                message: `rate limit exceeded, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
            }),
            onExceeded: (req) => void auditRateLimited(pool, deps.apiKeySecret, req).catch(() => undefined),
        });
        const rl = { config: { rateLimit: { max: config.rateMax, timeWindow: config.rateWindow, keyGenerator: apiKeyKey } } };
        // Online validate → 200 verdict (+ short-lived token on `valid`); genuine faults use the error model.
        scope.post("/v1/validate", rl, handler(validateOnline));
        // Silent heartbeat renewal → the SAME 200-verdict contract; re-checks status/expiry/entitlements per beat
        // (FR-003/004/017) on the SAME rate-limited validate scope (FR-021).
        scope.post("/v1/heartbeat", rl, handler(heartbeatRenew));
        // Signed CRL fallback (FR-010; US4): the latest (or a specific) signed CRL for a product, JSON by
        // default and the byte-identical signed FILE under `?format=file` (air-gap). Same `validate` scope +
        // rate limit. Caching aligns to `next_update` (ETag=version, Cache-Control/Expires) with `If-None-Match`
        // → 304. An unknown/cross-tenant product or an absent version → 404 (the client fails OPEN, FR-011); a
        // benign not-found is NOT audited as a denial (it is the expected fail-open path, not a security event).
        scope.get("/v1/revocation-list", rl, async (req, reply) => {
            if (!requireValidateScope(req, reply))
                return reply;
            const tenantId = req.tenant.tenantId;
            const parsed = crlQuerySchema.safeParse(req.query);
            if (!parsed.success)
                return validation(reply, parsed.error.issues[0]?.message ?? "invalid revocation-list query");
            const inm = req.headers["if-none-match"];
            return guard(reply, async () => {
                const result = await getRevocationList(pool, tenantId, parsed.data.productId, {
                    version: parsed.data.version,
                    format: parsed.data.format,
                    ifNoneMatch: typeof inm === "string" ? inm : null,
                });
                void reply.header("ETag", result.etag).header("Cache-Control", result.cacheControl).header("Expires", result.expires);
                if (result.status === 304)
                    return reply.code(304).send();
                void reply.header("Content-Type", result.contentType);
                if (parsed.data.format === "file") {
                    void reply.header("Content-Disposition", `attachment; filename="revocation-list-${parsed.data.productId}-v${result.version}.crl"`);
                }
                return reply.code(200).send(result.body);
            });
        });
    });
}
