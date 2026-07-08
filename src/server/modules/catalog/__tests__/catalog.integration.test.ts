// Full /admin/catalog HTTP surface against real Postgres via Fastify inject (US1–US5): product/plan/
// entitlement CRUD + archive-cascade, per-plan value set/edit/remove + effective read model, RBAC
// (viewer 403 + security_event), CSRF, duplicate/type-locked/archived conflicts, and tenant isolation.
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
const SECRET = "catalog-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
const tenantB = randomUUID();

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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "other" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  await seedUser(tenantB, "admin@other.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("catalog HTTP surface (integration, real Postgres)", () => {
  it("US1: products create/dup-409/list/patch(key-immutable)/archive-cascades-to-plans", async () => {
    const auth = await loginAs("acme", "admin@acme.test");

    const created = await authed("POST", "/admin/catalog/products", auth, { key: "acme-cad", name: "Acme CAD" });
    expect(created.statusCode).toBe(201);
    const productId = created.json().id as string;

    // Duplicate key → 409.
    expect((await authed("POST", "/admin/catalog/products", auth, { key: "acme-cad", name: "Dup" })).statusCode).toBe(409);

    // Edit name; a key in the body is ignored (immutable, FR-018) — the key stays.
    const patched = await authed("PATCH", `/admin/catalog/products/${productId}`, auth, { name: "Acme CAD Pro", key: "hacked" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Acme CAD Pro", key: "acme-cad" });

    // A plan under it, then archive the product → plan is archived too (cascade, SC-008).
    const plan = await authed("POST", `/admin/catalog/products/${productId}/plans`, auth, { key: "standard", name: "Standard" });
    const planId = plan.json().id as string;
    expect((await authed("POST", `/admin/catalog/products/${productId}/archive`, auth)).statusCode).toBe(200);
    const planAfter = await authed("GET", `/admin/catalog/plans/${planId}`, auth);
    expect(planAfter.json().status).toBe("archived");

    // Default product list excludes archived.
    const activeList = await authed("GET", "/admin/catalog/products", auth);
    expect((activeList.json().products as Array<{ id: string }>).some((p) => p.id === productId)).toBe(false);
    const allList = await authed("GET", "/admin/catalog/products?status=all", auth);
    expect((allList.json().products as Array<{ id: string }>).some((p) => p.id === productId)).toBe(true);
  });

  it("US2: plan defaults to seat limit 1, rejects seat<1, and carries its productId", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const prod = await authed("POST", "/admin/catalog/products", auth, { key: "widget", name: "Widget" });
    const productId = prod.json().id as string;

    const plan = await authed("POST", `/admin/catalog/products/${productId}/plans`, auth, { key: "basic", name: "Basic" });
    expect(plan.statusCode).toBe(201);
    expect(plan.json()).toMatchObject({ maxActivations: 1, productId });

    expect((await authed("PATCH", `/admin/catalog/plans/${plan.json().id}`, auth, { maxActivations: 0 })).statusCode).toBe(400);
    const bumped = await authed("PATCH", `/admin/catalog/plans/${plan.json().id}`, auth, { maxActivations: 25 });
    expect(bumped.json().maxActivations).toBe(25);
  });

  it("US3: entitlements boolean + integer_limit; type-change on a referenced entitlement → 409", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const boolEnt = await authed("POST", "/admin/catalog/entitlements", auth, { key: "export-pdf", name: "Export PDF", type: "boolean" });
    const intEnt = await authed("POST", "/admin/catalog/entitlements", auth, { key: "max-projects", name: "Max Projects", type: "integer_limit" });
    expect(boolEnt.json().type).toBe("boolean");
    expect(intEnt.json().type).toBe("integer_limit");
    expect((await authed("POST", "/admin/catalog/entitlements", auth, { key: "export-pdf", name: "dup", type: "boolean" })).statusCode).toBe(409);

    // Unreferenced → type change allowed.
    expect((await authed("PATCH", `/admin/catalog/entitlements/${intEnt.json().id}`, auth, { type: "boolean" })).statusCode).toBe(200);
    // Revert, then reference it from a plan, then a type change is locked.
    await authed("PATCH", `/admin/catalog/entitlements/${intEnt.json().id}`, auth, { type: "integer_limit" });
    const prod = await authed("POST", "/admin/catalog/products", auth, { key: "p3", name: "P3" });
    const plan = await authed("POST", `/admin/catalog/products/${prod.json().id}/plans`, auth, { key: "pl3", name: "Pl3" });
    await authed("PUT", `/admin/catalog/plans/${plan.json().id}/entitlements/${intEnt.json().id}`, auth, { value: 10 });
    expect((await authed("PATCH", `/admin/catalog/entitlements/${intEnt.json().id}`, auth, { type: "boolean" })).statusCode).toBe(409);
  });

  it("US4: set/edit per-plan values, type-mismatch 400, upsert, remove, and effective read model", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const prod = await authed("POST", "/admin/catalog/products", auth, { key: "suite", name: "Suite" });
    const plan = await authed("POST", `/admin/catalog/products/${prod.json().id}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 });
    const planId = plan.json().id as string;
    const boolE = await authed("POST", "/admin/catalog/entitlements", auth, { key: "sso", name: "SSO", type: "boolean" });
    const intE = await authed("POST", "/admin/catalog/entitlements", auth, { key: "seats", name: "Seats", type: "integer_limit" });

    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${boolE.json().id}`, auth, { value: true })).statusCode).toBe(200);
    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${intE.json().id}`, auth, { value: 50 })).statusCode).toBe(200);
    // Type mismatch + negative → 400, nothing saved.
    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${boolE.json().id}`, auth, { value: 3 })).statusCode).toBe(400);
    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${intE.json().id}`, auth, { value: -1 })).statusCode).toBe(400);
    // Edit (upsert) the int value; persists immediately.
    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${intE.json().id}`, auth, { value: 100 })).statusCode).toBe(200);

    const eff = await authed("GET", `/admin/catalog/plans/${planId}/effective`, auth);
    expect(eff.statusCode).toBe(200);
    expect(eff.json()).toMatchObject({ planKey: "pro", productKey: "suite", maxActivations: 5 });
    const ents = eff.json().entitlements as Array<{ key: string; value: unknown }>;
    expect(ents).toContainEqual({ key: "sso", type: "boolean", value: true });
    expect(ents).toContainEqual({ key: "seats", type: "integer_limit", value: 100 });

    // Remove one → 204, and it drops from effective.
    expect((await authed("DELETE", `/admin/catalog/plans/${planId}/entitlements/${boolE.json().id}`, auth)).statusCode).toBe(204);
    const eff2 = await authed("GET", `/admin/catalog/plans/${planId}/effective`, auth);
    expect((eff2.json().entitlements as Array<{ key: string }>).some((e) => e.key === "sso")).toBe(false);

    // Archived entitlement is frozen for new values (AD-010).
    await authed("POST", `/admin/catalog/entitlements/${intE.json().id}/archive`, auth);
    expect((await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${intE.json().id}`, auth, { value: 7 })).statusCode).toBe(409);
    // …and the archived entitlement is excluded from the effective read model.
    const eff3 = await authed("GET", `/admin/catalog/plans/${planId}/effective`, auth);
    expect((eff3.json().entitlements as Array<{ key: string }>).some((e) => e.key === "seats")).toBe(false);
  });

  it("US5: a viewer is blocked from mutations (403 + security_event); CSRF is required", async () => {
    const viewer = await loginAs("acme", "viewer@acme.test");
    // Viewer can read.
    expect((await authed("GET", "/admin/catalog/products", viewer)).statusCode).toBe(200);
    // Viewer cannot create → 403.
    const denied = await authed("POST", "/admin/catalog/products", viewer, { key: "nope", name: "Nope" });
    expect(denied.statusCode).toBe(403);

    const events = await privileged(pool, async (q) => {
      const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'authz.denied' AND security_event = true`, [tenantA]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(events).toBeGreaterThanOrEqual(1);

    // A mutation without the CSRF header → 403.
    const admin = await loginAs("acme", "admin@acme.test");
    expect((await authed("POST", "/admin/catalog/products", admin, { key: "csrfless", name: "X" }, false)).statusCode).toBe(403);
  });

  it("US5: catalog is tenant-isolated — tenant B sees none of tenant A's catalog", async () => {
    const a = await loginAs("acme", "admin@acme.test");
    const b = await loginAs("other", "admin@other.test");
    const created = await authed("POST", "/admin/catalog/products", a, { key: "secret-prod", name: "Secret" });
    const aProductId = created.json().id as string;

    // Tenant B cannot see A's product (cross-tenant id → 404 via RLS).
    expect((await authed("GET", `/admin/catalog/products/${aProductId}`, b)).statusCode).toBe(404);
    const bList = await authed("GET", "/admin/catalog/products?status=all", b);
    expect((bList.json().products as Array<{ key: string }>).some((p) => p.key === "secret-prod")).toBe(false);

    // Direct RLS check: tenant B sees zero of A's product rows.
    const bCount = await withTenant(pool, tenantB, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM product WHERE key = 'secret-prod'", []);
      return (r.rows[0] as { n: number }).n;
    });
    expect(bCount).toBe(0);
  });

  it("error paths: 404 for unknown ids, archived-plan value freeze, and description edits", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const ghost = randomUUID();

    // 404s across the surface.
    expect((await authed("GET", `/admin/catalog/products/${ghost}`, auth)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/catalog/plans/${ghost}`, auth)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/catalog/entitlements/${ghost}`, auth)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/catalog/plans/${ghost}/effective`, auth)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/catalog/plans/${ghost}/entitlements`, auth)).statusCode).toBe(404);
    expect((await authed("PATCH", `/admin/catalog/products/${ghost}`, auth, { name: "x" })).statusCode).toBe(404);
    expect((await authed("PUT", `/admin/catalog/plans/${ghost}/entitlements/${ghost}`, auth, { value: true })).statusCode).toBe(404);
    expect((await authed("DELETE", `/admin/catalog/plans/${ghost}/entitlements/${ghost}`, auth)).statusCode).toBe(404);

    // Archived PLAN freezes new values (AD-010).
    const prod = await authed("POST", "/admin/catalog/products", auth, { key: "frozen", name: "Frozen", description: "d1" });
    const plan = await authed("POST", `/admin/catalog/products/${prod.json().id}/plans`, auth, { key: "fp", name: "FP", description: "pd" });
    const ent = await authed("POST", "/admin/catalog/entitlements", auth, { key: "ff", name: "FF", type: "boolean", description: "ed" });
    await authed("POST", `/admin/catalog/plans/${plan.json().id}/archive`, auth);
    expect((await authed("PUT", `/admin/catalog/plans/${plan.json().id}/entitlements/${ent.json().id}`, auth, { value: true })).statusCode).toBe(409);

    // Description edits (covers the description-update path) + unknown-entitlement value → 404.
    const p2 = await authed("POST", "/admin/catalog/products", auth, { key: "descp", name: "Desc" });
    expect((await authed("PATCH", `/admin/catalog/products/${p2.json().id}`, auth, { description: "updated" })).json().description).toBe("updated");
    const plan2 = await authed("POST", `/admin/catalog/products/${p2.json().id}/plans`, auth, { key: "dp", name: "DP" });
    expect((await authed("PATCH", `/admin/catalog/plans/${plan2.json().id}`, auth, { description: "pd2" })).json().description).toBe("pd2");
    expect((await authed("PATCH", `/admin/catalog/entitlements/${ent.json().id}`, auth, { name: "renamed" })).json().name).toBe("renamed");
    expect((await authed("PUT", `/admin/catalog/plans/${plan2.json().id}/entitlements/${ghost}`, auth, { value: true })).statusCode).toBe(404);
  });

  it("audit: authorized catalog mutations are recorded (SC-010/011)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const prod = await authed("POST", "/admin/catalog/products", auth, { key: "audited", name: "Audited" });
    const plan = await authed("POST", `/admin/catalog/products/${prod.json().id}/plans`, auth, { key: "aud-plan", name: "AP" });
    const ent = await authed("POST", "/admin/catalog/entitlements", auth, { key: "aud-feat", name: "AF", type: "boolean" });
    await authed("PUT", `/admin/catalog/plans/${plan.json().id}/entitlements/${ent.json().id}`, auth, { value: true });

    const actions = await withTenant(pool, tenantA, async (q) => {
      const r = await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'catalog.%'`, []);
      return (r.rows as { action: string }[]).map((x) => x.action);
    });
    expect(actions).toEqual(expect.arrayContaining(["catalog.product.created", "catalog.plan.created", "catalog.entitlement.created", "catalog.value.set"]));
  });
});
