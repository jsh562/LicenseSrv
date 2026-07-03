// FR-017 / SC-011: no credential material may ever leave the server except where it must — a session
// token lives ONLY in an httpOnly+Secure cookie, and an API-key secret is shown ONCE at creation. This
// test drives every read surface and asserts that password hashes, session token_hashes, and api-key
// key_hashes never appear in a JSON body or a response header, and that the session cookie is hardened.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { makePool, privileged } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../password.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "leak-secret";
const PASSWORD = "leakage-pw-123";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
const tenantId = randomUUID();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantId, slug: "leak" });
  const uid = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [uid, tenantId, hmacKey("owner@leak.test", SECRET), hashPassword(PASSWORD)],
    );
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [
      randomUUID(),
      tenantId,
      uid,
    ]);
  });
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

/** The stored hashes that must never surface in a body or header. */
async function storedHashes(): Promise<string[]> {
  return privileged(pool, async (q) => {
    const u = await q("SELECT password_hash FROM app_user WHERE password_hash IS NOT NULL", []);
    const s = await q("SELECT token_hash FROM admin_session", []);
    const k = await q("SELECT key_hash FROM api_key", []);
    return [
      ...(u.rows as { password_hash: string }[]).map((r) => r.password_hash),
      ...(s.rows as { token_hash: string }[]).map((r) => r.token_hash),
      ...(k.rows as { key_hash: string }[]).map((r) => r.key_hash),
    ];
  });
}

describe("credential secrecy across the admin surface (FR-017/SC-011)", () => {
  it("never leaks password/session/key hashes in a body or header; hardens the session cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { tenantSlug: "leak", email: "owner@leak.test", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);

    // Session cookie is httpOnly + Secure + SameSite=Strict; the raw token is NOT in the JSON body.
    const rawSetCookie = String(login.headers["set-cookie"]);
    expect(rawSetCookie).toMatch(/admin_session=/);
    expect(rawSetCookie.toLowerCase()).toContain("httponly");
    expect(rawSetCookie.toLowerCase()).toContain("secure");
    expect(rawSetCookie.toLowerCase()).toContain("samesite=strict");
    const token = login.cookies.find((c) => c.name === "admin_session")!.value;
    const csrf = login.cookies.find((c) => c.name === "admin_csrf")!.value;
    expect(login.body).not.toContain(token); // token is cookie-only, never echoed in the body
    expect(login.body).not.toContain("password");
    const auth = { admin_session: token, admin_csrf: csrf };

    // Create an API key so a key_hash exists to check against.
    await app.inject({
      method: "POST",
      url: "/admin/api-keys",
      cookies: auth,
      headers: { "x-csrf-token": csrf },
      payload: { scopes: ["validate"] },
    });

    const hashes = await storedHashes();
    expect(hashes.length).toBeGreaterThan(0);

    // Sweep every read surface: no stored hash may appear in the body or any header value.
    for (const url of ["/admin/auth/me", "/admin/users", "/admin/api-keys", "/admin/audit"]) {
      const res = await app.inject({ method: "GET", url, cookies: auth });
      expect(res.statusCode).toBe(200);
      const headerBlob = JSON.stringify(res.headers);
      for (const h of hashes) {
        expect(res.body).not.toContain(h);
        expect(headerBlob).not.toContain(h);
      }
      // Structural: the raw column names for secrets never appear either.
      expect(res.body).not.toContain("password_hash");
      expect(res.body).not.toContain("token_hash");
      expect(res.body).not.toContain("key_hash");
    }
  });
});
