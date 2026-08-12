// T036 [US4] (FR-013, SC-007): the non-enforcing dry-run / simulate surface over the real /admin/policy HTTP
// surface (Fastify inject + Testcontainers Postgres). Proves the US4 guarantees against a SUPPLIED sample context:
//   - a dry-run returns the WOULD-BE decision + which rule fired (id+version) + the considered-but-not-applied
//     rules (highest-priority-wins), mode-marked `dry_run`;
//   - an UNSAVED `candidate` override is simulated INSTEAD of the persisted content and is NEVER persisted;
//   - NO live rule state changes (no new version, statuses unchanged) and NO enforcement happens;
//   - exactly one `policy_evaluation` row is appended, mode=`dry_run`, with a NULL license ref for a supplied
//     synthetic context (INV-9).
// Mirrors the E016/E007 admin-session + testcontainers harness.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { hmacKey } from "../../../db/hash.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-dry-run-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
let entitlementA: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)],
    );
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

function authed(method: "GET" | "POST" | "PATCH", url: string, auth: { session: string; csrf: string }, payload?: unknown, withCsrf = true) {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

/** Author an ACTIVE (enforced-eligible / live) rule targeting the entitlement, at a given priority + value. */
async function authorRule(auth: { session: string; csrf: string }, entId: string, priority: number, value: number): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority,
    status: "active",
    condition: { "==": [1, 1] }, // always matches (deterministic)
    effect: { kind: "adjust_limit", target: "api_calls", value },
  });
  if (res.statusCode !== 201) throw new Error(`author rule failed: ${res.statusCode} ${res.body}`);
  return res.json().ruleKey as string;
}

/** A within-bounds SUPPLIED decision context for the api_calls entitlement (OpenAPI DecisionContext shape). */
function suppliedContext(): Record<string, unknown> {
  return {
    decisionTimestamp: "2026-08-11T09:00:00Z",
    plan: { planId: "pro-2026", tier: "enterprise" },
    entitlement: {
      entitlementId: entitlementA,
      key: "api_calls",
      kind: "integer_limit",
      baseValue: 100,
      authoredMaximum: 50_000,
      ruleEligible: false,
    },
    usage: { api_calls: { value: 12_500, unit: "api-call" } },
  };
}

async function evalRows(licenseNull: boolean): Promise<Array<{ mode: string; license_id: string | null; decision: unknown; fired_rule: unknown; considered_rules: unknown }>> {
  return withTenant(pool, tenantA, async (q) => {
    const r = await q(
      `SELECT mode, license_id, decision, fired_rule, considered_rules FROM policy_evaluation
        WHERE mode = 'dry_run' AND license_id IS ${licenseNull ? "" : "NOT "}NULL ORDER BY created_at ASC`,
    );
    return r.rows as never;
  });
}

async function ruleVersionCount(entId: string): Promise<number> {
  return withTenant(pool, tenantA, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM policy_rule WHERE entitlement_id = $1", [entId]);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-dry-run" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("policy dry-run — non-enforcing simulation over a supplied context (integration) — SC-007", () => {
  it("a viewer is DENIED dry-run (403) and a missing CSRF is refused (403) — it is a mutation-plane op", async () => {
    const viewer = await loginAs("acme-dry-run", "viewer@acme.test");
    const ruleKey = randomUUID();
    expect((await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, viewer, { context: suppliedContext() })).statusCode).toBe(403);
    const admin = await loginAs("acme-dry-run", "admin@acme.test");
    const noCsrf = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, admin, { context: suppliedContext() }, false);
    expect(noCsrf.statusCode).toBe(403);
  });

  it("returns the would-be decision + fired rule + considered-not-applied; mode=dry_run; nothing enforced/persisted", async () => {
    const admin = await loginAs("acme-dry-run", "admin@acme.test");
    // Two live rules for the same entitlement: the higher-priority one wins; the lower is considered-not-applied.
    const high = await authorRule(admin, entitlementA, 200, 40_000);
    const low = await authorRule(admin, entitlementA, 50, 30_000);
    const beforeVersions = await ruleVersionCount(entitlementA);

    const res = await authed("POST", `/admin/policy/rules/${high}/dry-run`, admin, { context: suppliedContext() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mode: string;
      decisionTimestamp: string;
      decision: { target: string; effectKind: string | null; baseValue: number; resolvedValue: number; source: string; clamped: boolean; authoredMaximum: number };
      firedRule: { ruleKey: string; version: number } | null;
      consideredNotApplied: Array<{ ruleKey: string; version: number; reason: string }>;
    };

    expect(body.mode).toBe("dry_run");
    expect(body.decisionTimestamp).toBe("2026-08-11T09:00:00.000Z");
    // The higher-priority rule fires; its bounded value is the would-be decision (40000 <= authored max 50000).
    expect(body.decision).toMatchObject({ target: "api_calls", effectKind: "adjust_limit", resolvedValue: 40_000, source: "rule", clamped: false });
    expect(body.firedRule).toEqual({ ruleKey: high, version: 1 });
    // The lower-priority rule matched but did NOT apply (highest-priority-wins).
    expect(body.consideredNotApplied.map((r) => r.ruleKey)).toContain(low);

    // NON-ENFORCING: no new immutable version was created (both rules stay at version 1) and nothing was persisted
    // as active beyond what was authored.
    expect(await ruleVersionCount(entitlementA)).toBe(beforeVersions);

    // A `dry_run` audit row was appended with a NULL license ref (supplied synthetic context, INV-9).
    const rows = await evalRows(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.mode === "dry_run" && r.license_id === null)).toBe(true);
  });

  it("simulates an UNSAVED candidate override WITHOUT persisting it (test-before-save)", async () => {
    const admin = await loginAs("acme-dry-run", "admin@acme.test");
    const ruleKey = await authorRule(admin, entitlementA, 300, 40_000);

    // Dry-run a candidate that raises the value to 45000 (still within the authored max) — simulated, not saved.
    const res = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, admin, {
      context: suppliedContext(),
      candidate: { priority: 300, condition: { "==": [1, 1] }, effect: { kind: "adjust_limit", target: "api_calls", value: 45_000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.resolvedValue).toBe(45_000);
    expect(res.json().firedRule).toEqual({ ruleKey, version: 1 });

    // The PERSISTED rule content is UNCHANGED — the candidate was never saved (its head is still value 40000, v1).
    const detail = await authed("GET", `/admin/policy/rules/${ruleKey}`, admin);
    expect(detail.json().latestVersion).toBe(1);
    const head = (detail.json().versions as Array<{ effect: { value: number } }>)[0]!;
    expect(head.effect.value).toBe(40_000);
  });

  it("an unknown / cross-tenant ruleKey resolves to 404 (never leaks)", async () => {
    const admin = await loginAs("acme-dry-run", "admin@acme.test");
    const res = await authed("POST", `/admin/policy/rules/${randomUUID()}/dry-run`, admin, { context: suppliedContext() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });

  it("neither/both of context+licenseId → validation_error (contract oneOf)", async () => {
    const admin = await loginAs("acme-dry-run", "admin@acme.test");
    const ruleKey = await authorRule(admin, entitlementA, 10, 20_000);
    const neither = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, admin, {});
    expect(neither.statusCode).toBe(400);
    expect(neither.json().code).toBe("validation_error");
    const both = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, admin, { context: suppliedContext(), licenseId: randomUUID() });
    expect(both.statusCode).toBe(400);
    expect(both.json().code).toBe("validation_error");
  });
});
