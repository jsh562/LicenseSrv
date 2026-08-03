// The runtime usage-metering REST surface (/v1, the licensed application). Authenticated by the app.ts
// API-key context (`req.tenant`) and gated FAIL-CLOSED on the `usage.ingest` scope (401 no tenant / 403
// missing scope, FR-001/SC-016); NO CSRF (header-credential, not cookie). The POST /v1/usage endpoint is a
// high-write, FAST-ACK batch ingest: it enforces the WHOLE-REQUEST gates up front (scope, non-empty envelope,
// batch cap → 400 batch_too_large BEFORE any accrual, FR-005), appends the raw events + returns the per-batch
// summary quickly, and defers the rollup to the async US2 worker (it does NOT roll up synchronously). It is
// rate-limited PER API KEY (429 rate_limited + Retry-After, FR-005) and the denied/limited attempts are
// audited (FR-018). Errors use the project `{code,message,details?}` model. The admin aggregate-query route
// (GET /admin/licenses/:licenseId/usage) is a SEPARATE console plane added by US2.
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { resolveApiKey } from "../../auth/apikey.js";
import { recordSecurityEvent } from "../../audit/index.js";
import { requireRole } from "../../console/rbac-middleware.js";
import { withTenant } from "../../db/client.js";
import { ingestBatch } from "./ingest.js";
import { queryUsage } from "./query.js";
function err(reply, status, code, message, details) {
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    return reply.code(status).send(body);
}
const validation = (r, m = "invalid request", details) => err(r, 400, "validation_error", m, details);
// --- Admin aggregate-query schema (contract GET /admin/licenses/{licenseId}/usage) -----------------
/** The `raw` flag comes in as a query string; accept only the explicit `true`/`false` tokens. */
const rawSchema = z.enum(["true", "false"]).optional();
const usageQuerySchema = z
    .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    entitlementId: z.string().uuid().optional(),
    bucket: z.enum(["hour", "day", "period"]).optional(),
    raw: rawSchema,
})
    .strict();
/** Does a license id resolve within the session tenant? (RLS-scoped existence check for the 404 gate, FR-017.) */
async function licenseExists(q, licenseId) {
    const r = await q("SELECT 1 FROM license WHERE id = $1", [licenseId]);
    return Boolean(r.rowCount);
}
/**
 * The 429 body the @fastify/rate-limit plugin THROWS when a caller exceeds the ceiling (FR-005). It carries
 * `statusCode` so Fastify answers 429 (not 500), the machine `rate_limited` code, and a `retryAfterSeconds`
 * hint matching the standard `Retry-After` header the plugin also sets (the two never disagree).
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
/** The per-key rate-limit key: the caller's API key (per-key limiting, FR-005), falling back to the IP. */
function apiKeyKey(req) {
    const raw = req.headers["x-api-key"];
    return typeof raw === "string" ? raw : req.ip;
}
/** Best-effort audit of a rate-limited ingest as a security event (FR-005/018). Never throws into the plugin. */
async function auditRateLimited(pool, secret, req) {
    const raw = req.headers["x-api-key"];
    if (typeof raw !== "string")
        return;
    const ctx = await resolveApiKey(pool, raw, secret);
    if (!ctx)
        return;
    await withTenant(pool, ctx.tenantId, (q) => recordSecurityEvent(q, { actor: "usage-api", action: "usage.rate_limited", target: `${req.method} ${req.url}` }));
}
/**
 * Runtime preHandler: the app.ts API-key context must be present AND carry the `usage.ingest` scope
 * (FR-001/SC-016). A missing tenant context (no resolvable key) → 401; a resolvable key lacking the scope →
 * 403 forbidden `{ requiredScope }`, and the denied attempt is audited (FR-018). Returns false once it has
 * already answered, so the handler short-circuits.
 */
async function requireIngestScope(pool, req, reply) {
    if (!req.tenant) {
        await err(reply, 401, "unauthorized", "missing tenant context");
        return false;
    }
    if (!req.tenant.scopes.includes("usage.ingest")) {
        await withTenant(pool, req.tenant.tenantId, (q) => recordSecurityEvent(q, { actor: "usage-api", action: "usage.scope_denied", target: "usage.ingest" })).catch(() => undefined);
        await err(reply, 403, "forbidden", "the usage.ingest scope is required", { requiredScope: "usage.ingest" });
        return false;
    }
    return true;
}
/**
 * Register the /v1 runtime usage routes. The ingest endpoint is API-key + `usage.ingest` gated, rate-limited
 * per key, and fast-acks with the per-batch summary. Encapsulated in its own Fastify scope so the rate-limit
 * plugin instance is local to this plane (mirrors the E014/E015 runtime plane).
 */
