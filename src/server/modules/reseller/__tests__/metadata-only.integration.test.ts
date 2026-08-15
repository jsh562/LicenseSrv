// T016 [US1] (FR-017, SC-001, US1-AS5): the METADATA-ONLY guarantee — a reseller-admin sees ONLY a sub-tenant's
// administrative metadata (id/display-name/status/read-only/created-at) and NEVER its license, usage, or
// activation operational data, in the HTTP response (list + detail) AND the underlying repo projection. Even
// when the sub-tenant HAS license/activation data of its own, none of it is exposed to the reseller.
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
import { ResellerRepo } from "../reseller-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "reseller-metadata-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let repo: ResellerRepo;

const resellerR = randomUUID();
const subA = randomUUID();

// The exact metadata-only key sets (contract SubTenant, reseller plane) — and the forbidden substrings.
const WIRE_KEYS = ["subTenantId", "displayName", "status", "readOnly", "createdAt"].sort();
const REPO_KEYS = ["id", "slug", "name", "parentResellerId", "deletedAt", "createdAt"].sort();
const FORBIDDEN = /license|usage|activation|seat|entitlement|token|key|fingerprint/i;

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

function authed(method: "GET", url: string, auth: { session: string; csrf: string }): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf } });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  repo = new ResellerRepo(pool);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r" });
  await withTenant(pool, resellerR, (q) =>
    q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', 10)`),
  );
  await seedUser(resellerR, "admin@r.test", "admin");
  // A sub-tenant of the reseller — the reseller may see only its administrative metadata, never operational data.
  await provisionTenant(pool, { id: subA, slug: "sub-a", name: "Northwind Ltd" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR, subA]));
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("reseller sub-tenant view — metadata-only, no license/usage/activation (integration)", () => {
  it("the LIST response carries only metadata keys — no license/usage/activation field (FR-017)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("GET", "/admin/reseller/sub-tenants", admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subTenants: Array<Record<string, unknown>> };
    expect(body.subTenants.length).toBe(1);
    for (const s of body.subTenants) {
      expect(Object.keys(s).sort()).toEqual(WIRE_KEYS);
      for (const k of Object.keys(s)) expect(k).not.toMatch(FORBIDDEN);
    }
  });

  it("the DETAIL response carries only metadata keys — no license/usage/activation field (FR-017)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("GET", `/admin/reseller/sub-tenants/${subA}`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(WIRE_KEYS);
    for (const k of Object.keys(body)) expect(k).not.toMatch(FORBIDDEN);
  });

  it("the REPO projection (list + get) is metadata-only — no operational-data column (FR-017)", async () => {
    const list = await repo.listSubTenants(resellerR, { limit: 100 });
    expect(list.length).toBe(1);
    for (const row of list) {
      expect(Object.keys(row as Record<string, unknown>).sort()).toEqual(REPO_KEYS);
      for (const k of Object.keys(row as Record<string, unknown>)) expect(k).not.toMatch(FORBIDDEN);
    }
    const one = await repo.getSubTenant(resellerR, subA);
    expect(one).not.toBeNull();
    expect(Object.keys(one as unknown as Record<string, unknown>).sort()).toEqual(REPO_KEYS);
  });
});
