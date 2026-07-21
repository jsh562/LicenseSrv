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
import { startGraceWorker } from "./modules/billing/grace-worker.js";
import { startReconcileWorker } from "./modules/billing/reconcile-worker.js";
import { loadEnforcementConfig } from "./modules/enforcement/config.js";
import { startCrlWorker } from "./modules/enforcement/crl-worker.js";
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
    // Signed-CRL publication worker (E013/US4, FR-009): a periodic background job that regenerates + signs a
    // product's CRL when its revoked set changes or `next_update` elapses, and audits each publication
    // (`crl.published`). FAIL-OPEN and cancelable exactly like the observability canary above: the cadence timer
    // is unref'd, a fault on any tenant/product/sweep is caught + logged and NEVER crashes boot (the CRL is
    // belt-and-braces — a client fails OPEN when it is missing/stale, FR-011). With no signer configured it
    // no-ops (a CRL cannot be signed without the E004 key). Its lifecycle is tied to app.close() for clean
    // shutdown. NOTE: check-in retention pruning (`pruneExpiredCheckins`) is deliberately NOT scheduled here —
    // the app role holds SELECT/INSERT-only on `checkin`, so retention is a PLATFORM-OWNER job (privileged
    // role), not an app-process worker (see modules/enforcement/README.md).
    let crlWorker;
    try {
        const signer = app.signer;
        crlWorker = startCrlWorker(pool, signer, loadEnforcementConfig(env), { logger: app.log });
        app.log.info({}, "CRL publication worker started");
        app.addHook("onClose", async () => crlWorker?.stop());
    }
    catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "CRL publication worker failed to start (fail-open)");
    }
    // Billing grace-expiry auto-suspend worker (E014/US3, FR-008): a periodic TIME-driven job that suspends a
    // license via the E008 service when its subscription's grace window elapses with no recovering payment —
    // even absent any further webhook. FAIL-OPEN and cancelable exactly like the CRL worker above: the cadence
    // timer is unref'd, a fault on any tenant/subscription/sweep is caught + logged and NEVER crashes boot
    // (grace re-fires on the next sweep; recovery from suspended is still allowed). Its lifecycle is tied to
    // app.close() for clean shutdown.
    let graceWorker;
    try {
        graceWorker = startGraceWorker(pool, { logger: app.log });
        app.log.info({}, "billing grace-expiry worker started");
        app.addHook("onClose", async () => graceWorker?.stop());
    }
    catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "billing grace-expiry worker failed to start (fail-open)");
    }
    // Billing reconciliation worker (E014/US6, FR-017): a periodic self-heal that syncs each managed
    // subscription against the provider's AUTHORITATIVE state to recover from missed/dropped/out-of-order
    // webhooks — recency-guarded so it never regresses newer state. FAIL-OPEN and cancelable exactly like the
    // grace worker above: the cadence timer is unref'd, a per-tenant/per-subscription fault is caught + logged
    // and NEVER crashes boot, and with no live provider wired (the default no-op fetch) each sweep is a no-op.
    // Reads the billing seam's `providerFetch` (a real provider adapter in production). Tied to app.close().
    let reconcileWorker;
    try {
        const billing = app.billing;
        if (billing) {
            reconcileWorker = startReconcileWorker(billing, billing.providerFetch, { logger: app.log });
            app.log.info({}, "billing reconciliation worker started");
            app.addHook("onClose", async () => reconcileWorker?.stop());
        }
    }
    catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "billing reconciliation worker failed to start (fail-open)");
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
    return { app, pool, config, metricsListener, canary, crlWorker, graceWorker, reconcileWorker };
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
