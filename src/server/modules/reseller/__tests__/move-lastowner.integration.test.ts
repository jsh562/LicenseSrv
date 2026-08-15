// T036 [US4] (FR-015/016, SC-014/015): the OPERATOR-only MOVE of a sub-tenant between resellers + LAST-OWNER
// protection, over the real HTTP surface (Fastify inject + Testcontainers Postgres). Asserts:
//   - only the operator may move; a reseller-admin attempting it → 403 (operator plane, US1-AS4).
//   - the move RE-POINTS parent_reseller_id to the destination reseller.
//   - the move PRESERVES the sub-tenant's own branding overrides (its profile row is never touched).
//   - the move RE-RESOLVES per-field locks against the DESTINATION reseller (the source's locks no longer apply,
//     the destination's do) — resolution is computed at read (SC-014).
//   - the move writes a DUAL-IDENTITY audit on BOTH source and destination (actor_reseller_id = source AND = dest).
//   - LAST-OWNER protection holds for a reseller tenant: demoting its sole owner → 409 last_owner (SC-015, T042).
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
const SECRET = "reseller-move-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// O = operator; R1 = source reseller (locks primaryColor); R2 = destination reseller (locks secondaryColor);
// subS = sub-tenant under R1 with its own logoUrl override; RL = a reseller with a SINGLE owner (last-owner test).
const operatorO = randomUUID();
const resellerR1 = randomUUID();
const resellerR2 = randomUUID();
const subS = randomUUID();
const resellerLast = randomUUID();
let lastOwnerUserId = "";

async function seedUser(tenantId: string, email: string, role: string): Promise<string> {
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
  return id;
}

async function seedReseller(tenantId: string, quota: number): Promise<void> {
  await withTenant(pool, tenantId, (q) => q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', $1)`, [quota]));
}

async function seedBranding(
  tenantId: string,
  cols: { colPrimary?: string; colSecondary?: string; logo?: string; locked?: string[] },
): Promise<void> {
  await withTenant(pool, tenantId, (q) =>
    q(
      `INSERT INTO branding_profile (tenant_id, color_primary, color_secondary, logo_ref, locked_fields, updated_at)
       VALUES (${GUC}, $1, $2, $3, $4::jsonb, now())`,
      [cols.colPrimary ?? null, cols.colSecondary ?? null, cols.logo ?? null, JSON.stringify(cols.locked ?? [])],
    ),
  );
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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: operatorO, slug: "operator-o", name: "Operator" });
  await provisionTenant(pool, { id: resellerR1, slug: "reseller-r1", name: "Acme Partners" });
  await provisionTenant(pool, { id: resellerR2, slug: "reseller-r2", name: "Globex Partners" });
  await provisionTenant(pool, { id: subS, slug: "sub-s", name: "Northwind Ltd" });
  await provisionTenant(pool, { id: resellerLast, slug: "reseller-last", name: "Solo Partners" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR1, subS]));
  await seedReseller(resellerR1, 10);
  await seedReseller(resellerR2, 10);
  await seedReseller(resellerLast, 5);
  // R1 locks primaryColor; R2 locks secondaryColor (different) — so the move flips which field is locked for subS.
  await seedBranding(resellerR1, { colPrimary: "#111", locked: ["primaryColor"] });
  await seedBranding(resellerR2, { colSecondary: "#222", locked: ["secondaryColor"] });
  // subS keeps its OWN override (logoUrl) across the move.
  await seedBranding(subS, { logo: "https://cdn.northwind.example/logo.svg", locked: [] });
  await seedUser(operatorO, "admin@o.test", "admin");
  await seedUser(resellerR1, "admin@r1.test", "admin");
  await seedUser(subS, "admin@s.test", "admin");
  lastOwnerUserId = await seedUser(resellerLast, "owner@last.test", "owner");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("operator move sub-tenant (re-point + preserve overrides + re-resolve locks + dual audit) + last-owner (integration)", () => {
  it("a reseller-admin attempting the move (an operator action) → 403 forbidden (operator plane)", async () => {
    const resellerAdmin = await loginAs("reseller-r1", "admin@r1.test");
    const res = await authed("POST", `/admin/operator/sub-tenants/${subS}/move`, resellerAdmin, {
      destination: { type: "to_reseller", destinationResellerId: resellerR2 },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    // The parent link was NOT changed by the denied attempt.
    const r = await privileged(pool, (q) => q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [subS]));
    expect((r.rows[0] as { parent_reseller_id: string }).parent_reseller_id).toBe(resellerR1);
  });

  it("the operator MOVES subS from R1 → R2: re-points parent + returns the re-parented sub-tenant (200)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/sub-tenants/${subS}/move`, op, {
      destination: { type: "to_reseller", destinationResellerId: resellerR2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subTenantId: string; resellerId: string };
    expect(body.subTenantId).toBe(subS);
    expect(body.resellerId).toBe(resellerR2); // operator plane discloses the (new) managing reseller
    // The parent link was re-pointed to the destination reseller.
    const r = await privileged(pool, (q) => q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [subS]));
    expect((r.rows[0] as { parent_reseller_id: string }).parent_reseller_id).toBe(resellerR2);
  });

  it("the move PRESERVES the sub-tenant's own overrides and RE-RESOLVES locks against the destination (SC-014)", async () => {
    const subAdmin = await loginAs("sub-s", "admin@s.test");
    const res = await authed("GET", "/admin/branding", subAdmin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overrides: Record<string, string>;
      lockedFields: string[];
      resolved: Array<{ field: string; value: string | null; source: string; locked: boolean }>;
    };
    // Overrides preserved: subS still carries its own logoUrl override after the move.
    expect(body.overrides.logoUrl).toBe("https://cdn.northwind.example/logo.svg");
    // Locks re-resolved to the DESTINATION (R2 locks secondaryColor; R1's primaryColor lock no longer applies).
    expect(body.lockedFields).toEqual(["secondaryColor"]);
    const m = new Map(body.resolved.map((x) => [x.field, x]));
    expect(m.get("secondaryColor")).toMatchObject({ value: "#222", source: "reseller", locked: true });
    expect(m.get("primaryColor")!.locked).toBe(false); // no longer locked (source reseller left behind)
    expect(m.get("logoUrl")).toMatchObject({ value: "https://cdn.northwind.example/logo.svg", source: "sub_tenant" });
  });

  it("the move wrote a DUAL-IDENTITY audit on BOTH source and destination (SC-014)", async () => {
    const rows = await withTenant(pool, subS, (q) =>
      q("SELECT action, actor_reseller_id FROM audit_log WHERE action LIKE 'sub_tenant.move.%'"),
    );
    const byReseller = new Map(
      (rows.rows as { action: string; actor_reseller_id: string | null }[]).map((r) => [r.action, r.actor_reseller_id]),
    );
    expect(byReseller.get("sub_tenant.move.source")).toBe(resellerR1); // source attribution
    expect(byReseller.get("sub_tenant.move.destination")).toBe(resellerR2); // destination attribution
  });

  it("LAST-OWNER protection: demoting a reseller tenant's sole owner → 409 last_owner (SC-015, T042)", async () => {
    const owner = await loginAs("reseller-last", "owner@last.test");
    const res = await authed("PATCH", `/admin/users/${lastOwnerUserId}`, owner, { role: "viewer" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("last_owner");
  });
});
