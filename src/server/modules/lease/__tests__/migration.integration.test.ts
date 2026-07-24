// T014 (FR-019/021) [COMPLETES FR-021]: the 0011 lease migration against real Postgres. Asserts the new
// `lease` table + its indexes apply; forced RLS refuses unscoped access (unset GUC -> 0 rows) and cross-
// tenant rows are invisible; the partial-unique `lease_one_live` bounds ONE live lease per (license, holder)
// while allowing a re-acquire after release; the nonce UNIQUE (tenant, nonce) rejects a replay; the composite
// FK (tenant, license_id) -> license rejects an unknown license and BLOCKS a hard-delete of a referenced
// license (ON DELETE NO ACTION); the app role has NO DELETE on lease; and the plan/license snapshot CHECKs
// (TTL >= 3× heartbeat, scope enum, overage >= 0) reject bad rows. Reuses the testcontainers + migration
// harness — schema-level, no app/signer needed.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();

let licenseA: string;

/** Seed a product/plan/customer/license chain with a floating entitlement (max_concurrent = 5). */
async function seedChain(tenantId: string): Promise<{ licenseId: string }> {
  return withTenant(pool, tenantId, async (q) => {
    const productId = randomUUID();
    const planId = randomUUID();
    const customerId = randomUUID();
    const licenseId = randomUUID();
    await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${GUC}, $2, 'P')`, [productId, `prod-${productId.slice(0, 8)}`]);
    await q(`INSERT INTO plan (id, tenant_id, product_id, key, name, max_concurrent) VALUES ($1, ${GUC}, $2, $3, 'Plan', 5)`, [planId, productId, `plan-${planId.slice(0, 8)}`]);
    await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${GUC}, $2)`, [customerId, `cust-${customerId.slice(0, 8)}`]);
    await q(
      `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token, max_concurrent)
       VALUES ($1, ${GUC}, $2, $3, $4, 5, '{"pro":true}'::jsonb, 1, $5, 'LIC1.seed', 5)`,
      [licenseId, productId, planId, customerId, `lnonce-${licenseId.slice(0, 8)}`],
    );
    return { licenseId };
  });
}

