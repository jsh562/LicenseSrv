// T022 [US2] (FR-006/007, SC-003/004): the branding CRUD + per-field precedence surface over the real HTTP
// surface (Fastify inject + Testcontainers Postgres), mirroring the subtenants.integration harness. Asserts:
//   - a reseller can GET/PUT its own branding profile including per-field locks (FR-006).
//   - a sub-tenant sees the reseller brand by DEFAULT, and its OWN override where set (SC-003).
//   - each of the 8 fields resolves independently sub-tenant → reseller → platform (SC-004).
//   - a sub-tenant override of a reseller-LOCKED field is refused 409 field_locked (STF-001/002).
//   - CSRF/RBAC fail-closed on the mutations.
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
import { loadResellerConfig } from "../config.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "reseller-branding-secret";
const platform = loadResellerConfig().platformBranding;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const resellerR = randomUUID();
const subA = randomUUID();

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

async function seedReseller(tenantId: string, quota: number): Promise<void> {
  await withTenant(pool, tenantId, (q) => q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', $1)`, [quota]));
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function req(
  method: "GET" | "PUT",
  url: string,
  auth: { session: string; csrf: string },
  opts: { body?: unknown; csrf?: boolean } = {},
): ReturnType<FastifyInstance["inject"]> {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers["x-csrf-token"] = auth.csrf;
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers, payload: opts.body });
}

type Resolved = Array<{ field: string; value: string | null; source: string; locked: boolean }>;
const asMap = (r: Resolved) => new Map(r.map((x) => [x.field, x]));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r" });
  await provisionTenant(pool, { id: subA, slug: "sub-a", name: "Northwind Ltd" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR, subA]));
  await seedReseller(resellerR, 10);
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(resellerR, "viewer@r.test", "viewer");
  await seedUser(subA, "admin@a.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("reseller + sub-tenant branding CRUD, locks, per-field resolution (integration)", () => {
  it("a reseller sets its own branding profile + locks, then reads it back (FR-006)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const put = await req("PUT", "/admin/reseller/branding", admin, {
      body: { fields: { primaryColor: "#0a5", productName: "Acme LM", supportUrl: "https://support.acme.example" }, locked: ["primaryColor", "productName"] },
    });
    expect(put.statusCode).toBe(200);
    const get = await req("GET", "/admin/reseller/branding", admin);
    expect(get.statusCode).toBe(200);
    const body = get.json() as { fields: Record<string, string>; locked: string[]; resolved: Resolved };
    expect(body.fields.primaryColor).toBe("#0a5");
    expect(body.locked.sort()).toEqual(["primaryColor", "productName"]);
    // The reseller's OWN resolved branding: reseller value where set, platform default elsewhere.
    const m = asMap(body.resolved);
    expect(m.get("primaryColor")).toMatchObject({ value: "#0a5", source: "reseller", locked: true });
    expect(m.get("secondaryColor")).toMatchObject({ value: platform.secondaryColor, source: "platform" });
  });

  it("a sub-tenant sees the reseller brand by DEFAULT and its own override where set (SC-003/004)", async () => {
    const sub = await loginAs("sub-a", "admin@a.test");
    // Before any override: reseller default flows down.
    let get = await req("GET", "/admin/branding", sub);
    expect(get.statusCode).toBe(200);
    let body = get.json() as { overrides: Record<string, string>; lockedFields: string[]; resolved: Resolved };
    expect(asMap(body.resolved).get("supportUrl")).toMatchObject({ value: "https://support.acme.example", source: "reseller" });
    expect(body.lockedFields.sort()).toEqual(["primaryColor", "productName"]);

    // Set an UNLOCKED override (logoUrl) — it wins for that field only.
    const put = await req("PUT", "/admin/branding", sub, { body: { overrides: { logoUrl: "https://cdn.nw.example/logo.svg" } } });
    expect(put.statusCode).toBe(200);
    get = await req("GET", "/admin/branding", sub);
    body = get.json() as typeof body;
    const m = asMap(body.resolved);
    expect(m.get("logoUrl")).toMatchObject({ value: "https://cdn.nw.example/logo.svg", source: "sub_tenant" });
    expect(m.get("supportUrl")).toMatchObject({ value: "https://support.acme.example", source: "reseller" }); // unchanged
    expect(body.overrides.logoUrl).toBe("https://cdn.nw.example/logo.svg");
  });

  it("a sub-tenant override of a reseller-LOCKED field is refused 409 field_locked (STF-001/002)", async () => {
    const sub = await loginAs("sub-a", "admin@a.test");
    const put = await req("PUT", "/admin/branding", sub, { body: { overrides: { primaryColor: "#f00" } } });
    expect(put.statusCode).toBe(409);
    const body = put.json() as { code: string; details?: { field?: string } };
    expect(body.code).toBe("field_locked");
    expect(body.details?.field).toBe("primaryColor");
  });

  it("a locked field remains authoritative in the sub-tenant's resolved branding (SC-004)", async () => {
    const sub = await loginAs("sub-a", "admin@a.test");
    const get = await req("GET", "/admin/branding", sub);
    const body = get.json() as { resolved: Resolved };
    expect(asMap(body.resolved).get("primaryColor")).toMatchObject({ value: "#0a5", source: "reseller", locked: true });
  });

  it("a mutation without CSRF is refused fail-closed (403), and a viewer cannot mutate", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const noCsrf = await req("PUT", "/admin/reseller/branding", admin, { body: { fields: {} }, csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    const viewer = await loginAs("reseller-r", "viewer@r.test");
    const asViewer = await req("PUT", "/admin/reseller/branding", viewer, { body: { fields: {} } });
    expect(asViewer.statusCode).toBe(403);
  });

  it("setting a customDomain/emailSenderAddress before verification is refused 409 not_verified (FR-013)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const put = await req("PUT", "/admin/reseller/branding", admin, { body: { fields: { customDomain: "lic.acme.example" } } });
    expect(put.statusCode).toBe(409);
    expect((put.json() as { code: string }).code).toBe("not_verified");
  });
});
