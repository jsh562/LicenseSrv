// T033 [US4] (FR-001/010, US4-AS1): the OPERATOR-plane onboard surface over the real HTTP surface (Fastify
// inject + Testcontainers Postgres). Asserts the create-or-select onboarding flow + the one-level rule:
//   - create_new → 201 Reseller (default OR supplied quota), a first reseller-admin (owner) established (FR-010).
//   - promote_existing a plain tenant → 201, display name from tenant.name, first admin owner + quota.
//   - promote a tenant already a reseller → 409 onboarding_conflict (already_reseller).
//   - promote a tenant that is itself a sub-tenant → 409 onboarding_conflict (already_sub_tenant).
//   - promote an unknown tenant → 404 not_found.
//   - a reseller-admin attempting onboard (an operator action) → 403 forbidden (operator plane, US1-AS4).
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
const SECRET = "reseller-onboard-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// O = the operator (direct-platform); R = an existing reseller; plainPromote = a plain tenant to promote;
// subUnderR = a sub-tenant of R (already one level down).
const operatorO = randomUUID();
const resellerR = randomUUID();
const plainPromote = randomUUID();
const subUnderR = randomUUID();

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
  method: "GET" | "POST",
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

/** Count owner-role rows in a tenant (the first reseller-admin is established as an owner, FR-010/016). */
async function ownerCount(tenantId: string): Promise<number> {
  const r = await withTenant(pool, tenantId, (q) => q("SELECT count(*)::int AS n FROM role WHERE role = 'owner'"));
  return (r.rows[0] as { n: number }).n;
}

/** True if a pseudonymous first-admin reference was materialized as an app_user in the tenant. */
async function hasUserReference(tenantId: string, reference: string): Promise<boolean> {
  const r = await withTenant(pool, tenantId, (q) =>
    q("SELECT count(*)::int AS n FROM app_user WHERE email_hash = $1", [reference]),
  );
  return (r.rows[0] as { n: number }).n > 0;
}

const RESELLER_KEYS = ["resellerId", "displayName", "status", "subTenantQuota", "subTenantCount", "createdAt", "updatedAt"].sort();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: operatorO, slug: "operator-o", name: "Operator" });
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r", name: "Acme Partners" });
  await provisionTenant(pool, { id: plainPromote, slug: "plain-promote", name: "Promote Me Co" });
  await provisionTenant(pool, { id: subUnderR, slug: "sub-under-r", name: "Northwind Ltd" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR, subUnderR]));
  await seedReseller(resellerR, 10);
  await seedUser(operatorO, "admin@o.test", "admin");
  await seedUser(resellerR, "admin@r.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("operator onboard reseller — create-or-promote + first admin + quota + one-level rule (integration)", () => {
  it("onboards a NEW reseller tenant (201) with the supplied quota + a first reseller-admin (owner)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const ref = "u_" + randomUUID().slice(0, 8);
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "create_new",
      displayName: "Globex Partners",
      firstAdminUserReference: ref,
      subTenantQuota: 25,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toMatch(/^\/admin\/operator\/resellers\//);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(RESELLER_KEYS);
    expect(body.displayName).toBe("Globex Partners");
    expect(body.status).toBe("active");
    expect(body.subTenantQuota).toBe(25);
    expect(body.subTenantCount).toBe(0);

    const resellerId = body.resellerId as string;
    expect(await ownerCount(resellerId)).toBe(1); // the first reseller-admin (owner) is established (FR-010)
    expect(await hasUserReference(resellerId, ref)).toBe(true);
  });

  it("onboards a NEW reseller with an omitted quota → the platform-default quota (50)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "create_new",
      displayName: "Initech Partners",
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { subTenantQuota: number }).subTenantQuota).toBe(50);
  });

  it("PROMOTES an existing plain tenant to reseller (201) — display name from the tenant + first admin owner", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const ref = "u_" + randomUUID().slice(0, 8);
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "promote_existing",
      tenantId: plainPromote,
      firstAdminUserReference: ref,
      subTenantQuota: 7,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.resellerId).toBe(plainPromote);
    expect(body.displayName).toBe("Promote Me Co");
    expect(body.subTenantQuota).toBe(7);
    expect(await ownerCount(plainPromote)).toBe(1);
    expect(await hasUserReference(plainPromote, ref)).toBe(true);
  });

  it("refuses promoting a tenant that is ALREADY a reseller → 409 onboarding_conflict (already_reseller)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "promote_existing",
      tenantId: resellerR,
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; details?: { reason: string } };
    expect(body.code).toBe("onboarding_conflict");
    expect(body.details?.reason).toBe("already_reseller");
  });

  it("refuses promoting a tenant that is ITSELF a sub-tenant → 409 onboarding_conflict (already_sub_tenant)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "promote_existing",
      tenantId: subUnderR,
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; details?: { reason: string } };
    expect(body.code).toBe("onboarding_conflict");
    expect(body.details?.reason).toBe("already_sub_tenant");
  });

  it("refuses promoting an UNKNOWN tenant → 404 not_found", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", "/admin/operator/resellers", op, {
      mode: "promote_existing",
      tenantId: randomUUID(),
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("not_found");
  });

  it("a reseller-admin attempting onboard (an operator action) → 403 forbidden (operator plane, US1-AS4)", async () => {
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", "/admin/operator/resellers", resellerAdmin, {
      mode: "create_new",
      displayName: "Should Fail",
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
  });
});
