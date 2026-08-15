// T035 [US4] (FR-012, SC-010): the reseller OFFBOARD surface, over the real HTTP surface (Fastify inject +
// Testcontainers Postgres). Asserts:
//   - only the operator may offboard; a reseller-admin attempting it → 403 (operator plane, US1-AS4).
//   - offboard is BLOCKED 409 sub_tenants_unresolved while any sub-tenant remains — details carry the live
//     unresolved count AND the grace window (graceEndsAt); the reseller transitions to `offboarding` (grace anchor set).
//   - offboard is IDEMPOTENT: re-invoking keeps the ORIGINAL grace anchor (offboarding_started_at is stable).
//   - resolving every sub-tenant (operator move to direct-platform) then offboarding → 200, status `offboarding`,
//     unresolvedSubTenantCount 0, graceEndsAt present.
//   - every offboard attempt is AUDITED (reseller.offboarding rows under the reseller's own scope).
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
const SECRET = "reseller-offboard-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// O = operator; R = a reseller (active, quota 10) with two sub-tenants subA, subB.
const operatorO = randomUUID();
const resellerR = randomUUID();
const subA = randomUUID();
const subB = randomUUID();

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

async function seedSubTenant(id: string, slug: string, name: string, parentReseller: string): Promise<void> {
  await provisionTenant(pool, { id, slug, name });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [parentReseller, id]));
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
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

async function resellerRow(tenantId: string): Promise<{ status: string; offboarding_started_at: Date | null }> {
  const r = await withTenant(pool, tenantId, (q) => q("SELECT status, offboarding_started_at FROM reseller WHERE tenant_id = " + GUC));
  return r.rows[0] as { status: string; offboarding_started_at: Date | null };
}

async function offboardAuditCount(tenantId: string): Promise<number> {
  const r = await withTenant(pool, tenantId, (q) => q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'reseller.offboarding'"));
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: operatorO, slug: "operator-o", name: "Operator" });
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r", name: "Acme Partners" });
  await seedReseller(resellerR, 10);
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

describe("reseller offboard — blocked until resolved, grace window, idempotent, audited (integration)", () => {
  it("a reseller-admin attempting to offboard (an operator action) → 403 forbidden (operator plane)", async () => {
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/offboard`, resellerAdmin);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    expect((await resellerRow(resellerR)).status).toBe("active"); // unchanged by the denied attempt
  });

  let anchor: string;

  it("offboard is BLOCKED 409 sub_tenants_unresolved while sub-tenants remain; grace window applied (SC-010)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/offboard`, op);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; details?: { unresolvedSubTenantCount: number; graceEndsAt: string } };
    expect(body.code).toBe("sub_tenants_unresolved");
    expect(body.details?.unresolvedSubTenantCount).toBe(2);
    expect(typeof body.details?.graceEndsAt).toBe("string"); // the notice/grace window is present

    // The reseller transitioned to `offboarding` with a STABLE grace anchor (even though offboard is blocked).
    const row = await resellerRow(resellerR);
    expect(row.status).toBe("offboarding");
    expect(row.offboarding_started_at).not.toBeNull();
    anchor = row.offboarding_started_at!.toISOString();
  });

  it("offboard is IDEMPOTENT — re-invoking keeps the ORIGINAL grace anchor", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/offboard`, op);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("sub_tenants_unresolved");
    // The grace anchor is unchanged across the re-invocation (stable window).
    expect((await resellerRow(resellerR)).offboarding_started_at!.toISOString()).toBe(anchor);
  });

  it("resolving EVERY sub-tenant (operator move to direct-platform) then offboarding → 200, completed", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    // Move both sub-tenants to direct-platform ownership (no orphans) — the resolution path (FR-012).
    for (const sub of [subA, subB]) {
      const mv = await authed("POST", `/admin/operator/sub-tenants/${sub}/move`, op, {
        destination: { type: "to_direct_platform" },
      });
      expect(mv.statusCode).toBe(200);
      expect((mv.json() as { resellerId: string | null }).resellerId).toBeNull();
    }

    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/offboard`, op);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellerId: string; status: string; unresolvedSubTenantCount: number; graceEndsAt: string };
    expect(body.resellerId).toBe(resellerR);
    expect(body.status).toBe("offboarding");
    expect(body.unresolvedSubTenantCount).toBe(0);
    expect(typeof body.graceEndsAt).toBe("string");
  });

  it("every offboard attempt was AUDITED (reseller.offboarding rows under the reseller's own scope)", async () => {
    // Three offboard calls reached the lifecycle (two blocked + one completed); each appends an audit row.
    expect(await offboardAuditCount(resellerR)).toBeGreaterThanOrEqual(3);
  });
});
