// T049 [Polish] (FR-015, SC-012) [COMPLETES FR-015]: cross-tenant isolation of the policy surface over the real
// HTTP routes + forced RLS (Fastify inject + Testcontainers Postgres). Proves the two halves of INV-1 / FR-015:
//   (a) a cross-tenant rule reference resolves to NOT FOUND (404, never 403) on EVERY ruleKey-addressed policy
//       route — GET detail, PATCH edit, POST status, POST dry-run — and a cross-tenant LIST never surfaces
//       another tenant's rule; and
//   (b) forced RLS refuses UNSCOPED access — an unset `app.current_tenant` GUC yields ZERO rows on BOTH the
//       `policy_rule` and `policy_evaluation` tables (SC-012), even with rows present under a real tenant scope.
// No signer/issuance is needed: rules are authored through the admin routes and one `policy_evaluation` row is
// seeded directly (a synthetic dry_run, null license) so the unset-GUC count has something to (fail to) see.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-isolation-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
const tenantB = randomUUID();
let entitlementA: string;
let ruleKeyA: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [
      id,
      tenantId,
      hmacKey(email.toLowerCase(), SECRET),
      hashPassword("pw-" + email),
    ]);
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

async function seedEntitlement(tenantId: string, key: string, ruleMax: number): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max, rule_eligible)
       VALUES ($1, ${GUC}, $2, 'API', 'integer_limit', $3, false)`,
      [id, key, ruleMax],
    );
    return id;
  });
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function authed(method: "GET" | "POST" | "PATCH", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}

const validRuleBody = (entId: string) => ({
  targetEntitlementId: entId,
  priority: 100,
  status: "active" as const,
  condition: { "==": [1, 1] },
  effect: { kind: "adjust_limit", target: "api_calls", value: 40_000 },
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-isolation" });
  await provisionTenant(pool, { id: tenantB, slug: "other-policy-isolation" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantB, "admin@other.test", "admin");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  // Author a live rule under tenant A (through the admin route, tenant-scoped by session RLS).
  const a = await loginAs("acme-policy-isolation", "admin@acme.test");
  const created = await authed("POST", "/admin/policy/rules", a, validRuleBody(entitlementA));
  if (created.statusCode !== 201) throw new Error(`author failed: ${created.statusCode} ${created.body}`);
  ruleKeyA = created.json().ruleKey as string;

  // Seed one policy_evaluation row under tenant A (a synthetic dry_run, null license) so the unset-GUC count on
  // policy_evaluation has a real tenant-owned row to (fail to) see.
  await withTenant(pool, tenantA, (q) =>
    q(
      `INSERT INTO policy_evaluation (id, tenant_id, license_id, entitlement_key, input_hash, decision, mode)
       VALUES ($1, ${GUC}, NULL, 'api_calls', 'h-iso', '40000'::jsonb, 'dry_run')`,
      [randomUUID()],
    ),
  );
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 policy isolation (integration, real Postgres) — FR-015 / SC-012", () => {
  it("cross-tenant GET detail on tenant A's ruleKey → 404 (never 403)", async () => {
    const b = await loginAs("other-policy-isolation", "admin@other.test");
    const res = await authed("GET", `/admin/policy/rules/${ruleKeyA}`, b);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
    // Sanity: tenant A CAN read its own rule.
    const a = await loginAs("acme-policy-isolation", "admin@acme.test");
    expect((await authed("GET", `/admin/policy/rules/${ruleKeyA}`, a)).statusCode).toBe(200);
  });

  it("cross-tenant PATCH edit on tenant A's ruleKey → 404", async () => {
    const b = await loginAs("other-policy-isolation", "admin@other.test");
    const res = await authed("PATCH", `/admin/policy/rules/${ruleKeyA}`, b, {
      priority: 1,
      condition: { "==": [1, 1] },
      effect: { kind: "adjust_limit", target: "api_calls", value: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("cross-tenant POST status on tenant A's ruleKey → 404", async () => {
    const b = await loginAs("other-policy-isolation", "admin@other.test");
    const res = await authed("POST", `/admin/policy/rules/${ruleKeyA}/status`, b, { status: "disabled" });
    expect(res.statusCode).toBe(404);
    // Tenant A's rule is untouched (still active) after the cross-tenant attempt.
    const a = await loginAs("acme-policy-isolation", "admin@acme.test");
    expect((await authed("GET", `/admin/policy/rules/${ruleKeyA}`, a)).json().status).toBe("active");
  });

  it("cross-tenant POST dry-run on tenant A's ruleKey → 404 (rule not found in tenant B)", async () => {
    const b = await loginAs("other-policy-isolation", "admin@other.test");
    const res = await authed("POST", `/admin/policy/rules/${ruleKeyA}/dry-run`, b, { licenseId: randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it("cross-tenant LIST never surfaces tenant A's rule (isolation, not 403)", async () => {
    const b = await loginAs("other-policy-isolation", "admin@other.test");
    // Unfiltered list for tenant B: 200, but tenant A's ruleKey is absent.
    const all = await authed("GET", "/admin/policy/rules", b);
    expect(all.statusCode).toBe(200);
    expect((all.json().rules as Array<{ ruleKey: string }>).map((r) => r.ruleKey)).not.toContain(ruleKeyA);
    // Filtering by tenant A's entitlement id (owned by A) yields nothing under RLS for B.
    const filtered = await authed("GET", `/admin/policy/rules?entitlementId=${entitlementA}`, b);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().rules).toEqual([]);
    // Tenant A's own list DOES contain its rule.
    const a = await loginAs("acme-policy-isolation", "admin@acme.test");
    const mine = await authed("GET", "/admin/policy/rules", a);
    expect((mine.json().rules as Array<{ ruleKey: string }>).map((r) => r.ruleKey)).toContain(ruleKeyA);
  });

  it("forced RLS: an unset app.current_tenant GUC yields 0 rows on BOTH policy tables (SC-012)", async () => {
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
    // Control: under a real tenant scope the same rows ARE visible (RLS scopes, not hides everything).
    const seen = await withTenant(pool, tenantA, async (q) => {
      const rules = await q("SELECT count(*)::int AS n FROM policy_rule");
      const evals = await q("SELECT count(*)::int AS n FROM policy_evaluation");
      return { rules: (rules.rows[0] as { n: number }).n, evals: (evals.rows[0] as { n: number }).n };
    });
    expect(seen.rules).toBeGreaterThanOrEqual(1);
    expect(seen.evals).toBeGreaterThanOrEqual(1);
  });
});
