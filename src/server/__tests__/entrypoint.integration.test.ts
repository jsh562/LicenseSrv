// T014 (OR-010): the gated-migration guarantee. Booting the application against an UNMIGRATED database
// changes no schema (migrations are a separate job, DDR-004), and the migration job itself is idempotent
// and advisory-locked (concurrent runs never double-apply).
import { readdirSync } from "node:fs";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config/index.js";
import { makePool } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildServer, startServer } from "../main.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query("SELECT to_regclass($1) AS reg", [`public.${name}`]);
  return (r.rows[0] as { reg: string | null }).reg !== null;
}

describe("gated migration (integration, real Postgres)", () => {
  it("booting the app against an unmigrated DB performs NO schema change (OR-010)", async () => {
    expect(await tableExists("tenant")).toBe(false); // fresh DB — no app schema yet

    const config = loadConfig({ DATABASE_URL: container.getConnectionUri(), API_KEY_SECRET: "test-secret" });
    let app: FastifyInstance | undefined;
    try {
      app = buildServer(config, pool);
      await app.ready();
      const live = await app.inject({ url: "/internal/health/live" });
      expect(live.statusCode).toBe(200); // the app is fully assembled and serving
    } finally {
      await app?.close();
    }

    // The app never migrates on boot.
    expect(await tableExists("tenant")).toBe(false);
    expect(await tableExists("schema_migrations")).toBe(false);
  });

  it("the migrate job is advisory-locked (concurrent runs never double-apply) and idempotent", async () => {
    // Two runners race on a fresh DB; the advisory lock serializes them.
    const [a, b] = await Promise.all([runMigrations(pool, MIGRATIONS_DIR), runMigrations(pool, MIGRATIONS_DIR)]);
    const union = [...a, ...b];

    // Every migration applied exactly once across both runners — no file double-applied.
    expect(new Set(union).size).toBe(union.length); // no overlap
    expect(new Set(union)).toEqual(new Set(migrationFiles)); // all applied
    expect(await tableExists("tenant")).toBe(true); // schema is now present

    // A subsequent run is a no-op (idempotent).
    const third = await runMigrations(pool, MIGRATIONS_DIR);
    expect(third).toEqual([]);
  });

  it("startServer boots on an ephemeral port and serves the probes (OR-001)", async () => {
    // DB is migrated by the prior test. Bind an ephemeral port (PORT=0) to avoid conflicts.
    const server = await startServer({
      DATABASE_URL: container.getConnectionUri(),
      API_KEY_SECRET: "boot-secret",
      HOST: "127.0.0.1",
      PORT: "0",
    });
    try {
      const addr = server.app.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      const live = await fetch(`http://127.0.0.1:${port}/internal/health/live`);
      expect(live.status).toBe(200);
      const startup = await fetch(`http://127.0.0.1:${port}/internal/health/startup`);
      expect(startup.status).toBe(200); // started flips true after listen
    } finally {
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      await server.app.close();
      await server.pool.end().catch(() => undefined);
    }
  });
});
