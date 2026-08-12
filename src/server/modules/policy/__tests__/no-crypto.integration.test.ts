// T051 [Polish] (FR-018, SC-014) [COMPLETES FR-018]: the policy engine performs NO cryptography and touches NO
// signing/verification surface — proven against a real signer + the real WASM verifier core (Fastify inject +
// Testcontainers). It asserts INV-11 / SC-014 four ways:
//   - the engine emits a PLAIN, UNKEYED SHA-256 digest (`input_hash`) — independently reproducible from the
//     minimized snapshot with no key material — and NO token / signature / signing key anywhere in its output;
//   - a rule firing at issuance embeds the adjusted value into the LIC1 token and it VERIFIES OFFLINE unchanged;
//   - whether a rule fired or not, tokens verify OFFLINE under the SAME product keyring and the UN-RULED
//     entitlement is byte-identical — the engine changes only the ruled entitlement's value, never a token byte
//     of anything else, and introduces no new key material or verifier-core code (the difference between the two
//     issuances is only the ruled decision + the per-issuance nonce/id/time the E004 signer already stamped);
//   - the issued token is IMMUTABLE after signing — the stored token equals the issued token (the engine wrote
//     no post-sign byte) and re-verifying it is deterministic. Mirrors the E017 issuance testcontainers harness.
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
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
import { canonicalSerialize } from "../context.js";

const require = createRequire(import.meta.url);
const core = require("../../../../bindings/wasm/pkg/licensesrv.js") as {
  Keyring: new () => { add(k: string, p: Uint8Array): number; free(): void };
  verify: (kr: unknown, t: string, n: number) => { code: number; has(k: string): boolean; limit(k: string): number | undefined; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "policy-no-crypto-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;

const tenantA = randomUUID();
let keyedProductId: string;
let planId: string;
let apiEntId: string;
let reportsEntId: string;
let widgetsEntId: string;
let customerId: string;
let reportsRuleKey: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [
      id,
      tenantId,
      hmacKey(email.toLowerCase(), SECRET),
      hashPassword("pw-" + email),
    ]);
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

async function loginAs(slug: string, email: string): Promise<{ session: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { tenantSlug: slug, email, password: "pw-" + email } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return {
    session: res.cookies.find((c) => c.name === "admin_session")!.value,
    csrf: res.cookies.find((c) => c.name === "admin_csrf")!.value,
  };
}

function authed(method: "GET" | "POST" | "PATCH" | "PUT", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}

async function setRuleMax(entId: string, ruleMax: number): Promise<void> {
  await withTenant(pool, tenantA, (q) => q("UPDATE entitlement SET rule_max = $2 WHERE id = $1", [entId, ruleMax]));
}

async function authorActiveRule(auth: { session: string; csrf: string }, entId: string, target: string, value: number): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority: 100,
    status: "active",
    condition: { "==": [1, 1] },
    effect: { kind: "adjust_limit", target, value },
  });
  if (res.statusCode !== 201) throw new Error(`author rule failed: ${res.statusCode} ${res.body}`);
  return res.json().ruleKey as string;
}

async function verifyOffline(token: string, intKeys: string[]): Promise<{ code: number; limits: Record<string, number | undefined> }> {
  const keys = await listKeys(pool, tenantA, keyedProductId);
  const active = keys.find((k) => k.status === "active")!;
  const kr = new core.Keyring();
  kr.add(active.keyId, b64urlDecode(active.publicKey));
  const r = core.verify(kr, token, Math.floor(Date.now() / 1000));
  const out = { code: r.code, limits: Object.fromEntries(intKeys.map((k) => [k, r.limit(k)])) };
  r.free();
  kr.free();
  return out;
}

