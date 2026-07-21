// T018 (FR-003/012/014/015/021): the 0010 billing migration against real Postgres. Asserts the three new
// tenant-owned tables + the secret-excluding view apply; forced RLS refuses unscoped access (unset GUC -> 0
// rows) and cross-tenant rows are invisible; the idempotency UNIQUE (tenant, provider, provider_event_id)
// dedups (recordEvent + a raw duplicate INSERT); the 1:1 (tenant, license_id) link is enforced; grants are
// append-only (billing_event: no UPDATE/DELETE; subscription: no DELETE; billing_connection: UPDATE OK); and
// the signing secret is EXCLUDED from billing_connection_public. Reuses the issuance/activation testcontainers
// + migration harness -- schema-level, no app/signer needed.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { recordEvent } from "../ledger-repo.js";
import { linkSubscription } from "../subscription-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();

let licenseA: string;
let subscriptionA: string;

const GUC = "current_setting('app.current_tenant')::uuid";

async function seedChain(tenantId: string): Promise<{ licenseId: string }> {
  return withTenant(pool, tenantId, async (q) => {
    const productId = randomUUID();
    const planId = randomUUID();
    const customerId = randomUUID();
    const licenseId = randomUUID();
    await q(`INSERT INTO product (id, tenant_id, key, name) VALUES ($1, ${GUC}, $2, 'P')`, [productId, `prod-${productId.slice(0, 8)}`]);
    await q(`INSERT INTO plan (id, tenant_id, product_id, key, name) VALUES ($1, ${GUC}, $2, $3, 'Plan')`, [planId, productId, `plan-${planId.slice(0, 8)}`]);
    await q(`INSERT INTO customer (id, tenant_id, ref) VALUES ($1, ${GUC}, $2)`, [customerId, `cust-${customerId.slice(0, 8)}`]);
    await q(
      `INSERT INTO license (id, tenant_id, product_id, plan_id, customer_id, max_activations, entitlements, token_version, nonce, license_token)
       VALUES ($1, ${GUC}, $2, $3, $4, 5, '{"pro":true}'::jsonb, 1, $5, 'LIC1.seed')`,
      [licenseId, productId, planId, customerId, `lnonce-${licenseId.slice(0, 8)}`],
    );
    // A billing connection (secret is a raw placeholder bytea; this is a schema-level test, no custody).
    await q(
      `INSERT INTO billing_connection (id, tenant_id, provider, signing_secret_ref, secret_custody_scheme)
       VALUES ($1, ${GUC}, 'stripe', decode('deadbeef', 'hex'), 'keystore-aes256gcm-v1')`,
      [randomUUID()],
    );
    return { licenseId };
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-billing" });
  await provisionTenant(pool, { id: tenantB, slug: "other-billing" });
  const seeded = await seedChain(tenantA);
  licenseA = seeded.licenseId;
  const sub = await withTenant(pool, tenantA, (q) =>
    linkSubscription(q, { provider: "stripe", externalSubscriptionId: "sub_1", licenseId: licenseA, occurredAt: 1_000 }),
  );
  subscriptionA = sub.id;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0010 billing migration (integration, real Postgres)", () => {
  it("creates billing_connection + subscription + billing_event and the public view", async () => {
    const tables = await privileged(pool, (q) =>
      q(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('billing_connection','subscription','billing_event','billing_connection_public')
          ORDER BY table_name`,
      ),
    );
    expect(tables.rows.map((r) => (r as { table_name: string }).table_name)).toEqual([
      "billing_connection",
      "billing_connection_public",
      "billing_event",
      "subscription",
    ]);
  });

  it("EXCLUDES the signing secret from billing_connection_public (FR-015)", async () => {
    const cols = await privileged(pool, (q) =>
      q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'billing_connection_public'`),
    );
    const names = cols.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).not.toContain("signing_secret_ref");
    expect(names).not.toContain("signing_secret_prev");
    expect(names).toEqual(expect.arrayContaining(["id", "provider", "status", "secret_custody_scheme", "plan_map"]));
    // A read through the view never surfaces the secret.
    const row = await withTenant(pool, tenantA, (q) => q("SELECT * FROM billing_connection_public LIMIT 1"));
    expect(Object.keys(row.rows[0] as object)).not.toContain("signing_secret_ref");
  });

  it("forced RLS refuses unscoped access — unset tenant GUC -> 0 rows on all three tables (FR-014)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      for (const table of ["billing_connection", "subscription", "billing_event"]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cross-tenant rows are invisible — tenant B sees none of tenant A's billing rows (FR-014)", async () => {
    const counts = await withTenant(pool, tenantB, async (q) => {
      const conn = await q("SELECT count(*)::int AS n FROM billing_connection");
      const sub = await q("SELECT count(*)::int AS n FROM subscription");
      return { connections: (conn.rows[0] as { n: number }).n, subscriptions: (sub.rows[0] as { n: number }).n };
    });
    expect(counts).toEqual({ connections: 0, subscriptions: 0 });
  });

  it("dedups by the idempotency UNIQUE (tenant, provider, provider_event_id) — a redelivery writes no 2nd row (FR-003)", async () => {
    const evt = {
      provider: "stripe",
      providerEventId: "evt_dedup",
      type: "subscription.renewed",
      subscriptionId: subscriptionA,
      occurredAt: 1_100,
      outcome: "applied" as const,
      reason: null,
      payloadSummary: { type: "subscription.renewed" },
    };
    const first = await withTenant(pool, tenantA, (q) => recordEvent(q, evt));
    expect(first.duplicate).toBe(false);
    const second = await withTenant(pool, tenantA, (q) => recordEvent(q, evt));
    expect(second).toEqual({ id: null, duplicate: true }); // ON CONFLICT DO NOTHING -> no 2nd row
    const count = await withTenant(pool, tenantA, (q) =>
      q("SELECT count(*)::int AS n FROM billing_event WHERE provider_event_id = 'evt_dedup'"),
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
    // A raw duplicate INSERT is DB-rejected (the UNIQUE, not just the app ON CONFLICT).
    await expect(
      withTenant(pool, tenantA, (q) =>
        q(
          `INSERT INTO billing_event (id, tenant_id, provider, provider_event_id, type, occurred_at, outcome, reason)
           VALUES ($1, ${GUC}, 'stripe', 'evt_dedup', 'subscription.renewed', now(), 'applied', NULL)`,
          [randomUUID()],
        ),
      ),
    ).rejects.toThrow(/duplicate key value|unique/i);
  });

  it("enforces the 1:1 (tenant, license_id) link — a second subscription on the same license is rejected (FR-012)", async () => {
    await expect(
      withTenant(pool, tenantA, (q) =>
        linkSubscription(q, { provider: "stripe", externalSubscriptionId: "sub_2", licenseId: licenseA, occurredAt: 2_000 }),
      ),
    ).rejects.toMatchObject({ code: "duplicate_subscription" });
  });

  it("grants are append-only — billing_event has no UPDATE/DELETE, subscription no DELETE, billing_connection UPDATE ok", async () => {
    await expect(withTenant(pool, tenantA, (q) => q("UPDATE billing_event SET reason = 'x'"))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM billing_event"))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM subscription"))).rejects.toThrow(/permission denied/i);
    // billing_connection IS mutable (configure / rotate / disable).
    const upd = await withTenant(pool, tenantA, (q) => q("UPDATE billing_connection SET status = 'disabled' RETURNING status"));
    expect((upd.rows[0] as { status: string }).status).toBe("disabled");
  });
});
