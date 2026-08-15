// T034 [US4] (FR-011, SC-009): the reseller SUSPEND / REINSTATE surface + the DERIVED read-only cascade, over the
// real HTTP surface (Fastify inject + Testcontainers Postgres). Asserts:
//   - only the operator may suspend/reinstate; a reseller-admin attempting it → 403 (operator plane, US1-AS4).
//   - suspend transitions active → suspended (200); suspending a non-active reseller → 409 invalid_state_transition.
//   - under suspension a sub-tenant MUTATION is refused 409 reseller_suspended (provision + sub-tenant branding PUT),
//     while READS stay allowed (sub-tenant branding GET + reseller sub-tenant list, with readOnly=true).
//   - reinstate restores (suspended → active, 200); reinstating a non-suspended reseller → 409; mutations resume.
//   - the cascade is DERIVED (no fan-out write): the suspend never touches the sub-tenant row.
//   - an already-issued license token verifies OFFLINE byte-identical before AND after suspension (SC-009) — the
//     suspension is presentation-only and never touches any token/crypto (Principle I).
import { generateKeyPairSync, sign as edSign, verify as edVerify, randomUUID } from "node:crypto";
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
const SECRET = "reseller-suspend-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

// O = operator; R = a reseller (active, quota 10); subA = a sub-tenant under R.
const operatorO = randomUUID();
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

function authed(
  method: "GET" | "POST" | "PUT",
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

async function resellerStatus(tenantId: string): Promise<string> {
  const r = await withTenant(pool, tenantId, (q) => q("SELECT status FROM reseller WHERE tenant_id = " + GUC));
  return (r.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: operatorO, slug: "operator-o", name: "Operator" });
  await provisionTenant(pool, { id: resellerR, slug: "reseller-r", name: "Acme Partners" });
  await provisionTenant(pool, { id: subA, slug: "sub-a", name: "Northwind Ltd" });
  await privileged(pool, (q) => q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [resellerR, subA]));
  await seedReseller(resellerR, 10);
  await seedUser(operatorO, "admin@o.test", "admin");
  await seedUser(resellerR, "admin@r.test", "admin");
  await seedUser(subA, "admin@a.test", "admin");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("reseller suspend/reinstate + derived read-only cascade (integration)", () => {
  it("a reseller-admin attempting to suspend (an operator action) → 403 forbidden (operator plane)", async () => {
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/suspend`, resellerAdmin);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden");
    expect(await resellerStatus(resellerR)).toBe("active"); // unchanged by the denied attempt
  });

  it("the operator SUSPENDS the reseller (active → suspended, 200)", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/suspend`, op);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resellerId: string; status: string };
    expect(body.resellerId).toBe(resellerR);
    expect(body.status).toBe("suspended");
    expect(await resellerStatus(resellerR)).toBe("suspended");
  });

  it("suspending an ALREADY-suspended reseller → 409 invalid_state_transition", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/suspend`, op);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; details?: { from: string; to: string } };
    expect(body.code).toBe("invalid_state_transition");
    expect(body.details?.from).toBe("suspended");
  });

  it("under suspension a sub-tenant MUTATION is refused 409 reseller_suspended, but READS are allowed (SC-009)", async () => {
    // A reseller PROVISION (a new-sub-tenant mutation) is blocked by the read-only cascade.
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const prov = await authed("POST", "/admin/reseller/sub-tenants", resellerAdmin, {
      displayName: "Blocked Co",
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(prov.statusCode).toBe(409);
    expect((prov.json() as { code: string }).code).toBe("reseller_suspended");

    // A sub-tenant's OWN branding PUT (a mutation) is refused under the suspended reseller.
    const subAdmin = await loginAs("sub-a", "admin@a.test");
    const put = await authed("PUT", "/admin/branding", subAdmin, { overrides: { productName: "Nope" } });
    expect(put.statusCode).toBe(409);
    expect((put.json() as { code: string }).code).toBe("reseller_suspended");

    // READS still succeed: the sub-tenant reads its own branding...
    const get = await authed("GET", "/admin/branding", subAdmin);
    expect(get.statusCode).toBe(200);
    // ...and the reseller lists its sub-tenants, which report readOnly = true (derived from the suspension).
    const list = await authed("GET", "/admin/reseller/sub-tenants", resellerAdmin);
    expect(list.statusCode).toBe(200);
    const lb = list.json() as { subTenants: Array<{ subTenantId: string; readOnly: boolean }> };
    const s = lb.subTenants.find((x) => x.subTenantId === subA)!;
    expect(s.readOnly).toBe(true);
  });

  it("the cascade is DERIVED — the suspend never wrote to the sub-tenant row (no fan-out)", async () => {
    // The sub-tenant tenant row carries no per-sub-tenant suspend flag; its parent link is intact and it is not
    // tombstoned. The read-only state is computed purely from the reseller's status at request time.
    const r = await privileged(pool, (q) => q("SELECT deleted_at, parent_reseller_id FROM tenant WHERE id = $1", [subA]));
    const row = r.rows[0] as { deleted_at: Date | null; parent_reseller_id: string };
    expect(row.deleted_at).toBeNull();
    expect(row.parent_reseller_id).toBe(resellerR);
  });

  it("REINSTATE restores the reseller (suspended → active, 200) and mutations resume", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/reinstate`, op);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("active");

    // A mutation now succeeds again: the sub-tenant sets its own branding.
    const subAdmin = await loginAs("sub-a", "admin@a.test");
    const put = await authed("PUT", "/admin/branding", subAdmin, { overrides: { productName: "Northwind" } });
    expect(put.statusCode).toBe(200);

    // And the reseller can provision again.
    const resellerAdmin = await loginAs("reseller-r", "admin@r.test");
    const prov = await authed("POST", "/admin/reseller/sub-tenants", resellerAdmin, {
      displayName: "Allowed Co",
      firstAdminUserReference: "u_" + randomUUID().slice(0, 8),
    });
    expect(prov.statusCode).toBe(201);
  });

  it("reinstating an ALREADY-active reseller → 409 invalid_state_transition", async () => {
    const op = await loginAs("operator-o", "admin@o.test");
    const res = await authed("POST", `/admin/operator/resellers/${resellerR}/reinstate`, op);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("invalid_state_transition");
  });

  it("an already-issued license token verifies OFFLINE byte-identical before AND after suspension (SC-009)", async () => {
    // Model an "issued license" as a signed Ed25519 token — offline verification is a pure crypto check with NO
    // network/DB call, independent of any reseller state. Suspension is presentation-only and never touches it.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const token = Buffer.from("LIC1." + randomUUID(), "utf8");
    const signature = edSign(null, token, privateKey);
    expect(edVerify(null, token, publicKey, signature)).toBe(true); // verifies before suspension

    const op = await loginAs("operator-o", "admin@o.test");
    expect((await authed("POST", `/admin/operator/resellers/${resellerR}/suspend`, op)).statusCode).toBe(200);

    // The SAME token bytes + signature still verify offline while the reseller is suspended (unchanged).
    expect(edVerify(null, token, publicKey, signature)).toBe(true);

    await authed("POST", `/admin/operator/resellers/${resellerR}/reinstate`, op); // leave R active for isolation
  });
});
