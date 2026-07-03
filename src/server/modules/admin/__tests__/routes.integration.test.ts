// Full /admin HTTP surface against real Postgres via Fastify inject (US2–US5 + CSRF): RBAC gating,
// user/role/last-owner management, API-key lifecycle, and the read-only filtered audit log. Drives
// the app exactly as a browser would — session cookie + double-submit CSRF header on mutations.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { resolveApiKey } from "../../../auth/apikey.js";
import { makePool, privileged } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../password.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "routes-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
const tenantB = randomUUID();

async function seedUser(tenantId: string, email: string, password: string | null, role: string): Promise<string> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), password ? hashPassword(password) : null, "active"],
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

/** Sign in over HTTP and return the session + CSRF cookie values a browser would then resend. */
async function loginAs(slug: string, email: string, password: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/auth/login",
    payload: { tenantSlug: slug, email, password },
  });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((c) => c.name === "admin_session")?.value;
  const csrf = res.cookies.find((c) => c.name === "admin_csrf")?.value;
  if (!session || !csrf) throw new Error("login did not set session/csrf cookies");
  return { session, csrf };
}

/** An authenticated request with cookies + (for mutations) the double-submit CSRF header. */
function authed(
  method: "GET" | "POST" | "PATCH",
  url: string,
  auth: { session: string; csrf: string },
  payload?: unknown,
  opts: { withCsrf?: boolean } = { withCsrf: true },
) {
  const headers: Record<string, string> = {};
  if (opts.withCsrf !== false) headers["x-csrf-token"] = auth.csrf;
  return app.inject({
    method,
    url,
    cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
    headers,
    payload: payload as never,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "solo" });
  await seedUser(tenantA, "owner@acme.test", "owner-pw-123", "owner");
  await seedUser(tenantA, "viewer@acme.test", "viewer-pw-123", "viewer");
  await seedUser(tenantB, "owner@solo.test", "solo-pw-123", "owner");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("admin console HTTP surface (integration, real Postgres)", () => {
  it("US1: login returns cookies and /me reflects the principal", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");
    const me = await authed("GET", "/admin/auth/me", auth);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ tenantId: tenantA, role: "owner" });
  });

  it("US2: a viewer is blocked (403) from a privileged action and the denial is a security_event", async () => {
    const auth = await loginAs("acme", "viewer@acme.test", "viewer-pw-123");
    const res = await authed("POST", "/admin/users", auth, { email: "new@acme.test", role: "viewer" });
    expect(res.statusCode).toBe(403);
    const events = await privileged(pool, async (q) => {
      const r = await q(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE tenant_id = $1 AND action = 'authz.denied' AND security_event = true`,
        [tenantA],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(events).toBeGreaterThanOrEqual(1);
  });

  it("US2/CSRF: a state-changing request without the CSRF header is refused (403)", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");
    const res = await authed("POST", "/admin/users", auth, { email: "x@acme.test", role: "viewer" }, { withCsrf: false });
    expect(res.statusCode).toBe(403);
  });

  it("US3: admin creates a user, changes its role, deactivates it; deactivated cannot sign in", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");

    const created = await authed("POST", "/admin/users", auth, {
      email: "member@acme.test",
      role: "viewer",
      password: "member-pw-123",
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().id as string;

    const promoted = await authed("PATCH", `/admin/users/${userId}`, auth, { role: "admin" });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ role: "admin" });

    // Deactivate, then confirm sign-in is refused.
    const deact = await authed("PATCH", `/admin/users/${userId}`, auth, { status: "deactivated" });
    expect(deact.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { tenantSlug: "acme", email: "member@acme.test", password: "member-pw-123" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("US3: creating a duplicate email is a 409", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");
    const dup = await authed("POST", "/admin/users", auth, { email: "owner@acme.test", role: "viewer" });
    expect(dup.statusCode).toBe(409);
  });

  it("US3: the last active owner cannot be demoted or deactivated (409), but can once another owner exists", async () => {
    const auth = await loginAs("solo", "owner@solo.test", "solo-pw-123");
    const soloOwnerId = (await authed("GET", "/admin/auth/me", auth)).json().userId as string;

    const demote = await authed("PATCH", `/admin/users/${soloOwnerId}`, auth, { role: "admin" });
    expect(demote.statusCode).toBe(409);
    const deactivate = await authed("PATCH", `/admin/users/${soloOwnerId}`, auth, { status: "deactivated" });
    expect(deactivate.statusCode).toBe(409);

    // Add a second owner; now the first can be demoted.
    const second = await authed("POST", "/admin/users", auth, {
      email: "owner2@solo.test",
      role: "owner",
      password: "solo2-pw-123",
    });
    expect(second.statusCode).toBe(201);
    const nowDemote = await authed("PATCH", `/admin/users/${soloOwnerId}`, auth, { role: "admin" });
    expect(nowDemote.statusCode).toBe(200);
  });

  it("US4: API-key create shows the secret once; list hides it; rotate+revoke stop authenticating", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");

    const created = await authed("POST", "/admin/api-keys", auth, { scopes: ["validate"] });
    expect(created.statusCode).toBe(201);
    const { id: keyId, secret } = created.json() as { id: string; secret: string };
    expect(secret).toMatch(/^lsk_/);
    // The freshly-minted secret authenticates.
    expect(await resolveApiKey(pool, secret, SECRET)).toMatchObject({ tenantId: tenantA });

    // List returns metadata only — never the secret.
    const list = await authed("GET", "/admin/api-keys", auth);
    expect(list.statusCode).toBe(200);
    const listed = list.json().keys as Array<{ id: string; scopes: string[] }>;
    expect(listed.find((k) => k.id === keyId)?.scopes).toEqual(["validate"]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    // Rotate: old secret dies, new one lives.
    const rotated = await authed("POST", `/admin/api-keys/${keyId}/rotate`, auth);
    expect(rotated.statusCode).toBe(200);
    const newSecret = rotated.json().secret as string;
    expect(await resolveApiKey(pool, secret, SECRET)).toBeNull(); // old revoked
    expect(await resolveApiKey(pool, newSecret, SECRET)).toMatchObject({ tenantId: tenantA });

    // Revoke the replacement.
    const newId = rotated.json().id as string;
    const revoke = await authed("POST", `/admin/api-keys/${newId}/revoke`, auth);
    expect(revoke.statusCode).toBe(200);
    expect(await resolveApiKey(pool, newSecret, SECRET)).toBeNull();
  });

  it("US5: the audit log is readable, filterable by securityEvent, and has no write verb", async () => {
    const auth = await loginAs("acme", "owner@acme.test", "owner-pw-123");

    const all = await authed("GET", "/admin/audit", auth);
    expect(all.statusCode).toBe(200);
    expect((all.json().entries as unknown[]).length).toBeGreaterThan(0);

    const secOnly = await authed("GET", "/admin/audit?securityEvent=true", auth);
    expect(secOnly.statusCode).toBe(200);
    const secEntries = secOnly.json().entries as Array<{ securityEvent: boolean }>;
    expect(secEntries.every((e) => e.securityEvent === true)).toBe(true);

    // Append-only: there is no create/update/delete verb on the audit resource.
    const post = await authed("POST", "/admin/audit", auth, { action: "x" });
    expect(post.statusCode).toBe(404); // route does not exist
  });
});
