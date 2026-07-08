// US1 spine (FR-001/003/007/018): login → session → lockout → logout against real Postgres. Seeds a
// credentialed user directly (users.ts create is exercised separately) and drives the auth logic +
// session resolution, including brute-force lockout and admin_session RLS tenant isolation.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordSecurityEvent } from "../../../audit/index.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { login, logout, MAX_FAILED_LOGINS } from "../auth.js";
import { hashPassword } from "../password.js";
import { resolveSession } from "../../../console/session.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "test-secret";
const TTL = 3600;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();

async function seedUser(tenantId: string, email: string, password: string, role: string): Promise<string> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword(password)],
    );
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
      randomUUID(),
      tenantId,
      id,
      role,
    ]);
  });
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "other" });
  await seedUser(tenantA, "admin@acme.test", "pw-correct-horse", "owner");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("admin auth spine (integration, real Postgres)", () => {
  it("signs in a valid admin, resolves the session, and signs out (FR-001/003)", async () => {
    const r = await login(pool, SECRET, { tenantSlug: "acme", email: "admin@acme.test", password: "pw-correct-horse" }, TTL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("owner");
    expect(r.tenantId).toBe(tenantA);

    const principal = await resolveSession(pool, r.token);
    expect(principal?.userId).toBe(r.userId);
    expect(principal?.tenantId).toBe(tenantA);

    await logout(pool, tenantA, r.sessionId);
    expect(await resolveSession(pool, r.token)).toBeNull(); // revoked session grants nothing
  });

  it("rejects a wrong password with a generic reason and no session", async () => {
    const r = await login(pool, SECRET, { tenantSlug: "acme", email: "admin@acme.test", password: "nope" }, TTL);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns 'invalid' (not 'unknown-tenant') for an unknown tenant/email — no enumeration", async () => {
    expect(await login(pool, SECRET, { tenantSlug: "ghost", email: "x@y.z", password: "p" }, TTL)).toEqual({ ok: false, reason: "invalid" });
    expect(await login(pool, SECRET, { tenantSlug: "acme", email: "nobody@acme.test", password: "p" }, TTL)).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks the account after MAX_FAILED_LOGINS consecutive failures (FR-018)", async () => {
    const lockUser = "lockme@acme.test";
    await seedUser(tenantA, lockUser, "right-pw", "viewer");
    let lastReason = "";
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const r = await login(pool, SECRET, { tenantSlug: "acme", email: lockUser, password: "wrong" }, TTL);
      expect(r.ok).toBe(false);
      if (!r.ok) lastReason = r.reason;
    }
    expect(lastReason).toBe("locked");
    // Even the correct password is refused while locked.
    const now = await login(pool, SECRET, { tenantSlug: "acme", email: lockUser, password: "right-pw" }, TTL);
    expect(now).toEqual({ ok: false, reason: "locked" });
  });

  it("honors an operator-configured lockout threshold (FR-018 configurability)", async () => {
    const email = "config-lock@acme.test";
    await seedUser(tenantA, email, "right-pw", "viewer");
    // With a custom policy of 2, the account locks on the 2nd failure (not the default 5).
    const policy = { maxFailedLogins: 2, lockoutSeconds: 60 };
    const first = await login(pool, SECRET, { tenantSlug: "acme", email, password: "wrong" }, TTL, policy);
    expect(first).toEqual({ ok: false, reason: "invalid" });
    const second = await login(pool, SECRET, { tenantSlug: "acme", email, password: "wrong" }, TTL, policy);
    expect(second).toEqual({ ok: false, reason: "locked" });
  });

  it("isolates admin_session by tenant under RLS", async () => {
    const r = await login(pool, SECRET, { tenantSlug: "acme", email: "admin@acme.test", password: "pw-correct-horse" }, TTL);
    expect(r.ok).toBe(true);
    // Tenant B cannot see tenant A's sessions.
    const bCount = await withTenant(pool, tenantB, async (q) => {
      const c = await q("SELECT count(*)::int AS n FROM admin_session", []);
      return (c.rows[0] as { n: number }).n;
    });
    expect(bCount).toBe(0);
    void recordSecurityEvent;
  });

  it("writes an auth.login audit entry on success (FR-014)", async () => {
    await login(pool, SECRET, { tenantSlug: "acme", email: "admin@acme.test", password: "pw-correct-horse" }, TTL);
    const n = await withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login'", []);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
