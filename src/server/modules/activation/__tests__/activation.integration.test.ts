// Full activation surface against real Postgres via Fastify inject (US1–US4): activate → signed machine-bound
// LIC1 that verifies OFFLINE (with the machine fingerprint) against the product key; race-safe seat cap
// (exactly-S under concurrency); K-of-N drift re-uses the seat; nonce store-and-replay; runtime api-key scope
// (403) + missing key (401); app + operator deactivation (idempotent, frees the seat); registry (no secrets)
// + RBAC 403 security_event + tenant isolation; append-only audit with no PII/secrets; rate limiting (429);
// and a <1s perf assertion. Reuses the E008 signer/custody/WASM harness.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
import { Custody, shamirSplit } from "../../signing/custody.js";
import { listKeys, provisionKey } from "../../signing/registry.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (kr: unknown, token: string, now: number, anchor: number | null, fingerprint: string[] | null) => { code: number; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "activation-secret";
const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;
let prevRate: string | undefined;

const tenantA = randomUUID();
const tenantB = randomUUID();

let keyedProductId: string;
let keyedPlanId: string; // maxActivations 5
let seat2PlanId: string; // maxActivations 2
let customerId: string;
let activateKey: string; // API key with the `activate` scope
let validateKey: string; // API key WITHOUT the `activate` scope

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)]);
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return { session: res.cookies.find((c) => c.name === "admin_session")!.value, csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value };
}

function authed(method: "GET" | "POST" | "DELETE", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}

function activateReq(apiKey: string | null, body: unknown, target: FastifyInstance = app) {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  return target.inject({ method: "POST", url: "/v1/activations", headers, payload: body as never });
}
function deactivateReq(apiKey: string, id: string) {
  return app.inject({ method: "DELETE", url: `/v1/activations/${id}`, headers: { "x-api-key": apiKey } });
}

let nonceSeq = 0;
const nonce = (): string => `${randomUUID().replace(/-/g, "")}${(nonceSeq++).toString(16)}`;
const sigs = (...ids: string[]): string[] => ids.map((s) => `sighash-${s}`);

async function issueLicense(auth: { session: string; csrf: string }, planId: string): Promise<{ id: string; licenseKey: string }> {
  const r = await authed("POST", "/admin/licenses", auth, { planId, customerId });
  if (r.statusCode !== 201) throw new Error(`issue failed: ${r.statusCode} ${r.body}`);
  return r.json();
}

async function verifyOffline(token: string, fingerprint: string[]): Promise<number> {
  const keys = await listKeys(pool, tenantA, keyedProductId);
  const active = keys.find((k) => k.status === "active")!;
  const kr = new core.Keyring();
  kr.add(active.keyId, b64urlDecode(active.publicKey));
  const r = core.verify(kr, token, Math.floor(Date.now() / 1000), null, fingerprint);
  const code = r.code;
  r.free();
  kr.free();
  return code;
}

