import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { resolveApiKey } from "./auth/apikey.js";
import { registerModules } from "./modules/index.js";
import { recordRed } from "./observability/metrics.js";
import { buildRequestLog, createLogger, outcomeFromStatus } from "./observability/logger.js";
import { enterRequestContext, genReqId, sanitizeClientRequestId, setContextTenant } from "./observability/request-context.js";
/** Logger config used when a caller does not supply `config` (e.g. integration tests). */
const DEFAULT_LOGGER_CONFIG = { logLevel: "info", logFormat: "json" };
/** The billing webhook ingestion prefix (E014). Deliveries here carry a provider HMAC over the raw body. */
const WEBHOOK_PATH_PREFIX = "/v1/billing/webhooks/";
/**
 * The modular-monolith application skeleton (TR-010). Establishes the tenant-resolution
 * auth context (machine/runtime API key -> tenant + scopes, TR-009) and registers the
 * reserved feature-module seams. Business endpoints are added by the feature epics.
 */
export function createApp(deps) {
    const app = Fastify({
        // Pre-built pino instance (Fastify 5 `loggerInstance`); level/format from config (OR-001/004). A caller
        // may inject its own instance (tests capture the stream to prove no secret is ever logged, FR-018/022).
        loggerInstance: deps.loggerInstance ?? createLogger(deps.config ?? DEFAULT_LOGGER_CONFIG),
        // We emit exactly ONE structured line per request ourselves (Phase 3), so Fastify's default
        // request/response auto-logging is suppressed to avoid the extra pair of lines (OR-001).
        disableRequestLogging: true,
        // Authoritative, server-generated request id — inbound headers are never trusted (AD-002).
        genReqId: () => genReqId(),
        // Undefined here preserves Fastify's default (`'idle'`); the perf suite opts into `true` so a real
        // loopback listener's open/keep-alive sockets are force-destroyed at `app.close()` (prompt teardown).
        forceCloseConnections: deps.forceCloseConnections,
    });
    // Enter the per-request AsyncLocalStorage context first, so every later hook/handler (and the
    // response log line) can read `request_id` and the sanitized inbound correlation tag (OR-002).
    app.addHook("onRequest", async (req) => {
        const inbound = req.headers["x-correlation-id"] ?? req.headers["x-request-id"];
        enterRequestContext({ requestId: req.id, clientRequestId: sanitizeClientRequestId(inbound) });
    });
    // Emit EXACTLY ONE structured JSON line per request (OR-001) — covering ALL paths: success, error
    // responses, pre-auth 401 rejections, and non-`/v1` routes (`/internal/`, `/admin/`). Runs at the end
    // of every request's lifecycle regardless of outcome. `disableRequestLogging: true` (above) suppresses
    // Fastify's default request/response lines, so this is the sole per-request line. `buildRequestLog`
    // sets `tenant_id` to null when the tenant is unresolved (pre-auth / internal); `outcome` and
    // `duration_ms` come from the response status and Fastify's per-request timer.
    app.addHook("onResponse", async (req, reply) => {
        const durationMs = reply.elapsedTime;
        const outcome = outcomeFromStatus(reply.statusCode);
        req.log.info(buildRequestLog(req, reply, { durationMs, outcome }), "request completed");
        // Record RED metrics from the SAME hook (OR-006), labelled by bounded route PATTERN + method +
        // outcome so a metric and its log line share one measurement. Unmatched (404) requests collapse to
        // a single "unmatched" route so raw URLs never explode metric cardinality (OR-008). recordRed is
        // fail-open internally, so it never throws into the response path (OR-014).
        recordRed({ route: req.routeOptions.url ?? "unmatched", method: req.method, outcome, durationMs });
    });
    // Raw-body capture for the billing webhook plane (E014, HINT-001/FR-002). The provider HMAC is over the
    // RAW bytes, so it must be verifiable BEFORE any parse. We override the default application/json parser to
    // receive the raw Buffer, stash it on `req.rawBody` ONLY for the webhook route prefix, and still return
    // parsed JSON for EVERY route — so JSON parsing elsewhere is unchanged (the parser is faithful to the
    // default: empty body → 400, malformed JSON → 400). The webhook handler reads `req.rawBody`; all other
    // handlers see the parsed body exactly as before.
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
        const buf = body;
        if (req.url.startsWith(WEBHOOK_PATH_PREFIX))
            req.rawBody = buf;
        if (buf.length === 0) {
            // Match Fastify's default: an application/json request with an empty body is a 400.
            const err = Object.assign(new Error("Body cannot be empty when content-type is set to 'application/json'"), {
                statusCode: 400,
                code: "FST_ERR_CTP_EMPTY_JSON_BODY",
            });
            done(err, undefined);
            return;
        }
        try {
            done(null, JSON.parse(buf.toString("utf8")));
        }
        catch (e) {
            const err = Object.assign(e instanceof Error ? e : new Error(String(e)), { statusCode: 400 });
            done(err, undefined);
        }
    });
    // Human admin console (E005) authenticates via session cookies, not the machine X-API-Key.
    void app.register(cookie);
    app.addHook("preHandler", async (req, reply) => {
        if (req.url.startsWith("/internal/"))
            return; // reserved non-tenant routes (probes etc.)
        if (req.url.startsWith("/admin/"))
            return; // human session-auth path (E005); guarded by its own module
        // The billing webhook plane (E014) is authenticated by the PROVIDER HMAC SIGNATURE over the raw body,
        // NOT the machine X-API-Key — the connection resolves the tenant, and the module verifies the signature
        // before any processing (FR-002/AD-001). It must bypass this API-key gate (there is no tenant context yet).
        if (req.url.startsWith(WEBHOOK_PATH_PREFIX))
            return;
        const raw = req.headers["x-api-key"];
        if (typeof raw !== "string") {
            await reply.code(401).send({ error: "missing api key" });
            return;
        }
        const ctx = await resolveApiKey(deps.pool, raw, deps.apiKeySecret);
        if (!ctx) {
            await reply.code(401).send({ error: "invalid api key" });
            return;
        }
        req.tenant = ctx;
        // Record the authenticated tenant on the request context so the withTenant() isolation assertion
        // (OR-011) can compare it against the per-transaction tenant GUC. The context was entered at
        // onRequest before auth ran, so it carries no tenant until this point.
        setContextTenant(ctx.tenantId);
    });
    registerModules(app, deps);
    return app;
}
