// T014 (FR-003/008/009/014/018): the 0009 migration against real Postgres. Asserts the additive activation
// anchor columns + the new checkin + revocation_list tables apply; forced RLS refuses unscoped access
// (unset GUC -> 0 rows) and cross-tenant rows are invisible; grants are append-only (SELECT/INSERT only —
// UPDATE/DELETE denied on both new tables); the composite FK + nonce-uniqueness + idempotent replay work;
// and the guarded anchor advance is monotonic non-decreasing (a rollback is rejected). Reuses the
// activation/issuance testcontainers + migration harness — no app/signer needed (schema-level test).
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { advanceAnchor, recordCheckin } from "../checkin-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();

// Seeded FK chain (tenant A): product -> plan -> customer -> license -> activation.
let productA: string;
let activationA: string;

async function seedChain(tenantId: string): Promise<{ productId: string; activationId: string }> {
  return withTenant(pool, tenantId, async (q) => {
    const productId = randomUUID();
    const planId = randomUUID();
    const customerId = randomUUID();
    const licenseId = randomUUID();
    const activationId = randomUUID();
    const gucTenant = "current_setting('app.current_tenant')::uuid";
    await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${gucTenant}, $2, 'P')`, [productId, `prod-${productId.slice(0, 8)}`]);
    await q(`INSERT INTO plan (id, tenant_id, product_id, key, name) VALUES ($1, ${gucTenant}, $2, $3, 'Plan')`, [planId, productId, `plan-${planId.slice(0, 8)}`]);
    await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${gucTenant}, $2)`, [customerId, `cust-${customerId.slice(0, 8)}`]);
    await q(
      `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token)
       VALUES ($1, ${gucTenant}, $2, $3, $4, 5, '{"pro":true}'::jsonb, 1, $5, 'LIC1.seed')`,
      [licenseId, productId, planId, customerId, `lnonce-${licenseId.slice(0, 8)}`],
    );
    await q(
      `INSERT INTO activation (id, tenant_id, license_id, machine_id, signal_hashes, fp_min, nonce, machine_bound_token)
       VALUES ($1, ${gucTenant}, $2, 'mid', ARRAY['h1','h2','h3'], 3, $3, 'LIC1.bound')`,
      [activationId, licenseId, `anonce-${activationId.slice(0, 8)}`],
    );
    return { productId, activationId };
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-enf" });
  await provisionTenant(pool, { id: tenantB, slug: "other-enf" });
  const seeded = await seedChain(tenantA);
  productA = seeded.productId;
  activationA = seeded.activationId;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0009 online-enforcement migration (integration, real Postgres)", () => {
  it("adds the additive activation anchor columns (nullable; no existing-column change)", async () => {
    const cols = await privileged(pool, (q) =>
      q(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'activation' AND column_name IN ('last_checkin_at','last_anchor_at')
          ORDER BY column_name`,
      ),
    );
    expect(cols.rows).toEqual([
      { column_name: "last_anchor_at", is_nullable: "YES" },
      { column_name: "last_checkin_at", is_nullable: "YES" },
    ]);
    // A freshly-seeded activation is "never online": both anchors are NULL (not revoked-by-default, FR-012).
    const seeded = await withTenant(pool, tenantA, (q) => q("SELECT last_checkin_at, last_anchor_at FROM activation WHERE id = $1", [activationA]));
    expect(seeded.rows[0]).toEqual({ last_checkin_at: null, last_anchor_at: null });
  });

  it("creates the checkin + revocation_list tables", async () => {
    const tables = await privileged(pool, (q) =>
      q(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('checkin','revocation_list') ORDER BY table_name`),
    );
    expect(tables.rows.map((r) => (r as { table_name: string }).table_name)).toEqual(["checkin", "revocation_list"]);
  });

  it("records a check-in (composite FK to activation) and replays idempotently on a duplicate nonce (FR-008)", async () => {
    const nonce = `n-${randomUUID()}`;
    const first = await withTenant(pool, tenantA, (q) =>
      recordCheckin(q, { activationId: activationA, nonce, outcome: "renewed", reason: null, renewedToken: "LIC1.renewed-v1" }),
    );
    expect(first.replayed).toBe(false);
    // Same nonce + same activation -> the ORIGINAL row/token is replayed, not a second insert.
    const replay = await withTenant(pool, tenantA, (q) =>
      recordCheckin(q, { activationId: activationA, nonce, outcome: "renewed", reason: null, renewedToken: "LIC1.renewed-v2" }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(replay.renewedToken).toBe("LIC1.renewed-v1");
  });

  it("publishes a signed CRL row (composite FK to product; next_update > generated_at)", async () => {
    const id = await withTenant(pool, tenantA, async (q) => {
      const crlId = randomUUID();
      await q(
        `INSERT INTO revocation_list (id, tenant_id, product_id, version, next_update, key_id, signature, revoked_ids)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, 1, now() + interval '1 day', 'key-1', 'sig-1', $3::jsonb)`,
        [crlId, productA, JSON.stringify({ licenses: [], activations: [] })],
      );
      return crlId;
    });
    const got = await withTenant(pool, tenantA, (q) => q("SELECT version, key_id FROM revocation_list WHERE id = $1", [id]));
    expect(got.rows[0]).toMatchObject({ version: "1", key_id: "key-1" });
  });

  it("forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on both new tables (FR-018)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      const c = await client.query("SELECT count(*)::int AS n FROM checkin");
      const r = await client.query("SELECT count(*)::int AS n FROM revocation_list");
      expect((c.rows[0] as { n: number }).n).toBe(0);
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant rows are invisible — tenant B sees none of tenant A's check-ins/CRLs (FR-018)", async () => {
    const counts = await withTenant(pool, tenantB, async (q) => {
      const c = await q("SELECT count(*)::int AS n FROM checkin");
      const r = await q("SELECT count(*)::int AS n FROM revocation_list");
      return { checkins: (c.rows[0] as { n: number }).n, crls: (r.rows[0] as { n: number }).n };
    });
    expect(counts).toEqual({ checkins: 0, crls: 0 });
  });

  it("grants are append-only — UPDATE and DELETE on both new tables are denied to the app role", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("UPDATE checkin SET reason = 'x'"))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM checkin"))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(pool, tenantA, (q) => q("UPDATE revocation_list SET signature = 'x'"))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM revocation_list"))).rejects.toThrow(/permission denied/i);
  });

  it("the guarded anchor advance is monotonic non-decreasing — a rollback is rejected (FR-014)", async () => {
    const t2 = 2_000_000_000;
    const anchorOf = () =>
      withTenant(pool, tenantA, async (q) => {
        const r = await q("SELECT extract(epoch FROM last_anchor_at)::bigint AS a FROM activation WHERE id = $1", [activationA]);
        const a = (r.rows[0] as { a: string | null }).a;
        return a == null ? null : Number(a);
      });

    // First anchor -> advances (was NULL).
    expect(await withTenant(pool, tenantA, (q) => advanceAnchor(q, activationA, t2))).toBe(true);
    expect(await anchorOf()).toBe(t2);

    // A rolled-back time (< the floor) is REJECTED — the guard matches no row and the anchor is unchanged.
    expect(await withTenant(pool, tenantA, (q) => advanceAnchor(q, activationA, t2 - 1_000))).toBe(false);
    expect(await anchorOf()).toBe(t2);

    // A later time advances the floor.
    expect(await withTenant(pool, tenantA, (q) => advanceAnchor(q, activationA, t2 + 1_000))).toBe(true);
    expect(await anchorOf()).toBe(t2 + 1_000);

    // last_checkin_at is set on a successful advance (FR-003).
    const lastCheckin = await withTenant(pool, tenantA, (q) => q("SELECT last_checkin_at FROM activation WHERE id = $1", [activationA]));
    expect((lastCheckin.rows[0] as { last_checkin_at: Date | null }).last_checkin_at).not.toBeNull();
  });
});
