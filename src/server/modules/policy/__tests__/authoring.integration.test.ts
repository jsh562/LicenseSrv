// T021 [US1] (FR-002, SC-001): author-time validate-before-persist over the real /admin/policy HTTP surface
// (Fastify inject + Testcontainers Postgres). Proves that a create OR edit which is invalid/unsafe/out-of-bounds
// is REFUSED with a DISTINCT 400 code — `invalid_condition` / `unsafe_operator` / `effect_out_of_bounds` /
// `condition_too_large` — and is NEVER persisted (the rejected rule is absent from policy_rule; a rejected edit
// creates no new version). A well-formed, safe, in-bounds rule saves as version 1. Mirrors the E016/E007
// admin-session + testcontainers harness.
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

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-authoring-secret";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;

const tenantA = randomUUID();
let entitlementA: string;

async function seedUser(tenantId: string, email: string, role: string): Promise<void> {
  const id = randomUUID();
  await privileged(pool, async (q) => {
    await q(
      `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenantId, hmacKey(email.toLowerCase(), SECRET), hashPassword("pw-" + email)],
    );
    await q(`INSERT INTO role (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenantId, id, role]);
  });
}

/** Seed an integer_limit entitlement with an authored rule_max (so an adjust_limit effect has a ceiling). */
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
  const session = res.cookies.find((c) => c.name === "admin_session")!.value;
  const csrf = res.cookies.find((c) => c.name === "admin_csrf")!.value;
  return { session, csrf };
}

function authed(method: "GET" | "POST" | "PATCH", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({
    method,
    url,
    cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
    headers: { "x-csrf-token": auth.csrf },
    payload: payload as never,
  });
}

async function ruleCount(tenantId: string, entitlementId: string): Promise<number> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q("SELECT count(*)::int AS n FROM policy_rule WHERE entitlement_id = $1", [entitlementId]);
    return (r.rows[0] as { n: number }).n;
  });
}

/** A well-formed, safe, in-bounds authorable body (condition + adjust_limit effect within the rule_max). */
function validBody(entitlementId: string, value = 50_000): Record<string, unknown> {
  return {
    targetEntitlementId: entitlementId,
    priority: 100,
    condition: { ">": [{ var: "usage.api_calls" }, 10_000] },
    effect: { kind: "adjust_limit", target: "api_calls", value },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-authoring" });
  await seedUser(tenantA, "admin@acme.test", "admin");
  entitlementA = await seedEntitlement(tenantA, "api_calls", 50_000);
  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("author-time validate-before-persist (integration, real Postgres) — SC-001", () => {
  it("rejects each distinct 400 code on CREATE and persists NOTHING", async () => {
    const auth = await loginAs("acme-policy-authoring", "admin@acme.test");
    const base = validBody(entitlementA);

    // invalid_condition: a `var` path outside the allow-listed context schema (unknown root).
    const invalidCondition = await authed("POST", "/admin/policy/rules", auth, {
      ...base,
      condition: { "==": [{ var: "unknown_root.field" }, 1] },
    });
    expect(invalidCondition.statusCode).toBe(400);
    expect(invalidCondition.json().code).toBe("invalid_condition");

    // unsafe_operator: an operator outside the safety allow-list (the safety-lint boundary).
    const unsafe = await authed("POST", "/admin/policy/rules", auth, {
      ...base,
      condition: { eval: ["process"] },
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().code).toBe("unsafe_operator");

    // effect_out_of_bounds: an adjust_limit value above the authored per-entitlement maximum.
    const overBound = await authed("POST", "/admin/policy/rules", auth, {
      ...base,
      effect: { kind: "adjust_limit", target: "api_calls", value: 9_999_999 },
    });
    expect(overBound.statusCode).toBe(400);
    expect(overBound.json().code).toBe("effect_out_of_bounds");

    // condition_too_large: a condition exceeding the node-count / complexity cap.
    const bigAnd = { and: Array.from({ length: 300 }, () => ({ "==": [1, 1] })) };
    const tooLarge = await authed("POST", "/admin/policy/rules", auth, { ...base, condition: bigAnd });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().code).toBe("condition_too_large");

    // NOTHING was persisted — every rejected create left the policy_rule table empty for this entitlement.
    expect(await ruleCount(tenantA, entitlementA)).toBe(0);
  });

  it("saves a well-formed, safe, in-bounds rule as version 1 (SC-001 happy path)", async () => {
    const auth = await loginAs("acme-policy-authoring", "admin@acme.test");
    const created = await authed("POST", "/admin/policy/rules", auth, validBody(entitlementA));
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.version).toBe(1);
    expect(body.status).toBe("preview");
    expect(body.targetEntitlementId).toBe(entitlementA);
    expect(body.effect).toMatchObject({ kind: "adjust_limit", target: "api_calls", value: 50_000 });
    expect(created.headers.location).toBe(`/admin/policy/rules/${body.ruleKey}`);
    expect(await ruleCount(tenantA, entitlementA)).toBe(1);
  });

  it("rejects an invalid EDIT and creates NO new version (the rule stays at version 1)", async () => {
    const auth = await loginAs("acme-policy-authoring", "admin@acme.test");
    const created = await authed("POST", "/admin/policy/rules", auth, validBody(entitlementA));
    expect(created.statusCode).toBe(201);
    const ruleKey = created.json().ruleKey as string;

    // Each distinct code is refused on the PATCH edit path too — no new immutable version is created.
    const badEdits: Array<[Record<string, unknown>, string]> = [
      [{ condition: { "==": [{ var: "nope.x" }, 1] } }, "invalid_condition"],
      [{ condition: { require: ["fs"] } }, "unsafe_operator"],
      [{ effect: { kind: "adjust_limit", target: "api_calls", value: 9_999_999 } }, "effect_out_of_bounds"],
    ];
    for (const [override, code] of badEdits) {
      const res = await authed("PATCH", `/admin/policy/rules/${ruleKey}`, auth, {
        priority: 100,
        condition: { ">": [{ var: "usage.api_calls" }, 10_000] },
        effect: { kind: "adjust_limit", target: "api_calls", value: 50_000 },
        ...override,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
    }

    // The rule remains a single immutable version — no rejected edit persisted a version 2.
    const detail = await authed("GET", `/admin/policy/rules/${ruleKey}`, auth);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().latestVersion).toBe(1);
    expect((detail.json().versions as unknown[]).length).toBe(1);
  });
});
