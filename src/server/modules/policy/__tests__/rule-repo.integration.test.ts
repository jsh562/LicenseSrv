// [Foundational] T020 (FR-011/014/019): PolicyRuleRepo integration tests against real Postgres (Testcontainers +
// migrations 0000-0013). Proves the load-bearing repo invariants ADR-0014 requires:
//   - INV-2 (immutable content): `updateStatus` is the SOLE update path and changes ONLY `status`/`updated_at` —
//     every content column (condition/effect/priority/entitlement_id/plan_id/rule_key/version/author/created_at)
//     is byte-identical before and after. A content-column UPDATE is never performed through the repo.
//   - Immutable versioning (FR-011): a content edit is a NEW `(rule_key, version+1)` row via `nextVersion` +
//     `insertVersion`; the prior version row is retained unchanged.
//   - Live-rule-count (FR-019): `countLiveRulesForTenant` / `countLiveRulesForEntitlement` count active|preview.
// Also smoke-tests the append-only `policy_evaluation` write (INV-8). Reuses the testcontainers + migration
// harness idiom from the E016 usage integration tests.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { PolicyRuleRepo } from "../rule-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const repo = new PolicyRuleRepo();

const tenantA = randomUUID();
let planA: string;
let licenseA: string;
let entitlementA: string;

