// T023 (US1, FR-021, SC-019) — the catalog AUTHORED-MAXIMUM governance action over the running HTTP surface.
// The `rule_max`/`rule_eligible`/`rule_tiers` validation + persistence already live in validation.ts/
// entitlements.ts (T007); this locks that the governance is exposed as an ADMIN-ONLY, CSRF-protected, AUDITED
// catalog route: PUT /admin/catalog/entitlements/:id/rule-bounds behind admin RBAC + double-submit CSRF, wired
// to setEntitlementRuleBounds (→ assertRuleBounds) with the configured absolute cap. Against real Postgres via
// Fastify inject, it confirms (SC-019):
//   - an admin sets `rule_max` (≥ the base plan value and ≤ the absolute cap) + rule_eligible + rule_tiers → 200.
//   - a `rule_max` BELOW the entitlement's base plan value is refused 400 validation_error, nothing persisted.
//   - a `rule_max` ABOVE the configured absolute cap is refused 400 validation_error, nothing persisted.
//   - a VIEWER attempting the action is refused 403 (+ security_event).
//   - a mutation without the CSRF header is refused 403.
//   - the `catalog.entitlement.rule_bounds_set` audit row is written for a successful set.
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
const SECRET = "authored-max-secret";
// A small, deterministic absolute per-entitlement cap (FR-021) so an over-cap value is easy to exercise; the
// catalog module reads POLICY_ABSOLUTE_MAX_LIMIT from the env when no validated AppConfig is injected.
const ABSOLUTE_MAX = 100_000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevAbsoluteMaxEnv: string | undefined;

const tenantA = randomUUID();

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

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const session = res.cookies.find((c) => c.name === "admin_session")!.value;
  const csrf = res.cookies.find((c) => c.name === "admin_csrf")!.value;
  return { session, csrf };
}

function authed(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, auth: { session: string; csrf: string }, payload?: unknown, withCsrf = true) {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

function key(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Create an integer_limit entitlement referenced by a plan with `base` as its value → base plan value = `base`. */
async function seedEntitlementWithBase(auth: { session: string; csrf: string }, base: number): Promise<string> {
  const prod = await authed("POST", "/admin/catalog/products", auth, { key: key("am-prod"), name: "AM Product" });
  const plan = await authed("POST", `/admin/catalog/products/${prod.json().id}/plans`, auth, { key: key("am-plan"), name: "AM Plan" });
  const ent = await authed("POST", "/admin/catalog/entitlements", auth, { key: key("am-seats"), name: "AM Seats", type: "integer_limit" });
  const entId = ent.json().id as string;
  const set = await authed("PUT", `/admin/catalog/plans/${plan.json().id}/entitlements/${entId}`, auth, { value: base });
  expect(set.statusCode).toBe(200);
  return entId;
}

beforeAll(async () => {
  prevAbsoluteMaxEnv = process.env.POLICY_ABSOLUTE_MAX_LIMIT;
  process.env.POLICY_ABSOLUTE_MAX_LIMIT = String(ABSOLUTE_MAX);
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  // createApp reads POLICY_ABSOLUTE_MAX_LIMIT at registration (no AppConfig injected here).
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
  if (prevAbsoluteMaxEnv === undefined) delete process.env.POLICY_ABSOLUTE_MAX_LIMIT;
  else process.env.POLICY_ABSOLUTE_MAX_LIMIT = prevAbsoluteMaxEnv;
});

describe("catalog authored-max governance — PUT /admin/catalog/entitlements/:id/rule-bounds (US1, FR-021, SC-019)", () => {
  it("an admin sets rule_max (≥ base, ≤ cap) + rule_eligible + rule_tiers → 200, persisted", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const entId = await seedEntitlementWithBase(auth, 100);

    const res = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, auth, {
      ruleMax: 500,
      ruleEligible: true,
      ruleTiers: [100, 250, 500],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: entId, ruleMax: 500, ruleEligible: true, ruleTiers: [100, 250, 500] });

    // Reloading confirms the bound persisted.
    const reload = await authed("GET", `/admin/catalog/entitlements/${entId}`, auth);
    expect(reload.json()).toMatchObject({ ruleMax: 500, ruleEligible: true, ruleTiers: [100, 250, 500] });
  });

  it("refuses a rule_max BELOW the base plan value → 400 validation_error, nothing persisted", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const entId = await seedEntitlementWithBase(auth, 100);

    const res = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, auth, { ruleMax: 50 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");

    // Unchanged — the rejected bound never persisted.
    expect((await authed("GET", `/admin/catalog/entitlements/${entId}`, auth)).json().ruleMax).toBeNull();
  });

  it("refuses a rule_max ABOVE the configured absolute cap → 400 validation_error, nothing persisted", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const entId = await seedEntitlementWithBase(auth, 100);

    const res = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, auth, { ruleMax: ABSOLUTE_MAX + 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");

    expect((await authed("GET", `/admin/catalog/entitlements/${entId}`, auth)).json().ruleMax).toBeNull();
  });

  it("refuses a viewer (403 + security_event) and a mutation missing CSRF (403)", async () => {
    const admin = await loginAs("acme", "admin@acme.test");
    const entId = await seedEntitlementWithBase(admin, 100);

    // A viewer cannot set the authored maximum → 403.
    const viewer = await loginAs("acme", "viewer@acme.test");
    const denied = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, viewer, { ruleMax: 500 });
    expect(denied.statusCode).toBe(403);

    const events = await privileged(pool, async (q) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'authz.denied' AND security_event = true`,
        [tenantA],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(events).toBeGreaterThanOrEqual(1);

    // An admin mutation WITHOUT the CSRF header → 403 (double-submit fails).
    const noCsrf = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, admin, { ruleMax: 500 }, false);
    expect(noCsrf.statusCode).toBe(403);

    // Still unchanged after both denied attempts.
    expect((await authed("GET", `/admin/catalog/entitlements/${entId}`, admin)).json().ruleMax).toBeNull();
  });

  it("writes a catalog.entitlement.rule_bounds_set audit row for a successful set", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const entId = await seedEntitlementWithBase(auth, 100);

    const res = await authed("PUT", `/admin/catalog/entitlements/${entId}/rule-bounds`, auth, { ruleMax: 250, ruleEligible: true });
    expect(res.statusCode).toBe(200);

    const n = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.entitlement.rule_bounds_set' AND target = $1`,
        [entId],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(1);
  });
});
