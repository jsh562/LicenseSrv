// T017/T018/T024/T025 + T029 (REST surface): the key-management + keyring routes over the real app
// (Fastify inject + real Postgres). Covers provision (201/admin), list (viewer+), rotate, revoke
// (200/409/404), keyring (jwk-set+json), RBAC (403), and the readiness probe.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { makePool } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { createApiKey, provisionTenant } from "../../../db/repository.js";
import { shamirSplit } from "../custody.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "test-secret";
const ADMIN_KEY = "admin-raw-key";
const VIEWER_KEY = "viewer-raw-key";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenant = randomUUID();
const product = randomUUID();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenant, slug: "t" });
  await createApiKey(
    pool,
    tenant,
    { id: randomUUID(), keyHash: hmacKey(ADMIN_KEY, SECRET), scopes: ["admin"] },
    "setup",
  );
  await createApiKey(
    pool,
    tenant,
    { id: randomUUID(), keyHash: hmacKey(VIEWER_KEY, SECRET), scopes: ["validate"] },
    "setup",
  );

  // Inject custodian shares (E006 secrets) so the signing module unlocks custody at boot.
  const shares = shamirSplit(Buffer.alloc(32, 5), 3, 2).slice(0, 2);
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 180_000);

afterAll(async () => {
  delete process.env.SIGNING_CUSTODIAN_SHARES;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

const admin = { "x-api-key": ADMIN_KEY };
const viewer = { "x-api-key": VIEWER_KEY };

describe("signing REST routes (integration)", () => {
  it("readiness reports ready once custody is unlocked", async () => {
    const r = await app.inject({ method: "GET", url: "/internal/ready/signing" });
    expect(r.statusCode).toBe(200);
  });

  it("provisions a key (201, admin) and lists it (200, viewer+)", async () => {
    const prov = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys`,
      headers: admin,
    });
    expect(prov.statusCode).toBe(201);
    expect(prov.headers.location).toContain("/signing-keys/");
    const meta = prov.json() as { keyId: string; status: string; publicKey: string };
    expect(meta.status).toBe("active");
    expect(meta).not.toHaveProperty("private_key_ref"); // never any private material

    const list = await app.inject({
      method: "GET",
      url: `/v1/products/${product}/signing-keys`,
      headers: viewer,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { keys: unknown[] }).keys).toHaveLength(1);
  });

  it("refuses provisioning without the admin scope (403)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys`,
      headers: viewer,
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { code: string }).code).toBe("forbidden");
  });

  it("rejects a missing api key (401)", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/products/${product}/keyring` });
    expect(r.statusCode).toBe(401);
  });

  it("rotates (200) and publishes both keys in the JWKS keyring", async () => {
    const rot = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys/rotate`,
      headers: admin,
    });
    expect(rot.statusCode).toBe(200);

    const kr = await app.inject({
      method: "GET",
      url: `/v1/products/${product}/keyring`,
      headers: viewer,
    });
    expect(kr.statusCode).toBe(200);
    expect(kr.headers["content-type"]).toContain("application/jwk-set+json");
    const keyring = kr.json() as { keys: { kid: string; x: string; d?: string }[] };
    expect(keyring.keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keyring.keys) expect(k).not.toHaveProperty("d"); // no private member, ever
  });

  it("revokes a key (200), then reports it already revoked (409), and 404 for unknown", async () => {
    const kr = await app.inject({ method: "GET", url: `/v1/products/${product}/keyring`, headers: viewer });
    const victim = (kr.json() as { keys: { kid: string }[] }).keys[0]!.kid;

    const first = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys/${victim}/revoke`,
      headers: admin,
    });
    expect(first.statusCode).toBe(200);

    const again = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys/${victim}/revoke`,
      headers: admin,
    });
    expect(again.statusCode).toBe(409);

    const unknown = await app.inject({
      method: "POST",
      url: `/v1/products/${product}/signing-keys/k-does-not-exist/revoke`,
      headers: admin,
    });
    expect(unknown.statusCode).toBe(404);
  });
});
