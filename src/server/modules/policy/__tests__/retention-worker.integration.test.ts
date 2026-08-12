// T048 [Polish] IT (FR-014; AD-008, INV-8): the fail-open, OWNER-ROLE `policy_evaluation` retention prune over a
// config-sourced age window, against real Postgres (Testcontainers). Proves:
//   - aged rows strictly older than `now - retention` are pruned while still-in-window rows SURVIVE (bounded trail);
//   - the prune runs on the OWNER role (the app role has NO DELETE grant on the append-only audit) and is scoped
//     per-tenant by an explicit tenant_id predicate — one tenant's prune never touches another's rows (INV-1);
//   - each pruning tenant gets a synthetic-actor `policy.retention_pruned` audit row (FR-014);
//   - the sweep is FAIL-OPEN: a fault on a closed pool is caught + surfaced, never thrown.
// Rows are inserted directly on the OWNER connection with an explicit aged `created_at` (the app INSERT defaults
// created_at=now(), and the trail has no app UPDATE grant to backdate it) — a synthetic dry_run row (nullable
// license ref) satisfies the license-shape CHECK without needing a real license.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { policyRetentionSweep, POLICY_RETENTION_ACTOR, startPolicyRetentionWorker } from "../retention-worker.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const DAY_MS = 86_400_000;
const RETENTION_SECS = 7_776_000; // 90 days

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();

/** Insert a synthetic dry_run policy_evaluation row on the OWNER role with an explicit created_at. */
async function insertEval(tenantId: string, createdAt: Date, key = "api_calls"): Promise<string> {
  const id = randomUUID();
  await privileged(pool, (q) =>
    q(
      `INSERT INTO policy_evaluation
         (id, tenant_id, license_id, plan_id, entitlement_key, fired_rule, considered_rules,
          input_hash, input_snapshot, decision, mode, created_at)
       VALUES ($1, $2, NULL, NULL, $3, NULL, NULL, $4, NULL, '0'::jsonb, 'dry_run', $5)`,
      [id, tenantId, key, "0".repeat(64), createdAt],
    ),
  );
  return id;
}

async function countEvals(tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM policy_evaluation");
    return (r.rows[0] as { n: number }).n;
  });
}

async function pruneAuditCount(tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM audit_log WHERE actor = $1 AND action = 'policy.retention_pruned'", [
      POLICY_RETENTION_ACTOR,
    ]);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-retention" });
  await provisionTenant(pool, { id: tenantB, slug: "beta-policy-retention" });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("E017 policy_evaluation retention prune (integration) — FR-014", () => {
  it("prunes aged rows, retains in-window rows, isolates per tenant, and audits to the synthetic actor", async () => {
    // tenantA: one aged (100d) + one recent (1d). tenantB: one aged (100d) — proves per-tenant isolation.
    const agedA = await insertEval(tenantA, new Date(Date.now() - 100 * DAY_MS));
    await insertEval(tenantA, new Date(Date.now() - 1 * DAY_MS), "recent_calls");
    await insertEval(tenantB, new Date(Date.now() - 100 * DAY_MS));

    expect(await countEvals(tenantA)).toBe(2);
    expect(await countEvals(tenantB)).toBe(1);

    const result = await policyRetentionSweep(pool, { retentionSecs: RETENTION_SECS, now: new Date() });

    // Both tenants' aged rows pruned (2 total); the recent tenantA row survives.
    expect(result.tenants).toBe(2);
    expect(result.evaluations).toBe(2);
    expect(await countEvals(tenantA)).toBe(1); // only the recent row remains
    expect(await countEvals(tenantB)).toBe(0);

    // The pruned aged row is gone; each pruning tenant carries a synthetic-actor audit row.
    const remainingA = await withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT id FROM policy_evaluation WHERE id = $1", [agedA]);
      return r.rowCount ?? 0;
    });
    expect(remainingA).toBe(0);
    expect(await pruneAuditCount(tenantA)).toBe(1);
    expect(await pruneAuditCount(tenantB)).toBe(1);
  });

  it("is idempotent — a second sweep over the already-pruned window deletes zero rows and writes no audit", async () => {
    const before = await pruneAuditCount(tenantA);
    const result = await policyRetentionSweep(pool, { retentionSecs: RETENTION_SECS, now: new Date() });
    expect(result.evaluations).toBe(0);
    expect(result.tenants).toBe(0);
    expect(await pruneAuditCount(tenantA)).toBe(before); // no prune → no new audit row
  });

  it("the worker runOnce is fail-open on a closed pool — it never throws", async () => {
    const dead = makePool(container.getConnectionUri(), 1);
    await dead.end();
    let captured: unknown;
    const worker = startPolicyRetentionWorker(dead, {
      retentionSecs: RETENTION_SECS,
      onError: (err) => {
        captured = err;
      },
    });
    await expect(worker.runOnce()).resolves.toBeUndefined();
    worker.stop();
    expect(captured).toBeDefined();
  });
});
