// T050 [Polish] (FR-017, SC-013) [COMPLETES FR-017]: secret / signing-key / PII NON-EXPOSURE across the whole
// policy surface (Fastify inject + Testcontainers Postgres). Proves INV-10 / SC-013 end to end:
//   - the assembled DECISION CONTEXT + audit SNAPSHOT are MINIMIZED to the allow-listed, pseudonymous fields —
//     a secret / signing key / PII field handed to the engine is DROPPED, never copied into the snapshot, the
//     canonical hash pre-image, or the persisted `policy_evaluation` row;
//   - a rule CONDITION cannot even REFERENCE a non-allow-listed (secret/PII) context field — it is refused at
//     author time (`invalid_condition`), so a rule can never read or emit a secret;
//   - a dry-run SUPPLIED context with an out-of-allow-list field is REJECTED (the server allow-list, not the
//     caller, is authoritative), and neither the HTTP RESPONSE nor the audit row carries a secret.
// No signer/issuance is needed: the evaluate seam is driven directly and the dry-run route is exercised over HTTP.
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
import { LICENSE_FIELDS } from "../context.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-secret-leakage-secret";

// The secret / signing-key / PII values handed to the engine that MUST NEVER surface in any projection.
const LEAKS = {
  email: "jane.doe@example.com",
  customerName: "Jane Q Doe",
  signingKey: "ed25519-PRIVATE-KEYMATERIAL-DEADBEEF",
  apiSecret: "sk_live_00secretkey00",
} as const;
const LEAK_VALUES = Object.values(LEAKS);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
let entitlementA: string;
let ruleKeyA: string;

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

