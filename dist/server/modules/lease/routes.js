// The runtime lease REST surface (/v1, the licensed app). Authenticated by the app.ts API-key context
// (`req.tenant`) and gated on the `lease` scope, fail-closed (401 no tenant / 403 missing scope, FR-002/
// SC-020); NO CSRF (header-credential, not cookie). All three routes (acquire / renew / release) are rate-
// limited per API key with a threshold sized for heartbeat cadence, refusing over-limit `429 rate_limited`
// with `Retry-After` and auditing the event (FR-017). Errors use the project `{code,message,details?}` model;
// a thrown LeaseError maps to it. [COMPLETES FR-001] acquire (US1); renew/release added by US2 (FR-002). The
// ADMIN plane — GET /admin/licenses/:licenseId/leases (viewer registry, US5/T034) + POST /admin/leases/
// :leaseId/force-release (admin + double-submit CSRF, US5/T035) — is a SEPARATE console scope: session cookie
// + RBAC + CSRF (NOT the API key), cross-tenant → 404, viewer/CSRF denials recorded as security events.
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { resolveApiKey } from "../../auth/apikey.js";
import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import { requireRole } from "../../console/rbac-middleware.js";
import { withTenant } from "../../db/client.js";
import { acquireLease, resolveLicenseForLease } from "./acquire.js";
import { LeaseError } from "./index.js";
import { releaseLease } from "./release.js";
import { renewLease } from "./renew.js";
/** The hard cap on a registry list (bounded, NOT paginated); a `truncated` signal flags the newest-1000 clamp (FR-015). */
const REGISTRY_LIST_CAP = 1000;
/** The default recently-ended display window for the registry (FR-015): live + leases ended within the last 24h. */
const REGISTRY_DISPLAY_WINDOW_SECONDS = 24 * 60 * 60;
function err(reply, status, code, message, details) {
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    return reply.code(status).send(body);
}
const validation = (r, m = "invalid request", details) => err(r, 400, "validation_error", m, details);
/**
 * The 429 body the @fastify/rate-limit plugin THROWS when a caller exceeds the ceiling (FR-017). It carries
 * `statusCode` so Fastify answers 429 (not 500), the machine `rate_limited` code, and a `retryAfterSeconds`
 * hint; the plugin ALSO sets the standard `Retry-After` header. Shared by the runtime plane (per API key) and
 * the admin plane (per source IP).
 */
function rateLimitBody(retryAfterSeconds) {
    return {
        statusCode: 429,
        error: "Too Many Requests",
        code: "rate_limited",
        message: `rate limit exceeded, retry in ${retryAfterSeconds}s`,
        details: { retryAfterSeconds },
    };
}
/**
 * Run a handler, mapping a thrown LeaseError to its HTTP status; other errors propagate (→ 500). A client-side
 * refusal (status < 500) — AND the transient signer-fault (503, no seat consumed) — is passed to `onDenied`
 * first so the route can audit the denied attempt in its own fresh transaction (FR-018); the business
 * transaction has already rolled back.
 */
