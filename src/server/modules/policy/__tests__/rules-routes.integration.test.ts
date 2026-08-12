// T022 [US1] (FR-001, FR-016, SC-011/012): the admin-plane auth on the /admin/policy rule routes over the real
// HTTP surface (Fastify inject + Testcontainers Postgres). Mirrors the E016/E007 console harness exactly:
//   - session + RBAC: a VIEWER is denied a mutation (403); a viewer CAN read (200).
//   - double-submit CSRF: an admin mutation WITHOUT the X-CSRF-Token header is refused fail-closed (403).
//   - immutable versioning: a PATCH edit creates a NEW version (v2), the prior version retained.
//   - tenant isolation (forced RLS): tenant B cannot GET or PATCH tenant A's ruleKey → 404 (never 403).
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
const SECRET = "policy-routes-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
const tenantB = randomUUID();
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
  const session = res.cookies.find((c) => c.name === "admin_session")!.value;
  const csrf = res.cookies.find((c) => c.name === "admin_csrf")!.value;
  return { session, csrf };
}

function authed(
  method: "GET" | "POST" | "PATCH",
  url: string,
  auth: { session: string; csrf: string },
  payload?: unknown,
  withCsrf = true,
) {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

function validBody(entitlementId: string, value = 40_000): Record<string, unknown> {
  return {
    targetEntitlementId: entitlementId,
    priority: 100,
    condition: { ">": [{ var: "usage.api_calls" }, 10_000] },
    effect: { kind: "adjust_limit", target: "api_calls", value },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-routes" });
  await provisionTenant(pool, { id: tenantB, slug: "other-policy-routes" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  await seedUser(tenantB, "admin@other.test", "admin");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("policy rule routes — session + RBAC + CSRF + versioning + isolation (integration)", () => {
  it("a viewer can READ the list but is DENIED a mutation (403 fail-closed)", async () => {
    const viewer = await loginAs("acme-policy-routes", "viewer@acme.test");
    expect((await authed("GET", "/admin/policy/rules", viewer)).statusCode).toBe(200);
    const denied = await authed("POST", "/admin/policy/rules", viewer, validBody(entitlementA));
    expect(denied.statusCode).toBe(403);
  });

  it("an admin mutation WITHOUT the CSRF header is refused fail-closed (403)", async () => {
    const admin = await loginAs("acme-policy-routes", "admin@acme.test");
    const noCsrf = await authed("POST", "/admin/policy/rules", admin, validBody(entitlementA), false);
    expect(noCsrf.statusCode).toBe(403);
  });

  it("an admin creates a rule, then a PATCH edit creates a NEW immutable version (prior retained)", async () => {
    const admin = await loginAs("acme-policy-routes", "admin@acme.test");
    const created = await authed("POST", "/admin/policy/rules", admin, { ...validBody(entitlementA), status: "active" });
    expect(created.statusCode).toBe(201);
    const ruleKey = created.json().ruleKey as string;
    expect(created.json().version).toBe(1);

    const edited = await authed("PATCH", `/admin/policy/rules/${ruleKey}`, admin, {
      priority: 100,
      condition: { ">": [{ var: "usage.api_calls" }, 20_000] },
      effect: { kind: "adjust_limit", target: "api_calls", value: 50_000 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().version).toBe(2);
    // The edit takes over the live slot (the created rule was active) — the new head is active.
    expect(edited.json().status).toBe("active");

    // The prior version is retained (immutable history); the head is v2.
    const detail = await authed("GET", `/admin/policy/rules/${ruleKey}`, admin);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().latestVersion).toBe(2);
    expect((detail.json().versions as Array<{ version: number }>).map((v) => v.version)).toEqual([2, 1]);
  });

  it("tenant isolation: tenant B cannot GET or PATCH tenant A's ruleKey → 404 (never 403)", async () => {
    const a = await loginAs("acme-policy-routes", "admin@acme.test");
    const b = await loginAs("other-policy-routes", "admin@other.test");
    const created = await authed("POST", "/admin/policy/rules", a, validBody(entitlementA));
    const ruleKey = created.json().ruleKey as string;

    expect((await authed("GET", `/admin/policy/rules/${ruleKey}`, b)).statusCode).toBe(404);
    const crossPatch = await authed("PATCH", `/admin/policy/rules/${ruleKey}`, b, {
      priority: 1,
      condition: { ">": [{ var: "usage.api_calls" }, 1 ] },
      effect: { kind: "adjust_limit", target: "api_calls", value: 1 },
    });
    expect(crossPatch.statusCode).toBe(404);

    // A cross-tenant unknown ruleKey (valid UUID shape) also resolves to 404.
    expect((await authed("GET", `/admin/policy/rules/${randomUUID()}`, b)).statusCode).toBe(404);
  });
});
