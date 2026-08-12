// T045 [US6] (FR-006, SC-010): deterministic conflict resolution + precedence over the real /admin/policy surface
// (Fastify inject + Testcontainers Postgres) and the issuance-path `evaluate` seam. Proves the US6 guarantees:
//   - DISTINCT priorities on ONE entitlement -> the HIGHEST-priority matching rule's effect wins, reproducibly on
//     every re-evaluation (identical decision + fired rule + canonical input_hash), the rest recorded considered;
//   - SAME priority on ONE entitlement -> a stable `(rule_key ASC, version DESC)` tiebreak yields ONE reproducible
//     outcome, independent of insertion order;
//   - an OVERLAPPING (same-priority) or UNREACHABLE (shadowed by a higher-priority always-matching) rule -> the
//     author-time lint SURFACES a non-blocking warning at create (SC-010), without blocking the persist.
// Evaluation rules are inserted DIRECTLY via the repo (to control the `rule_key` the tiebreak orders on); the
// lint is exercised through the real POST /admin/policy/rules route. Mirrors the E016/E007 admin-session harness.
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
import { PolicyRuleRepo } from "../rule-repo.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const GUC = "current_setting('app.current_tenant')::uuid";
const SECRET = "policy-conflict-secret";
const FIXED_TS = 1_700_000_000_000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let app: FastifyInstance;
const repo = new PolicyRuleRepo();

const tenantA = randomUUID();
let prioEntId: string; // distinct-priority test target
let tieEntId: string; // same-priority tiebreak test target
let overlapEntId: string; // author-time overlap-lint target
let unreachEntId: string; // author-time unreachable-lint target

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