beforeAll(async () => {
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  prevRate = process.env.ACTIVATION_RATE_MAX;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  process.env.ACTIVATION_RATE_MAX = "100000"; // high so functional tests never trip the limiter

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 12);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "other" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  await seedUser(tenantA, "viewer@acme.test", "viewer");
  await seedUser(tenantB, "admin@other.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme", "admin@acme.test");
  keyedProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, keyedProductId, custody, "test-setup");
  keyedPlanId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  seat2PlanId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "duo", name: "Duo", maxActivations: 2 })).json().id;
  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1" })).json().id;

  activateKey = (await authed("POST", "/admin/api-keys", auth, { scopes: ["activate"] })).json().secret;
  validateKey = (await authed("POST", "/admin/api-keys", auth, { scopes: ["validate"] })).json().secret;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  if (prevRate === undefined) delete process.env.ACTIVATION_RATE_MAX;
  else process.env.ACTIVATION_RATE_MAX = prevRate;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("machine activation & seat enforcement (integration, real Postgres)", () => {
  it("US1: activates a machine and the credential verifies offline on that machine (SC-001)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = sigs("a1", "a2", "a3", "a4", "a5");
    const res = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: fp }, nonce: nonce() });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { machineBoundKey: string; seatsUsed: number; seatLimit: number; machineId: string };
    expect(body.machineBoundKey).toMatch(/^LIC1\./);
    expect(body.seatsUsed).toBe(1);
    expect(body.seatLimit).toBe(5);
    expect(await verifyOffline(body.machineBoundKey, fp)).toBe(0); // valid offline WITH the fingerprint
    // Activation by license KEY (not id) also works.
    const byKey = await activateReq(activateKey, { licenseKey: lic.licenseKey, fingerprint: { signals: sigs("b1", "b2", "b3", "b4", "b5") }, nonce: nonce() });
    expect(byKey.statusCode).toBe(201);
  });

  it("US1: enforces the seat cap race-safely — exactly S concurrent successes (SC-002/003)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, seat2PlanId); // 2 seats
    expect((await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("c1", "c2", "c3") }, nonce: nonce() })).statusCode).toBe(201);
    expect((await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("d1", "d2", "d3") }, nonce: nonce() })).statusCode).toBe(201);
    const over = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("e1", "e2", "e3") }, nonce: nonce() });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("seat_limit_reached");

    // Concurrency: N distinct machines race for 2 seats → exactly 2 succeed.
    const lic2 = await issueLicense(auth, seat2PlanId);
    const attempts = ["f", "g", "h", "i", "j"].map((m) => activateReq(activateKey, { licenseId: lic2.id, fingerprint: { signals: sigs(`${m}1`, `${m}2`, `${m}3`) }, nonce: nonce() }));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });

  it("US1: refuses a non-active license; existing activations are NOT auto-deactivated (SC-004/FR-023)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const a = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("k1", "k2", "k3") }, nonce: nonce() });
    expect(a.statusCode).toBe(201);
    await authed("POST", `/admin/licenses/${lic.id}/revoke`, auth);
    const after = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("l1", "l2", "l3") }, nonce: nonce() });
    expect(after.statusCode).toBe(409);
    expect(after.json().code).toBe("license_not_active");
    // FR-023: the machine activated before revocation stays active; the seat count is unchanged.
    const reg = (await authed("GET", `/admin/licenses/${lic.id}/activations`, auth)).json();
    expect(reg.seatsUsed).toBe(1);
    expect(reg.activations.find((x: { id: string }) => x.id === a.json().id).status).toBe("active");
  });

  it("US1: nonce store-and-replay — retry replays, a forged reuse is rejected (SC-010)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = sigs("m1", "m2", "m3", "m4", "m5");
    const n = nonce();
    const first = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: fp }, nonce: n });
    expect(first.statusCode).toBe(201);
    const replay = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: fp }, nonce: n });
    expect(replay.statusCode).toBe(200); // idempotent replay of the same request
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.json().seatsUsed).toBe(1); // no second seat
    const forge = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("z1", "z2", "z3") }, nonce: n });
    expect(forge.statusCode).toBe(409);
    expect(forge.json().code).toBe("nonce_replayed");
  });

  it("US1: runtime auth — missing activate scope → 403; missing key → 401 (FR-002)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const denied = await activateReq(validateKey, { licenseId: lic.id, fingerprint: { signals: sigs("n1", "n2", "n3") }, nonce: nonce() });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("forbidden");
    const noKey = await activateReq(null, { licenseId: lic.id, fingerprint: { signals: sigs("o1", "o2", "o3") }, nonce: nonce() });
    expect(noKey.statusCode).toBe(401);
  });

  it("US2: deactivation frees a seat and is idempotent (SC-005/006)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, seat2PlanId);
    const a = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("p1", "p2", "p3") }, nonce: nonce() });
    await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("q1", "q2", "q3") }, nonce: nonce() });
    expect((await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("r1", "r2", "r3") }, nonce: nonce() })).statusCode).toBe(409); // full
    expect((await deactivateReq(activateKey, a.json().id)).statusCode).toBe(204);
    expect((await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("s1", "s2", "s3") }, nonce: nonce() })).statusCode).toBe(201); // freed
    expect((await deactivateReq(activateKey, a.json().id)).statusCode).toBe(204); // idempotent
    expect((await deactivateReq(activateKey, randomUUID())).statusCode).toBe(404); // unknown
  });

  it("US2: an operator reclaims a seat from the console (T020)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, seat2PlanId);
    const a = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("t1", "t2", "t3") }, nonce: nonce() });
    const reclaim = await authed("POST", `/admin/licenses/${lic.id}/activations/${a.json().id}/deactivate`, auth);
    expect(reclaim.statusCode).toBe(200);
    expect(reclaim.json().status).toBe("deactivated");
    expect((await authed("GET", `/admin/licenses/${lic.id}/activations`, auth)).json().seatsUsed).toBe(0);
  });

  it("US3: tolerates hardware drift — same seat, refreshed credential verifies offline (SC-007)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const first = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("u1", "u2", "u3", "u4", "u5") }, nonce: nonce() });
    expect(first.statusCode).toBe(201);
    // Change one of five signals (4 still match, >= K=3) → same activation, same seat.
    const drifted = sigs("u1", "u2", "u3", "u4", "uX");
    const again = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: drifted }, nonce: nonce() });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(again.json().seatsUsed).toBe(1);
    expect(await verifyOffline(again.json().machineBoundKey, drifted)).toBe(0);
  });

  it("US3: a <K machine is new; too-few signals are refused (SC-008/FR-016)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("v1", "v2", "v3", "v4", "v5") }, nonce: nonce() });
    const fresh = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("w1", "w2", "w3") }, nonce: nonce() }); // shares 0
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().seatsUsed).toBe(2);
    const tooFew = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("x1", "x2") }, nonce: nonce() }); // < fpMin 3
    expect(tooFew.statusCode).toBe(400);
    expect(tooFew.json().code).toBe("insufficient_signals");
  });

  it("US4: registry lists pseudonymous machines + seat summary, exposes no secrets (FR-012/SC-011)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("A1", "A2", "A3") }, nonce: nonce() });
    await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("B1", "B2", "B3") }, nonce: nonce() });
    const reg = await authed("GET", `/admin/licenses/${lic.id}/activations`, auth);
    expect(reg.statusCode).toBe(200);
    const body = reg.json() as { activations: Record<string, unknown>[]; seatsUsed: number; seatLimit: number };
    expect(body.seatsUsed).toBe(2);
    expect(body.seatLimit).toBe(5);
    expect(body.activations).toHaveLength(2);
    for (const a of body.activations) {
      expect(typeof a.machineId).toBe("string");
      expect(a.machineBoundKey).toBeUndefined(); // credential never in the registry
      expect(a.signal_hashes ?? a.signalHashes).toBeUndefined(); // raw signals never exposed
    }
    expect(reg.body).not.toContain("sighash-A1"); // no raw signal hash in the payload
    expect(reg.body).not.toContain("LIC1.");
  });

  it("US4: RBAC + tenant isolation — viewer 403 + security_event; cross-tenant 404 (SC-009/012)", async () => {
    const admin = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(admin, keyedPlanId);
    const a = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("C1", "C2", "C3") }, nonce: nonce() });
    const viewer = await loginAs("acme", "viewer@acme.test");
    expect((await authed("GET", `/admin/licenses/${lic.id}/activations`, viewer)).statusCode).toBe(200); // viewer reads
    const denied = await authed("POST", `/admin/licenses/${lic.id}/activations/${a.json().id}/deactivate`, viewer);
    expect(denied.statusCode).toBe(403);
    const events = await privileged(pool, async (q) => {
      const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'authz.denied' AND security_event = true`, [tenantA]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(events).toBeGreaterThanOrEqual(1);
    // Tenant B cannot see tenant A's license activations.
    const b = await loginAs("other", "admin@other.test");
    expect((await authed("GET", `/admin/licenses/${lic.id}/activations`, b)).statusCode).toBe(404);
  });

  it("audit: activation actions are recorded with no raw signals, nonce, token, or key (FR-014)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const secretSignal = "sighash-SECRETVALUE";
    const secretNonce = `NONCE${randomUUID().replace(/-/g, "")}`;
    const res = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: [secretSignal, "sighash-S2", "sighash-S3"] }, nonce: secretNonce });
    expect(res.statusCode).toBe(201);
    // A refused attempt (too few signals) is audited as a denial — with no fingerprint/nonce leaked (FR-014).
    const deniedSignal = "sighash-DENIEDSECRET";
    const deniedNonce = `DENIED${randomUUID().replace(/-/g, "")}`;
    const denied = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: [deniedSignal] }, nonce: deniedNonce });
    expect(denied.statusCode).toBe(400);
    const { actions, blob } = await withTenant(pool, tenantA, async (q) => {
      const a = await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'activation.%'`, []);
      const b = await q(`SELECT coalesce(string_agg(to_jsonb(audit_log)::text, ' '), '') AS blob FROM audit_log`, []);
      return { actions: (a.rows as { action: string }[]).map((x) => x.action), blob: (b.rows[0] as { blob: string }).blob };
    });
    expect(actions).toEqual(expect.arrayContaining(["activation.created", "activation.deactivated", "activation.denied"]));
    expect(blob).not.toContain(secretSignal);
    expect(blob).not.toContain(secretNonce);
    expect(blob).not.toContain(deniedSignal);
    expect(blob).not.toContain(deniedNonce);
    expect(blob).not.toContain("LIC1.");
    expect(blob).not.toContain("BEGIN PRIVATE KEY");
  });

  it("migration 0008: forced RLS refuses unscoped access — unset tenant GUC → 0 rows (FR-015)", async () => {
    // Activations exist by now; a connection in the app role WITHOUT the tenant GUC must see none.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE licensesrv_app");
      const r = await client.query("SELECT count(*)::int AS n FROM activation");
      expect((r.rows[0] as { n: number }).n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("perf: a single activation completes well under 1s (SC-001)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const started = Date.now();
    const res = await activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs("P1", "P2", "P3") }, nonce: nonce() });
    expect(res.statusCode).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rate limiting: over the threshold → 429 rate_limited + Retry-After, audited (FR-013/FR-020)", async () => {
    prevRate = process.env.ACTIVATION_RATE_MAX;
    process.env.ACTIVATION_RATE_MAX = "2"; // a low ceiling for this app instance
    const rlApp = createApp({ pool, apiKeySecret: SECRET });
    await rlApp.ready();
    try {
      const auth = await loginAs("acme", "admin@acme.test");
      const lic = await issueLicense(auth, keyedPlanId);
      const mk = (m: string) => activateReq(activateKey, { licenseId: lic.id, fingerprint: { signals: sigs(`${m}1`, `${m}2`, `${m}3`) }, nonce: nonce() }, rlApp);
      expect((await mk("rl_a")).statusCode).toBe(201);
      expect((await mk("rl_b")).statusCode).toBe(201);
      const limited = await mk("rl_c");
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBe("rate_limited");
      expect(limited.headers["retry-after"]).toBeDefined();
      // onExceeded audits fire-and-forget; poll briefly for the security event.
      const countEvents = () =>
        privileged(pool, async (q) => {
          const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'activation.rate_limited'`, [tenantA]);
          return (r.rows[0] as { n: number }).n;
        });
      let events = 0;
      for (let i = 0; i < 20 && events < 1; i++) {
        events = await countEvents();
        if (events < 1) await new Promise((r) => setTimeout(r, 50));
      }
      expect(events).toBeGreaterThanOrEqual(1);
    } finally {
      await rlApp.close();
      process.env.ACTIVATION_RATE_MAX = "100000";
    }
  });
});
