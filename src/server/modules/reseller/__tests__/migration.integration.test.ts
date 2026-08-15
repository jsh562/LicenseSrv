// T009 (FR-005/FR-009/FR-013) [Foundational]: the 0014 reseller + white-label migration against real
// Postgres. Asserts the expand-only DDL (self-ref `tenant.parent_reseller_id`, the three NEW tenant-owned
// forced-RLS tables `reseller`/`branding_profile`/`domain_binding`, the nullable `audit_log.actor_reseller_id`)
// applies and behaves per data-model.md:
//   (a) forced RLS refuses unscoped access — an unset/empty `app.current_tenant` GUC yields 0 rows on ALL
//       THREE new tables under the non-owner `licensesrv_app` role (INV-1, SC-012);
//   (b) the one-level self-ref link — the FK works AND `tenant_parent_reseller_not_self` CHECK(<> id) rejects
//       self-parenting; a dangling parent id is rejected by the FK (the "a reseller must not carry a parent"
//       one-level rule itself is a SERVICE-layer guard a single-column CHECK cannot express);
//   (c) one-binding-per-host — the GLOBAL partial-unique `(binding_type, host) WHERE status IN
//       ('verified','active')` rejects a second tenant holding a verified/active binding for the same host,
//       while many `pending` claims on the same host are allowed (anti-squatting, INV-5, SC-011);
//   (d) `reseller_offboarding_shape` CHECK — `offboarding_started_at` is non-null EXACTLY when
//       status='offboarding';
//   (e) `audit_log.actor_reseller_id` exists + is nullable, and the append-only grants are preserved (no
//       UPDATE/DELETE to the app role).
// Reuses the testcontainers + migration harness (schema-level, no app/signer needed), mirroring the E016 usage
// and E017 policy migration.integration tests.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

// tenantA: RLS seed + audit; tenantB: offboarding-shape; tenantC/tenantD: cross-tenant host uniqueness;
// subTenant: the self-ref parent link target.
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantC = randomUUID();
const tenantD = randomUUID();
const subTenant = randomUUID();

