// T013 (FR-017) [Foundational]: the 0012 usage-metering migration against real Postgres. Asserts the three
// new tables (usage_event / usage_rollup / usage_unique_value) + their indexes apply; the expand-only E007
// entitlement metered extension (type CHECK admits `metered`; the metered-shape + aggregation/allowance
// CHECKs); forced RLS refuses unscoped access (unset GUC -> 0 rows on ALL THREE tables) and cross-tenant
// rows are invisible; the `(tenant, source, event_id)` dedupe UNIQUE rejects a duplicate; the composite FKs
// (tenant, license_id) / (tenant, entitlement_id) reject an unknown ref and BLOCK a hard-delete of a
// referenced license (ON DELETE NO ACTION); the hourly-bucket CHECK rejects a non-hour usage_rollup bucket;
// and the app role has NO DELETE on usage_event (append-only). Reuses the testcontainers + migration harness
// — schema-level, no app/signer needed.
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
let entitlementA: string;

/** Seed a product/plan/customer/license chain + a metered (SUM) entitlement for tenant `tenantId`. */
async function seedChain(tenantId: string): Promise<{ licenseId: string; entitlementId: string }> {
  return withTenant(pool, tenantId, async (q) => {
    const productId = randomUUID();
    const planId = randomUUID();
    const customerId = randomUUID();
    const licenseId = randomUUID();
    const entitlementId = randomUUID();
    await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${GUC}, $2, 'P')`, [productId, `prod-${productId.slice(0, 8)}`]);
    await q(`INSERT INTO plan (id, tenant_id, product_id, key, name) VALUES ($1, ${GUC}, $2, $3, 'Plan')`, [planId, productId, `plan-${planId.slice(0, 8)}`]);
    await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${GUC}, $2)`, [customerId, `cust-${customerId.slice(0, 8)}`]);
    await q(
      `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token)
       VALUES ($1, ${GUC}, $2, $3, $4, 5, '{"pro":true}'::jsonb, 1, $5, 'LIC1.seed')`,
      [licenseId, productId, planId, customerId, `lnonce-${licenseId.slice(0, 8)}`],
    );
    await q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, aggregation, unit, allowance)
       VALUES ($1, ${GUC}, $2, 'Metered', 'metered', 'sum', 'gb', 10000)`,
      [entitlementId, `meter-${entitlementId.slice(0, 8)}`],
    );
    return { licenseId, entitlementId };
  });
}

/** Insert a raw usage_event directly (schema-level) with an explicit (source, event_id) idempotency key. */
async function insertEvent(
  tenantId: string,
  licenseId: string,
  entitlementId: string,
  source: string,
  eventId: string,
): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO usage_event (id, tenant_id, license_id, entitlement_id, source, event_id, event_time, quantity)
       VALUES ($1, ${GUC}, $2, $3, $4, $5, now(), 100)`,
      [id, licenseId, entitlementId, source, eventId],
    );
    return id;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-usage" });
  await provisionTenant(pool, { id: tenantB, slug: "other-usage" });
  const seeded = await seedChain(tenantA);
  licenseA = seeded.licenseId;
  entitlementA = seeded.entitlementId;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0012 usage-metering migration (integration, real Postgres)", () => {
  it("creates the three usage tables and their indexes", async () => {
    const tbl = await privileged(pool, (q) =>
      q(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('usage_event','usage_rollup','usage_unique_value')`,
      ),
    );
    expect(tbl.rowCount).toBe(3);
    const idx = await privileged(pool, (q) =>
      q(`SELECT indexname FROM pg_indexes WHERE tablename = 'usage_event' ORDER BY indexname`),
    );
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(expect.arrayContaining(["usage_event_rollup", "usage_event_prune"]));
  });

  it("expands the E007 entitlement type CHECK to admit `metered` + the metered-only columns", async () => {
    const cols = await privileged(pool, (q) =>
      q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entitlement' AND column_name IN ('aggregation','unit','allowance')`,
      ),
    );
    expect(cols.rowCount).toBe(3);
    // A metered entitlement was seeded in beforeAll -> the type CHECK accepts it.
    const r = await withTenant(pool, tenantA, (q) =>
      q("SELECT type, aggregation FROM entitlement WHERE id = $1", [entitlementA]),
    );
    expect((r.rows[0] as { type: string; aggregation: string }).type).toBe("metered");
  });

  it("enforces the metered-shape CHECK — a metered row MUST carry aggregation + unit", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO entitlement (id, tenant_id, key, name, type) VALUES ($1, ${GUC}, $2, 'Bad', 'metered')`,
          [randomUUID(), `bad-${randomUUID().slice(0, 8)}`],
        ),
      ),
    ).rejects.toThrow(/entitlement_metered_shape|check constraint/i);
  });

  it("enforces the aggregation-valid CHECK — a bad aggregation value is rejected", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO entitlement (id, tenant_id, key, name, type, aggregation, unit)
           VALUES ($1, ${GUC}, $2, 'Bad', 'metered', 'median', 'x')`,
          [randomUUID(), `bad2-${randomUUID().slice(0, 8)}`],
        ),
      ),
    ).rejects.toThrow(/entitlement_aggregation_valid|check constraint/i);
  });

  it("a non-metered entitlement may NOT carry the metered-only columns (shape CHECK)", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO entitlement (id, tenant_id, key, name, type, aggregation)
           VALUES ($1, ${GUC}, $2, 'Bool', 'boolean', 'sum')`,
          [randomUUID(), `bad3-${randomUUID().slice(0, 8)}`],
        ),
      ),
    ).rejects.toThrow(/entitlement_metered_shape|check constraint/i);
  });

  it("forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on all three tables (SC-012)", async () => {
    await insertEvent(tenantA, licenseA, entitlementA, "src-rls", `ev-rls-${randomUUID()}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      for (const table of ["usage_event", "usage_rollup", "usage_unique_value"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant usage rows are invisible — tenant B sees none of tenant A's events (FR-017, SC-012)", async () => {
    const n = await withTenant(pool, tenantB, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM usage_event");
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });

  it("dedupe UNIQUE (tenant, source, event_id) rejects a re-reported key", async () => {
    const source = "src-dedupe";
    const eventId = `ev-dedupe-${randomUUID()}`;
    await insertEvent(tenantA, licenseA, entitlementA, source, eventId);
    await expect(insertEvent(tenantA, licenseA, entitlementA, source, eventId)).rejects.toThrow(
      /duplicate key value|unique|usage_event_idem_uniq/i,
    );
  });

  it("the composite FK rejects an event bound to an unknown license", async () => {
    await expect(
      insertEvent(tenantA, randomUUID(), entitlementA, "src-fk", `ev-fk-${randomUUID()}`),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("ON DELETE NO ACTION — a license with any usage_event cannot be hard-deleted (FR-017)", async () => {
    await insertEvent(tenantA, licenseA, entitlementA, "src-nodelete", `ev-nd-${randomUUID()}`);
    await expect(
      privileged(pool, (q) => q("DELETE FROM license WHERE id = $1", [licenseA])),
    ).rejects.toThrow(/foreign key|violates|still referenced/i);
  });

  it("the hourly-bucket CHECK rejects a non-hour usage_rollup bucket", async () => {
    const badBucket = withTenant(pool, tenantA, (q) =>
      q(
        `INSERT INTO usage_rollup (id, tenant_id, license_id, entitlement_id, bucket, agg_type, watermark_ingested_at)
         VALUES ($1, ${GUC}, $2, $3, '2026-08-02T08:15:00Z', 'sum', now())`,
        [randomUUID(), licenseA, entitlementA],
      ),
    );
    await expect(badBucket).rejects.toThrow(/usage_rollup_bucket_hourly|check constraint/i);
    // A whole UTC hour is accepted.
    const okBucket = await withTenant(pool, tenantA, (q) =>
      q(
        `INSERT INTO usage_rollup (id, tenant_id, license_id, entitlement_id, bucket, agg_type, watermark_ingested_at)
         VALUES ($1, ${GUC}, $2, $3, '2026-08-02T08:00:00Z', 'sum', now()) RETURNING id`,
        [randomUUID(), licenseA, entitlementA],
      ),
    );
    expect(okBucket.rowCount).toBe(1);
  });

  it("the app role has NO DELETE on usage_event (append-only; prune is the owner path)", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM usage_event"))).rejects.toThrow(
      /permission denied/i,
    );
    // SELECT + INSERT are granted.
    const sel = await withTenant(pool, tenantA, (q) => q("SELECT count(*)::int AS n FROM usage_event"));
    expect((sel.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
