// T029 [US2] (FR-008, SC-002/003/004/014/016): the E017 issuance-path evaluation hook against real Postgres +
// the real WASM verifier core (Fastify inject + Testcontainers). Proves the epic's load-bearing guarantees:
//   - a live ACTIVE rule adjusts the entitlement decision at issuance, and the adjusted value is embedded in the
//     signed LIC1 token and verifies OFFLINE (SC-002);
//   - evaluation is DETERMINISTIC — re-evaluating an identical context reproduces the identical decision, fired
//     rule, AND canonical input_hash (SC-003, driven directly through the seam with a fixed decision timestamp);
//   - the trusted applier CLAMPS an effect to the authored maximum at evaluation, and a lift ABOVE the base plan
//     value (up to the authored max) is honored (SC-004/015);
//   - evaluation runs ONLY on the issuance/signing path — no per-read re-decision (SC-016);
//   - the engine performs NO cryptography and touches NO token byte: the offline token is byte-identical (the
//     stored key equals the issued key), a rule-free entitlement is unchanged, and the verifier core is untouched
//     (SC-014, Principle I / INV-11).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
  verify: (kr: unknown, t: string, n: number) => { code: number; has(k: string): boolean; limit(k: string): number | undefined; free(): void };
};
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "policy-issuance-secret";
const GUC = "current_setting('app.current_tenant')::uuid";

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
let clampEntId: string;
let tierEntId: string;
let customerId: string;

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

/** Set an entitlement's authored per-entitlement bound directly (bypasses the catalog governance route). */
async function setRuleMax(entId: string, ruleMax: number): Promise<void> {
  await withTenant(pool, tenantA, (q) => q("UPDATE entitlement SET rule_max = $2 WHERE id = $1", [entId, ruleMax]));
}

/** Set an entitlement's plan-defined NUMERIC select_tier options directly (the authored `rule_tiers` bound). */
async function setRuleTiers(entId: string, tiers: number[]): Promise<void> {
  await withTenant(pool, tenantA, (q) =>
    q("UPDATE entitlement SET rule_tiers = $2::jsonb WHERE id = $1", [entId, JSON.stringify(tiers)]),
  );
}

/** Author an ACTIVE policy rule targeting an entitlement with a bounded select_tier effect (a NUMERIC tier). */
async function authorSelectTierRule(auth: { session: string; csrf: string }, entId: string, target: string, value: number): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority: 100,
    status: "active",
    condition: { "==": [1, 1] }, // always matches (deterministic)
    effect: { kind: "select_tier", target, value },
  });
  if (res.statusCode !== 201) throw new Error(`author select_tier rule failed: ${res.statusCode} ${res.body}`);
  return res.json().ruleKey as string;
}

/** Author an ACTIVE policy rule targeting an entitlement with a bounded adjust_limit effect. */
async function authorActiveRule(auth: { session: string; csrf: string }, entId: string, target: string, value: number): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority: 100,
    status: "active",
    condition: { "==": [1, 1] }, // always matches (deterministic)
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

