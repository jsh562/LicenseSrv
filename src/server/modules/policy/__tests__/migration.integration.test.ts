// T019 (FR-011/FR-014/FR-015) [Foundational]: the 0013 policy-rules migration against real Postgres. Asserts
// the two new tenant-owned tables (policy_rule / policy_evaluation) apply and behave: (a) forced RLS refuses
// unscoped access -> an unset app.current_tenant GUC yields 0 rows on BOTH tables (SC-012); (b) the immutable
// versioning UNIQUE (policy_rule_version_uniq) rejects a duplicate (rule_key, version) AND the partial
// policy_rule_one_live UNIQUE rejects a second live (active|preview) version per rule_key; (c) the
// policy_evaluation_license_shape CHECK rejects a NON-dry_run row with a NULL license_id and PERMITS a dry_run
// with a NULL license_id; (d) the policy_evaluation_considered_array CHECK rejects a non-array considered_rules.
// Reuses the testcontainers + migration harness (schema-level, no app/signer needed), mirroring the E016
// usage migration.integration.test.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();

let planA: string;
let licenseA: string;
let entitlementA: string;

/** Seed a product/plan/customer/license chain + a (boolean) entitlement for tenant `tenantId`. */
async function seedChain(tenantId: string): Promise<{ planId: string; licenseId: string; entitlementId: string }> {
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
      `INSERT INTO entitlement (id, tenant_id, key, name, type) VALUES ($1, ${GUC}, $2, 'Feature', 'boolean')`,
      [entitlementId, `feat-${entitlementId.slice(0, 8)}`],
    );
    return { planId, licenseId, entitlementId };
  });
}