beforeAll(async () => {
  const shares = shamirSplit(Buffer.alloc(32, 5), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-no-crypto" });
  await seedUser(tenantA, "admin@acme.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-policy-no-crypto", "admin@acme.test");
  keyedProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, keyedProductId, custody, "test-setup");

  planId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  apiEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "api_calls", name: "API", type: "integer_limit" })).json().id;
  reportsEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "reports", name: "Reports", type: "integer_limit" })).json().id;
  widgetsEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "widgets", name: "Widgets", type: "integer_limit" })).json().id;

  // Base plan values: api_calls=100, reports=10, widgets=7.
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${apiEntId}`, auth, { value: 100 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${reportsEntId}`, auth, { value: 10 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${widgetsEntId}`, auth, { value: 7 });

  await setRuleMax(apiEntId, 50_000);
  await setRuleMax(reportsEntId, 500);
  // api_calls: an always-on active rule (used by every test). reports: a toggleable active rule (fired-vs-disabled).
  await authorActiveRule(auth, apiEntId, "api_calls", 40_000);
  reportsRuleKey = await authorActiveRule(auth, reportsEntId, "reports", 500);

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme" })).json().id;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 no-crypto / no-token-change (integration, real signer + WASM verifier) — FR-018 / SC-014", () => {
  it("the engine emits a PLAIN unkeyed SHA-256 digest and NO token / signature / key", async () => {
    const result = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: randomUUID(),
      planId,
      mode: "enforced",
      decisionTimestamp: 1_700_000_000_000,
      entitlements: [{ key: "api_calls", type: "integer_limit", value: 100 }],
    });
    const ev = result.evaluations[0]!;
    // The input_hash is EXACTLY an unkeyed SHA-256 over the canonical serialization of the snapshot — no signing
    // key is mixed in (reproducible from the public snapshot alone). A keyed/HMAC/signature would NOT reproduce.
    const independent = createHash("sha256").update(canonicalSerialize(ev.inputSnapshot), "utf8").digest("hex");
    expect(ev.inputHash).toBe(independent);
    expect(ev.inputHash).toMatch(/^[0-9a-f]{64}$/);
    // The engine's output carries no token, no signature, no key material.
    const blob = JSON.stringify(result.evaluations);
    expect(blob).not.toContain("LIC1");
    expect(blob).not.toContain("BEGIN");
    expect(blob).not.toMatch(/signature|privateKey|signingKey/i);
  });

  it("a rule firing at issuance embeds the adjusted value; the LIC1 token verifies OFFLINE unchanged", async () => {
    const auth = await loginAs("acme-policy-no-crypto", "admin@acme.test");
    const body = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as {
      licenseKey: string;
      entitlements: Record<string, unknown>;
    };
    expect(body.entitlements).toMatchObject({ api_calls: 40_000, reports: 500, widgets: 7 });
    expect(body.licenseKey.startsWith("LIC1.")).toBe(true);
    const v = await verifyOffline(body.licenseKey, ["api_calls", "reports", "widgets"]);
    expect(v.code).toBe(0);
    expect(v.limits).toEqual({ api_calls: 40_000, reports: 500, widgets: 7 });
  });

  it("the issued token is IMMUTABLE after signing — stored equals issued, re-verification is deterministic", async () => {
    const auth = await loginAs("acme-policy-no-crypto", "admin@acme.test");
    const issued = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as { id: string; licenseKey: string };
    // The engine wrote NO byte after the E004 signer ran: the stored token is byte-for-byte the issued token.
    const stored = (await authed("GET", `/admin/licenses/${issued.id}/key`, auth)).json().licenseKey as string;
    expect(stored).toBe(issued.licenseKey);
    // Verifying the SAME token twice is deterministic (the verifier core is a pure function, untouched by E017).
    const v1 = await verifyOffline(stored, ["api_calls"]);
    const v2 = await verifyOffline(stored, ["api_calls"]);
    expect(v1).toEqual(v2);
    expect(v1.code).toBe(0);
  });

  it("fired-vs-disabled: both tokens verify OFFLINE under the SAME keyring; the un-ruled entitlement is byte-identical", async () => {
    const auth = await loginAs("acme-policy-no-crypto", "admin@acme.test");

    // (1) reports rule ACTIVE → reports lifted 10 -> 500.
    const withRule = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as {
      licenseKey: string;
      entitlements: Record<string, unknown>;
    };
    expect(withRule.entitlements.reports).toBe(500);

    // (2) Disable the reports rule (a lifecycle status flip — no crypto, no token-format change).
    const off = await authed("POST", `/admin/policy/rules/${reportsRuleKey}/status`, auth, { status: "disabled" });
    expect(off.statusCode).toBe(200);
    const withoutRule = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as {
      licenseKey: string;
      entitlements: Record<string, unknown>;
    };
    // Only the ruled entitlement changed (500 -> base 10); the un-ruled widgets is byte-identical either way.
    expect(withoutRule.entitlements.reports).toBe(10);
    expect(withRule.entitlements.widgets).toBe(withoutRule.entitlements.widgets);
    expect(withRule.entitlements.api_calls).toBe(withoutRule.entitlements.api_calls); // the always-on rule unchanged

    // Both tokens verify OFFLINE under the SAME unchanged product keyring — no new key material / verifier change.
    const a = await verifyOffline(withRule.licenseKey, ["reports", "widgets"]);
    const b = await verifyOffline(withoutRule.licenseKey, ["reports", "widgets"]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.limits.reports).toBe(500);
    expect(b.limits.reports).toBe(10);
    expect(a.limits.widgets).toBe(b.limits.widgets); // the un-ruled entitlement's token value is identical
  });
});
