// T032 [US3] (FR-009, SC-005): sandbox-escape integration test against real Postgres. Proves the load-bearing
// hard-boundary guarantee ADR-0014 requires: an attempt to reach eval / vm / host globals / I-O from a rule
// CONDITION is refused and NO host state is read or written. The evaluator (condition.ts) is the security
// boundary — so these malicious rules are inserted DIRECTLY through the repo (bypassing the author-time
// validator, which would already reject them, FR-002) and then run through the real issuance-path evaluator
// (`evaluatePolicy`): each escape payload FAILS CLOSED (the base static decision stands, no rule fires) and the
// process is unharmed (no prototype pollution, no global mutation, no throw). Representative payloads: an unknown
// operator (`eval`), a prototype-polluting `var` path, an oversized condition, and an over-deep condition. A
// well-formed rule is the positive control — it still evaluates within the configured resource bounds (SC-005).
import { randomUUID } from "node:crypto";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePool, privileged, withTenant } from "../../../db/client.js";
import { runMigrations } from "../../../db/migrate.js";
import { provisionTenant } from "../../../db/repository.js";
import { loadPolicyConfig, type PolicyConfig } from "../config.js";
import { evaluatePolicy } from "../evaluate.js";
import { PolicyRuleRepo } from "../rule-repo.js";

const MIGRATIONS_DIR = "migrations";
const tenantA = randomUUID();

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let config: PolicyConfig;
const repo = new PolicyRuleRepo();

let apiEntId: string; // target for the malicious rules (all fail closed)
let reportsEntId: string; // target for the well-formed positive-control rule

/** Insert an entitlement row directly (owner role) with an authored per-entitlement ceiling. */
async function seedEntitlement(key: string, ruleMax: number | null): Promise<string> {
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

/** Insert an ACTIVE rule DIRECTLY (bypassing author-time validation) so the eval-path sandbox is exercised. */
async function insertActiveRule(entId: string, ruleKey: string, condition: unknown, value = 40_000): Promise<void> {
  await withTenant(pool, tenantA, (q) =>
    repo.insertVersion(q, {
      ruleKey,
      version: 1,
      entitlementId: entId,
      condition,
      effect: { kind: "adjust_limit", target: "api_calls", value },
      priority: 100,
      status: "active",
      author: "sandbox-test",
    }),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = makePool(container.getConnectionUri(), 4);
  await runMigrations(pool, MIGRATIONS_DIR);
  await provisionTenant(pool, { id: tenantA, slug: "acme-sandbox-escape" });
  config = loadPolicyConfig();

  apiEntId = await seedEntitlement("api_calls", 50_000);
  reportsEntId = await seedEntitlement("reports", 500);

  // A giant string literal whose serialization blows the author-time/eval byte cap (default 8 KiB).
  const oversized = { "==": [{ var: "now" }, "x".repeat(10_000)] };
  // A condition nested far past the AST-depth cap (default 16).
  let overDeep: unknown = true;
  for (let i = 0; i < 40; i++) overDeep = { "!": overDeep };

  await insertActiveRule(apiEntId, "escape-eval", { eval: ["process"] });
  await insertActiveRule(apiEntId, "escape-require", { require: ["fs"] });
  await insertActiveRule(apiEntId, "escape-proto", { var: "__proto__.polluted" });
  await insertActiveRule(apiEntId, "escape-proto2", { "==": [{ var: "constructor.prototype.polluted" }, 1] });
  await insertActiveRule(apiEntId, "escape-oversized", oversized);
  await insertActiveRule(apiEntId, "escape-overdeep", overDeep);

  // Positive control: a well-formed always-true rule that lifts reports 10 -> 500 within its ceiling.
  await insertActiveRule(reportsEntId, "ok-lift", { "==": [1, 1] }, 500);
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("E017 sandbox escape (integration, real Postgres) — no host state reachable (FR-009, SC-005)", () => {
  it("refuses every eval/host/IO/proto/oversize/over-deep escape and fails closed to the base decision", async () => {
    let result: Awaited<ReturnType<typeof evaluatePolicy>> | undefined;

    // The issuance-path evaluator must NEVER throw on a malicious rule — a bad rule fails closed, never crashes.
    await expect(
      (async () => {
        result = await evaluatePolicy(
          { pool, repo, config },
          {
            tenantId: tenantA,
            licenseId: randomUUID(),
            planId: null,
            mode: "enforced",
            decisionTimestamp: 1_700_000_000_000,
            entitlements: [{ key: "api_calls", type: "integer_limit", value: 100 }],
          },
        );
      })(),
    ).resolves.toBeUndefined();

    // Every escape payload is refused -> the base static decision (100) stands, NO rule fired.
    expect(result!.decisions.api_calls).toBe(100);
    expect(result!.evaluations).toHaveLength(1);
    expect(result!.evaluations[0]!.firedRule).toBeNull();
    expect(result!.evaluations[0]!.enforced).toBe(false);
    expect(result!.evaluations[0]!.consideredRules).toEqual([]);
  });

  it("reads and writes NO host state — no prototype pollution, no global mutation", () => {
    // The prototype-polluting `var` paths were evaluated above; assert nothing leaked into the host.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((globalThis as Record<string, unknown>).polluted).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__sandbox_escaped__).toBeUndefined();
  });

  it("a well-formed rule still evaluates WITHIN the configured resource bounds (positive control, SC-005)", async () => {
    const result = await evaluatePolicy(
      { pool, repo, config },
      {
        tenantId: tenantA,
        licenseId: randomUUID(),
        planId: null,
        mode: "enforced",
        decisionTimestamp: 1_700_000_000_000,
        entitlements: [{ key: "reports", type: "integer_limit", value: 10 }],
      },
    );
    expect(result.decisions.reports).toBe(500); // lifted 10 -> 500 within the authored ceiling
    expect(result.evaluations[0]!.enforced).toBe(true);
    expect(result.evaluations[0]!.firedRule?.rule_key).toBe("ok-lift");
  });
});