async function guard(reply, fn, onDenied) {
    try {
        return await fn();
    }
    catch (e) {
        if (e instanceof LeaseError) {
            // Audit every business refusal (status < 500) AND the transient signer-fault (503, no seat consumed) on
            // the acquire/renew path — FR-018 mandates a distinct audit entry for the signer fault too. Any other
            // 5xx (there are none in the current error set) is left to the generic 500 log, not the denial audit.
            if (onDenied && (e.status < 500 || e.code === "signer_unavailable")) {
                await onDenied(e).catch(() => undefined);
            }
            return err(reply, e.status, e.code, e.message, e.details);
        }
        throw e;
    }
}
/** Runtime preHandler: the app.ts API-key context must be present and carry the `lease` scope (FR-002/SC-020). */
function requireLeaseScope(req, reply) {
    if (!req.tenant) {
        void err(reply, 401, "unauthorized", "missing tenant context");
        return false;
    }
    if (!req.tenant.scopes.includes("lease")) {
        void err(reply, 403, "forbidden", "the lease scope is required", { requiredScope: "lease" });
        return false;
    }
    return true;
}
const signalHash = z.string().min(1).max(256);
const acquireSchema = z
    .object({
    licenseId: z.string().uuid().optional(),
    licenseKey: z.string().min(1).max(4096).optional(),
    holderReference: z.string().min(8).max(512),
    acquireToken: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/),
    fingerprint: z.object({ signals: z.array(signalHash).min(1).max(32) }).optional(),
    activationReference: z.string().uuid().optional(),
})
    .refine((b) => Boolean(b.licenseId) !== Boolean(b.licenseKey), {
    message: "exactly one of licenseId or licenseKey is required",
});
const leaseParams = z.object({ leaseId: z.string().uuid() });
const licenseParams = z.object({ licenseId: z.string().uuid() });
const registryQuery = z.object({ status: z.enum(["live", "released", "reclaimed"]).optional() });
/** Project a lease row to the registry summary — only pseudonymous holder identity, never the handle/raw ref (SC-015). */
function toSummary(lease) {
    return {
        id: lease.id,
        holderKey: lease.holderKey,
        scope: lease.scope,
        status: lease.status,
        acquiredAt: lease.acquiredAt,
        lastRenewedAt: lease.lastRenewedAt,
        expiresAt: lease.expiresAt,
    };
}
/** The rate-limit key: the caller's API key (per-key limiting, FR-017), falling back to the client IP. */
function apiKeyKey(req) {
    const raw = req.headers["x-api-key"];
    return typeof raw === "string" ? raw : req.ip;
}
/** Best-effort audit of a rate-limited request as a security event (FR-017/018). Never throws into the plugin. */
async function auditRateLimited(pool, secret, req) {
    const raw = req.headers["x-api-key"];
    if (typeof raw !== "string")
        return;
    const ctx = await resolveApiKey(pool, raw, secret);
    if (!ctx)
        return;
    await withTenant(pool, ctx.tenantId, (q) => recordSecurityEvent(q, { actor: "lease-api", action: "lease.rate_limited", target: `${req.method} ${req.url}` }));
}
/** Register the /v1 runtime lease routes (acquire / renew / release) — API key + `lease` scope + rate limit. */
export function registerLeaseRoutes(app, deps, apiKeySecret) {
    const { pool, config } = deps;
    void app.register(async (scope) => {
        await scope.register(rateLimit, {
            global: false,
            // The plugin THROWS the builder's object, so it must carry `statusCode` for Fastify to answer 429 (not 500).
            errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
            onExceeded: (req) => void auditRateLimited(pool, apiKeySecret, req).catch(() => undefined),
        });
        const rl = { config: { rateLimit: { max: config.rateMax, timeWindow: config.rateWindow, keyGenerator: apiKeyKey } } };
        // Acquire a floating seat (201 fresh / 200 idempotent replay + Location).
        scope.post("/v1/leases", rl, async (req, reply) => {
            if (!requireLeaseScope(req, reply))
                return reply;
            const tenantId = req.tenant.tenantId;
            const b = acquireSchema.safeParse(req.body);
            if (!b.success)
                return validation(reply, b.error.issues[0]?.message ?? "invalid acquire payload");
            return guard(reply, async () => {
                const { created, grant } = await acquireLease(deps, tenantId, {
                    licenseId: b.data.licenseId,
                    licenseKey: b.data.licenseKey,
                    holderReference: b.data.holderReference,
                    acquireToken: b.data.acquireToken,
                    signals: b.data.fingerprint?.signals ?? null,
                    activationReference: b.data.activationReference ?? null,
                });
                const r = reply.code(created ? 201 : 200);
                if (created)
                    r.header("Location", `/v1/leases/${grant.id}`);
                return r.send(grant);
            }, (e) => withTenant(pool, tenantId, (q) => writeAudit(q, { actor: "lease-api", action: "lease.denied", target: e.code })));
        });
        // Heartbeat-renew a live lease (200 + refreshed handle).
        scope.post("/v1/leases/:leaseId/renew", rl, async (req, reply) => {
            if (!requireLeaseScope(req, reply))
                return reply;
            const tenantId = req.tenant.tenantId;
            const p = leaseParams.safeParse(req.params);
            if (!p.success)
                return validation(reply, "invalid leaseId");
            return guard(reply, async () => {
                const { grant } = await renewLease(deps, tenantId, p.data.leaseId);
                return reply.code(200).send(grant);
            }, (e) => withTenant(pool, tenantId, (q) => writeAudit(q, { actor: "lease-api", action: "lease.renew_denied", target: e.code })));
        });
        // Release a lease (idempotent 200 no-op — free the seat immediately).
        scope.post("/v1/leases/:leaseId/release", rl, async (req, reply) => {
            if (!requireLeaseScope(req, reply))
                return reply;
            const tenantId = req.tenant.tenantId;
            const p = leaseParams.safeParse(req.params);
            if (!p.success)
                return validation(reply, "invalid leaseId");
            return guard(reply, async () => reply.code(200).send(await releaseLease(deps, tenantId, p.data.leaseId)));
        });
    });
    registerLeaseAdminRoutes(app, deps);
}
/**
 * Register the ADMIN console lease plane (US5): the per-license registry (GET, viewer RBAC) and the operator
 * force-release (POST, admin RBAC + double-submit CSRF). Both go through `requireRole` (session cookie + RBAC +
 * CSRF fail-closed), which records a viewer/CSRF denial as a security event (SC-010/013). Cross-tenant ids
 * resolve to `404` under RLS (FR-019). Kept in its own encapsulated scope, distinct from the API-key runtime
 * plane above.
 */