/** Insert a domain_binding directly (schema-level) with an explicit status/host. */
async function insertBinding(
  tenantId: string,
  host: string,
  status: "pending" | "verified" | "active",
  bindingType: "custom_domain" | "email_sender" = "custom_domain",
): Promise<string> {
  const method = bindingType === "custom_domain" ? "dns_txt" : "spf_dkim_dmarc";
  const verifiedAt = status === "pending" ? "NULL" : "now()";
  const activatedAt = status === "active" ? "now()" : "NULL";
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO domain_binding
         (id, tenant_id, binding_type, host, status, verification_method, challenge_token, verified_at, activated_at)
       VALUES ($1, ${GUC}, $2, $3, $4, $5, 'public-dns-token', ${verifiedAt}, ${activatedAt})`,
      [id, bindingType, host, status, method],
    );
    return id;
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-reseller" });
  await provisionTenant(pool, { id: tenantB, slug: "beta-reseller" });
  await provisionTenant(pool, { id: tenantC, slug: "gamma-reseller" });
  await provisionTenant(pool, { id: tenantD, slug: "delta-reseller" });
  await provisionTenant(pool, { id: subTenant, slug: "sub-of-acme" });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0014 reseller + white-label migration (integration, real Postgres)", () => {
  it("creates the three new tenant-owned tables + their indexes", async () => {
    const tbl = await privileged(pool, (q) =>
      q(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('reseller','branding_profile','domain_binding')`,
      ),
    );
    expect(tbl.rowCount).toBe(3);
    const idx = await privileged(pool, (q) =>
      q(
        `SELECT indexname FROM pg_indexes
          WHERE tablename IN ('tenant','reseller','domain_binding') ORDER BY indexname`,
      ),
    );
    const names = idx.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "tenant_parent_reseller",
        "reseller_status",
        "domain_binding_tenant",
        "domain_binding_host_bound_uniq",
      ]),
    );
  });

  it("adds the expand-only self-ref tenant.parent_reseller_id column (nullable, default NULL)", async () => {
    const cols = await privileged(pool, (q) =>
      q(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'tenant' AND column_name = 'parent_reseller_id'`,
      ),
    );
    expect(cols.rowCount).toBe(1);
    const row = cols.rows[0] as { is_nullable: string; column_default: string | null };
    expect(row.is_nullable).toBe("YES");
    expect(row.column_default).toBeNull();
    // Existing rows keep NULL (direct-platform tenants).
    const r = await privileged(pool, (q) =>
      q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [tenantA]),
    );
    expect((r.rows[0] as { parent_reseller_id: string | null }).parent_reseller_id).toBeNull();
  });

  it("(a) forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on all THREE new tables (SC-012)", async () => {
    // Seed one row into each new table under a proper tenant scope first.
    await withTenant(pool, tenantA, (q) =>
      q(`INSERT INTO reseller (tenant_id, status, sub_tenant_quota) VALUES (${GUC}, 'active', 10)`),
    );
    await withTenant(pool, tenantA, (q) =>
      q(`INSERT INTO branding_profile (tenant_id, product_name) VALUES (${GUC}, 'Acme White-label')`),
    );
    await insertBinding(tenantA, "seed-a.example", "pending");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      for (const table of ["reseller", "branding_profile", "domain_binding"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("(b) the self-ref FK links a sub-tenant to its managing reseller (one level)", async () => {
    // Schema-level: set the link on the privileged seam (a cross-tenant operator action).
    const ok = await privileged(pool, (q) =>
      q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2 RETURNING id", [tenantA, subTenant]),
    );
    expect(ok.rowCount).toBe(1);
    // Partial index only indexes linked sub-tenants — the link is now visible on the privileged seam.
    const r = await privileged(pool, (q) =>
      q("SELECT parent_reseller_id FROM tenant WHERE id = $1", [subTenant]),
    );
    expect((r.rows[0] as { parent_reseller_id: string }).parent_reseller_id).toBe(tenantA);
  });

  it("(b) tenant_parent_reseller_not_self CHECK rejects self-parenting (parent = id)", async () => {
    await expect(
      privileged(pool, (q) =>
        q("UPDATE tenant SET parent_reseller_id = id WHERE id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/tenant_parent_reseller_not_self|check constraint/i);
  });

  it("(b) the self-ref FK rejects a dangling parent id (no such tenant)", async () => {
    await expect(
      privileged(pool, (q) =>
        q("UPDATE tenant SET parent_reseller_id = $1 WHERE id = $2", [randomUUID(), subTenant]),
      ),
    ).rejects.toThrow(/foreign key|violates|tenant_parent_reseller_fk/i);
  });

  it("(c) one-binding-per-host — a SECOND tenant cannot hold a verified binding for the same (type, host)", async () => {
    const host = `bound-${randomUUID().slice(0, 8)}.example`;
    await insertBinding(tenantC, host, "verified");
    // The global partial-unique index is enforced across ALL tenants regardless of RLS/GUC.
    await expect(insertBinding(tenantD, host, "verified")).rejects.toThrow(
      /duplicate key value|unique|domain_binding_host_bound_uniq/i,
    );
  });

  it("(c) one-binding-per-host also blocks a verified host from being re-claimed as active by another tenant", async () => {
    const host = `active-${randomUUID().slice(0, 8)}.example`;
    await insertBinding(tenantC, host, "verified");
    await expect(insertBinding(tenantD, host, "active")).rejects.toThrow(
      /duplicate key value|unique|domain_binding_host_bound_uniq/i,
    );
  });

  it("(c) many `pending` claims on the same host are allowed (anti-squatting; first-to-bind wins later)", async () => {
    const host = `pending-${randomUUID().slice(0, 8)}.example`;
    const a = await insertBinding(tenantC, host, "pending");
    const b = await insertBinding(tenantD, host, "pending");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it("(d) reseller_offboarding_shape — offboarding REQUIRES offboarding_started_at", async () => {
    await expect(
      withTenant(pool, tenantB, (q) =>
        q(
          `INSERT INTO reseller (tenant_id, status, sub_tenant_quota, offboarding_started_at)
           VALUES (${GUC}, 'offboarding', 5, NULL)`,
        ),
      ),
    ).rejects.toThrow(/reseller_offboarding_shape|check constraint/i);
  });

  it("(d) reseller_offboarding_shape — a non-offboarding status must NOT carry offboarding_started_at", async () => {
    await expect(
      withTenant(pool, tenantB, (q) =>
        q(
          `INSERT INTO reseller (tenant_id, status, sub_tenant_quota, offboarding_started_at)
           VALUES (${GUC}, 'active', 5, now())`,
        ),
      ),
    ).rejects.toThrow(/reseller_offboarding_shape|check constraint/i);
  });

  it("(d) reseller_offboarding_shape — offboarding WITH offboarding_started_at is accepted", async () => {
    const ok = await withTenant(pool, tenantB, (q) =>
      q(
        `INSERT INTO reseller (tenant_id, status, sub_tenant_quota, offboarding_started_at)
         VALUES (${GUC}, 'offboarding', 5, now()) RETURNING tenant_id`,
      ),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("(e) audit_log.actor_reseller_id column exists and is nullable", async () => {
    const cols = await privileged(pool, (q) =>
      q(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'audit_log' AND column_name = 'actor_reseller_id'`,
      ),
    );
    expect(cols.rowCount).toBe(1);
    expect((cols.rows[0] as { is_nullable: string }).is_nullable).toBe("YES");
    // A dual-identity reseller-action row round-trips: tenant_id=target, actor_reseller_id=acting reseller.
    const ok = await withTenant(pool, subTenant, (q) =>
      q(
        `INSERT INTO audit_log (tenant_id, actor, action, target, security_event, actor_reseller_id)
         VALUES (${GUC}, 'reseller-admin', 'subtenant.branding.updated', 'branding', false, $1) RETURNING actor_reseller_id`,
        [tenantA],
      ),
    );
    expect((ok.rows[0] as { actor_reseller_id: string }).actor_reseller_id).toBe(tenantA);
    // Ordinary non-delegated actions leave it NULL (e.g. the provisionTenant audit row).
    const base = await withTenant(pool, tenantA, (q) =>
      q("SELECT actor_reseller_id FROM audit_log WHERE action = 'tenant.provisioned'"),
    );
    expect((base.rows[0] as { actor_reseller_id: string | null }).actor_reseller_id).toBeNull();
  });

  it("(e) append-only audit_log grants preserved — the app role has NO DELETE / NO UPDATE", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM audit_log"))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      withTenant(pool, tenantA, (q) => q("UPDATE audit_log SET actor = 'x'")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the app role has full DML on the three config tables (SELECT/INSERT/UPDATE/DELETE)", async () => {
    // Reseller config tables are mutable (not append-only ledgers): a scoped UPDATE + DELETE succeed.
    const upd = await withTenant(pool, tenantA, (q) =>
      q("UPDATE reseller SET sub_tenant_quota = 25 WHERE tenant_id = $1 RETURNING sub_tenant_quota", [tenantA]),
    );
    expect((upd.rows[0] as { sub_tenant_quota: number }).sub_tenant_quota).toBe(25);
    const del = await withTenant(pool, tenantA, (q) =>
      q("DELETE FROM branding_profile WHERE tenant_id = $1", [tenantA]),
    );
    expect(del.rowCount).toBe(1);
  });
});