const condV1 = { "==": [{ var: "entitlement.type" }, "metered"] };
const effV1 = { kind: "adjust_limit", target: "api_calls", value: 5_000 };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-repo" });
  const seeded = await seedChainIn(tenantA);
  planA = seeded.planId;
  licenseA = seeded.licenseId;
  entitlementA = seeded.entitlementId;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("PolicyRuleRepo — immutable content + status-only UPDATE (INV-2), versioning (FR-011), counts (FR-019)", () => {
  it("insertVersion persists version 1 with the given content (preview default)", async () => {
    const ruleKey = `rk-${randomUUID().slice(0, 8)}`;
    const row = await withTenant(pool, tenantA, (q) =>
      repo.insertVersion(q, {
        ruleKey,
        version: 1,
        entitlementId: entitlementA,
        planId: planA,
        condition: condV1,
        effect: effV1,
        priority: 7,
        author: "admin",
      }),
    );
    expect(row.version).toBe(1);
    expect(row.status).toBe("preview");
    expect(row.priority).toBe(7);
    expect(row.condition).toEqual(condV1);
    expect(row.effect).toEqual(effV1);
    expect(row.entitlementId).toBe(entitlementA);
    expect(row.planId).toBe(planA);
  });

  it("updateStatus changes ONLY status/updated_at — every content column is unchanged (INV-2)", async () => {
    const ruleKey = `rk-${randomUUID().slice(0, 8)}`;
    const before = await withTenant(pool, tenantA, (q) =>
      repo.insertVersion(q, {
        ruleKey,
        version: 1,
        entitlementId: entitlementA,
        planId: planA,
        condition: condV1,
        effect: effV1,
        priority: 3,
        author: "admin",
      }),
    );

    const after = await withTenant(pool, tenantA, (q) =>
      repo.updateStatus(q, { ruleKey, version: 1, status: "active" }),
    );
    expect(after).not.toBeNull();
    const a = after!;

    // The ONE permitted change: status flips, updated_at moves forward.
    expect(a.status).toBe("active");
    expect(a.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    // INV-2: EVERY content column is byte-identical — the repo never mutates content.
    expect(a.id).toBe(before.id);
    expect(a.ruleKey).toBe(before.ruleKey);
    expect(a.version).toBe(before.version);
    expect(a.entitlementId).toBe(before.entitlementId);
    expect(a.planId).toBe(before.planId);
    expect(a.condition).toEqual(before.condition);
    expect(a.effect).toEqual(before.effect);
    expect(a.priority).toBe(before.priority);
    expect(a.author).toBe(before.author);
    expect(a.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it("updateStatus returns null for an unknown (rule_key, version)", async () => {
    const missing = await withTenant(pool, tenantA, (q) =>
      repo.updateStatus(q, { ruleKey: `nope-${randomUUID().slice(0, 8)}`, version: 1, status: "active" }),
    );
    expect(missing).toBeNull();
  });

  it("a content edit is a NEW version+1 row; the prior version is retained UNCHANGED (FR-011)", async () => {
    const ruleKey = `rk-${randomUUID().slice(0, 8)}`;
    const v1 = await withTenant(pool, tenantA, (q) =>
      repo.insertVersion(q, {
        ruleKey,
        version: 1,
        entitlementId: entitlementA,
        condition: condV1,
        effect: effV1,
        priority: 1,
        status: "active",
        author: "admin",
      }),
    );

    // Edit: disable the live v1 (one-live slot) then INSERT an immutable v2 with NEW content.
    const condV2 = { ">": [{ var: "usage.api_calls" }, 1_000] };
    const effV2 = { kind: "adjust_limit", target: "api_calls", value: 9_000 };
    const v2 = await withTenant(pool, tenantA, async (q) => {
      await repo.updateStatus(q, { ruleKey, version: 1, status: "disabled" });
      const next = await repo.nextVersion(q, ruleKey);
      return repo.insertVersion(q, {
        ruleKey,
        version: next,
        entitlementId: entitlementA,
        condition: condV2,
        effect: effV2,
        priority: 2,
        status: "active",
        author: "admin",
      });
    });
    expect(v2.version).toBe(2);

    // The prior version row is retained; its content is UNCHANGED (only its status was toggled to disabled).
    const history = await withTenant(pool, tenantA, (q) => repo.getVersions(q, ruleKey));
    expect(history.map((r) => r.version)).toEqual([2, 1]);
    const priorV1 = history.find((r) => r.version === 1)!;
    expect(priorV1.condition).toEqual(condV1);
    expect(priorV1.effect).toEqual(effV1);
    expect(priorV1.priority).toBe(1);
    expect(priorV1.status).toBe("disabled");
    expect(priorV1.id).toBe(v1.id);

    // nextVersion now advances to 3.
    const next3 = await withTenant(pool, tenantA, (q) => repo.nextVersion(q, ruleKey));
    expect(next3).toBe(3);
  });

  it("counts LIVE (active|preview) rules per tenant and per entitlement (FR-019)", async () => {
    const isolated = randomUUID();
    await provisionTenant(pool, { id: isolated, slug: "acme-policy-count" });
    const chain = await seedChainIn(isolated);

    const base = `ct-${randomUUID().slice(0, 8)}`;
    await withTenant(pool, isolated, async (q) => {
      await repo.insertVersion(q, { ruleKey: `${base}-a`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, status: "active", author: "admin" });
      await repo.insertVersion(q, { ruleKey: `${base}-b`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, status: "preview", author: "admin" });
      await repo.insertVersion(q, { ruleKey: `${base}-c`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, status: "disabled", author: "admin" });
    });

    const [tenantCount, entCount] = await withTenant(pool, isolated, async (q) => [
      await repo.countLiveRulesForTenant(q),
      await repo.countLiveRulesForEntitlement(q, chain.entitlementId),
    ]);
    // active + preview count; disabled is excluded.
    expect(tenantCount).toBe(2);
    expect(entCount).toBe(2);
  });

  it("selectLiveRulesForEntitlement returns active|preview in priority DESC, stable tiebreak (FR-006)", async () => {
    const isolated = randomUUID();
    await provisionTenant(pool, { id: isolated, slug: "acme-policy-eval" });
    const chain = await seedChainIn(isolated);
    const base = `ev-${randomUUID().slice(0, 8)}`;
    await withTenant(pool, isolated, async (q) => {
      await repo.insertVersion(q, { ruleKey: `${base}-hi`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, priority: 10, status: "active", author: "admin" });
      await repo.insertVersion(q, { ruleKey: `${base}-lo`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, priority: 1, status: "preview", author: "admin" });
      await repo.insertVersion(q, { ruleKey: `${base}-off`, version: 1, entitlementId: chain.entitlementId, condition: condV1, effect: effV1, priority: 99, status: "disabled", author: "admin" });
    });
    const live = await withTenant(pool, isolated, (q) => repo.selectLiveRulesForEntitlement(q, chain.entitlementId, 50));
    expect(live.map((r) => r.priority)).toEqual([10, 1]); // disabled excluded; highest priority first
  });

  it("appendEvaluation writes ONE append-only, mode-marked audit row (INV-8)", async () => {
    const id = await withTenant(pool, tenantA, (q) =>
      repo.appendEvaluation(q, {
        licenseId: licenseA,
        planId: planA,
        entitlementKey: "api_calls",
        firedRule: { rule_id: randomUUID(), rule_key: "rk", version: 1 },
        consideredRules: [{ rule_key: "other", version: 2 }],
        inputHash: "deadbeef",
        inputSnapshot: { now: 1 },
        decision: { value: 5_000 },
        mode: "enforced",
      }),
    );
    const found = await withTenant(pool, tenantA, (q) =>
      q("SELECT mode, entitlement_key, input_hash FROM policy_evaluation WHERE id = $1", [id]),
    );
    expect(found.rowCount).toBe(1);
    const row = found.rows[0] as { mode: string; entitlement_key: string; input_hash: string };
    expect(row.mode).toBe("enforced");
    expect(row.entitlement_key).toBe("api_calls");
    expect(row.input_hash).toBe("deadbeef");

    // Append-only: the app role has NO DELETE on policy_evaluation (INV-8).
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM policy_evaluation"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

/** Seed a fresh product/plan/customer/license + entitlement chain in an already-provisioned tenant. */
async function seedChainIn(tenantId: string): Promise<{ planId: string; licenseId: string; entitlementId: string }> {
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
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max) VALUES ($1, ${GUC}, $2, 'Feature', 'integer_limit', 100000)`,
      [entitlementId, `feat-${entitlementId.slice(0, 8)}`],
    );
    return { planId, licenseId, entitlementId };
  });
}
