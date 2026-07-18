import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

import { resolveApiKey } from "./auth/apikey.js";
import type { AppConfig } from "./config/index.js";
import { registerModules } from "./modules/index.js";
import { recordRed } from "./observability/metrics.js";
import { buildRequestLog, createLogger, type LoggerConfig, outcomeFromStatus } from "./observability/logger.js";
import { enterRequestContext, genReqId, sanitizeClientRequestId, setContextTenant } from "./observability/request-context.js";

export interface AppDeps {
  pool: pg.Pool;
  apiKeySecret: string;
  /**
   * Validated runtime config — drives the pino logger (level/format) and downstream telemetry.
   * Optional so existing callers (tests) keep working; when absent a safe default logger is used.
   */
  config?: AppConfig;
}

/** Logger config used when a caller does not supply `config` (e.g. integration tests). */
const DEFAULT_LOGGER_CONFIG: LoggerConfig = { logLevel: "info", logFormat: "json" };

declare module "fastify" {
  interface FastifyRequest {
    tenant?: { tenantId: string; scopes: string[] };
  }
}

/**
 * The modular-monolith application skeleton (TR-010). Establishes the tenant-resolution
 * auth context (machine/runtime API key -> tenant + scopes, TR-009) and registers the
 * reserved feature-module seams. Business endpoints are added by the feature epics.
 */
export function createApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    // Pre-built pino instance (Fastify 5 `loggerInstance`); level/format from config (OR-001/004).
    loggerInstance: createLogger(deps.config ?? DEFAULT_LOGGER_CONFIG),
    // We emit exactly ONE structured line per request ourselves (Phase 3), so Fastify's default
    // request/response auto-logging is suppressed to avoid the extra pair of lines (OR-001).
    disableRequestLogging: true,
    // Authoritative, server-generated request id — inbound headers are never trusted (AD-002).
    genReqId: () => genReqId(),
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

  // Human admin console (E005) authenticates via session cookies, not the machine X-API-Key.
  void app.register(cookie);

  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/internal/")) return; // reserved non-tenant routes (probes etc.)
    if (req.url.startsWith("/admin/")) return; // human session-auth path (E005); guarded by its own module
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
