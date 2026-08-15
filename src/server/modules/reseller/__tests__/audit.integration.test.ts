// T030 [US3] (FR-009, SC-005; AD-008, INV-8): the DUAL-IDENTITY, APPEND-ONLY reseller-audit proof over the real
// HTTP surface (Fastify inject + Testcontainers Postgres). Proves the two US3 audit guarantees:
//   - EVERY reseller action on a sub-tenant writes ONE dual-identity row carrying BOTH identities the target
//     scope cannot itself express — `tenant_id` = the TARGET sub-tenant (the scoped-descent GUC), `actor` = the
//     acting reseller-admin user, `actor_reseller_id` = the acting reseller's HOME tenant (SC-005). A denied
//     escalation is a security-event audit row too (security_event=true, same dual identity).
//   - The trail is APPEND-ONLY / tamper-evident: an edit (UPDATE) or delete (DELETE) is REFUSED for ALL RBAC
//     roles — owner, admin, viewer all resolve to the single non-owner `licensesrv_app` DB role, which holds
//     only SELECT,INSERT on `audit_log` (no UPDATE/DELETE grant), so no session role can mutate the log.
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
const SECRET = "reseller-audit-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// R = the acting reseller; S = a sibling reseller (its customer is a lateral/IDOR target); adminUserR = R's admin id.
const resellerR = randomUUID();
const resellerS = randomUUID();
const subOfS = randomUUID();
let adminUserR = "";

async function seedUser(tenantId: string, email: string, role: string): Promise<string> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)],
    );
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
  return id;
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
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function authed(method: "GET" | "POST", url: string, auth: { session: string; csrf: string }, payload?: unknown): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}

function provisionBody(displayName: string): Record<string, unknown> {
  return { displayName, firstAdminUserReference: "u_" + randomUUID().slice(0, 8) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r" });
  await provisionTenant(pool, { id: resellerS, slug: "reseller-s" });
  await seedReseller(resellerR, 10);
  await seedReseller(resellerS, 10);
  adminUserR = await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(resellerR, "owner@r.test", "owner");
  await seedSubTenant(subOfS, "sub-of-s", "Sibling Customer", resellerS);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

interface AuditRow {
  tenant_id: string;
  actor: string;
  action: string;
  target: string | null;
  security_event: boolean;
  actor_reseller_id: string | null;
}

describe("reseller dual-identity, append-only audit (integration, SC-005)", () => {
  it("a reseller ACTION on a sub-tenant writes ONE dual-identity row (tenant_id=target, actor=reseller-admin, actor_reseller_id=reseller)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", "/admin/reseller/sub-tenants", admin, provisionBody("Provisioned Co"));
    expect(res.statusCode).toBe(201);
    const newSubTenant = (res.json() as { subTenantId: string }).subTenantId;

    // Read the audit row from the TARGET sub-tenant's own scope — where the dual-identity row was written.
    const rows = await withTenant(pool, newSubTenant, async (q) => {
      const r = await q(
        `SELECT tenant_id, actor, action, target, security_event, actor_reseller_id
           FROM audit_log WHERE action = 'sub_tenant.provision'`,
      );
      return r.rows as AuditRow[];
    });
    expect(rows).toHaveLength(1); // exactly one row per action
    const row = rows[0]!;
    expect(row.tenant_id).toBe(newSubTenant); // written under the TARGET sub-tenant scope
    expect(row.actor).toBe(adminUserR); // the acting reseller-admin USER principal
    expect(row.actor_reseller_id).toBe(resellerR); // the acting reseller's HOME tenant — the second identity
    expect(row.security_event).toBe(false); // an ordinary (non-denied) delegated action
    // The two identities are distinct: the actor (a reseller-tenant user) is FOREIGN to the target sub-tenant.
    expect(row.actor).not.toBe(newSubTenant);
    expect(row.actor_reseller_id).not.toBe(newSubTenant);
  });

  it("a DENIED escalation is a dual-identity SECURITY-EVENT audit row too (security_event=true, actor_reseller_id=reseller)", async () => {
    const admin = await loginAs("reseller-r", "admin@r.test");
    const denied = await authed("GET", `/admin/reseller/sub-tenants/${subOfS}`, admin);
    expect(denied.statusCode).toBe(404);
    const rows = await withTenant(pool, resellerR, async (q) => {
      const r = await q(
        `SELECT actor, action, security_event, actor_reseller_id FROM audit_log
          WHERE action = 'reseller.subtree.denied' AND security_event = true`,
      );
      return r.rows as AuditRow[];
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actor).toBe(adminUserR);
    expect(rows[0]!.actor_reseller_id).toBe(resellerR);
  });

  it("the trail is APPEND-ONLY — an edit/delete is REFUSED for ALL RBAC roles (owner/admin/viewer → the same non-owner app role)", async () => {
    // Every RBAC role (owner, admin, viewer) handles requests through `withTenant`, which drops to the single
    // non-owner `licensesrv_app` DB role. That role has only SELECT,INSERT on `audit_log` — so UPDATE and DELETE
    // are refused irrespective of the caller's tenant role. Tamper-evident: no role can rewrite history (SC-005).
    await expect(
      withTenant(pool, resellerR, (q) => q("UPDATE audit_log SET actor = 'tampered' WHERE actor_reseller_id = $1", [resellerR])),
    ).rejects.toThrow();
    await expect(
      withTenant(pool, resellerR, (q) => q("DELETE FROM audit_log WHERE actor_reseller_id = $1", [resellerR])),
    ).rejects.toThrow();
    // No row anywhere was altered/deleted: a privileged (owner) global scan finds NO tampered actor and the
    // dual-identity provision + denial rows survive intact.
    const tampered = await privileged(pool, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM audit_log WHERE actor = 'tampered'");
      return (r.rows[0] as { n: number }).n;
    });
    expect(tampered).toBe(0);
    const survived = await privileged(pool, async (q) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE actor = $1 AND action IN ('sub_tenant.provision','reseller.subtree.denied')`,
        [adminUserR],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(survived).toBeGreaterThanOrEqual(2);
  });
});