export function registerUsageRoutes(app, deps, apiKeySecret) {
    const { pool, config } = deps;
    void app.register(async (scope) => {
        await scope.register(rateLimit, {
            global: false,
            // The plugin THROWS the builder's object, so it must carry `statusCode` for Fastify to answer 429.
            errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
            onExceeded: (req) => void auditRateLimited(pool, apiKeySecret, req).catch(() => undefined),
        });
        const rl = {
            config: { rateLimit: { max: config.ingestRateMax, timeWindow: config.ingestRateWindow, keyGenerator: apiKeyKey } },
        };
        // POST /v1/usage — ingest a batch of usage events (idempotent, fast-ack, per-event summary). FR-001/005/007.
        scope.post("/v1/usage", rl, async (req, reply) => {
            if (!(await requireIngestScope(pool, req, reply)))
                return reply;
            const tenantId = req.tenant.tenantId;
            // WHOLE-REQUEST envelope gates (two disjoint vocabularies, AD-008) — refuse pre-accrual:
            const body = req.body;
            const events = body?.events;
            if (!Array.isArray(events) || events.length === 0) {
                return validation(reply, "events must be a non-empty array", { field: "events" });
            }
            if (events.length > config.maxBatch) {
                return err(reply, 400, "batch_too_large", `the batch exceeds the maximum of ${config.maxBatch} events; split and retry`, {
                    max: config.maxBatch,
                    size: events.length,
                });
            }
            // Fast-ack: append the raw events + return the per-batch summary. The rollup is the async US2 worker —
            // NOT rolled up here. A single bad event is a per-event rejection inside the summary, never a batch fail.
            const summary = await ingestBatch(deps, tenantId, "usage-api", events);
            return reply.code(200).send(summary);
        });
    });
    // --- OPERATOR plane: GET /admin/licenses/:licenseId/usage (session + RBAC viewer) ------------------
    // The console projection of the reproducible aggregate (US2, FR-011/013/020). Session cookie + RBAC (viewer
    // reads); tenant-scoped (cross-tenant licenseId → 404, never 403, FR-017/SC-012). `raw=true` returns the
    // TRUE signed net and is BOUNDED to an ELEVATED role (admin+, FR-020/SC-019) — a viewer requesting it is
    // refused 403. The window span is bounded (window_too_large) BEFORE any aggregation (FR-011). NO CSRF (GET).
    // Kept in its OWN encapsulated Fastify scope so the admin query plane is ALSO bounded (FR-005): a per-source-IP
    // rate limit sheds a hammering flood with `429 rate_limited` + `Retry-After` (session + RBAC are the primary
    // control; this mirrors the E015 lease / E014 billing admin planes). Distinct from the runtime per-key limiter.
    void app.register(async (adminScope) => {
        await adminScope.register(rateLimit, {
            global: true,
            max: config.ingestRateMax,
            timeWindow: config.ingestRateWindow,
            keyGenerator: (req) => req.ip,
            errorResponseBuilder: (_req, ctx) => rateLimitBody(Math.max(1, Math.ceil(ctx.ttl / 1000))),
        });
        const viewer = { preHandler: requireRole(pool, "viewer") };
        adminScope.get("/admin/licenses/:licenseId/usage", viewer, async (req, reply) => {
            const licenseId = req.params.licenseId;
            if (!UUID_RE.test(licenseId))
                return err(reply, 404, "not_found", "no such license in this tenant", { licenseId });
            const parsed = usageQuerySchema.safeParse(req.query ?? {});
            if (!parsed.success) {
                const field = parsed.error.issues[0]?.path.join(".") || undefined;
                return validation(reply, parsed.error.issues[0]?.message ?? "invalid query", field ? { field } : undefined);
            }
            const { from: fromStr, to: toStr, entitlementId, bucket, raw: rawStr } = parsed.data;
            const from = new Date(fromStr);
            const to = new Date(toStr);
            if (to.getTime() <= from.getTime())
                return validation(reply, "to must be after from", { field: "to" });
            // raw=true (the un-floored true signed net) is bounded to an ELEVATED role (admin+, FR-020/SC-019).
            const raw = rawStr === "true";
            if (raw && req.admin.role === "viewer") {
                return err(reply, 403, "forbidden", "the raw signed net requires the admin role", {
                    minRole: "admin",
                    role: req.admin.role,
                });
            }
            // Window span bound (a bucket-count cap) — refuse an unbounded expensive aggregate BEFORE any read.
            const hours = Math.ceil((to.getTime() - from.getTime()) / 3_600_000);
            if (hours > config.queryMaxHours) {
                return err(reply, 400, "window_too_large", `the query window exceeds the maximum of ${config.queryMaxHours} hours`, {
                    maxHours: config.queryMaxHours,
                    hours,
                });
            }
            const tenantId = req.admin.tenantId;
            const result = await withTenant(pool, tenantId, async (q) => {
                if (!(await licenseExists(q, licenseId)))
                    return null;
                return queryUsage(q, deps.repo, { licenseId, entitlementId, from, to, bucket, raw });
            });
            if (!result)
                return err(reply, 404, "not_found", "no such license in this tenant", { licenseId });
            return reply.code(200).send(result);
        });
    });
}
/** Canonical-UUID shape guard so a malformed path id resolves to 404 (never leaks) without a DB round-trip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