async function evalCount(licenseId: string): Promise<number> {
  return withTenant(pool, tenantA, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM policy_evaluation WHERE license_id = $1", [licenseId]);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  const shares = shamirSplit(Buffer.alloc(32, 9), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-issuance" });
  await seedUser(tenantA, "admin@acme.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-policy-issuance", "admin@acme.test");
  keyedProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, keyedProductId, custody, "test-setup");

  planId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  apiEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "api_calls", name: "API", type: "integer_limit" })).json().id;
  reportsEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "reports", name: "Reports", type: "integer_limit" })).json().id;
  widgetsEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "widgets", name: "Widgets", type: "integer_limit" })).json().id;
  // A NON-attached entitlement used only to exercise the evaluation-time clamp directly (not in the token).
  clampEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "clamped", name: "Clamped", type: "integer_limit" })).json().id;
  // An integer_limit entitlement whose rule selects one of its plan-defined NUMERIC tiers (embedded in the token).
  tierEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "tier_level", name: "Tier", type: "integer_limit" })).json().id;

  // Base plan values: api_calls=100, reports=10, widgets=7 (no rule -> unchanged), tier_level=1.
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${apiEntId}`, auth, { value: 100 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${reportsEntId}`, auth, { value: 10 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${widgetsEntId}`, auth, { value: 7 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${tierEntId}`, auth, { value: 1 });

  // Authored per-entitlement ceilings (>= base), then ACTIVE rules that lift within them.
  await setRuleMax(apiEntId, 50_000);
  await setRuleMax(reportsEntId, 500);
  await setRuleMax(clampEntId, 500);
  await authorActiveRule(auth, apiEntId, "api_calls", 40_000); // lift 100 -> 40000 (< max)
  await authorActiveRule(auth, reportsEntId, "reports", 500); // lift 10 -> 500 (== max)
  await authorActiveRule(auth, clampEntId, "clamped", 500); // in-bounds at author time; ceiling lowered later
  // A select_tier rule: the plan-defined NUMERIC tiers are [1, 5, 10]; the rule selects tier 10.
  await setRuleTiers(tierEntId, [1, 5, 10]);
  await authorSelectTierRule(auth, tierEntId, "tier_level", 10);

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme" })).json().id;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 issuance-path evaluation (integration, real Postgres + WASM verifier)", () => {
  it("a live active rule adjusts the entitlement decision at issuance; the token verifies OFFLINE (SC-002/015)", async () => {
    const auth = await loginAs("acme-policy-issuance", "admin@acme.test");
    const res = await authed("POST", "/admin/licenses", auth, { planId, customerId });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; licenseKey: string; entitlements: Record<string, unknown> };

    // The signed snapshot carries the ADJUSTED values (api_calls lifted 100->40000, reports 10->500, the
    // select_tier rule picked numeric tier 10) and the rule-free entitlement is UNCHANGED (widgets stays at 7).
    expect(body.entitlements).toEqual({ api_calls: 40_000, reports: 500, widgets: 7, tier_level: 10 });

    const v = await verifyOffline(body.licenseKey, ["api_calls", "reports", "widgets", "tier_level"]);
    expect(v.code).toBe(0); // valid offline
    expect(v.limits.api_calls).toBe(40_000); // the adjusted decision is embedded + verifiable
    expect(v.limits.reports).toBe(500);
    expect(v.limits.widgets).toBe(7); // no rule -> base stands (the engine changed only ruled entitlements)
    expect(v.limits.tier_level).toBe(10); // the selected NUMERIC tier is embedded + verifiable offline
  });

  it("a select_tier rule embeds the selected NUMERIC tier in the signed token AND matches the audit (FR-003, SC-014/015)", async () => {
    // The regression this guards (T057): a select_tier decision was validated/audited but SILENTLY DROPPED from the
    // signed token because only number|boolean decisions were copied. Constraining a tier to a finite number makes
    // it flow through the token's numeric branch, so the token value equals the audit `decision` — no discrepancy.
    const auth = await loginAs("acme-policy-issuance", "admin@acme.test");
    const res = await authed("POST", "/admin/licenses", auth, { planId, customerId });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; licenseKey: string; entitlements: Record<string, unknown> };

    // (a) The selected numeric tier is embedded in the SIGNED token and verifies OFFLINE.
    expect(body.entitlements.tier_level).toBe(10);
    const v = await verifyOffline(body.licenseKey, ["tier_level"]);
    expect(v.code).toBe(0);
    expect(v.limits.tier_level).toBe(10);

    // (b) The token value equals the `policy_evaluation` audit `decision` — no audit-vs-token discrepancy.
    const auditDecision = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        "SELECT decision FROM policy_evaluation WHERE license_id = $1 AND entitlement_key = 'tier_level'",
        [body.id],
      );
      return (r.rows[0] as { decision: unknown }).decision;
    });
    expect(auditDecision).toBe(10);
    expect(v.limits.tier_level).toBe(auditDecision); // audit == signed token
  });

  it("the offline token is byte-identical + verifies; no crypto/verifier change (SC-014, INV-11)", async () => {
    const auth = await loginAs("acme-policy-issuance", "admin@acme.test");
    const issued = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as { id: string; licenseKey: string };

    // The STORED token equals the token returned at issue — the engine wrote no token byte after signing; the
    // token is immutable and re-verifies offline unchanged (an already-issued token is unaffected by the engine).
    const stored = (await authed("GET", `/admin/licenses/${issued.id}/key`, auth)).json().licenseKey as string;
    expect(stored).toBe(issued.licenseKey);
    expect(issued.licenseKey.startsWith("LIC1.")).toBe(true);
    expect((await verifyOffline(stored, ["api_calls"])).code).toBe(0);
  });

  it("determinism: re-evaluating an identical context reproduces the identical decision + fired rule + input_hash (SC-003)", async () => {
    // Drive the seam DIRECTLY with a FIXED decision timestamp (the injected clock) so the context is identical
    // across runs — the only non-determinism a real issuance carries is the wall-clock issue time.
    const fixedTs = 1_700_000_000_000;
    const input = {
      tenantId: tenantA,
      licenseId: randomUUID(),
      planId,
      mode: "enforced" as const,
      decisionTimestamp: fixedTs,
      entitlements: [{ key: "api_calls", type: "integer_limit" as const, value: 100 }],
    };
    const first = await app.policy!.evaluate(input);
    const second = await app.policy!.evaluate(input);

    expect(first.decisions.api_calls).toBe(40_000);
    expect(first.evaluations).toHaveLength(1);
    const a = first.evaluations[0]!;
    const b = second.evaluations[0]!;
    expect(a.firedRule).not.toBeNull();
    // Identical decision, identical fired rule (id+version), identical canonical hash -> reproducible (INV-12).
    expect(b.decision).toBe(a.decision);
    expect(b.firedRule).toEqual(a.firedRule);
    expect(b.inputHash).toBe(a.inputHash);
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/); // a plain SHA-256 digest, no signing key
  });

  it("clamps an effect to the authored maximum at EVALUATION (defense-in-depth, SC-004/INV-4)", async () => {
    // The `clamped` rule was authored in-bounds (value 500 == the then-ceiling). Lower the authored ceiling to
    // 300 AFTER authoring: the evaluation-time applier now CLAMPS the effect down to the current maximum.
    await setRuleMax(clampEntId, 300);
    const r = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: randomUUID(),
      planId,
      mode: "enforced",
      decisionTimestamp: 1_700_000_000_000,
      entitlements: [{ key: "clamped", type: "integer_limit", value: 10 }],
    });
    expect(r.decisions.clamped).toBe(300); // clamped from the authored 500 to the lowered ceiling 300
    expect(r.evaluations[0]!.enforced).toBe(true);
  });

  it("issuance-only: the decision is resolved once at issue, never re-decided on a read (SC-016)", async () => {
    const auth = await loginAs("acme-policy-issuance", "admin@acme.test");
    const lic = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as { id: string };

    // Exactly one mode-marked audit row per EVALUATED entitlement (api_calls + reports + tier_level fired;
    // widgets has no rule).
    const afterIssue = await evalCount(lic.id);
    expect(afterIssue).toBe(3);

    // Reading the license / its key several times performs NO re-evaluation -> the audit count is unchanged.
    await authed("GET", `/admin/licenses/${lic.id}`, auth);
    await authed("GET", `/admin/licenses/${lic.id}/key`, auth);
    await authed("GET", `/admin/licenses/${lic.id}`, auth);
    expect(await evalCount(lic.id)).toBe(afterIssue);

    // The audit rows are mode-marked `enforced` (the issuance path).
    const modes = await withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT DISTINCT mode FROM policy_evaluation WHERE license_id = $1", [lic.id]);
      return (r.rows as { mode: string }[]).map((x) => x.mode);
    });
    expect(modes).toEqual(["enforced"]);
  });
});
