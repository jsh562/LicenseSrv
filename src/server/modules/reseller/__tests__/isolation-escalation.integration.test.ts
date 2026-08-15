// T029 [US3] (FR-005, SC-002/007; AD-001/002, HINT-001/002): the ISOLATION / ESCALATION proof over the real
// HTTP surface AND the raw data-access layer (Fastify inject + Testcontainers Postgres). Seeds TWO resellers,
// each with its own sub-tenants, plus a direct-platform tenant, and proves that NO cross-subtree read/write is
// reachable — the crux of this epic:
//   - UPWARD (a reseller's own id / a direct-platform / an unknown id) → 404 not_found, never 403 (a reseller
//     carries no parent; the platform is above the subtree).
//   - LATERAL + IDOR-by-valid-id (reseller-1 reaching reseller-2's real sub-tenant UUID) → 404 no disclosure +
//     a DUAL-IDENTITY `security_event` audit row (actor_reseller_id = the ACTING reseller), never 403.
//   - DATA LAYER: the repo's downward-only `parent_reseller_id = :reseller` lookup returns null cross-subtree;
//     `withSubTenantScope` never opens a scope on a denied target; and under a reseller's OWN tenant session the
//     per-tenant `tenant` RLS predicate exposes ONLY its own row (the subtree is NOT visible) — proving the
//     predicate was never broadened to reach `parent_reseller_id`.
//   - FAIL-CLOSED: an unset/empty `app.current_tenant` GUC yields ZERO rows on all three new reseller tables
//     (reseller, branding_profile, domain_binding) — unscoped access is refused, not unscoped (INV-1, SC-007).
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
import { withSubTenantScope } from "../gate.js";
import { ResellerRepo } from "../reseller-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "reseller-isolation-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let repo: ResellerRepo;

