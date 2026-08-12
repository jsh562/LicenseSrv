// T052 [Polish] (supporting NFR coverage, FR-002/009/019): performance + resource-bound characteristics of the
// policy engine against real Postgres (evaluate driven directly — the same code path E008 issuance runs). It is
// not a wall-clock benchmark (CI timing is noisy) but a BOUNDEDNESS proof with generous budgets:
//   - AUTHOR-TIME validation is a fast pure lint (thousands of validations complete well under budget; an
//     oversized condition is refused immediately by the byte cap, before any AST walk);
//   - a bounded EVALUATION honors the timeout / serialized-size / AST-depth caps — each breach throws (the
//     evaluator's fail-closed signal) rather than running unbounded;
//   - at ISSUANCE a resource-bound breach (over-deep condition) fails closed to the base decision quickly, and
//     the per-DECISION rule cap (FR-019) is enforced (an entitlement whose live active set exceeds the cap fails
//     closed to base) — so the signing path stays bounded regardless of rule-set growth.
// The per-issuance cap is pinned to 1 via POLICY_MAX_RULES_PER_ISSUANCE so a 2-rule entitlement exceeds it.
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { ConditionError, evaluateCondition } from "../condition.js";
import { loadPolicyConfig, type PolicyConfig } from "../config.js";
import type { EntitlementBounds } from "../effect.js";
import { evaluatePolicy } from "../evaluate.js";
import { PolicyRuleRepo } from "../rule-repo.js";
import { validateRule, type ValidateRuleOptions } from "../validate.js";

const MIGRATIONS_DIR = "migrations";
const tenantA = randomUUID();
const repo = new PolicyRuleRepo();

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let config: PolicyConfig;
let prevCap: string | undefined;

let okEntId: string; // one always-true rule -> fires (positive control)
let deepEntId: string; // one over-deep rule -> resource-bound breach -> fails closed
let capEntId: string; // two active rules -> exceeds the per-issuance cap of 1 -> fails closed

async function seedEntitlement(key: string, ruleMax: number): Promise<string> {
  const id = randomUUID();
  await privileged(pool, (q) =>
    q(
      `INSERT INTO entitlement (id, tenant_id, key, name, type, rule_max, rule_eligible)
       VALUES ($1, $2, $3, $4, 'integer_limit', $5, false)`,
      [id, tenantA, key, key, ruleMax],
    ),
  );
  return id;
}

async function insertActiveRule(entId: string, ruleKey: string, target: string, condition: unknown, value: number): Promise<void> {
  await withTenant(pool, tenantA, (q) =>
    repo.insertVersion(q, {
      ruleKey,
      version: 1,
      entitlementId: entId,
      condition,
      effect: { kind: "adjust_limit", target, value },
      priority: 100,
      status: "active",
      author: "perf-test",
    }),
  );
}

beforeAll(async () => {
  prevCap = process.env.POLICY_MAX_RULES_PER_ISSUANCE;
  process.env.POLICY_MAX_RULES_PER_ISSUANCE = "1";

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 4);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-policy-perf" });
  config = loadPolicyConfig(); // reads POLICY_MAX_RULES_PER_ISSUANCE=1

  okEntId = await seedEntitlement("okent", 50_000);
  deepEntId = await seedEntitlement("deepent", 5_000);
  capEntId = await seedEntitlement("capent", 50_000);

  // A condition nested far past the AST-depth cap (default 16) -> a resource-bound breach at evaluation.
  let overDeep: unknown = true;
  for (let i = 0; i < 40; i++) overDeep = { "!": overDeep };

  await insertActiveRule(okEntId, "ok-rule", "okent", { "==": [1, 1] }, 40_000);
  await insertActiveRule(deepEntId, "deep-rule", "deepent", overDeep, 3_000);
  // Two distinct live active rules on ONE entitlement -> exceeds the per-issuance cap of 1.
  await insertActiveRule(capEntId, "cap-a", "capent", { "==": [1, 1] }, 40_000);
  await insertActiveRule(capEntId, "cap-b", "capent", { "==": [1, 1] }, 45_000);
}, 240_000);

afterAll(async () => {
  if (prevCap === undefined) delete process.env.POLICY_MAX_RULES_PER_ISSUANCE;
  else process.env.POLICY_MAX_RULES_PER_ISSUANCE = prevCap;
  await pool?.end();
  await container?.stop();
});

/** Capture a synchronous throw and return its ConditionError code (or throw if it did not throw). */
function conditionErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConditionError) return e.code;
    throw e;
  }
  throw new Error("expected a ConditionError, but nothing was thrown");
}

