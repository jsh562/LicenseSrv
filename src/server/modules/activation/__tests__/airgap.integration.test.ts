// Full air-gap surface against real Postgres via Fastify inject (US1–US3): request file → POST → response file
// → decode → OFFLINE verify via the E001 WASM core (zero network); seat consume + cap refusal (no response
// file); byte-identical idempotent replay (no 2nd seat); K-of-N drift re-match (same seat, created:false);
// cross-transport shared nonce (online↔air-gap); tenant isolation (cross-tenant 404); every refusal a distinct
// code, each audited airgap.denied; signer-unavailable 503; tampered response rejected at import; rate-limit
// 429; provenance audit; perf <1s. Reuses the E009 activation harness.
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
import { revokeKey, rotateKey } from "../../signing/rotation.js";
import { loadActivationConfig } from "../index.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (kr: unknown, token: string, now: number, anchor: number | null, fingerprint: string[] | null) => { code: number; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "airgap-secret";
const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
const cfg = loadActivationConfig({});

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;
let prevRate: string | undefined;

const tenantA = randomUUID();
const tenantB = randomUUID();

let keyedProductId: string;
let keyedPlanId: string; // 5 seats
let seat2PlanId: string; // 2 seats
let customerId: string;
let activateKey: string; // tenantA activate-scope key
let activateKeyB: string; // tenantB activate-scope key
let validateKey: string; // tenantA key WITHOUT the activate scope

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

let nonceSeq = 0;
const nonce = (): string => `${randomUUID().replace(/-/g, "")}${(nonceSeq++).toString(16)}`;
const sigs = (...ids: string[]): string[] => ids.map((s) => `sighash-${s}`);

