// Server entrypoint (OR-001/017, AD-001/007). Loads and validates config (fail-fast), opens the pool,
// mounts the existing modular-monolith app (createApp), registers the health probes, and listens. It
// NEVER runs migrations — schema changes are a separate gated job (OR-010, DDR-004). Startup logging is
// structured and secret-free (OR-017). A minimal SIGTERM/SIGINT close is included; the configurable
// bounded-window drain guarantee is OBJ7 (P2, deferred).
import type { FastifyInstance } from "fastify";
import type pg from "pg";

import { createApp } from "./app.js";
import { type AppConfig, configSummary, loadConfig } from "./config/index.js";
import { applySecretFile } from "./config/secrets.js";
import { makePool } from "./db/client.js";
import { registerHealth } from "./health/index.js";

export interface Server {
  app: FastifyInstance;
  pool: pg.Pool;
  config: AppConfig;
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
  const app = createApp({ pool, apiKeySecret: config.apiKeySecret });
  registerHealth(app, {
    pool,
    started: opts.started,
    // The signing module decorates the app with its readiness when a signer is configured (OR-013).
    signerReady: (app as WithSigner).signerReady,
  });
  return app;
}

function log(fields: Record<string, unknown>): void {
  // Structured single-line JSON to stdout (12-factor). configSummary never carries a secret (OR-017).
  console.log(JSON.stringify({ level: "info", ...fields }));
}

/** Boot the API: hydrate file-mounted secrets, validate config, listen, and wire clean shutdown. */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  // Module-owned secret (signing custody) supports the <VAR>_FILE convention too.
  applySecretFile(env, "SIGNING_CUSTODIAN_SHARES");
  const config = loadConfig(env);
  log({ msg: "starting license-api", ...configSummary(config) });

  const pool = makePool(config.databaseUrl, config.poolMax);
  let started = false;
  const app = buildServer(config, pool, { started: () => started });

  await app.listen({ host: config.host, port: config.port });
  started = true;
  log({ msg: "listening", host: config.host, port: config.port });

  const shutdown = async (signal: string): Promise<void> => {
    log({ msg: "shutting down", signal });
    try {
      await app.close();
    } finally {
      await pool.end().catch(() => undefined);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { app, pool, config };
}

// CLI entry: `node dist/server/main.js` (the image's serve command).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
  startServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", msg: "startup failed", error: message }));
    process.exit(1);
  });
}
