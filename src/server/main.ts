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

import type { FastifyInstance } from "fastify";
import type pg from "pg";

import { createApp } from "./app.js";
import { type AppConfig, configSummary, loadConfig } from "./config/index.js";
import { applySecretFile } from "./config/secrets.js";
import { makePool } from "./db/client.js";
import { registerHealth } from "./health/index.js";
import type { BillingDeps } from "./modules/billing/index.js";
import { type GraceWorkerHandle, startGraceWorker } from "./modules/billing/grace-worker.js";
import { type ReconcileWorkerHandle, startReconcileWorker } from "./modules/billing/reconcile-worker.js";
import { type RetentionWorkerHandle, startBillingRetentionWorker } from "./modules/billing/retention-worker.js";
import { loadEnforcementConfig } from "./modules/enforcement/config.js";
import { type CrlWorkerHandle, startCrlWorker } from "./modules/enforcement/crl-worker.js";
import { loadLeaseConfig } from "./modules/lease/config.js";
import { type ReclaimWorkerHandle, startReclaimWorker } from "./modules/lease/reclaim-worker.js";
import type { Signer } from "./modules/signing/signer.js";
import { loadUsageConfig } from "./modules/usage/config.js";
import { type UsageRetentionWorkerHandle, startUsageRetentionWorker } from "./modules/usage/retention-worker.js";
import { type RollupWorkerHandle, startRollupWorker } from "./modules/usage/rollup-worker.js";
import { type CanaryHandle, makeCrossTenantProbe, startCanary } from "./observability/canary.js";
import { createLogger } from "./observability/logger.js";
import { type MetricsListener, setPoolStatsSource, startMetricsListener } from "./observability/metrics.js";
import { shutdownTracing } from "./observability/tracing.js";

export interface Server {
  app: FastifyInstance;
  pool: pg.Pool;
  config: AppConfig;
  /** The dedicated metrics listener, when started (absent when `metricsPort === 0` or bind failed). */
  metricsListener?: MetricsListener;
  /** The synthetic tenant-isolation canary, when enabled and started (absent when disabled/unconfigured). */
  canary?: CanaryHandle;
  /** The signed-CRL publication worker (E013/US4), started fail-open and tied to app.close(). */
  crlWorker?: CrlWorkerHandle;
  /** The billing grace-expiry auto-suspend worker (E014/US3), started fail-open and tied to app.close(). */
  graceWorker?: GraceWorkerHandle;
  /** The billing reconciliation worker (E014/US6), started fail-open and tied to app.close(). */
  reconcileWorker?: ReconcileWorkerHandle;
  /** The billing ledger-retention prune worker (E014/US1, FR-021), started fail-open and tied to app.close(). */
  retentionWorker?: RetentionWorkerHandle;
  /** The floating-seat lease reclaim sweeper (E015/US3, FR-010/024), started fail-open and tied to app.close(). */
  reclaimWorker?: ReclaimWorkerHandle;
  /** The usage-metering watermark rollup sweeper (E016/US2, FR-010), started fail-open and tied to app.close(). */
  rollupWorker?: RollupWorkerHandle;
  /** The usage-metering retention/prune worker (E016/US6, FR-015), started fail-open and tied to app.close(). */
  usageRetentionWorker?: UsageRetentionWorkerHandle;
}

type WithSigner = FastifyInstance & { signerReady?: () => boolean };

/**
 * Assemble the app + health probes WITHOUT listening. Used by startServer and by integration tests
 * (via fastify inject) so no real port is bound. `started` gates the startup probe.
 */
export function buildServer(
  config: AppConfig,
  pool: pg.Pool,
  opts: { started?: () => boolean } = {},
): FastifyInstance {
  const app = createApp({ pool, apiKeySecret: config.apiKeySecret, config });
  registerHealth(app, {
    pool,
    started: opts.started,
    // The signing module decorates the app with its readiness when a signer is configured (OR-013).
    signerReady: (app as WithSigner).signerReady,
  });
  return app;
}