/** Insert a live lease directly (schema-level) for `licenseId` with an explicit holder key + nonce. */
async function insertLive(tenantId: string, licenseId: string, holderKey: Buffer, nonce: string): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO lease (id, tenant_id, license_id, holder_key, concurrency_scope, expires_at, nonce)
       VALUES ($1, ${GUC}, $2, $3, 'session', now() + make_interval(secs => 1800), $4)`,
      [id, licenseId, holderKey, nonce],
    );
    return id;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-lease" });
  await provisionTenant(pool, { id: tenantB, slug: "other-lease" });
  const seeded = await seedChain(tenantA);
  licenseA = seeded.licenseId;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0011 lease migration (integration, real Postgres)", () => {
  it("creates the lease table and its indexes (one_live / seat / reclaim / prune)", async () => {
    const tbl = await privileged(pool, (q) =>
      q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'lease'`),
    );
    expect(tbl.rowCount).toBe(1);
    const idx = await privileged(pool, (q) =>
      q(`SELECT indexname FROM pg_indexes WHERE tablename = 'lease' ORDER BY indexname`),
    );
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(expect.arrayContaining(["lease_one_live", "lease_seat", "lease_reclaim", "lease_prune"]));
  });

  it("adds the expand-only concurrency snapshot columns to plan + license", async () => {
    const cols = await privileged(pool, (q) =>
      q(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name IN ('plan','license') AND column_name IN ('max_concurrent','concurrency_scope','concurrency_overage','lease_ttl_seconds','lease_policy_on_revoke')`,
      ),
    );
    const set = new Set(cols.rows.map((r) => `${(r as { table_name: string }).table_name}.${(r as { column_name: string }).column_name}`));
    for (const c of ["max_concurrent", "concurrency_scope", "concurrency_overage", "lease_ttl_seconds", "lease_policy_on_revoke"]) {
      expect(set.has(`plan.${c}`)).toBe(true);
      expect(set.has(`license.${c}`)).toBe(true);
    }
  });

  it("forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on lease (FR-019)", async () => {
    await insertLive(tenantA, licenseA, Buffer.from("hk-rls-1"), `n-rls-${randomUUID()}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      const r = await client.query("SELECT count(*)::int AS n FROM lease");
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant lease rows are invisible — tenant B sees none of tenant A's leases (FR-019, SC-012)", async () => {
    const n = await withTenant(pool, tenantB, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM lease");
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });

  it("bounds ONE live lease per (license, holder) via the partial-unique lease_one_live (FR-023)", async () => {
    const hk = Buffer.from("hk-one-live");
    const first = await insertLive(tenantA, licenseA, hk, `n-ol-${randomUUID()}`);
    // A second LIVE lease for the same holder is rejected by the partial unique index.
    await expect(insertLive(tenantA, licenseA, hk, `n-ol-${randomUUID()}`)).rejects.toThrow(/duplicate key value|unique|lease_one_live/i);
    // Release the first (soft transition), then the SAME holder may re-acquire (terminal rows unconstrained).
    await withTenant(pool, tenantA, (q) =>
      q("UPDATE lease SET status = 'released', ended_at = now(), updated_at = now() WHERE id = $1", [first]),
    );
    const reacquired = await insertLive(tenantA, licenseA, hk, `n-ol-${randomUUID()}`);
    expect(reacquired).toBeTruthy();
  });

  it("rejects a replayed acquire nonce via UNIQUE (tenant, nonce) (FR-014)", async () => {
    const nonce = `n-dup-${randomUUID()}`;
    await insertLive(tenantA, licenseA, Buffer.from(`hk-nonce-${randomUUID()}`), nonce);
    await expect(
      insertLive(tenantA, licenseA, Buffer.from(`hk-nonce-${randomUUID()}`), nonce),
    ).rejects.toThrow(/duplicate key value|unique|lease_nonce_uniq/i);
  });

  it("the composite FK rejects a lease bound to an unknown license", async () => {
    await expect(
      insertLive(tenantA, randomUUID(), Buffer.from("hk-fk"), `n-fk-${randomUUID()}`),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("ON DELETE NO ACTION — a license with any lease cannot be hard-deleted (FR-021)", async () => {
    await insertLive(tenantA, licenseA, Buffer.from(`hk-nodelete-${randomUUID()}`), `n-nd-${randomUUID()}`);
    // Even as the privileged owner, the composite FK blocks deleting a referenced license.
    await expect(
      privileged(pool, (q) => q("DELETE FROM license WHERE id = $1", [licenseA])),
    ).rejects.toThrow(/foreign key|violates|still referenced/i);
  });

  it("the app role has NO DELETE on lease (soft transitions + retention purge only)", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM lease"))).rejects.toThrow(/permission denied/i);
    // SELECT / INSERT / UPDATE are granted.
    const upd = await withTenant(pool, tenantA, (q) =>
      q("UPDATE lease SET updated_at = now() WHERE license_id = $1 RETURNING id", [licenseA]),
    );
    expect((upd.rowCount ?? 0)).toBeGreaterThan(0);
  });

  it("enforces the snapshot CHECKs on license — TTL ≥ 3× heartbeat, scope enum, overage ≥ 0 (FR-009)", async () => {
    const badLicense = (col: string, val: string): Promise<unknown> =>
      withTenant(pool, tenantA, async (q) => {
        const productId = randomUUID();
        const planId = randomUUID();
        const customerId = randomUUID();
        await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${GUC}, $2, 'P')`, [productId, `p-${productId.slice(0, 8)}`]);
        await q(`INSERT INTO plan (id, tenant_id, product_id, key, name) VALUES ($1, ${GUC}, $2, $3, 'Pl')`, [planId, productId, `pl-${planId.slice(0, 8)}`]);
        await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${GUC}, $2)`, [customerId, `c-${customerId.slice(0, 8)}`]);
        await q(
          `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token, ${col})
           VALUES ($1, ${GUC}, $2, $3, $4, 5, '{}'::jsonb, 1, $5, 'LIC1.seed', ${val})`,
          [randomUUID(), productId, planId, customerId, `ln-${randomUUID()}`],
        );
      });
    // TTL 100 with default heartbeat 600 => TTL < 3× heartbeat => rejected.
    await expect(badLicense("lease_ttl_seconds", "100")).rejects.toThrow(/lease_ttl_ge_3x_hb|check constraint/i);
    await expect(badLicense("concurrency_scope", "'bogus'")).rejects.toThrow(/concurrency_scope_valid|check constraint/i);
    await expect(badLicense("concurrency_overage", "-1")).rejects.toThrow(/concurrency_overage_nn|check constraint/i);
  });
});
