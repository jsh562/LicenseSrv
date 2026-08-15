// T051 [US4] (FR-003): the OPERATOR-plane reseller quota + list/get surface over the real HTTP surface
// (Fastify inject + Testcontainers Postgres). Asserts:
//   - ONLY the operator may change a reseller's quota — a reseller-admin attempting the operator quota PATCH is
//     denied 403 + a security event (a reseller can never raise its own, US1-AS4).
//   - lowering a quota BELOW the current sub-tenant count is ALLOWED 200 (a hard cap never deletes existing
//     tenants); it only blocks FURTHER provisioning until the count falls back under the new cap.
//   - over-cap provisioning is still blocked at the hard cap (409 quota_exceeded), and lifting the quota lets a
//     new provision succeed.
//   - operator reseller list is DETERMINISTIC (by displayName then id) + bounded + truncated; get one → 200; an
//     unknown reseller → 404.
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
const SECRET = "operator-reseller-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// O = the operator; R = a reseller at quota 2 with two sub-tenants; Q = a second reseller (list ordering).
const operatorO = randomUUID();
const resellerR = randomUUID();
const resellerQ = randomUUID();
const subA = randomUUID();
const subB = randomUUID();

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

async function seedReseller(tenantId: string, quota: number): Promise<void> {
  await withTenant(pool, tenantId, (q) =>
    q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', $1)`, [quota]),
  );
}

async function seedSubTenant(id: string, slug: string, name: string, parentReseller: string): Promise<void> {
  await provisionTenant(pool, { id, slug, name });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [parentReseller, id]));
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
): ReturnType<FastifyInstance["inject"]> {
  return app.inject({
    method,
    url,
    cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
    headers: { "x-csrf-token": auth.csrf },
    payload: payload as never,
  });
}

function provisionBody(displayName: string): Record<string, unknown> {
  return { displayName, firstAdminUserReference: "u_" + randomUUID().slice(0, 8) };
}

const SUMMARY_KEYS = ["resellerId", "displayName", "status", "subTenantQuota", "subTenantCount"].sort();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: operatorO, slug: "operator-o", name: "Operator" });
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r", name: "Zzz Partners" });
  await provisionTenant(pool, { id: resellerQ, slug: "reseller-q", name: "Aaa Partners" });
  await seedReseller(resellerR, 2);
  await seedReseller(resellerQ, 5);
  await seedUser(operatorO, "admin@o.test", "admin");
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedSubTenant(subA, "sub-a", "Northwind Ltd", resellerR);
  await seedSubTenant(subB, "sub-b", "Globex Inc", resellerR);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("operator reseller quota + list/get — operator-only, count-safe, deterministic (integration)", () => {
  it("a reseller-admin attempting the operator quota PATCH → 403 forbidden + a security event (US1-AS4)", async () => {
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("PATCH", `/admin/operator/resellers/${resellerR}/quota`, resellerAdmin, { subTenantQuota: 99 });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    const rows = await withTenant(pool, resellerR, (q) =>
      q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'operator.plane.denied' AND security_event = true"),
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
    // The quota was NOT changed by the denied attempt.
    const detail = await withTenant(pool, resellerR, (q) => q("SELECT sub_tenant_quota FROM reseller WHERE tenant_id = " + GUC));
    expect((detail.rows[0] as { sub_tenant_quota: number }).sub_tenant_quota).toBe(2);
  });

  it("ALLOWS lowering a quota BELOW the current sub-tenant count → 200 (a hard cap never deletes tenants)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("PATCH", `/admin/operator/resellers/${resellerR}/quota`, op, { subTenantQuota: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subTenantQuota: number; subTenantCount: number };
    expect(body.subTenantQuota).toBe(1); // the cap is set below the live count...
    expect(body.subTenantCount).toBe(2); // ...but the two existing sub-tenants are retained (never deleted).
    // The lowered cap persisted.
    const detail = await withTenant(pool, resellerR, (q) => q("SELECT sub_tenant_quota FROM reseller WHERE tenant_id = " + GUC));
    expect((detail.rows[0] as { sub_tenant_quota: number }).sub_tenant_quota).toBe(1);
  });

  it("over-cap provisioning is still blocked at the hard cap → 409 quota_exceeded", async () => {
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", "/admin/reseller/sub-tenants", resellerAdmin, provisionBody("Over Cap Co"));
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("quota_exceeded");
  });

  it("the operator RAISES the quota (200) and a new provision then succeeds (201)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const raise = await authed("PATCH", `/admin/operator/resellers/${resellerR}/quota`, op, { subTenantQuota: 4 });
    expect(raise.statusCode).toBe(200);
    expect((raise.json() as { subTenantQuota: number }).subTenantQuota).toBe(4);

    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const prov = await authed("POST", "/admin/reseller/sub-tenants", resellerAdmin, provisionBody("Now Allowed Co"));
    expect(prov.statusCode).toBe(201);
  });

  it("lists resellers DETERMINISTICALLY (displayName then id), bounded + not truncated", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("GET", "/admin/operator/resellers", op);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellers: Array<Record<string, unknown>>; truncated: boolean };
    expect(body.truncated).toBe(false);
    const names = body.resellers.map((r) => r.displayName as string);
    // Aaa Partners (Q) sorts before Zzz Partners (R).
    expect(names.indexOf("Aaa Partners")).toBeLessThan(names.indexOf("Zzz Partners"));
    for (const r of body.resellers) expect(Object.keys(r).sort()).toEqual(SUMMARY_KEYS);
  });

  it("filters the reseller list by status", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("GET", "/admin/operator/resellers?status=active", op);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellers: Array<{ status: string }> };
    expect(body.resellers.length).toBeGreaterThanOrEqual(2);
    for (const r of body.resellers) expect(r.status).toBe("active");
  });

  it("gets one reseller (200) with its quota position; an unknown reseller → 404", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("GET", `/admin/operator/resellers/${resellerR}`, op);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellerId: string; displayName: string; subTenantQuota: number; status: string };
    expect(body.resellerId).toBe(resellerR);
    expect(body.displayName).toBe("Zzz Partners");
    expect(body.subTenantQuota).toBe(4);
    expect(body.status).toBe("active");

    const missing = await authed("GET", `/admin/operator/resellers/${randomUUID()}`, op);
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe("not_found");
  });
});
