// Health probes (OR-012/013, AD-005). Three endpoints on the unauthenticated /internal/ path:
//   - live:    the process is alive — independent of any dependency (gates the container's lifetime).
//   - ready:   can currently serve — the database probe (SELECT 1) plus, where a signer is configured,
//              its composed readiness. Fails 503 on any degraded dependency so traffic is withheld
//              WITHOUT the container being killed (readiness gates traffic, liveness gates the process).
//   - startup: initial boot completed (listener bound), used to defer live/ready during startup.
// Payloads are dependency-status only — never a secret or tenant detail.
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";

export interface HealthDeps {
  pool: pg.Pool;
  /** Returns true once the server has bound its listener (startup complete). Default: always started. */
  started?: () => boolean;
  /** Optional composed signer readiness (present when a signer is configured). */
  signerReady?: () => boolean;
  /** Database probe timeout in ms (default 2000). */
  dbTimeoutMs?: number;
}

interface Check {
  name: string;
  status: "up" | "down";
}

const timeout = (ms: number): Promise<never> =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref());

/** True iff `SELECT 1` succeeds within the timeout — the readiness database check. */
async function checkDatabase(pool: pg.Pool, timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([pool.query("SELECT 1"), timeout(timeoutMs)]);
    return true;
  } catch {
    return false;
  }
}

/** Register the liveness, readiness, and startup probes under /internal/health/. */
export function registerHealth(app: FastifyInstance, deps: HealthDeps): void {
  const dbTimeout = deps.dbTimeoutMs ?? 2000;

  // Liveness — never touches a dependency; a DB outage must not restart the container.
  app.get("/internal/health/live", async () => ({ status: "alive" }));

  // Startup — 200 once the listener is bound; 503 while still starting.
  app.get("/internal/health/startup", async (_req, reply: FastifyReply) => {
    const started = deps.started ? deps.started() : true;
    return reply.code(started ? 200 : 503).send({ status: started ? "started" : "starting" });
  });

  // Readiness — DB (+ composed signer) health; gates traffic.
  app.get("/internal/health/ready", async (_req, reply: FastifyReply) => {
    const checks: Check[] = [];
    checks.push({ name: "database", status: (await checkDatabase(deps.pool, dbTimeout)) ? "up" : "down" });
    if (deps.signerReady) {
      checks.push({ name: "signer", status: deps.signerReady() ? "up" : "down" });
    }
    const ready = checks.every((c) => c.status === "up");
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not-ready", checks });
  });
}