describe("E017 policy performance + resource bounds (integration) — NFR (FR-002/009/019)", () => {
  it("author-time validation is fast (thousands of validations well under budget)", () => {
    const opts: ValidateRuleOptions = {
      maxBytes: config.conditionMaxBytes,
      maxDepth: config.conditionMaxDepth,
      maxComplexity: config.conditionMaxComplexity,
    };
    const bounds: EntitlementBounds = { ruleMax: 50_000, absoluteMax: config.absoluteMaxLimit };
    const condition = {
      and: [
        { ">": [{ var: "usage.api_calls" }, 10_000] },
        { "==": [{ var: "plan.tier" }, "pro"] },
      ],
    };
    const effect = { kind: "adjust_limit", target: "api_calls", value: 40_000 };

    const N = 5_000;
    const start = Date.now();
    for (let i = 0; i < N; i++) validateRule({ condition, effect, bounds }, opts);
    const elapsed = Date.now() - start;
    // 5k pure lints must finish comfortably under budget (typically < 200ms; 3s is a very safe CI ceiling).
    expect(elapsed).toBeLessThan(3_000);
  });

  it("an oversized condition is refused immediately by the byte cap (condition_too_large)", () => {
    const opts: ValidateRuleOptions = { maxBytes: config.conditionMaxBytes };
    const bounds: EntitlementBounds = { ruleMax: 50_000, absoluteMax: config.absoluteMaxLimit };
    // A giant string literal whose serialization blows the author-time byte cap.
    const oversized = { "==": [{ var: "plan.tier" }, "x".repeat(config.conditionMaxBytes + 1_000)] };
    let code: string | undefined;
    try {
      validateRule({ condition: oversized, effect: { kind: "adjust_limit", target: "x", value: 1 }, bounds }, opts);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("condition_too_large");
  });

  it("bounded evaluation honors the timeout / size / depth caps (each breach throws)", () => {
    // TIMEOUT: an injected monotonic clock jumps past the deadline on the first node -> `timeout`.
    let tick = 0;
    const clockSeq = [0, 10_000, 10_000, 10_000];
    const monotonicNow = () => clockSeq[Math.min(tick++, clockSeq.length - 1)]!;
    expect(conditionErrorCode(() =>
      evaluateCondition({ "==": [{ var: "now" }, { var: "now" }] }, {}, { timeoutMs: 5, now: 0, monotonicNow }),
    )).toBe("timeout");

    // SIZE: a serialized condition beyond the byte cap is refused before any traversal.
    const big = { "==": [{ var: "plan.tier" }, "y".repeat(500)] };
    expect(conditionErrorCode(() => evaluateCondition(big, {}, { maxBytes: 100 }))).toBe("max_size_exceeded");

    // DEPTH: a condition nested past the AST-depth cap is refused.
    let overDeep: unknown = true;
    for (let i = 0; i < 40; i++) overDeep = { "!": overDeep };
    expect(conditionErrorCode(() => evaluateCondition(overDeep, {}, { maxDepth: 16 }))).toBe("max_depth_exceeded");
  });

  it("a positive-control rule evaluates within bounds and fires (fast)", async () => {
    const start = Date.now();
    const r = await evaluatePolicy(
      { pool, repo, config },
      {
        tenantId: tenantA,
        licenseId: randomUUID(),
        planId: null,
        mode: "enforced",
        decisionTimestamp: 1_700_000_000_000,
        entitlements: [{ key: "okent", type: "integer_limit", value: 100 }],
      },
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(r.decisions.okent).toBe(40_000);
    expect(r.evaluations[0]!.enforced).toBe(true);
  });

  it("at issuance a resource-bound breach fails closed to base quickly", async () => {
    const start = Date.now();
    const r = await evaluatePolicy(
      { pool, repo, config },
      {
        tenantId: tenantA,
        licenseId: randomUUID(),
        planId: null,
        mode: "enforced",
        decisionTimestamp: 1_700_000_000_000,
        entitlements: [{ key: "deepent", type: "integer_limit", value: 30 }],
      },
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(r.decisions.deepent).toBe(30); // base stands (the over-deep rule was excluded)
    expect(r.evaluations[0]!.firedRule).toBeNull();
    expect(r.evaluations[0]!.enforced).toBe(false);
  });

  it("the per-decision rule cap (FR-019) is enforced — an over-cap entitlement fails closed to base", async () => {
    const r = await evaluatePolicy(
      { pool, repo, config },
      {
        tenantId: tenantA,
        licenseId: randomUUID(),
        planId: null,
        mode: "enforced",
        decisionTimestamp: 1_700_000_000_000,
        entitlements: [{ key: "capent", type: "integer_limit", value: 100 }],
      },
    );
    // The 2-rule active set exceeds the per-issuance cap of 1 -> fail closed for this entitlement (NOT truncation).
    expect(r.decisions.capent).toBeUndefined(); // base kept by omission in the caller's map
    expect(r.evaluations).toHaveLength(1);
    expect(r.evaluations[0]!.firedRule).toBeNull();
    expect(r.evaluations[0]!.enforced).toBe(false);
  });
});