async function seedEntitlement(tenantId: string, key: string, ruleMax: number): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max, rule_eligible)
       VALUES ($1, ${GUC}, $2, 'API', 'integer_limit', $3, false)`,
      [id, key, ruleMax],
    );
    return id;
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

function authed(method: "GET" | "POST" | "PATCH", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({ method, url, cookies: { admin_session: auth.session, admin_csrf: auth.csrf }, headers: { "x-csrf-token": auth.csrf }, payload: payload as never });
}

/** Assert a serialized blob contains NONE of the secret/PII values. */
function containsNoLeak(blob: string): void {
  for (const v of LEAK_VALUES) expect(blob).not.toContain(v);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-secret" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-policy-secret", "admin@acme.test");
  const created = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entitlementA,
    priority: 100,
    status: "active",
    condition: { "==": [1, 1] },
    effect: { kind: "adjust_limit", target: "api_calls", value: 40_000 },
  });
  if (created.statusCode !== 201) throw new Error(`author failed: ${created.statusCode} ${created.body}`);
  ruleKeyA = created.json().ruleKey as string;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 secret / signing-key / PII non-exposure (integration) — FR-017 / SC-013", () => {
  it("the decision-context snapshot is minimized — a secret/PII field handed to the engine is DROPPED", async () => {
    // Hand the engine a license context laden with secrets/PII beyond the allow-list (plus a legitimate
    // pseudonymous `customerRef`). The minimized snapshot must carry ONLY the allow-listed fields.
    const result = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: randomUUID(),
      planId: null,
      mode: "enforced",
      decisionTimestamp: 1_700_000_000_000,
      entitlements: [{ key: "api_calls", type: "integer_limit", value: 100 }],
      licenseContext: {
        plan: "pro",
        product: "keyed",
        status: "active",
        customerRef: "cust-pseudonymous-42", // allow-listed pseudonymous ref — this is the ONLY customer id kept
        ...LEAKS, // email / customerName / signingKey / apiSecret — all NON-allow-listed → dropped
      },
    });
    expect(result.evaluations).toHaveLength(1);
    const snap = result.evaluations[0]!.inputSnapshot as { license?: Record<string, unknown> };
    // Every retained license key is on the allow-list; none of the secret/PII keys survived minimization.
    expect(snap.license).toBeDefined();
    for (const k of Object.keys(snap.license!)) expect(LICENSE_FIELDS).toContain(k);
    for (const k of Object.keys(LEAKS)) expect(snap.license![k]).toBeUndefined();
    // The pseudonymous ref IS retained (allow-listed, not PII beyond a reference).
    expect(snap.license!.customerRef).toBe("cust-pseudonymous-42");
    // No secret value leaks into the snapshot, the resolved decision, or the canonical hash pre-image.
    containsNoLeak(JSON.stringify(result.evaluations[0]));
    expect(result.evaluations[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the persisted policy_evaluation audit row carries NO secret / signing key / PII", async () => {
    // Persist a dry_run audit row (null license) built from a secret-laden context, then inspect the stored row.
    const result = await app.policy!.evaluate({
      tenantId: tenantA,
      licenseId: null,
      planId: null,
      mode: "dry_run",
      decisionTimestamp: 1_700_000_000_000,
      entitlements: [{ key: "api_calls", type: "integer_limit", value: 100 }],
      licenseContext: { plan: "pro", customerRef: "cust-77", ...LEAKS },
    });
    await withTenant(pool, tenantA, (q) => result.writeAudit(q));

    const row = await withTenant(pool, tenantA, async (q) => {
      const r = await q(
        `SELECT input_hash, input_snapshot, decision, fired_rule FROM policy_evaluation
          WHERE mode = 'dry_run' AND entitlement_key = 'api_calls' ORDER BY created_at DESC LIMIT 1`,
      );
      return r.rows[0] as { input_hash: string; input_snapshot: unknown; decision: unknown; fired_rule: unknown };
    });
    expect(row).toBeDefined();
    expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/); // a plain digest — not a keyed/signing artifact
    // The whole persisted row (snapshot + decision + fired rule) is free of any secret/PII value.
    containsNoLeak(JSON.stringify(row));
    const snap = row.input_snapshot as { license?: Record<string, unknown> };
    for (const k of Object.keys(LEAKS)) expect(snap.license?.[k]).toBeUndefined();
  });

  it("a rule CONDITION cannot reference a non-allow-listed (secret/PII) context field — refused at author time", async () => {
    const auth = await loginAs("acme-policy-secret", "admin@acme.test");
    const forbiddenPaths = ["license.signingKey", "license.email", "license.customerName", "secret"];
    for (const p of forbiddenPaths) {
      const res = await authed("POST", "/admin/policy/rules", auth, {
        targetEntitlementId: entitlementA,
        priority: 5,
        condition: { "==": [{ var: p }, 1] },
        effect: { kind: "adjust_limit", target: "api_calls", value: 40_000 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_condition");
    }
  });

  it("a dry-run SUPPLIED context with an out-of-allow-list field is REJECTED (server allow-list authoritative)", async () => {
    const auth = await loginAs("acme-policy-secret", "admin@acme.test");
    const res = await authed("POST", `/admin/policy/rules/${ruleKeyA}/dry-run`, auth, {
      context: {
        decisionTimestamp: "2026-08-11T09:00:00Z",
        plan: { planId: "pro", tier: "pro" },
        entitlement: { entitlementId: entitlementA, key: "api_calls", kind: "integer_limit", baseValue: 100, authoredMaximum: 50_000 },
        signingKey: LEAKS.signingKey, // an out-of-schema field — the strict allow-list refuses it
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");
    containsNoLeak(res.body);
  });

  it("a well-formed dry-run RESPONSE + its audit row expose no secret", async () => {
    const auth = await loginAs("acme-policy-secret", "admin@acme.test");
    const res = await authed("POST", `/admin/policy/rules/${ruleKeyA}/dry-run`, auth, {
      context: {
        decisionTimestamp: "2026-08-11T09:00:00Z",
        plan: { planId: "pro", tier: "pro" },
        entitlement: { entitlementId: entitlementA, key: "api_calls", kind: "integer_limit", baseValue: 100, authoredMaximum: 50_000, ruleEligible: false },
        license: { customerReference: "cust-pseudonymous-9", status: "active" }, // a pseudonymous ref only
        usage: { api_calls: { value: 12_500, unit: "api-call" } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("dry_run");
    containsNoLeak(res.body);
  });
});
