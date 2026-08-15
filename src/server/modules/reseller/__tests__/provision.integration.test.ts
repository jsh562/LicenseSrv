// T015 [US1] (FR-002/003, SC-008, US1-AS4): the reseller-plane PROVISION surface over the real HTTP surface
// (Fastify inject + Testcontainers Postgres). Asserts:
//   - provision UNDER the hard quota → 201, an immediately-administrable metadata-only sub-tenant (FR-003).
//   - provision AT the hard cap → 409 quota_exceeded with a clear reason (SC-008).
//   - RBAC/CSRF fail-closed: a viewer provisioning → 403; an admin without the CSRF header → 403.
//   - a reseller-admin attempting an OPERATOR action (move) → 403 forbidden + a security event (US1-AS4).
//   - a dual-identity append-only audit row is written for the provision (actor + actor_reseller_id + target).
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
const SECRET = "reseller-provision-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// R = the acting reseller (quota 2 — small so the cap is easy to hit); O = a direct-platform operator tenant.
const resellerR = randomUUID();
const operatorO = randomUUID();
const strayCustomer = randomUUID(); // a sub-tenant to attempt an operator move on

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
): ReturnType<FastifyInstance["inject"]> {
  const headers: Record<string, string> = {};
  if (withCsrf) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: payload as never });
}

function provisionBody(displayName: string): Record<string, unknown> {
  return { displayName, firstAdminUserReference: "u_" + randomUUID().slice(0, 8) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r" });
  await provisionTenant(pool, { id: operatorO, slug: "operator-o" });
  await provisionTenant(pool, { id: strayCustomer, slug: "stray-customer" });
  await seedReseller(resellerR, 2);
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(resellerR, "viewer@r.test", "viewer");
  await seedUser(operatorO, "admin@o.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("reseller provision — hard quota + RBAC/CSRF + operator-action denial (integration)", () => {
  it("provisions a sub-tenant UNDER the quota (201, metadata-only, immediately administrable)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", "/admin/reseller/sub-tenants", admin, provisionBody("Initech LLC"));
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toMatch(/^\/admin\/reseller\/sub-tenants\//);
    const body = res.json() as { subTenantId: string; displayName: string; readOnly: boolean };
    expect(body.displayName).toBe("Initech LLC");
    expect(body.readOnly).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["subTenantId", "displayName", "status", "readOnly", "createdAt"].sort());

    // The new sub-tenant is immediately administrable by the reseller (in-subtree GET → 200).
    const get = await authed("GET", `/admin/reseller/sub-tenants/${body.subTenantId}`, admin);
    expect(get.statusCode).toBe(200);

    // Dual-identity append-only audit: tenant_id = the new sub-tenant, actor_reseller_id = the acting reseller.
    const audit = await withTenant(pool, body.subTenantId, (q) =>
      q("SELECT actor_reseller_id FROM audit_log WHERE action = 'sub_tenant.provision'"),
    );
    expect((audit.rows[0] as { actor_reseller_id: string }).actor_reseller_id).toBe(resellerR);
  });

  it("refuses provisioning AT the hard cap → 409 quota_exceeded with a clear reason (SC-008)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    // Quota is 2 and one was created above; create the 2nd to reach the cap, then the 3rd must be refused.
    const second = await authed("POST", "/admin/reseller/sub-tenants", admin, provisionBody("Second Co"));
    expect(second.statusCode).toBe(201);
    const overCap = await authed("POST", "/admin/reseller/sub-tenants", admin, provisionBody("Over Cap Co"));
    expect(overCap.statusCode).toBe(409);
    const body = overCap.json() as { code: string; details?: { quota: number; used: number } };
    expect(body.code).toBe("quota_exceeded");
    expect(body.details?.quota).toBe(2);
    expect(body.details?.used).toBe(2);
  });

  it("RBAC/CSRF fail-closed: a viewer provisioning → 403; an admin without CSRF → 403", async () => {
    const viewer = await loginAs("reseller-r", "viewer@r.test");
    expect((await authed("POST", "/admin/reseller/sub-tenants", viewer, provisionBody("X"))).statusCode).toBe(403);
    const admin = await loginAs("reseller-r", "admin@r.test");
    expect((await authed("POST", "/admin/reseller/sub-tenants", admin, provisionBody("Y"), false)).statusCode).toBe(403);
  });

  it("a reseller-admin attempting an OPERATOR action (move) → 403 forbidden + a security event (US1-AS4)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", `/admin/operator/sub-tenants/${strayCustomer}/move`, admin, {
      destination: { type: "to_reseller", destinationResellerId: resellerR },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    const rows = await withTenant(pool, resellerR, (q) =>
      q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'operator.plane.denied' AND security_event = true"),
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("the operator (a direct-platform tenant) is permitted on the operator plane (move succeeds)", async () => {
    const operator = await loginAs("operator-o", "admin@o.test");
    // The earlier hard-cap test filled resellerR to its quota (2); a move INTO an at-cap reseller correctly
    // returns 409 quota_exceeded ("destination at cap", plan Error Handling). Give the DESTINATION headroom via
    // the real operator quota API first, so this test exercises the OPERATOR-PLANE-PERMITTED path (not the cap).
    const raise = await authed("PATCH", `/admin/operator/resellers/${resellerR}/quota`, operator, { subTenantQuota: 5 });
    expect(raise.statusCode).toBe(200);
    const res = await authed("POST", `/admin/operator/sub-tenants/${strayCustomer}/move`, operator, {
      destination: { type: "to_reseller", destinationResellerId: resellerR },
    });
    expect(res.statusCode).toBe(200);
  });
});
