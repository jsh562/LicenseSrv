// T018 (OR-012/013): the probes against a real Postgres. Readiness reflects DB reachability and the
// composed signer status; liveness stays healthy when the DB is down (so the container is not killed);
// the readiness payload is dependency-status only (no secret/tenant detail).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool } from "../../db/client.js";
import { registerHealth } from "../index.js";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance; // with a signer configured
let appNoSigner: FastifyInstance;

let started = true;
let signerUp = true;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 4);

  app = Fastify({ logger: false });
  registerHealth(app, { pool, started: () => started, signerReady: () => signerUp, dbTimeoutMs: 1500 });
  await app.ready();

  appNoSigner = Fastify({ logger: false });
  registerHealth(appNoSigner, { pool, dbTimeoutMs: 1500 });
  await appNoSigner.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await appNoSigner?.close();
  await pool?.end();
  await container?.stop();
});

describe("health probes (integration, real Postgres)", () => {
  it("liveness is always alive", async () => {
    const r = await app.inject({ method: "GET", url: "/internal/health/live" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "alive" });
  });

  it("startup reflects the started gate", async () => {
    started = true;
    expect((await app.inject({ url: "/internal/health/startup" })).statusCode).toBe(200);
    started = false;
    const r = await app.inject({ url: "/internal/health/startup" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: "starting" });
    started = true;
  });

  it("readiness is 200 when the DB and signer are up; payload is status-only", async () => {
    signerUp = true;
    const r = await app.inject({ method: "GET", url: "/internal/health/ready" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; checks: Array<{ name: string; status: string }> };
    expect(body.status).toBe("ready");
    expect(body.checks).toEqual([
      { name: "database", status: "up" },
      { name: "signer", status: "up" },
    ]);
    // No secret/tenant detail — exactly the two documented keys.
    expect(Object.keys(body).sort()).toEqual(["checks", "status"]);
  });

  it("readiness is 503 when the composed signer is down (DB still up)", async () => {
    signerUp = false;
    const r = await app.inject({ url: "/internal/health/ready" });
    expect(r.statusCode).toBe(503);
    const body = r.json() as { status: string; checks: Array<{ name: string; status: string }> };
    expect(body.status).toBe("not-ready");
    expect(body.checks).toContainEqual({ name: "signer", status: "down" });
    expect(body.checks).toContainEqual({ name: "database", status: "up" });
    signerUp = true;
  });

  it("omits the signer check when no signer is configured", async () => {
    const r = await appNoSigner.inject({ url: "/internal/health/ready" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { checks: Array<{ name: string }> };
    expect(body.checks.map((c) => c.name)).toEqual(["database"]);
  });

  it("readiness flips to not-ready when the DB is unreachable, but liveness stays alive (OR-013)", async () => {
    // A pool pointed at an unreachable server models a down/degraded database without disturbing the
    // shared container. Swallow the pool's async connection errors (expected here).
    const deadPool = makePool("postgres://x:x@127.0.0.1:1/none", 1);
    deadPool.on("error", () => undefined);
    const deadApp = Fastify({ logger: false });
    registerHealth(deadApp, { pool: deadPool, dbTimeoutMs: 800 });
    await deadApp.ready();
    try {
      const ready = await deadApp.inject({ url: "/internal/health/ready" });
      expect(ready.statusCode).toBe(503);
      const body = ready.json() as { status: string; checks: Array<{ name: string; status: string }> };
      expect(body.status).toBe("not-ready");
      expect(body.checks).toContainEqual({ name: "database", status: "down" });

      const live = await deadApp.inject({ url: "/internal/health/live" });
      expect(live.statusCode).toBe(200); // liveness independent of the DB
    } finally {
      await deadApp.close();
      await deadPool.end().catch(() => undefined);
    }
  });
});