/** Boot the API: hydrate file-mounted secrets, validate config, listen, and wire clean shutdown. */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
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
  let metricsListener: MetricsListener | undefined;
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
    } catch (err: unknown) {
      app.log.warn({ error: err instanceof Error ? err.message : String(err) }, "metrics listener failed to start (fail-open)");
    }
  }

  // Synthetic tenant-isolation canary (OR-012, OBJ3): probe a KNOWN cross-tenant access at a cadence and
  // page if RLS ever fails to block it. Started ONLY when explicitly enabled AND given its two reserved
  // synthetic tenant fixtures. FAIL-OPEN and DISTINCT from the breach path: a start/probe failure warns and
  // NEVER crashes the app — it only trips the canary dead-man's switch, never the isolation page. The
  // canary's cadence timer is unref'd, and its lifecycle is tied to app.close() for clean shutdown.
  let canary: CanaryHandle | undefined;
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
    } catch (err: unknown) {
      app.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "tenant-isolation canary failed to start (fail-open)",
      );
    }
  } else if (config.canaryEnabled) {
    app.log.warn(
      {},
      "tenant-isolation canary enabled but not started: set OBS_CANARY_SCOPED_TENANT and OBS_CANARY_TARGET_TENANT (reserved synthetic tenants)",
    );
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
  let crlWorker: CrlWorkerHandle | undefined;
  try {
    const signer = (app as FastifyInstance & { signer?: Signer }).signer;
    crlWorker = startCrlWorker(pool, signer, loadEnforcementConfig(env), { logger: app.log });
    app.log.info({}, "CRL publication worker started");
    app.addHook("onClose", async () => crlWorker?.stop());
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "CRL publication worker failed to start (fail-open)",
    );
  }

  // Billing grace-expiry auto-suspend worker (E014/US3, FR-008): a periodic TIME-driven job that suspends a
  // license via the E008 service when its subscription's grace window elapses with no recovering payment —
  // even absent any further webhook. FAIL-OPEN and cancelable exactly like the CRL worker above: the cadence
  // timer is unref'd, a fault on any tenant/subscription/sweep is caught + logged and NEVER crashes boot
  // (grace re-fires on the next sweep; recovery from suspended is still allowed). Its lifecycle is tied to
  // app.close() for clean shutdown.
  let graceWorker: GraceWorkerHandle | undefined;
  try {
    graceWorker = startGraceWorker(pool, { logger: app.log });
    app.log.info({}, "billing grace-expiry worker started");
    app.addHook("onClose", async () => graceWorker?.stop());
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "billing grace-expiry worker failed to start (fail-open)",
    );
  }

  // Billing reconciliation worker (E014/US6, FR-017): a periodic self-heal that syncs each managed
  // subscription against the provider's AUTHORITATIVE state to recover from missed/dropped/out-of-order
  // webhooks — recency-guarded so it never regresses newer state. FAIL-OPEN and cancelable exactly like the
  // grace worker above: the cadence timer is unref'd, a per-tenant/per-subscription fault is caught + logged
  // and NEVER crashes boot, and with no live provider wired (the default no-op fetch) each sweep is a no-op.
  // Reads the billing seam's `providerFetch` (a real provider adapter in production). Tied to app.close().
  let reconcileWorker: ReconcileWorkerHandle | undefined;
  try {
    const billing = (app as FastifyInstance & { billing?: BillingDeps }).billing;
    if (billing) {
      reconcileWorker = startReconcileWorker(billing, billing.providerFetch, { logger: app.log });
      app.log.info({}, "billing reconciliation worker started");
      app.addHook("onClose", async () => reconcileWorker?.stop());
    }
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "billing reconciliation worker failed to start (fail-open)",
    );
  }

  // Billing ledger-retention prune worker (E014/US1, FR-021/SC-015): a periodic PLATFORM-OWNER maintenance job
  // that enforces the GDPR-bounded ledger retention horizon by DELETing `billing_event` rows older than
  // `now - retention` (the horizon is clamped strictly above the idempotency floor so a still-redeliverable
  // event id is never pruned, FR-003). The append-only ledger has NO app-role DELETE grant, so the prune runs
  // on the schema-OWNER (privileged) connection — exactly the E013 `pruneExpiredCheckins` platform-owner path,
  // just scheduled from the app process here (the delete never touches an RLS-forced app-role connection).
  // FAIL-OPEN and cancelable like the workers above: the cadence timer is unref'd, a prune fault is caught +
  // logged and NEVER crashes boot. Reads the live retention horizon from the billing seam. Tied to app.close().
  let retentionWorker: RetentionWorkerHandle | undefined;
  try {
    const billing = (app as FastifyInstance & { billing?: BillingDeps }).billing;
    if (billing) {
      retentionWorker = startBillingRetentionWorker(pool, billing.config, { logger: app.log });
      app.log.info({}, "billing ledger-retention worker started");
      app.addHook("onClose", async () => retentionWorker?.stop());
    }
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "billing ledger-retention worker failed to start (fail-open)",
    );
  }

  // Floating-seat lease reclaim sweeper (E015/US3, FR-010/024): a periodic TIME-driven job that returns dead-
  // machine seats to the pool (TTL + grace-lapsed live leases) and proactively reclaims a revoked license's
  // live leases (revoke-reclaim), attributing every reclamation to a synthetic worker actor. FAIL-OPEN and
  // cancelable exactly like the workers above: the cadence timer is unref'd, a per-tenant/sweep fault is
  // caught + logged and NEVER crashes boot (or blocks the live acquire/renew/release surface). Tied to
  // app.close() for clean shutdown.
  let reclaimWorker: ReclaimWorkerHandle | undefined;
  try {
    const leaseConfig = loadLeaseConfig(env);
    reclaimWorker = startReclaimWorker(pool, {
      intervalMs: leaseConfig.sweepSeconds * 1_000,
      maxBatch: leaseConfig.sweepMaxBatch,
      logger: app.log,
    });
    app.log.info({}, "lease reclaim worker started");
    app.addHook("onClose", async () => reclaimWorker?.stop());
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "lease reclaim worker failed to start (fail-open)",
    );
  }

  // Usage-metering watermark rollup sweeper (E016/US2, FR-010/018): a periodic TIME-driven job that folds the
  // append-only raw usage_event stream into the durable hourly usage_rollup aggregate keyed by an advancing
  // watermark (a RECOMPUTE-from-raw, not a hot per-event counter, AD-002) — so the high-write ingest path is
  // never contended and a restart / overlapping sweep re-folds idempotently (no double-count, SC-004). A late
  // event re-opens its already-rolled bucket (FR-012); each pass is attributed to a synthetic worker actor
  // (FR-018). FAIL-OPEN and cancelable exactly like the workers above: the cadence timer is unref'd, a
  // per-tenant/sweep fault is caught + logged and NEVER crashes boot (or blocks ingest; the on-read fallback
  // keeps the open bucket eventually consistent). Tied to app.close() for clean shutdown. [COMPLETES FR-010]
  let rollupWorker: RollupWorkerHandle | undefined;
  try {
    const usageConfig = loadUsageConfig(env);
    rollupWorker = startRollupWorker(pool, {
      intervalMs: usageConfig.rollupIntervalMs,
      bucketSeconds: usageConfig.bucketSeconds,
      logger: app.log,
    });
    app.log.info({}, "usage rollup worker started");
    app.addHook("onClose", async () => rollupWorker?.stop());
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "usage rollup worker failed to start (fail-open)",
    );
  }

  // Usage-metering retention/prune worker (E016/US6, FR-015/016/018): a periodic OWNER-ROLE maintenance job that
  // prunes closed-bucket raw usage_event rows + their idempotency keys + the closed buckets' usage_unique_value
  // working rows once older than the event-timestamp acceptance window, while the durable usage_rollup +
  // usage_unique_value aggregates for still-open buckets SURVIVE (INV-6/SC-010). The app role has NO DELETE grant
  // on the usage tables, so the prune runs RLS-bypassing on the schema-owner (privileged) connection, per-tenant
  // scoped by an explicit tenant_id predicate (HINT-004) and attributed to a synthetic worker actor (FR-018).
  // FAIL-OPEN and cancelable exactly like the workers above: the cadence timer is unref'd, a prune fault is
  // caught + logged and NEVER crashes boot (or blocks ingest; it re-fires next sweep). Tied to app.close().
  // [COMPLETES FR-015]
  let usageRetentionWorker: UsageRetentionWorkerHandle | undefined;
  try {
    const usageConfig = loadUsageConfig(env);
    usageRetentionWorker = startUsageRetentionWorker(pool, {
      retentionSecs: usageConfig.retentionSecs,
      bucketSeconds: usageConfig.bucketSeconds,
      logger: app.log,
    });
    app.log.info({}, "usage retention worker started");
    app.addHook("onClose", async () => usageRetentionWorker?.stop());
  } catch (err: unknown) {
    app.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "usage retention worker failed to start (fail-open)",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close(); // the onClose hooks above also stop the metrics listener and the canary
    } finally {
      setPoolStatsSource(undefined);
      await pool.end().catch(() => undefined);
      // Best-effort flush of batched spans; fail-open (a tracing shutdown error never blocks shutdown).
      await shutdownTracing();
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { app, pool, config, metricsListener, canary, crlWorker, graceWorker, reconcileWorker, retentionWorker, reclaimWorker, rollupWorker, usageRetentionWorker };
}

// CLI entry: `node dist/server/main.js` (the image's serve command).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
  startServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Config may not have loaded (fail-fast), so use a minimal standalone pino for the fatal line.
    createLogger({ logLevel: "error", logFormat: "json" }).error({ error: message }, "startup failed");
    process.exit(1);
  });
}
