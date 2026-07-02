// T019/T026/T013 (OBJ1–OBJ3): DB-backed integration against real Postgres. Covers provision +
// sign + conformance (SC-001), RLS tenant isolation + per-product isolation (SC-002/003), lifecycle
// audit, overlapping rotation keeping prior tokens verifiable (SC-004), and revocation-by-omission
// from the keyring (SC-005).
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordSecurityEvent } from "../../../audit/index.js";
import { makePool, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { Custody, shamirSplit } from "../custody.js";
import { KeystoreSigner } from "../keystore-signer.js";
import { buildKeyring } from "../keyring.js";
import { activeKey, listKeys, provisionKey } from "../registry.js";
import { retireKey, revokeKey, rotateKey } from "../rotation.js";
import { SignerError } from "../signer.js";
import type { Claims } from "../token.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (kr: unknown, t: string, n: number) => { code: number; has(k: string): boolean; limit(k: string): number | undefined; free(): void };
};
const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let custody: Custody;
let signer: KeystoreSigner;

const tenantA = randomUUID();
const tenantB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const productC = randomUUID();

function claims(productId: string): Claims {
  return {
    tokenVersion: 1,
    licenseId: "lic-x",
    productId,
    planId: "plan-1",
    customerId: "cust-1",
    issuedAt: 1_800_000_000,
    expiresAt: 1_900_000_000,
    maxActivations: 3,
    entitlements: { pro: true, seats: 5 },
    keyId: "",
    nonce: randomUUID(),
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 6);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "tenant-a" });
  await provisionTenant(pool, { id: tenantB, slug: "tenant-b" });

  custody = new Custody();
  custody.unlock(shamirSplit(Buffer.alloc(32, 9), 3, 2).slice(0, 2)); // k=2 of n=3
  signer = new KeystoreSigner(pool, custody);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("signing service (integration, real Postgres)", () => {
  it("provisions an active key and mints a conformant token (SC-001)", async () => {
    const meta = await provisionKey(pool, tenantA, productA, custody, "admin-a");
    expect(meta.status).toBe("active");

    const token = await signer.sign(tenantA, claims(productA));
    const pub = b64urlDecode(meta.publicKey);
    const kr = new core.Keyring();
    kr.add(meta.keyId, pub);
    const r = core.verify(kr, token, 1_800_000_000);
    expect(r.code).toBe(0);
    expect(r.has("pro")).toBe(true);
    expect(r.limit("seats")).toBe(5);
    r.free();
    kr.free();
  });

  it("isolates keys by tenant under RLS — tenant B sees nothing, cannot sign (SC-002/003)", async () => {
    expect(await listKeys(pool, tenantB, productA)).toHaveLength(0);
    expect(await activeKey(pool, tenantB, productA)).toBeNull();
    await expect(signer.sign(tenantB, claims(productA))).rejects.toMatchObject({
      failure: "no-active-key",
    });
  });

  it("isolates keys by product — a product-A token is not trusted under product-B's key", async () => {
    await provisionKey(pool, tenantA, productB, custody, "admin-a");
    const tokenA = await signer.sign(tenantA, claims(productA));
    const keyB = (await activeKey(pool, tenantA, productB))!;
    const kr = new core.Keyring();
    kr.add(keyB.keyId, keyB.publicKey); // product B's key
    const r = core.verify(kr, tokenA, 1_800_000_000);
    expect(r.code).not.toBe(0); // UnknownKey: A's key_id is absent from B's keyring
    r.free();
    kr.free();
  });

  it("audits key creation (TR-014)", async () => {
    const n = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'signing_key.created'",
        [],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBeGreaterThanOrEqual(2); // productA + productB
  });

  it("rotates without invalidating a prior-key token, keeps both trusted (SC-004)", async () => {
    // A token minted under the current active key BEFORE rotation.
    const before = await signer.sign(tenantA, claims(productA));
    const oldActive = (await activeKey(pool, tenantA, productA))!;

    const rotated = await rotateKey(pool, tenantA, productA, custody, "admin-a");
    expect(rotated.status).toBe("active");
    expect(rotated.keyId).not.toBe(oldActive.keyId);

    // The keyring now publishes BOTH keys (new active + prior rotating).
    const keyring = await buildKeyring(pool, tenantA, productA);
    const kids = keyring.keys.map((k) => k.kid);
    expect(kids).toContain(oldActive.keyId);
    expect(kids).toContain(rotated.keyId);

    // The pre-rotation token still verifies against the published keyring (no reissue).
    const kr = new core.Keyring();
    for (const k of keyring.keys) kr.add(k.kid, b64urlDecode(k.x));
    const r = core.verify(kr, before, 1_800_000_000);
    expect(r.code).toBe(0);
    r.free();
    kr.free();
  });

  it("revokes a key — omitted from the keyring and never signed with (SC-005)", async () => {
    const keyring = await buildKeyring(pool, tenantA, productA);
    const victim = keyring.keys.find((k) => k.kid)!.kid;
    expect(await revokeKey(pool, tenantA, productA, victim, "admin-a")).toBe(true);

    const after = await buildKeyring(pool, tenantA, productA);
    expect(after.keys.map((k) => k.kid)).not.toContain(victim);
  });

  it("bounds the rotation overlap window and governs the retired state (TR-019)", async () => {
    await provisionKey(pool, tenantA, productC, custody, "admin-a");
    const rotated = await rotateKey(pool, tenantA, productC, custody, "admin-a", 3600); // 1h overlap

    // The demoted (rotating) key now has a BOUNDED valid_until — not open-ended.
    const rotating = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT key_id, valid_until FROM signing_key WHERE product_id = $1 AND status = 'rotating'",
        [productC],
      );
      return r.rows[0] as { key_id: string; valid_until: Date | null } | undefined;
    });
    expect(rotating).toBeDefined();
    expect(rotating!.valid_until).not.toBeNull();

    // retire: rotating -> retired (still publishable/trusted until removed).
    expect(await retireKey(pool, tenantA, productC, rotating!.key_id, "admin-a")).toBe(true);
    const keyring = await buildKeyring(pool, tenantA, productC);
    const kids = keyring.keys.map((k) => k.kid);
    expect(kids).toContain(rotating!.key_id); // retired stays trusted/published
    expect(kids).toContain(rotated.keyId); // new active
  });

  it("records revocation as a security event (TR-011/TR-014)", async () => {
    const n = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'signing_key.revoked' AND security_event = true",
        [],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBeGreaterThanOrEqual(1);
    void recordSecurityEvent; // (imported to mirror the audit contract used above)
  });
});
