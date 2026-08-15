// T014 [US1] (FR-002/004, SC-001/002): the reseller-plane sub-tenant READ surface over the real HTTP surface
// (Fastify inject + Testcontainers Postgres), mirroring the E016/E017 console harness. Asserts the load-bearing
// downward-only isolation contract:
//   - list/get OWN sub-tenants → 200, METADATA-ONLY, plus the reseller's own quota position (SC-001).
//   - a sibling's customer, the reseller's own id (a parent probe), and an unknown/platform id → 404 not_found
//     with NO existence disclosure, never 403 (SC-002, HINT-002).
//   - a non-reseller session on the reseller plane → 403 forbidden + a security event (fail-closed, FR-002).
//   - the data layer itself: an unset tenant GUC yields 0 rows on the `reseller` table (INV-1, SC-002).
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
const SECRET = "reseller-subtenants-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// R = the acting reseller; S = an unrelated sibling reseller; P = a plain (non-reseller) tenant.
const resellerR = randomUUID();
const resellerS = randomUUID();
const plainP = randomUUID();
const subA = randomUUID();
const subB = randomUUID();
const subC = randomUUID(); // S's customer — out of R's subtree

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

function authed(method: "GET" | "POST", url: string, auth: { session: string; csrf: string }): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf } });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r" });
  await provisionTenant(pool, { id: resellerS, slug: "reseller-s" });
  await provisionTenant(pool, { id: plainP, slug: "plain-p" });
  await seedReseller(resellerR, 10);
  await seedReseller(resellerS, 10);
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(resellerR, "viewer@r.test", "viewer");
  await seedUser(resellerS, "admin@s.test", "admin");
  await seedUser(plainP, "admin@p.test", "admin");
  await seedSubTenant(subA, "sub-a", "Northwind Ltd", resellerR);
  await seedSubTenant(subB, "sub-b", "Globex Inc", resellerR);
  await seedSubTenant(subC, "sub-c", "Sibling Customer", resellerS);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const ALLOWED_SUBTENANT_KEYS = ["subTenantId", "displayName", "status", "readOnly", "createdAt"].sort();

describe("reseller sub-tenants — list/get own, downward-only 404, metadata-only (integration)", () => {
  it("lists ONLY the reseller's own sub-tenants (metadata-only) plus its quota position (SC-001)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("GET", "/admin/reseller/sub-tenants", admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subTenants: Array<{ subTenantId: string; displayName: string }>;
      truncated: boolean;
      subTenantQuota: number;
      subTenantCount: number;
    };
    const ids = body.subTenants.map((s) => s.subTenantId).sort();
    expect(ids).toEqual([subA, subB].sort());
    expect(ids).not.toContain(subC); // the sibling's customer is never visible
    expect(body.subTenantCount).toBe(2);
    expect(body.subTenantQuota).toBe(10);
    expect(body.truncated).toBe(false);
    // Deterministic order: by displayName then subTenantId (Globex before Northwind).
    expect(body.subTenants.map((s) => s.displayName)).toEqual(["Globex Inc", "Northwind Ltd"]);
    // METADATA-ONLY: each row carries exactly the allowed keys — no license/usage/activation/resellerId.
    for (const s of body.subTenants) expect(Object.keys(s).sort()).toEqual(ALLOWED_SUBTENANT_KEYS);
  });

  it("gets ONE own sub-tenant (metadata-only)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("GET", `/admin/reseller/sub-tenants/${subA}`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.subTenantId).toBe(subA);
    expect(body.displayName).toBe("Northwind Ltd");
    expect(body.readOnly).toBe(false);
    expect(Object.keys(body).sort()).toEqual(ALLOWED_SUBTENANT_KEYS);
  });

  it("a sibling's customer resolves 404 not_found (never 403), no existence disclosure (SC-002)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("GET", `/admin/reseller/sub-tenants/${subC}`, admin);
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
    expect(res.json().code).toBe("not_found");
  });

  it("a parent/platform/IDOR id resolves 404 not_found (downward-only, SC-002)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    // The reseller's own id (an upward/self probe — a reseller has no parent) → 404.
    expect((await authed("GET", `/admin/reseller/sub-tenants/${resellerR}`, admin)).statusCode).toBe(404);
    // An unknown/platform id (valid UUID shape) → 404.
    expect((await authed("GET", `/admin/reseller/sub-tenants/${randomUUID()}`, admin)).statusCode).toBe(404);
  });

  it("records a security event on an out-of-subtree probe (HINT-002)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    await authed("GET", `/admin/reseller/sub-tenants/${subC}`, admin);
    const rows = await withTenant(pool, resellerR, (q) =>
      q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'reseller.subtree.denied' AND security_event = true"),
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("a VIEWER can read the list (200)", async () => {
    const viewer = await loginAs("reseller-r", "viewer@r.test");
    expect((await authed("GET", "/admin/reseller/sub-tenants", viewer)).statusCode).toBe(200);
  });

  it("a NON-reseller session on the reseller plane is denied 403 + a security event (fail-closed, FR-002)", async () => {
    const plain = await loginAs("plain-p", "admin@p.test");
    const res = await authed("GET", "/admin/reseller/sub-tenants", plain);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    const rows = await withTenant(pool, plainP, (q) =>
      q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'reseller.plane.denied' AND security_event = true"),
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("the data layer refuses unscoped access — an unset tenant GUC yields 0 rows on `reseller` (INV-1)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      const r = await client.query("SELECT count(*)::int AS n FROM reseller");
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