function registerLeaseAdminRoutes(app, deps) {
    const { pool, repo, config } = deps;
    const viewer = { preHandler: requireRole(pool, "viewer") };
    const admin = { preHandler: requireRole(pool, "admin") };
    void app.register(async (adminScope) => {
        // A bounded per-source-IP ceiling on the operator plane too (FR-017). Session + RBAC + CSRF are the primary
        // control; this sheds a hammering/credential-stuffing flood with `429 rate_limited` + `Retry-After` — so the
        // admin lease plane is ALSO rate-limited (not just the runtime plane), mirroring the billing admin plane.
        await adminScope.register(rateLimit, {
            global: true,
            max: config.rateMax,
            timeWindow: config.rateWindow,
            keyGenerator: (req) => req.ip,
            errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
        });
        // GET the license's lease registry — live + recently-ended (24h), used-vs-cap, deterministic, bounded 1000
        // + truncated; pseudonymous holderKey only, NO handle (SC-015). Viewer RBAC (FR-015). [T034]
        adminScope.get("/admin/licenses/:licenseId/leases", viewer, async (req, reply) => {
            const p = licenseParams.safeParse(req.params);
            if (!p.success)
                return validation(reply, "invalid licenseId");
            const qy = registryQuery.safeParse(req.query ?? {});
            if (!qy.success)
                return validation(reply, "invalid status filter");
            // Do all DB work inside withTenant, then send AFTER it resolves (committed) — never send from inside the
            // tx callback (the response could flush before COMMIT). Mirrors the billing admin registry pattern.
            const result = await withTenant(pool, req.admin.tenantId, async (q) => {
                const license = await resolveLicenseForLease(q, { id: p.data.licenseId });
                if (!license)
                    return null;
                const concurrencyUsed = await repo.countLive(q, license.id);
                const { leases, truncated } = await repo.list(q, {
                    licenseId: license.id,
                    status: qy.data.status,
                    cap: REGISTRY_LIST_CAP,
                    displayWindowSeconds: REGISTRY_DISPLAY_WINDOW_SECONDS,
                });
                return {
                    concurrencyUsed,
                    maxConcurrent: license.maxConcurrent,
                    overageAllowance: license.overageAllowance,
                    scope: license.scope,
                    truncated,
                    leases: leases.map(toSummary),
                };
            });
            if (!result)
                return err(reply, 404, "not_found", "unknown license", { licenseId: p.data.licenseId });
            return reply.code(200).send(result);
        });
        // POST force-release a specific lease — reclaim the seat; admin RBAC + CSRF, audited, idempotent. Unknown/
        // cross-tenant leaseId → 404 not_found (FR-016/019). [T035]
        adminScope.post("/admin/leases/:leaseId/force-release", admin, async (req, reply) => {
            const p = leaseParams.safeParse(req.params);
            if (!p.success)
                return validation(reply, "invalid leaseId");
            const { tenantId, userId } = req.admin;
            // Resolve → force-release → audit inside the tx; send AFTER it commits (never from inside the callback,
            // else the 200 could flush before COMMIT and a follow-up read would still see the live seat).
            const result = await withTenant(pool, tenantId, async (q) => {
                const existing = await repo.getById(q, p.data.leaseId);
                if (!existing)
                    return null; // unknown / cross-tenant → 404 (FR-019)
                const res = await repo.forceRelease(q, p.data.leaseId);
                await writeAudit(q, {
                    actor: userId,
                    action: "lease.force_released",
                    target: res.id,
                    after: { licenseId: existing.licenseId, changed: res.changed },
                });
                return { id: res.id, status: res.status };
            });
            if (!result)
                return err(reply, 404, "not_found", "unknown lease", { leaseId: p.data.leaseId });
            return reply.code(200).send(result);
        });
    });
}