/** Build a base64url request-file envelope (what the offline SDK would produce). */
function makeRequestFile(over: Record<string, unknown>): string {
  const env = { formatVersion: cfg.airgapRequestVersion, nonce: nonce(), producedAt: new Date().toISOString(), ...over };
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
}
function postAirGap(apiKey: string | null, requestFile: string, target: FastifyInstance = app) {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  return target.inject({ method: "POST", url: "/v1/air-gap/activations", headers, payload: { requestFile } as never });
}
function decodeResp(responseFile: string): { machineBoundKey: string; activationId: string; machineId: string; formatVersion: string } {
  return JSON.parse(b64urlDecode(responseFile).toString("utf8"));
}
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
/** Verify against the WHOLE product keyring (all keys) — proves a prior-key credential survives rotation. */
async function verifyOfflineAllKeys(token: string, fingerprint: string[]): Promise<number> {
  const kr = new core.Keyring();
  for (const k of await listKeys(pool, tenantA, keyedProductId)) kr.add(k.keyId, b64urlDecode(k.publicKey));
  const r = core.verify(kr, token, Math.floor(Date.now() / 1000), null, fingerprint);
  const code = r.code;
  r.free();
  kr.free();
  return code;
}
async function seatsUsed(auth: { session: string; csrf: string }, licenseId: string): Promise<number> {
  return (await authed("GET", `/admin/licenses/${licenseId}/activations`, auth)).json().seatsUsed;
}
async function auditCount(action: string): Promise<number> {
  return privileged(pool, async (q) => {
    const r = await q(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = $2`, [tenantA, action]);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  prevRate = process.env.ACTIVATION_RATE_MAX;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  process.env.ACTIVATION_RATE_MAX = "100000";

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 12);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme" });
  await provisionTenant(pool, { id: tenantB, slug: "other" });
  await seedUser(tenantA, "admin@acme.test", "admin");
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

  const authB = await loginAs("other", "admin@other.test");
  activateKeyB = (await authed("POST", "/admin/api-keys", authB, { scopes: ["activate"] })).json().secret;
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

describe("air-gapped activation (integration, real Postgres)", () => {
  it("US1: full file exchange — request → response → offline verify (SC-001/002)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = sigs("a1", "a2", "a3", "a4", "a5");
    const res = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: fp } }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { responseFile: string; created: boolean };
    expect(body.created).toBe(true);
    const resp = decodeResp(body.responseFile);
    expect(resp.formatVersion).toBe(cfg.airgapResponseVersion);
    expect(resp.machineBoundKey).toMatch(/^LIC1\./);
    expect(await verifyOffline(resp.machineBoundKey, fp)).toBe(0); // valid offline WITH the fingerprint
    // Activation by license KEY also works.
    const byKey = await postAirGap(activateKey, makeRequestFile({ licenseKey: lic.licenseKey, fingerprint: { signals: sigs("b1", "b2", "b3", "b4", "b5") } }));
    expect(byKey.statusCode).toBe(200);
  });

  it("US2: seat cap + byte-identical idempotent replay (SC-003/004/005)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, seat2PlanId);
    const rf1 = makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("c1", "c2", "c3") } });
    const first = await postAirGap(activateKey, rf1);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { created: boolean }).created).toBe(true);
    expect((await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("d1", "d2", "d3") } }))).statusCode).toBe(200);
    // seats full → 3rd distinct machine refused, no response file.
    const full = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("e1", "e2", "e3") } }));
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("seat_limit_reached");
    expect(full.json().responseFile).toBeUndefined();
    // Re-submit the SAME request file → byte-identical response, created:false, no 2nd seat.
    const replay = await postAirGap(activateKey, rf1);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { created: boolean }).created).toBe(false);
    expect((replay.json() as { responseFile: string }).responseFile).toBe((first.json() as { responseFile: string }).responseFile);
    expect(await seatsUsed(auth, lic.id)).toBe(2);
  });

  it("US2: K-of-N drift re-import reuses the seat (FR-025); cross-transport + cross-tenant (FR-024/SC-010)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const base = sigs("f1", "f2", "f3", "f4", "f5");
    expect((await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: base } }))).statusCode).toBe(200);
    // Drift: change one signal, new nonce → same seat, created:false.
    const drift = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("f1", "f2", "f3", "f4", "fX") } }));
    expect(drift.statusCode).toBe(200);
    expect((drift.json() as { created: boolean }).created).toBe(false);
    expect(await seatsUsed(auth, lic.id)).toBe(1);

    // Cross-transport shared nonce: an online activation's nonce reused in an air-gap file for a DIFFERENT machine → replayed/refused.
    const n = nonce();
    const online = await app.inject({ method: "POST", url: "/v1/activations", headers: { "x-api-key": activateKey }, payload: { licenseId: lic.id, fingerprint: { signals: sigs("g1", "g2", "g3") }, nonce: n } as never });
    expect(online.statusCode).toBe(201);
    const forge = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("h1", "h2", "h3") }, nonce: n }));
    expect(forge.statusCode).toBe(409);
    expect(forge.json().code).toBe("nonce_replayed");

    // Cross-tenant: tenant B's key cannot activate tenant A's license.
    const cross = await postAirGap(activateKeyB, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("i1", "i2", "i3") } }));
    expect(cross.statusCode).toBe(404);
    expect(cross.json().code).toBe("license_not_found");
  });

  it("US3: every refusal is a distinct code, no response file (SC-007/008)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = { signals: sigs("j1", "j2", "j3") };
    // malformed (non-decodable)
    expect((await postAirGap(activateKey, "not-a-valid-envelope-$$$")).json().code).toBe("validation_error");
    // unknown format version
    const badVer = Buffer.from(JSON.stringify({ formatVersion: "airgap-req-99", licenseId: lic.id, fingerprint: fp, nonce: nonce(), producedAt: new Date().toISOString() }), "utf8").toString("base64url");
    expect((await postAirGap(activateKey, badVer)).json().code).toBe("unknown_format_version");
    // stale (produced long ago, unseen nonce)
    const stale = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: fp, producedAt: "2020-01-01T00:00:00.000Z" }));
    expect(stale.statusCode).toBe(400);
    expect(stale.json().code).toBe("stale_request");
    // oversize
    const oversize = await postAirGap(activateKey, "A".repeat(cfg.airgapMaxRequestBytes + 1));
    expect(oversize.json().code).toBe("validation_error");
    expect(oversize.json().details).toMatchObject({ reason: "oversize" });
    // too-few signals
    const few = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("k1", "k2") } }));
    expect(few.json().code).toBe("insufficient_signals");
    // non-active license (revoked)
    await authed("POST", `/admin/licenses/${lic.id}/revoke`, auth);
    const revoked = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: fp }));
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().code).toBe("license_not_active");
  });

  it("a key without the activate scope is refused 403 and audited (FR-002/FR-012/SC-011)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const before = await auditCount("airgap.denied");
    const res = await postAirGap(validateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("v1", "v2", "v3") } }));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    // The 403 is sent before the audit write commits (the scope guard replies immediately) — poll for it.
    let after = before;
    for (let i = 0; i < 20 && after <= before; i++) {
      after = await auditCount("airgap.denied");
      if (after <= before) await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).toBeGreaterThan(before); // the scope denial is audited
  });

  it("US2: an already-seen nonce replays past the freshness window (FR-021)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const n = nonce();
    const fp = { signals: sigs("w1", "w2", "w3") };
    expect((await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: fp, nonce: n }))).statusCode).toBe(200);
    // Same nonce + machine but an ANCIENT producedAt → NOT stale (already seen), replays (FR-021 first-sight-only).
    const replay = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: fp, nonce: n, producedAt: "2020-01-01T00:00:00.000Z" }));
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { created: boolean }).created).toBe(false);
  });

  it("US3: a tampered response file is rejected at import (SC-006)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = sigs("t1", "t2", "t3", "t4", "t5");
    const res = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: fp } }));
    const resp = decodeResp((res.json() as { responseFile: string }).responseFile);
    expect(await verifyOffline(resp.machineBoundKey, fp)).toBe(0); // valid before tampering
    // Flip one mid-token character to a guaranteed-different base64url char — alters the signed bytes.
    const i = Math.floor(resp.machineBoundKey.length / 2);
    const tampered = resp.machineBoundKey.slice(0, i) + (resp.machineBoundKey[i] === "A" ? "B" : "A") + resp.machineBoundKey.slice(i + 1);
    expect(tampered).not.toBe(resp.machineBoundKey);
    expect(await verifyOffline(tampered, fp)).not.toBe(0); // import rejects the altered credential
  });

  it("audit: airgap.activated + airgap.denied recorded, no raw signals/nonce (SC-011/FR-026)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const secretSignal = "sighash-AIRGAPSECRET";
    const rf = makeRequestFile({ licenseId: lic.id, fingerprint: { signals: [secretSignal, "sighash-S2", "sighash-S3"] } });
    expect((await postAirGap(activateKey, rf)).statusCode).toBe(200);
    await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("z1") } })); // too-few → airgap.denied
    const { actions, blob } = await withTenant(pool, tenantA, async (q) => {
      const a = await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'airgap.%'`, []);
      const b = await q(`SELECT coalesce(string_agg(to_jsonb(audit_log)::text, ' '), '') AS blob FROM audit_log WHERE action LIKE 'airgap.%'`, []);
      return { actions: (a.rows as { action: string }[]).map((x) => x.action), blob: (b.rows[0] as { blob: string }).blob };
    });
    expect(actions).toEqual(expect.arrayContaining(["airgap.activated", "airgap.denied"]));
    expect(blob).not.toContain(secretSignal);
    expect(blob).not.toContain("LIC1.");
  });

  it("perf: a single air-gap process completes well under 1s", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const started = Date.now();
    const res = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("P1", "P2", "P3") } }));
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rate limiting: over the threshold → 429 rate_limited + Retry-After (FR-013/SC-012)", async () => {
    process.env.ACTIVATION_RATE_MAX = "2";
    const rlApp = createApp({ pool, apiKeySecret: SECRET });
    await rlApp.ready();
    try {
      const auth = await loginAs("acme", "admin@acme.test");
      const lic = await issueLicense(auth, keyedPlanId);
      const mk = (m: string) => postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs(`${m}1`, `${m}2`, `${m}3`) } }), rlApp);
      expect((await mk("rl_a")).statusCode).toBe(200);
      expect((await mk("rl_b")).statusCode).toBe(200);
      const limited = await mk("rl_c");
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBe("rate_limited");
      expect(limited.headers["retry-after"]).toBeDefined();
      // onExceeded audits fire-and-forget — poll for the throttled-attempt security event (SC-012).
      let events = 0;
      for (let i = 0; i < 20 && events < 1; i++) {
        events = await auditCount("activation.rate_limited");
        if (events < 1) await new Promise((r) => setTimeout(r, 50));
      }
      expect(events).toBeGreaterThanOrEqual(1);
    } finally {
      await rlApp.close();
      process.env.ACTIVATION_RATE_MAX = "100000";
    }
  });

  it("a prior-key credential still verifies offline against the overlapping keyring after rotation (SC-019/FR-016)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId);
    const fp = sigs("R1", "R2", "R3", "R4", "R5");
    const res = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: fp } }));
    const resp = decodeResp((res.json() as { responseFile: string }).responseFile);
    // Rotate the product's signing key — the prior key stays valid in the overlap window.
    const custody = new Custody();
    custody.unlock(shares);
    await rotateKey(pool, tenantA, keyedProductId, custody, "test");
    // The credential (signed by the prior key) still verifies against the whole keyring (SC-019).
    expect(await verifyOfflineAllKeys(resp.machineBoundKey, fp)).toBe(0);
  });

  // MUST be last: revoking every active key for the product breaks offline verify for any later test.
  it("signer unavailable → 503, no response file, no seat (SC-015/FR-023)", async () => {
    const auth = await loginAs("acme", "admin@acme.test");
    const lic = await issueLicense(auth, keyedPlanId); // issued while a key is still active
    // Revoke every non-revoked key for the product (the prior rotation left two) → no active key.
    for (const k of await listKeys(pool, tenantA, keyedProductId)) {
      if (k.status !== "revoked") await revokeKey(pool, tenantA, keyedProductId, k.keyId, "test");
    }
    const res = await postAirGap(activateKey, makeRequestFile({ licenseId: lic.id, fingerprint: { signals: sigs("u1", "u2", "u3") } }));
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("signer_unavailable");
    expect(res.json().responseFile).toBeUndefined();
    expect(await seatsUsed(auth, lic.id)).toBe(0); // fail-closed: no seat consumed on signer fault
  });
});
