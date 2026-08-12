// T033 [US3] (FR-010/FR-019, SC-006/017/020): fail-closed integration test against real Postgres + a real signer
// (Fastify inject + Testcontainers). Proves the epic's non-negotiable fail-closed guarantees at the issuance path:
//   - a rule ERROR (unguarded absent field), a BOUND breach (an effect refused by the trusted clamp), and the
//     per-DECISION rule cap (FR-019) each fail closed FOR THE AFFECTED ENTITLEMENT ONLY — its base static
//     decision stands, the token carries the base value, and the breach is AUDITED (SC-006/017);
//   - an induced audit-write FAILURE ALSO fails closed: the base static decision stands, the token is STILL
//     issued, and the audit-persistence failure goes to operational logging — never the signing path (SC-020).
// The per-decision cap is exercised with POLICY_MAX_RULES_PER_ISSUANCE=1: an entitlement with 2 live active rules
// exceeds the cap and fails closed (NOT a silent LIMIT truncation). Fail-closed rules are inserted DIRECTLY via
// the repo (a bound-breach / cap-breach rule is refused by the author-time validator, FR-002, by design) so the
// EVAL-path fail-closed is exercised end-to-end through real issuance (the audit FK is a real license).
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { makePool, privileged, withTenant, type TxQuery } from "../../../db/client.js";
import { hmacKey } from "../../../db/hash.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { provisionKey } from "../../signing/registry.js";
import { PolicyRuleRepo } from "../rule-repo.js";

const MIGRATIONS_DIR = "migrations";
const SECRET = "policy-fail-closed-secret";
const tenantA = randomUUID();
const repo = new PolicyRuleRepo();

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;
let prevCap: string | undefined;

let productId: string;
let planId: string;
let customerId: string;
let capEntId: string;
let errEntId: string;
let boundEntId: string;

async function seedUser(email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(`INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`, [
      id,
      tenantA,
      hmacKey(email.toLowerCase(), SECRET),
      hashPassword("pw-" + email),
    ]);
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantA, id, role]);
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

async function setRuleMax(entId: string, ruleMax: number | null): Promise<void> {
  await withTenant(pool, tenantA, (q) => q("UPDATE entitlement SET rule_max = $2 WHERE id = $1", [entId, ruleMax]));
}

/** Insert an ACTIVE rule DIRECTLY (bypassing author-time validation) so the EVAL-path fail-closed is exercised. */
async function insertActiveRule(entId: string, ruleKey: string, target: string, condition: unknown, value: unknown): Promise<void> {
  await withTenant(pool, tenantA, (q) =>
    repo.insertVersion(q, {
      ruleKey,
      version: 1,
      entitlementId: entId,
      condition,
      effect: { kind: "adjust_limit", target, value },
      priority: 100,
      status: "active",
      author: "fail-closed-test",
    }),
  );
}

async function auditRows(licenseId: string): Promise<{ entitlement_key: string; fired_rule: unknown }[]> {
  return withTenant(pool, tenantA, async (q) => {
    const r = await q(
      "SELECT entitlement_key, fired_rule FROM policy_evaluation WHERE license_id = $1 ORDER BY entitlement_key",
      [licenseId],
    );
    return r.rows as { entitlement_key: string; fired_rule: unknown }[];
  });
}

