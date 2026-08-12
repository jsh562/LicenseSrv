// T037 [US4] (FR-020, SC-018): the dry-run SUPPLIED-context bounding over the real /admin/policy HTTP surface
// (Fastify inject + Testcontainers Postgres + the real signer). Proves that a SUPPLIED decision context is
// validated against the SAME allow-listed field schema + serialized-size / JSON-depth / field-count caps as the
// real assembled context BEFORE any evaluation:
//   - an OUT-OF-SCHEMA field, an OVERSIZED / over-wide context, or a MALFORMED / over-depth value is refused
//     `400 validation_error` and NEVER evaluated (no admin can inject an oversized context to escape the eval
//     resource bounds or bypass FR-002/009);
//   - a WITHIN-BOUNDS supplied context evaluates IDENTICALLY to the same rule run against a REAL assembled license
//     context (same fired rule + resolved decision).
// Reuses the E017 issuance harness (custody shares + provisioned signing key + catalog flow) to mint a real license.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../app.js";
import { hmacKey } from "../../../db/hash.js";
import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { hashPassword } from "../../admin/password.js";
import { Custody, shamirSplit } from "../../signing/custody.js";
import { provisionKey } from "../../signing/registry.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const SECRET = "policy-dry-run-bound-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
let prevShares: string | undefined;

const tenantA = randomUUID();
let productId: string;
let planId: string;
let entId: string;
let customerId: string;
let ruleKey: string;
let licenseId: string;

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

async function setRuleMax(id: string, ruleMax: number): Promise<void> {
  await withTenant(pool, tenantA, (q) => q("UPDATE entitlement SET rule_max = $2 WHERE id = $1", [id, ruleMax]));
}

/** A within-bounds SUPPLIED decision context equivalent to the REAL license's assembled context. */
function suppliedContext(): Record<string, unknown> {
  return {
    decisionTimestamp: "2026-08-11T09:00:00Z",
    plan: { planId: "pro", tier: "pro" },
    entitlement: {
      entitlementId: entId,
      key: "api_calls",
      kind: "integer_limit",
      baseValue: 100,
      authoredMaximum: 50_000,
      ruleEligible: false,
    },
  };
}

beforeAll(async () => {
  const shares = shamirSplit(Buffer.alloc(32, 9), 3, 2).slice(0, 2);
  prevShares = process.env.SIGNING_CUSTODIAN_SHARES;
  process.env.SIGNING_CUSTODIAN_SHARES = shares.map((s) => s.toString("base64")).join(",");

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-dry-run-bound" });
  await seedUser(tenantA, "admin@acme.test", "admin");

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();

  const auth = await loginAs("acme-dry-run-bound", "admin@acme.test");
  productId = (await authed("POST", "/admin/catalog/products", auth, { key: "keyed", name: "Keyed" })).json().id;
  const custody = new Custody();
  custody.unlock(shares);
  await provisionKey(pool, tenantA, productId, custody, "test-setup");

  planId = (await authed("POST", `/admin/catalog/products/${productId}/plans`, auth, { key: "pro", name: "Pro", maxActivations: 5 })).json().id;
  entId = (await authed("POST", "/admin/catalog/entitlements", auth, { key: "api_calls", name: "API", type: "integer_limit" })).json().id;
  await authed("PUT", `/admin/catalog/plans/${planId}/entitlements/${entId}`, auth, { value: 100 });
  await setRuleMax(entId, 50_000);

  // An ACTIVE rule whose condition reads the assembled context (entitlement.baseValue) — fires for base 100.
  ruleKey = (
    await authed("POST", "/admin/policy/rules", auth, {
      targetEntitlementId: entId,
      priority: 100,
      status: "active",
      condition: { ">": [{ var: "entitlement.baseValue" }, 0] },
      effect: { kind: "adjust_limit", target: "api_calls", value: 40_000 },
    })
  ).json().ruleKey as string;

  customerId = (await authed("POST", "/admin/customers", auth, { ref: "cust-1", name: "Acme" })).json().id;
  licenseId = (await authed("POST", "/admin/licenses", auth, { planId, customerId })).json().id as string;
}, 240_000);

afterAll(async () => {
  if (prevShares === undefined) delete process.env.SIGNING_CUSTODIAN_SHARES;
  else process.env.SIGNING_CUSTODIAN_SHARES = prevShares;
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("policy dry-run — supplied-context bounding vs the real assembled context (integration) — SC-018", () => {
  it("rejects an OUT-OF-SCHEMA supplied context with validation_error BEFORE evaluation", async () => {
    const auth = await loginAs("acme-dry-run-bound", "admin@acme.test");
    const bad = { ...suppliedContext(), evil: "not-allowed" }; // an unknown top-level field (additionalProperties false)
    const res = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, auth, { context: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");
  });

  it("rejects an OVERSIZED / over-wide supplied context (field-count cap) with validation_error", async () => {
    const auth = await loginAs("acme-dry-run-bound", "admin@acme.test");
    // ~300 usage aggregates blows the decision-context field-count cap (default 128) — refused before eval.
    const usage = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, { value: i }]));
    const res = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, auth, { context: { ...suppliedContext(), usage } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");
  });

  it("rejects a MALFORMED / over-depth supplied context value with validation_error", async () => {
    const auth = await loginAs("acme-dry-run-bound", "admin@acme.test");
    const bad = { ...suppliedContext(), entitlement: { ...(suppliedContext().entitlement as object), baseValue: { deep: { deeper: { deepest: 1 } } } } };
    const res = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, auth, { context: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_error");
  });

  it("a WITHIN-BOUNDS supplied context evaluates IDENTICALLY to the real assembled license context", async () => {
    const auth = await loginAs("acme-dry-run-bound", "admin@acme.test");

    const real = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, auth, { licenseId });
    expect(real.statusCode).toBe(200);
    const supplied = await authed("POST", `/admin/policy/rules/${ruleKey}/dry-run`, auth, { context: suppliedContext() });
    expect(supplied.statusCode).toBe(200);

    const r = real.json();
    const s = supplied.json();
    // The same rule fires with the same resolved (bounded) decision in both paths (SC-018).
    expect(r.decision.resolvedValue).toBe(40_000);
    expect(s.decision.resolvedValue).toBe(40_000);
    expect(r.decision.source).toBe("rule");
    expect(s.decision.source).toBe("rule");
    expect(r.firedRule).toEqual({ ruleKey, version: 1 });
    expect(s.firedRule).toEqual({ ruleKey, version: 1 });
    expect(s.decision.effectKind).toBe(r.decision.effectKind);
    expect(s.decision.clamped).toBe(r.decision.clamped);
  });
});