/** Insert a policy_rule version row directly (schema-level). */
async function insertRule(
  tenantId: string,
  ruleKey: string,
  version: number,
  status: "active" | "preview" | "disabled",
): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO policy_rule (id, tenant_id, rule_key, version, entitlement_id, condition, effect, status, author)
       VALUES ($1, ${GUC}, $2, $3, $4, '{"==":[1,1]}'::jsonb, '{"kind":"toggle_boolean","target":"feat","value":true}'::jsonb, $5, 'admin')`,
      [id, ruleKey, version, entitlementA, status],
    );
    return id;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy" });
  const seeded = await seedChain(tenantA);
  planA = seeded.planId;
  licenseA = seeded.licenseId;
  entitlementA = seeded.entitlementId;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0013 policy-rules migration (integration, real Postgres)", () => {
  it("creates the two policy tables and their indexes", async () => {
    const tbl = await withTenant(pool, tenantA, (q) =>
      q(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('policy_rule','policy_evaluation')`,
      ),
    );
    expect(tbl.rowCount).toBe(2);
    const idx = await withTenant(pool, tenantA, (q) =>
      q(`SELECT indexname FROM pg_indexes WHERE tablename IN ('policy_rule','policy_evaluation') ORDER BY indexname`),
    );
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "policy_rule_eval",
        "policy_rule_one_live",
        "policy_evaluation_license",
        "policy_evaluation_prune",
      ]),
    );
  });

  it("adds the expand-only entitlement rule-bound columns (rule_max/rule_eligible/rule_tiers)", async () => {
    const cols = await withTenant(pool, tenantA, (q) =>
      q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entitlement' AND column_name IN ('rule_max','rule_eligible','rule_tiers')`,
      ),
    );
    expect(cols.rowCount).toBe(3);
    // Existing rows default rule_eligible=false (safe: not rule-eligible) with NULL bounds.
    const r = await withTenant(pool, tenantA, (q) =>
      q("SELECT rule_eligible, rule_max, rule_tiers FROM entitlement WHERE id = $1", [entitlementA]),
    );
    const row = r.rows[0] as { rule_eligible: boolean; rule_max: string | null; rule_tiers: unknown };
    expect(row.rule_eligible).toBe(false);
    expect(row.rule_max).toBeNull();
    expect(row.rule_tiers).toBeNull();
  });

  it("(a) forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on BOTH policy tables (SC-012)", async () => {
    // Seed one row into each table under a proper tenant scope first.
    await insertRule(tenantA, `rls-${randomUUID().slice(0, 8)}`, 1, "active");
    await withTenant(pool, tenantA, (q) =>
      q(
        `INSERT INTO policy_evaluation (id, tenant_id, license_id, plan_id, entitlement_key, input_hash, decision, mode)
         VALUES ($1, ${GUC}, $2, $3, 'feat', 'h-rls', '{"value":true}'::jsonb, 'enforced')`,
        [randomUUID(), licenseA, planA],
      ),
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      for (const table of ["policy_rule", "policy_evaluation"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("(b) policy_rule_version_uniq rejects a duplicate (rule_key, version)", async () => {
    const ruleKey = `dup-${randomUUID().slice(0, 8)}`;
    await insertRule(tenantA, ruleKey, 1, "disabled");
    await expect(insertRule(tenantA, ruleKey, 1, "disabled")).rejects.toThrow(
      /duplicate key value|unique|policy_rule_version_uniq/i,
    );
    // A distinct version of the same logical rule is accepted (immutable versioning).
    const id = await insertRule(tenantA, ruleKey, 2, "disabled");
    expect(id).toBeTruthy();
  });

  it("(b) policy_rule_one_live rejects a SECOND live (active|preview) version per rule_key", async () => {
    const ruleKey = `live-${randomUUID().slice(0, 8)}`;
    await insertRule(tenantA, ruleKey, 1, "active");
    // A second live version (preview) of the same logical rule violates the partial UNIQUE.
    await expect(insertRule(tenantA, ruleKey, 2, "preview")).rejects.toThrow(
      /duplicate key value|unique|policy_rule_one_live/i,
    );
    // But a disabled version does NOT occupy the single-live slot.
    const id = await insertRule(tenantA, ruleKey, 3, "disabled");
    expect(id).toBeTruthy();
  });

  it("(c) policy_evaluation_license_shape rejects a NON-dry_run row with a NULL license_id", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO policy_evaluation (id, tenant_id, license_id, entitlement_key, input_hash, decision, mode)
           VALUES ($1, ${GUC}, NULL, 'feat', 'h1', '{"value":true}'::jsonb, 'enforced')`,
          [randomUUID()],
        ),
      ),
    ).rejects.toThrow(/policy_evaluation_license_shape|check constraint/i);
  });

  it("(c) policy_evaluation_license_shape PERMITS a dry_run row with a NULL license_id (synthetic context)", async () => {
    const ok = await withTenant(pool, tenantA, (q) =>
      q(
        `INSERT INTO policy_evaluation (id, tenant_id, license_id, entitlement_key, input_hash, decision, mode)
         VALUES ($1, ${GUC}, NULL, 'feat', 'h2', '{"value":true}'::jsonb, 'dry_run') RETURNING id`,
        [randomUUID()],
      ),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("(d) policy_evaluation_considered_array rejects a non-array considered_rules", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO policy_evaluation (id, tenant_id, license_id, plan_id, entitlement_key, considered_rules, input_hash, decision, mode)
           VALUES ($1, ${GUC}, $2, $3, 'feat', '{"not":"an-array"}'::jsonb, 'h3', '{"value":true}'::jsonb, 'enforced')`,
          [randomUUID(), licenseA, planA],
        ),
      ),
    ).rejects.toThrow(/policy_evaluation_considered_array|check constraint/i);
    // A JSON array (or NULL) is accepted.
    const ok = await withTenant(pool, tenantA, (q) =>
      q(
        `INSERT INTO policy_evaluation (id, tenant_id, license_id, plan_id, entitlement_key, considered_rules, input_hash, decision, mode)
         VALUES ($1, ${GUC}, $2, $3, 'feat', '[{"rule_key":"k","version":1}]'::jsonb, 'h4', '{"value":true}'::jsonb, 'enforced') RETURNING id`,
        [randomUUID(), licenseA, planA],
      ),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("the app role has NO DELETE on policy_evaluation (append-only; prune is the owner path)", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM policy_evaluation"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});
