// T041 [US5] (FR-014, SC-009): the unified, mode-marked, append-only `policy_evaluation` audit over the real
// issuance path + the dry-run route (Fastify inject + Testcontainers Postgres). Proves the US5 audit guarantees:
//   - EVERY evaluation writes ONE row recording the fired rule id + version, the considered-but-not-applied rule
//     ids + versions (FR-006), a canonical `input_hash` (+ minimized snapshot), and the resolved decision;
//   - the trail is a SINGLE unified trail distinctly MODE-marked enforced | preview | dry_run;
//   - the trail is APPEND-ONLY: the app role has no UPDATE/DELETE grant.
// One issuance produces an ENFORCED row (an active-ruled entitlement, with a considered-not-applied peer) AND a
// PREVIEW row (a report-only rule, would-be decision logged, base still enforced in the token); the dry-run route
// produces a DRY_RUN row (nullable license ref). Mirrors the E017 issuance testcontainers harness.
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
import { provisionKey } from "../../signing/registry.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "policy-audit-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;

const tenantA = randomUUID();
let keyedProductId: string;
let planId: string;
let apiEntId: string;
let previewEntId: string;
let customerId: string;
let apiHighKey: string;
let apiLowKey: string;

interface EvalRow {
  mode: string;
  license_id: string | null;
  entitlement_key: string;
  fired_rule: { rule_id: string; rule_key: string; version: number } | null;
  considered_rules: Array<{ rule_id: string; rule_key: string; version: number }> | null;
  input_hash: string;
  input_snapshot: unknown;
  decision: unknown;
}

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

async function authorRule(auth: { session: string; csrf: string }, entId: string, target: string, value: number, status: "active" | "preview", priority: number): Promise<string> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority,
    status,
    condition: { "==": [1, 1] },
    effect: { kind: "adjust_limit", target, value },
  });
  if (res.statusCode !== 201) throw new Error(`author rule failed: ${res.statusCode} ${res.body}`);
  return res.json().ruleKey as string;
}

async function evalRowsFor(licenseId: string): Promise<EvalRow[]> {
  return withTenant(pool, tenantA, async (q) => {
    const r = await q(
      `SELECT mode, license_id, entitlement_key, fired_rule, considered_rules, input_hash, input_snapshot, decision
         FROM policy_evaluation WHERE license_id = $1 ORDER BY entitlement_key ASC`,
      [licenseId],
    );
    return r.rows as EvalRow[];
  });
}