beforeAll(async () => {
  const shares = shamirSplit(Buffer.alloc(32, 7), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");
  // Force a per-issuance rule cap of 1 so an entitlement with 2 live active rules FAILS CLOSED (FR-019/SC-017).
  prevCap = process.env.POLICY_MAX_RULES_PER_ISSUANCE;
  process.env.POLICY_MAX_RULES_PER_ISSUANCE = "1";

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-fail-closed" });
  await seedUser("admin@acme.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-fail-closed", "admin@acme.test");
  productId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, productId, custody, "test-setup");

  planId = (await authed("POST", `/admin/catalog/products/${productId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  capEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "capent", name: "Cap", type: "integer_limit" })).json().id;
  errEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "errent", name: "Err", type: "integer_limit" })).json().id;
  boundEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "boundent", name: "Bound", type: "integer_limit" })).json().id;
  const okEntId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "okent", name: "Ok", type: "integer_limit" })).json().id;

  // Base plan values.
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${capEntId}`, auth, { value: 100 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${errEntId}`, auth, { value: 20 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${boundEntId}`, auth, { value: 30 });
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${okEntId}`, auth, { value: 7 });

  await setRuleMax(capEntId, 50_000);
  await setRuleMax(errEntId, 5_000);
  await setRuleMax(boundEntId, 5_000);

  // A condition nested far past the AST-depth cap (default 16) -> a RESOURCE-BOUND breach at evaluation.
  let overDeep: unknown = true;
  for (let i = 0; i < 40; i++) overDeep = { "!": overDeep };

  // capent: TWO live active rules -> exceeds the per-issuance cap of 1 -> fails closed (NOT a silent truncation).
  await insertActiveRule(capEntId, "cap-a", "capent", { "==": [1, 1] }, 40_000);
  await insertActiveRule(capEntId, "cap-b", "capent", { "==": [1, 1] }, 45_000);
  // errent: a rule whose condition ERRORS (unguarded absent field) -> excluded -> base stands.
  await insertActiveRule(errEntId, "err-rule", "errent", { ">": [{ var: "usage.missing_metric" }, 1] }, 3_000);
  // boundent: a rule whose condition breaches the AST-depth resource bound -> excluded -> base stands.
  await insertActiveRule(boundEntId, "bound-rule", "boundent", overDeep, 3_000);

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme" })).json().id;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  if (prevCap === undefined) delete process.env.POLICY_MAX_RULES_PER_ISSUANCE;
  else process.env.POLICY_MAX_RULES_PER_ISSUANCE = prevCap;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 fail-closed issuance (integration, real Postgres + signer)", () => {
  it("rule error + bound breach + per-decision cap each fail closed to base and are audited (SC-006/017)", async () => {
    const auth = await loginAs("acme-fail-closed", "admin@acme.test");
    const res = await authed("POST", "/admin/licenses", auth, { planId, customerId });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; licenseKey: string; entitlements: Record<string, unknown> };

    // Every fail-closed entitlement carries its BASE value in the signed snapshot (the affected entitlement only).
    expect(body.entitlements.capent).toBe(100); // per-decision cap breach -> base
    expect(body.entitlements.errent).toBe(20); // rule error -> base
    expect(body.entitlements.boundent).toBe(30); // resource-bound breach -> base
    expect(body.entitlements.okent).toBe(7); // no rule -> base unchanged

    // Each fail-closed entitlement is AUDITED with fired_rule = NULL (base decision stood); okent (no rule) is not.
    const rows = await auditRows(body.id);
    expect(rows.map((r) => r.entitlement_key)).toEqual(["boundent", "capent", "errent"]);
    for (const row of rows) expect(row.fired_rule).toBeNull();
  });

  it("an induced audit-write failure ALSO fails closed — the token is still issued (SC-020)", async () => {
    const auth = await loginAs("acme-fail-closed", "admin@acme.test");
    // Break the append-only audit table so the policy_evaluation write throws during issuance.
    await privileged(pool, (q) => q("ALTER TABLE policy_evaluation RENAME TO policy_evaluation_broken"));
    try {
      const res = await authed("POST", "/admin/licenses", auth, { planId, customerId });
      // The audit write failed, but issuance is NEVER blocked: the license/token is still issued (SC-020).
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; licenseKey: string; entitlements: Record<string, unknown> };
      expect(body.licenseKey.startsWith("LIC1.")).toBe(true);
      expect(body.entitlements.okent).toBe(7); // base decisions still resolved
      // The license row is durably committed even though the audit append failed.
      const exists = await withTenant(pool, tenantA, async (q) => {
        const r = await q("SELECT 1 FROM license WHERE id = $1", [body.id]);
        return (r.rowCount ?? 0) === 1;
      });
      expect(exists).toBe(true);
    } finally {
      await privileged(pool, (q) => q("ALTER TABLE policy_evaluation_broken RENAME TO policy_evaluation"));
    }
  });

  it("the evaluate.ts writeAudit closure never throws when the append fails (fail-closed to operational logging)", async () => {
    // Drive the seam directly, then invoke writeAudit with a query that always rejects: it must be swallowed
    // (surfaced to operational logging), NEVER re-thrown onto the signing path (INV-8, SC-020).
    const result = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: randomUUID(),
      planId,
      mode: "enforced",
      decisionTimestamp: 1_700_000_000_000,
      entitlements: [{ key: "capent", type: "integer_limit", value: 100 }],
    });
    expect(result.evaluations.length).toBeGreaterThan(0);
    const throwingQ = (() => Promise.reject(new Error("audit sink down"))) as unknown as TxQuery;
    await expect(result.writeAudit(throwingQ)).resolves.toBeUndefined();
  });
});