// TWO resellers each with sub-tenants + one direct-platform tenant — the cross-subtree matrix.
const resellerR1 = randomUUID();
const resellerR2 = randomUUID();
const directPlatform = randomUUID();
const subA1 = randomUUID(); // R1's customer
const subB1 = randomUUID(); // R1's customer
const subA2 = randomUUID(); // R2's customer — LATERAL / IDOR target for R1

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
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function authed(method: "GET" | "POST", url: string, auth: { session: string; csrf: string }): ReturnType<FastifyInstance["inject"]> {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf } });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  repo = new ResellerRepo(pool);

  await provisionTenant(pool, { id: resellerR1, slug: "reseller-1" });
  await provisionTenant(pool, { id: resellerR2, slug: "reseller-2" });
  await provisionTenant(pool, { id: directPlatform, slug: "direct-platform" });
  await seedReseller(resellerR1, 10);
  await seedReseller(resellerR2, 10);
  await seedUser(resellerR1, "admin@r1.test", "admin");
  await seedUser(resellerR2, "admin@r2.test", "admin");
  await seedSubTenant(subA1, "sub-a1", "R1 Alpha", resellerR1);
  await seedSubTenant(subB1, "sub-b1", "R1 Bravo", resellerR1);
  await seedSubTenant(subA2, "sub-a2", "R2 Alpha", resellerR2);

  // Seed R2-owned white-label config (a branding_profile + a domain_binding) to prove LATERAL data isolation:
  // R1 must never read R2's config rows, and an unset GUC must expose none of them.
  await withTenant(pool, resellerR2, (q) =>
    q(`INSERT INTO branding_profile (tenant_id, product_name, locked_fields) VALUES (${GUC}, 'R2 Brand', '[]'::jsonb)`),
  );
  await withTenant(pool, resellerR2, (q) =>
    q(
      `INSERT INTO domain_binding (id, tenant_id, binding_type, host, status, verification_method, challenge_token)
       VALUES ($1, ${GUC}, 'custom_domain', 'r2.example.com', 'pending', 'dns_txt', 'tok-r2')`,
      [randomUUID()],
    ),
  );

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("reseller isolation / escalation — no cross-subtree path is reachable (integration, SC-007)", () => {
  it("LATERAL + IDOR-by-valid-id: R1 reaching R2's real sub-tenant → 404 no disclosure + a dual-identity security event", async () => {
    const r1 = await loginAs("reseller-1", "admin@r1.test");
    const res = await authed("GET", `/admin/reseller/sub-tenants/${subA2}`, r1);
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403); // 403 would leak existence (HINT-002)
    expect(res.json().code).toBe("not_found");
    // The denial is recorded at the data layer as a DUAL-IDENTITY security event under R1's own trail.
    const rows = await withTenant(pool, resellerR1, (q) =>
      q(
        `SELECT actor_reseller_id FROM audit_log
          WHERE action = 'reseller.subtree.denied' AND security_event = true AND actor_reseller_id = $1`,
        [resellerR1],
      ),
    );
    expect(rows.rowCount).toBeGreaterThanOrEqual(1);
    expect((rows.rows[0] as { actor_reseller_id: string }).actor_reseller_id).toBe(resellerR1);
  });

  it("UPWARD/self and platform references → 404 (a reseller has no parent; the platform is above the subtree)", async () => {
    const r1 = await loginAs("reseller-1", "admin@r1.test");
    // R1's own id (an upward/self probe), the direct-platform tenant, and an unknown id — all 404.
    expect((await authed("GET", `/admin/reseller/sub-tenants/${resellerR1}`, r1)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/reseller/sub-tenants/${directPlatform}`, r1)).statusCode).toBe(404);
    expect((await authed("GET", `/admin/reseller/sub-tenants/${randomUUID()}`, r1)).statusCode).toBe(404);
    // The mirror image holds: R2 cannot reach R1's real customer either.
    const r2 = await loginAs("reseller-2", "admin@r2.test");
    expect((await authed("GET", `/admin/reseller/sub-tenants/${subA1}`, r2)).statusCode).toBe(404);
  });

  it("R1 lists ONLY its own two sub-tenants — R2's customer is never present (downward-only visibility)", async () => {
    const r1 = await loginAs("reseller-1", "admin@r1.test");
    const res = await authed("GET", "/admin/reseller/sub-tenants", r1);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { subTenants: Array<{ subTenantId: string }> }).subTenants.map((s) => s.subTenantId).sort();
    expect(ids).toEqual([subA1, subB1].sort());
    expect(ids).not.toContain(subA2);
  });

  it("DATA LAYER: the downward-only repo lookup returns null cross-subtree; the subtree list excludes the sibling", async () => {
    // R1 → R2's customer: the `parent_reseller_id = :reseller` filter matches zero rows (no disclosure).
    expect(await repo.getSubTenant(resellerR1, subA2)).toBeNull();
    // R2 → R1's customer: symmetric.
    expect(await repo.getSubTenant(resellerR2, subA1)).toBeNull();
    // R1's own customer resolves; the id round-trips downward-only.
    expect((await repo.getSubTenant(resellerR1, subA1))?.id).toBe(subA1);
    // The privileged subtree read never returns a sibling's customer.
    const r1Subs = (await repo.listSubTenants(resellerR1, { limit: 100 })).map((s) => s.id).sort();
    expect(r1Subs).toEqual([subA1, subB1].sort());
    expect(r1Subs).not.toContain(subA2);
  });

  it("DATA LAYER: withSubTenantScope never opens a scope on a denied cross-subtree target (fail-closed)", async () => {
    let ran = false;
    await expect(
      withSubTenantScope({ pool, repo }, resellerR1, subA2, async () => {
        ran = true;
        return "should-not-run";
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(ran).toBe(false);
  });

  it("NO RLS BROADENING: under R1's OWN tenant session the `tenant` predicate exposes ONLY its own row", async () => {
    // The per-tenant `tenant_isolation` predicate is `id = app.current_tenant` — a reseller session sees exactly
    // its own tenant row, NOT its sub-tenants. Subtree reach is the privileged seam alone (never a widened predicate).
    const visible = await withTenant(pool, resellerR1, async (q) => {
      const r = await q("SELECT id FROM tenant");
      return (r.rows as { id: string }[]).map((x) => x.id);
    });
    expect(visible).toEqual([resellerR1]);
    expect(visible).not.toContain(subA1);
    expect(visible).not.toContain(subA2);
  });

  it("LATERAL data isolation: R1 cannot read R2's branding_profile or domain_binding rows", async () => {
    const brand = await withTenant(pool, resellerR1, (q) => q("SELECT count(*)::int AS n FROM branding_profile"));
    expect((brand.rows[0] as { n: number }).n).toBe(0); // R2's profile is invisible to R1
    const dom = await withTenant(pool, resellerR1, (q) => q("SELECT count(*)::int AS n FROM domain_binding"));
    expect((dom.rows[0] as { n: number }).n).toBe(0); // R2's binding is invisible to R1
  });

  it("FAIL-CLOSED: an unset/empty tenant GUC yields ZERO rows on all three new reseller tables (INV-1, SC-007)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app"); // the non-owner app role, RLS forced, GUC unset
      for (const table of ["reseller", "branding_profile", "domain_binding"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      // An explicitly-empty GUC is likewise NULL → zero rows (never unscoped).
      await client.query("SELECT set_config('app.current_tenant', '', true)");
      const empty = await client.query("SELECT count(*)::int AS n FROM reseller");
      expect((empty.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