beforeAll(async () => {
  const shares = shamirSplit(Buffer.alloc(32, 9), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-audit" });
  await seedUser(tenantA, "admin@acme.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-policy-audit", "admin@acme.test");
  keyedProductId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, keyedProductId, custody, "test-setup");

  planId = (await authed("POST", `/admin/catalog/products/${keyedProductId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  apiEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "api_calls", name: "API", type: "integer_limit" })).json().id;
  previewEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "preview_calls", name: "Preview", type: "integer_limit" })).json().id;

  // Base plan values: api_calls=100, preview_calls=7.
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${apiEntId}`, auth, { value: 100 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${previewEntId}`, auth, { value: 7 });

  await setRuleMax(apiEntId, 50_000);
  await setRuleMax(previewEntId, 50_000);

  // api_calls: TWO active rules — the higher-priority one FIRES, the lower is considered-but-not-applied.
  apiHighKey = await authorRule(auth, apiEntId, "api_calls", 40_000, "active", 200);
  apiLowKey = await authorRule(auth, apiEntId, "api_calls", 30_000, "active", 50);
  // preview_calls: ONE preview (report-only) rule — logs a would-be decision, does NOT enforce.
  await authorRule(auth, previewEntId, "preview_calls", 20_000, "preview", 100);

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme" })).json().id;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 unified mode-marked append-only audit (integration) — SC-009", () => {
  it("one issuance writes an ENFORCED row (fired id+version + considered_rules + hash/snapshot + decision) and a PREVIEW row", async () => {
    const auth = await loginAs("acme-policy-audit", "admin@acme.test");
    const lic = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json() as { id: string; entitlements: Record<string, unknown> };

    // The signed snapshot ENFORCES the active rule (api_calls 100->40000) but leaves the preview entitlement at
    // its BASE (preview_calls stays 7 — a preview rule never enforces).
    expect(lic.entitlements).toMatchObject({ api_calls: 40_000, preview_calls: 7 });

    const rows = await evalRowsFor(lic.id);
    // Exactly two audit rows: one enforced (api_calls), one preview (preview_calls). Ordered by entitlement_key.
    expect(rows.map((r) => [r.entitlement_key, r.mode])).toEqual([
      ["api_calls", "enforced"],
      ["preview_calls", "preview"],
    ]);

    const enforced = rows.find((r) => r.entitlement_key === "api_calls")!;
    // Fired rule id + version recorded (the higher-priority active rule).
    expect(enforced.fired_rule).toMatchObject({ rule_key: apiHighKey, version: 1 });
    expect(typeof enforced.fired_rule!.rule_id).toBe("string");
    // The lower-priority active rule is recorded considered-but-not-applied (FR-006).
    expect(enforced.considered_rules).not.toBeNull();
    expect(enforced.considered_rules!.map((c) => c.rule_key)).toContain(apiLowKey);
    // Canonical input_hash (plain SHA-256 digest, no signing key) + a minimized snapshot + the resolved decision.
    expect(enforced.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(enforced.input_snapshot).not.toBeNull();
    expect(enforced.decision).toBe(40_000);

    // The PREVIEW row logs the WOULD-BE decision (20000) even though it was not enforced in the token.
    const preview = rows.find((r) => r.entitlement_key === "preview_calls")!;
    expect(preview.mode).toBe("preview");
    expect(preview.fired_rule).not.toBeNull();
    expect(preview.decision).toBe(20_000);
    expect(preview.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the dry-run route appends a DRY_RUN row (nullable license ref) on the SAME unified trail", async () => {
    const auth = await loginAs("acme-policy-audit", "admin@acme.test");
    const suppliedContext = {
      decisionTimestamp: "2026-08-11T09:00:00Z",
      plan: { planId: "pro", tier: "pro" },
      entitlement: { entitlementId: apiEntId, key: "api_calls", kind: "integer_limit", baseValue: 100, authoredMaximum: 50_000, ruleEligible: false },
      usage: { api_calls: { value: 12_500, unit: "api-call" } },
    };
    const res = await authed("POST", `/admin/policy/rules/${apiHighKey}/dry-run`, auth, { context: suppliedContext });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("dry_run");

    // A dry_run row exists with a NULL license ref (supplied synthetic context), fully recorded.
    const dryRows = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        `SELECT mode, license_id, fired_rule, input_hash, decision FROM policy_evaluation
          WHERE mode = 'dry_run' AND license_id IS NULL ORDER BY created_at DESC LIMIT 1`,
      );
      return r.rows as Array<{ mode: string; license_id: string | null; fired_rule: unknown; input_hash: string; decision: unknown }>;
    });
    expect(dryRows).toHaveLength(1);
    expect(dryRows[0]!.mode).toBe("dry_run");
    expect(dryRows[0]!.license_id).toBeNull();
    expect(dryRows[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);

    // The three modes now coexist on ONE unified trail.
    const modes = await withTenant(pool, tenantA, async (q) => {
      const r = await q("SELECT DISTINCT mode FROM policy_evaluation ORDER BY mode");
      return (r.rows as { mode: string }[]).map((x) => x.mode);
    });
    expect(modes).toEqual(["dry_run", "enforced", "preview"]);
  });

  it("the audit trail is APPEND-ONLY — the app role has no UPDATE/DELETE grant", async () => {
    await expect(
      withTenant(pool, tenantA, (q) => q("UPDATE policy_evaluation SET decision = '0'::jsonb")),
    ).rejects.toThrow();
    await expect(withTenant(pool, tenantA, (q) => q("DELETE FROM policy_evaluation"))).rejects.toThrow();
  });
});
