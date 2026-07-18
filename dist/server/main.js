// Server entrypoint (OR-001/017, AD-001/007). Loads and validates config (fail-fast), opens the pool,
// mounts the existing modular-monolith app (createApp), registers the health probes, and listens. It
// NEVER runs migrations — schema changes are a separate gated job (OR-010, DDR-004). Startup logging is
// structured (pino) and secret-free (OR-017): a standalone logger covers the pre-app "starting" line,
// then app.log carries "listening"/"shutting down". A minimal SIGTERM/SIGINT close is included; the
// configurable bounded-window drain guarantee is OBJ7 (P2, deferred).
// TRACING PRELOAD (HINT-001, OR-013): this side-effect import MUST come first so the OTel SDK starts and
// patches pg/fastify/http BEFORE they are imported below. In production the image also loads it via
// `node --import ./dist/server/observability/tracing.js` (see package.json `start` / Dockerfile CMD); this
// first-position import is the belt-and-braces fallback so a bare `node dist/server/main.js` still traces.
// `startTracing()` is fail-open and idempotent — a failed/absent Collector never crashes bootstrap.
import "./observability/tracing.js";
import { createApp } from "./app.js";
import { configSummary, loadConfig } from "./config/index.js";
import { applySecretFile } from "./config/secrets.js";
import { makePool } from "./db/client.js";
import { registerHealth } from "./health/index.js";
import { makeCrossTenantProbe, startCanary } from "./observability/canary.js";
import { createLogger } from "./observability/logger.js";
import { setPoolStatsSource, startMetricsListener } from "./observability/metrics.js";
import { shutdownTracing } from "./observability/tracing.js";
/**
 * Assemble the app + health probes WITHOUT listening. Used by startServer and by integration tests
 * (via fastify inject) so no real port is bound. `started` gates the startup probe.
 */
export function buildServer(config, pool, opts = {}) {
    const app = createApp({ pool, apiKeySecret: config.apiKeySecret, config });
    registerHealth(app, {
        pool,
        started: opts.started,
        // The signing module decorates the app with its readiness when a signer is configured (OR-013).
        signerReady: app.signerReady,
    });
    return app;
}
/** Boot the API: hydrate file-mounted secrets, validate config, listen, and wire clean shutdown. */
export async function startServer(env = process.env) {
    // Module-owned secret (signing custody) supports the <VAR>_FILE convention too.
    applySecretFile(env, "SIGNING_CUSTODIAN_SHARES");
    const config = loadConfig(env);
    // Pre-app startup logging goes through a standalone pino built from the same config; once the app
    // exists we reuse its logger (app.log) so there is a single logger config and no double logging.
    // configSummary never carries a secret (OR-017).
    const logger = createLogger(config);
    logger.info(configSummary(config), "starting license-api");
    const pool = makePool(config.databaseUrl, config.poolMax);
    // Expose live pg-pool connection stats on the metrics registry (OR-007); detached on shutdown.
    setPoolStatsSource(pool);
    let started = false;
    const app = buildServer(config, pool, { started: () => started });
    await app.listen({ host: config.host, port: config.port });
    started = true;
    app.log.info({ host: config.host, port: config.port }, "listening");
    // Dedicated internal metrics-port listener (OR-005, AD-001): a separate OpenMetrics `/metrics` surface
    // off the public API listener, bound to loopback. `metricsPort === 0` disables it. Binding is FAIL-OPEN
    // (OR-014): a bind failure logs a warning and NEVER crashes startup, so telemetry can never take the API
    // down. `startMetricsListener` already resolves (never rejects) on a bind failure; the guard is belt-and-braces.
    let metricsListener;
    if (config.metricsPort > 0) {
        try {
            metricsListener = await startMetricsListener({ port: config.metricsPort, logger: app.log });
            if (metricsListener.bound) {
                app.log.info({ port: metricsListener.port }, "metrics listener started");
                // Tie the listener lifecycle to the app: any `app.close()` (SIGTERM, tests) also stops it, so the
                // dedicated metrics port is never leaked when the app shuts down through a path other than `shutdown`.
                app.addHook("onClose", async () => {
                    await metricsListener?.close().catch(() => undefined);
                });
            }
        }
        catch (err) {
            app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "metrics listener failed to start (fail-open)");
        }
    }
    // Synthetic tenant-isolation canary (OR-012, OBJ3): probe a KNOWN cross-tenant access at a cadence and
    // page if RLS ever fails to block it. Started ONLY when explicitly enabled AND given its two reserved
    // synthetic tenant fixtures. FAIL-OPEN and DISTINCT from the breach path: a start/probe failure warns and
    // NEVER crashes the app — it only trips the canary dead-man's switch, never the isolation page. The
    // canary's cadence timer is unref'd, and its lifecycle is tied to app.close() for clean shutdown.
    let canary;
    if (config.canaryEnabled && config.canaryScopedTenant && config.canaryTargetTenant) {
        try {
            canary = startCanary({
                probe: makeCrossTenantProbe({
                    pool,
                    scopedTenant: config.canaryScopedTenant,
                    targetTenant: config.canaryTargetTenant,
                }),
                intervalMs: config.canaryIntervalMs,
                logger: app.log,
            });
            app.log.info({ intervalMs: config.canaryIntervalMs }, "tenant-isolation canary started");
            app.addHook("onClose", async () => canary?.stop());
        }
        catch (err) {
            app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "tenant-isolation canary failed to start (fail-open)");
        }
    }
    else if (config.canaryEnabled) {
        app.log.warn({}, "tenant-isolation canary enabled but not started: set OBS_CANARY_SCOPED_TENANT and OBS_CANARY_TARGET_TENANT (reserved synthetic tenants)");
    }
    const shutdown = async (signal) => {
        app.log.info({ signal }, "shutting down");
        try {
            await app.close(); // the onClose hooks above also stop the metrics listener and the canary
        }
        finally {
            setPoolStatsSource(undefined);
            await pool.end().catch(() => undefined);
            // Best-effort flush of batched spans; fail-open (a tracing shutdown error never blocks shutdown).
            await shutdownTracing();
        }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    return { app, pool, config, metricsListener, canary };
}
// CLI entry: `node dist/server/main.js` (the image's serve command).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
    startServer().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Config may not have loaded (fail-fast), so use a minimal standalone pino for the fatal line.
        createLogger({ logLevel: "error", logFormat: "json" }).error({ error: message }, "startup failed");
        process.exit(1);
    });
}