async function seedEntitlement(tenantId: string, key: string, ruleMax: number): Promise<string> {
  return withTenant(pool, tenantId, async (q) => {
    const id = randomUUID();
    await q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max, rule_eligible)
       VALUES ($1, ${GUC}, $2, $2, 'integer_limit', $3, false)`,
      [id, key, ruleMax],
    );
    return id;
  });
}

/** Insert an ACTIVE rule DIRECTLY with a CONTROLLED rule_key/priority so the deterministic scan is exercised. */
async function insertActiveRule(
  entId: string,
  ruleKey: string,
  target: string,
  value: number,
  priority: number,
): Promise<void> {
  await withTenant(pool, tenantA, (q) =>
    repo.insertVersion(q, {
      ruleKey,
      version: 1,
      entitlementId: entId,
      condition: { "==": [1, 1] }, // always matches (deterministic)
      effect: { kind: "adjust_limit", target, value },
      priority,
      status: "active",
      author: "conflict-test",
    }),
  );
}

/** Drive the issuance-path evaluate seam directly with the injected (fixed) decision timestamp. */
function evaluate(entKey: string, baseValue: number) {
  return app.policy!.evaluate({
    tenantId: tenantA,
    licenseId: randomUUID(),
    planId: null,
    mode: "enforced",
    decisionTimestamp: FIXED_TS,
    entitlements: [{ key: entKey, type: "integer_limit", value: baseValue }],
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

function authed(method: "POST", url: string, auth: { session: string; csrf: string }, payload?: unknown) {
  return app.inject({
    method,
    url,
    cookies: { admin_session: auth.session, admin_csrf: auth.csrf },
    headers: { "x-csrf-token": auth.csrf },
    payload: payload as never,
  });
}

interface LintWarning {
  code: string;
  ruleKey: string;
  version: number;
  priority: number;
  message: string;
}

/** Author a rule via the real route; returns its ruleKey + the non-blocking author-time lint warnings. */
async function authorRule(
  auth: { session: string; csrf: string },
  entId: string,
  target: string,
  value: number,
  priority: number,
): Promise<{ ruleKey: string; warnings: LintWarning[] }> {
  const res = await authed("POST", "/admin/policy/rules", auth, {
    targetEntitlementId: entId,
    priority,
    status: "active",
    condition: { "==": [1, 1] },
    effect: { kind: "adjust_limit", target, value },
  });
  if (res.statusCode !== 201) throw new Error(`author rule failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { ruleKey: string; warnings: LintWarning[] };
  return { ruleKey: body.ruleKey, warnings: body.warnings };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 8);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-conflict" });
  await seedUser(tenantA, "admin@acme.test", "admin");

  prioEntId = await seedEntitlement(tenantA, "prio", 50_000);
  tieEntId = await seedEntitlement(tenantA, "tie", 50_000);
  overlapEntId = await seedEntitlement(tenantA, "overlap", 50_000);
  unreachEntId = await seedEntitlement(tenantA, "unreach", 50_000);

  // Distinct priorities on ONE entitlement: priority 20 must win over priority 10.
  await insertActiveRule(prioEntId, "prio-low", "prio", 20_000, 10);
  await insertActiveRule(prioEntId, "prio-high", "prio", 40_000, 20);

  // Same priority on ONE entitlement: the stable (rule_key ASC) tiebreak makes "tie-aaa" win over "tie-bbb".
  await insertActiveRule(tieEntId, "tie-bbb", "tie", 22_000, 15); // inserted FIRST (reverse of the ASC order)
  await insertActiveRule(tieEntId, "tie-aaa", "tie", 11_000, 15);

  app = createApp({ pool, apiKeySecret: SECRET });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("E017 conflict resolution & precedence (integration) — SC-010", () => {
  it("DISTINCT priorities: the highest-priority rule wins reproducibly, the rest are considered (FR-006)", async () => {
    const first = await evaluate("prio", 100);
    expect(first.decisions.prio).toBe(40_000); // priority-20 rule, not the priority-10 one
    const ev = first.evaluations[0]!;
    expect(ev.firedRule?.rule_key).toBe("prio-high");
    expect(ev.enforced).toBe(true);
    expect(ev.consideredRules.map((c) => c.rule_key)).toEqual(["prio-low"]);

    // Reproducible: re-evaluating the identical context yields the identical decision, fired rule, and hash.
    const second = await evaluate("prio", 100);
    expect(second.decisions.prio).toBe(40_000);
    expect(second.evaluations[0]!.firedRule).toEqual(ev.firedRule);
    expect(second.evaluations[0]!.inputHash).toBe(ev.inputHash);
  });

  it("SAME priority: the stable (rule_key, version) tiebreak yields ONE reproducible outcome (FR-006, INV-5)", async () => {
    const first = await evaluate("tie", 100);
    // "tie-aaa" < "tie-bbb" by rule_key ASC -> it wins regardless of insertion order (bbb was inserted first).
    expect(first.decisions.tie).toBe(11_000);
    expect(first.evaluations[0]!.firedRule?.rule_key).toBe("tie-aaa");
    expect(first.evaluations[0]!.consideredRules.map((c) => c.rule_key)).toEqual(["tie-bbb"]);

    const second = await evaluate("tie", 100);
    expect(second.decisions.tie).toBe(11_000);
    expect(second.evaluations[0]!.firedRule?.rule_key).toBe("tie-aaa");
  });

  it("OVERLAP lint: a same-priority peer surfaces a non-blocking overlapping_rule warning at author time (SC-010)", async () => {
    const admin = await loginAs("acme-conflict", "admin@acme.test");
    // The FIRST rule on the entitlement has no live peer -> no warning.
    const a = await authorRule(admin, overlapEntId, "overlap", 40_000, 100);
    expect(a.warnings).toEqual([]);

    // A SECOND rule at the SAME priority overlaps the first -> a non-blocking overlapping_rule warning (persisted).
    const b = await authorRule(admin, overlapEntId, "overlap", 30_000, 100);
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]!.code).toBe("overlapping_rule");
    expect(b.warnings[0]!.ruleKey).toBe(a.ruleKey);
    expect(b.warnings[0]!.priority).toBe(100);
  });

  it("UNREACHABLE lint: a lower-priority rule shadowed by a higher always-matching rule is flagged (SC-010)", async () => {
    const admin = await loginAs("acme-conflict", "admin@acme.test");
    // A higher-priority ALWAYS-matching rule ({"==":[1,1]}) always fires first.
    const high = await authorRule(admin, unreachEntId, "unreach", 40_000, 200);
    expect(high.warnings).toEqual([]);

    // A strictly-lower-priority rule can NEVER win -> a non-blocking unreachable_rule warning (still persisted).
    const low = await authorRule(admin, unreachEntId, "unreach", 30_000, 100);
    expect(low.warnings).toHaveLength(1);
    expect(low.warnings[0]!.code).toBe("unreachable_rule");
    expect(low.warnings[0]!.ruleKey).toBe(high.ruleKey);
    expect(low.warnings[0]!.priority).toBe(200);
  });
});
