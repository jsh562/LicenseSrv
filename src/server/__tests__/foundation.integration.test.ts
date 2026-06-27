import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { resolveApiKey } from "../auth/apikey.js";
import { recordSecurityEvent, writeAudit } from "../audit/index.js";
import { authorize } from "../auth/rbac.js";
import { assertPgVersion, makePool, privileged, withTenant } from "../db/client.js";
import { eraseTenantPersonalData, exportTenant } from "../db/gdpr.js";
import { hmacKey } from "../db/hash.js";
import { runMigrations } from "../db/migrate.js";
import {
  countAudit,
  createApiKey,
  createUser,
  listUsers,
  provisionTenant,
} from "../db/repository.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
  await runMigrations(pool, MIGRATIONS_DIR);

  await provisionTenant(pool, { id: tenantA, slug: "tenant-a" });
  await provisionTenant(pool, { id: tenantB, slug: "tenant-b" });
  await createUser(pool, tenantA, { id: userA, emailHash: "hash-a" }, "actor-a");
  await createUser(pool, tenantB, { id: userB, emailHash: "hash-b" }, "actor-b");
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("tenancy & data foundation (integration, real Postgres)", () => {
  it("isolates tenant data — A sees only A, B sees only B (TR-001/002, SC-001)", async () => {
    const aUsers = await listUsers(pool, tenantA);
    const bUsers = await listUsers(pool, tenantB);
    expect(aUsers.map((u) => u.id)).toEqual([userA]);
    expect(bUsers.map((u) => u.id)).toEqual([userB]);
    expect(aUsers.find((u) => u.id === userB)).toBeUndefined();
    expect(bUsers.find((u) => u.id === userA)).toBeUndefined();
  });

  it("refuses an unscoped query — unset GUC under the app role yields zero rows (SC-002)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      // Deliberately do NOT set app.current_tenant.
      const r = await client.query("SELECT count(*)::int AS n FROM app_user");
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // The repository wrapper also hard-fails an empty tenant scope.
    await expect(withTenant(pool, "", async () => 1)).rejects.toThrow();
  });

  it("RLS WITH CHECK blocks writing another tenant's row (TR-002)", async () => {
    await expect(
      withTenant(pool, tenantA, async (q) =>
        q("INSERT INTO app_user (id, tenant_id, email_hash) VALUES ($1, $2, $3)", [
          randomUUID(),
          tenantB,
          "evil",
        ]),
      ),
    ).rejects.toThrow();
  });

  it("writes an append-only audit row per mutation; app role cannot UPDATE/DELETE it (TR-008, SC-005)", async () => {
    const n = await countAudit(pool, tenantA);
    expect(n).toBeGreaterThan(0); // tenant.provisioned + user.created
    await expect(
      withTenant(pool, tenantA, async (q) => q("UPDATE audit_log SET action = 'tamper'", [])),
    ).rejects.toThrow();
    await expect(
      withTenant(pool, tenantA, async (q) => q("DELETE FROM audit_log", [])),
    ).rejects.toThrow();
  });

  it("migrations are idempotent under the advisory-locked runner (TR-007, SC-003)", async () => {
    const applied = await runMigrations(pool, MIGRATIONS_DIR);
    expect(applied).toEqual([]);
  });

  it("resolves an API key to its tenant + scopes (TR-009)", async () => {
    const raw = "raw-api-key-xyz";
    await createApiKey(
      pool,
      tenantA,
      { id: randomUUID(), keyHash: hmacKey(raw, "test-secret"), scopes: ["validate"], createdBy: userA },
      "actor-a",
    );
    const ctx = await resolveApiKey(pool, raw, "test-secret");
    expect(ctx?.tenantId).toBe(tenantA);
    expect(ctx?.scopes).toContain("validate");
    // wrong key resolves to nothing
    expect(await resolveApiKey(pool, "nope", "test-secret")).toBeNull();
  });

  it("exports then erases a tenant's personal data while preserving audit (TR-012, SC-008)", async () => {
    const tenantC = randomUUID();
    const userC = randomUUID();
    await provisionTenant(pool, { id: tenantC, slug: "tenant-c" });
    await createUser(pool, tenantC, { id: userC, emailHash: "hash-c" }, "actor-c");
    await createApiKey(
      pool,
      tenantC,
      { id: randomUUID(), keyHash: hmacKey("kc", "test-secret"), scopes: ["validate"], createdBy: userC },
      "actor-c",
    );

    const exported = await exportTenant(pool, tenantC);
    expect(exported.users.length).toBe(1);
    expect(exported.apiKeys.length).toBe(1);
    expect(exported.auditCount).toBeGreaterThan(0);

    // an audit row carrying PII payloads, to verify redaction on erase
    await withTenant(pool, tenantC, async (q) =>
      writeAudit(q, {
        actor: "x",
        action: "pii-event",
        before: { email: "a@b.com" },
        after: { email: "c@d.com" },
      }),
    );

    const auditBefore = await countAudit(pool, tenantC);
    await eraseTenantPersonalData(pool, tenantC);
    const after = await exportTenant(pool, tenantC);
    expect(after.users.length).toBe(0);
    expect(after.apiKeys.length).toBe(0);
    // append-only audit event records preserved (count grew by the erase event)
    expect(await countAudit(pool, tenantC)).toBeGreaterThan(auditBefore);
    // PII payloads redacted; tenant tombstoned
    const redacted = await privileged(pool, (q) =>
      q("SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = 'pii-event'", [
        tenantC,
      ]),
    );
    expect((redacted.rows[0] as { before: unknown; after: unknown }).before).toBeNull();
    expect((redacted.rows[0] as { before: unknown; after: unknown }).after).toBeNull();
    const tomb = await privileged(pool, (q) =>
      q("SELECT deleted_at FROM tenant WHERE id = $1", [tenantC]),
    );
    expect((tomb.rows[0] as { deleted_at: unknown }).deleted_at).not.toBeNull();
  });

  it("authenticates requests via the API-key tenant context (TR-009)", async () => {
    const app = createApp({ pool, apiKeySecret: "test-secret" });
    app.get("/v1/whoami", async (req) => ({ tenant: req.tenant?.tenantId ?? null }));
    app.get("/internal/ping", async () => ({ ok: true }));
    await app.ready();
    try {
      const noKey = await app.inject({ method: "GET", url: "/v1/whoami" });
      expect(noKey.statusCode).toBe(401);

      const ok = await app.inject({
        method: "GET",
        url: "/v1/whoami",
        headers: { "x-api-key": "raw-api-key-xyz" }, // created under tenantA above
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().tenant).toBe(tenantA);

      const internal = await app.inject({ method: "GET", url: "/internal/ping" });
      expect(internal.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("enforces the minimum PostgreSQL version (TR-014)", async () => {
    expect(await assertPgVersion(pool)).toBeGreaterThanOrEqual(160004);
  });

  it("does not bleed tenant context across reused pooled connections (TR-003, SC-002)", async () => {
    const single = makePool(container.getConnectionUri(), 1); // force connection reuse
    try {
      const a = await withTenant(single, tenantA, async (q) =>
        (await q("SELECT count(*)::int AS n FROM app_user", [])).rows[0],
      );
      const b = await withTenant(single, tenantB, async (q) =>
        (await q("SELECT count(*)::int AS n FROM app_user", [])).rows[0],
      );
      expect((a as { n: number }).n).toBeGreaterThan(0);
      expect((b as { n: number }).n).toBeGreaterThan(0);
      // the same reused connection now carries no tenant context
      const client = await single.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE licensesrv_app");
        const r = await client.query("SELECT count(*)::int AS n FROM app_user");
        expect((r.rows[0] as { n: number }).n).toBe(0);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await single.end();
    }
  });

  it("denies DDL to the non-owner app role (TR-002, HINT-002)", async () => {
    await expect(
      withTenant(pool, tenantA, async (q) => q("CREATE TABLE evil_ddl (x int)", [])),
    ).rejects.toThrow();
  });

  it("serializes concurrent migration runners via the advisory lock (TR-007)", async () => {
    const [r1, r2] = await Promise.all([
      runMigrations(pool, MIGRATIONS_DIR),
      runMigrations(pool, MIGRATIONS_DIR),
    ]);
    expect(r1).toEqual([]); // already applied -> both no-op without error
    expect(r2).toEqual([]);
  });

  it("rolls back a failed migration atomically — no half-applied schema (TR-015, SC-012)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mig-fail-"));
    writeFileSync(path.join(dir, "9999_bad.sql"), "CREATE TABLE atom_probe (x int);\nSELECT 1/0;\n");
    await expect(runMigrations(pool, dir)).rejects.toThrow();
    const reg = await privileged(pool, (q) => q("SELECT to_regclass('public.atom_probe') AS r"));
    expect((reg.rows[0] as { r: string | null }).r).toBeNull();
  });

  it("records an authorization denial as a security event (TR-011/TR-016, SC-007)", async () => {
    const decision = authorize(
      { role: "viewer", scopes: ["validate"] },
      { minRole: "admin", requiredScope: "admin" },
    );
    expect(decision.allowed).toBe(false);
    await withTenant(pool, tenantA, async (q) =>
      recordSecurityEvent(q, { actor: "viewer-x", action: "denied", target: decision.reason ?? null }),
    );
    const n = await withTenant(pool, tenantA, async (q) =>
      (await q("SELECT count(*)::int AS n FROM audit_log WHERE security_event = true", [])).rows[0],
    );
    expect((n as { n: number }).n).toBeGreaterThan(0);
  });

  it("every tenant-owned table has a tenant_id-leading composite index (TR-004, SC-009)", async () => {
    const r = await privileged(pool, (q) =>
      q(
        `SELECT tablename, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('app_user','role','api_key','audit_log')`,
      ),
    );
    const defs = r.rows as { tablename: string; indexdef: string }[];
    for (const table of ["app_user", "role", "api_key", "audit_log"]) {
      const hasLeading = defs.some(
        (d) => d.tablename === table && /\(\s*tenant_id\b/.test(d.indexdef),
      );
      expect(hasLeading, `${table} is missing a tenant_id-leading index`).toBe(true);
    }
  });

  it("expand/contract — a prior-version (N-1) query/insert still works against the migrated schema (TR-006, SC-004)", async () => {
    // 0003 added tenant.deleted_at (expand). A prior app that doesn't know that column must
    // still operate: provisioning + reads/inserts that reference only pre-0003 columns succeed.
    const tPrev = randomUUID();
    await provisionTenant(pool, { id: tPrev, slug: "n-minus-1" });
    const read = await privileged(pool, (q) =>
      q("SELECT id, slug, name, created_at FROM tenant WHERE id = $1", [tPrev]),
    );
    expect(read.rowCount).toBe(1);
    const t2 = randomUUID();
    await privileged(pool, (q) =>
      q("INSERT INTO tenant (id, slug) VALUES ($1, $2)", [t2, "n-minus-1-insert"]),
    );
    const ok = await privileged(pool, (q) => q("SELECT 1 FROM tenant WHERE id = $1", [t2]));
    expect(ok.rowCount).toBe(1);
  });
});
