// [Foundational] T008 (FR-009/014/019/021): policy config resolver unit tests. Exercises `loadPolicyConfig`'s
// default + env-override + invalid-fallback branches for every key (eval timeout; condition size/AST-depth/
// complexity caps; context size/depth/field caps; the three FR-019 cost caps; the FR-021 absolute authored-max
// ceiling; the FR-014 retention window; the FR-006 conflict policy) and `resolveConflictPolicy`. Pure — no DB.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ABSOLUTE_MAX_LIMIT,
  DEFAULT_CONDITION_MAX_BYTES,
  DEFAULT_CONDITION_MAX_COMPLEXITY,
  DEFAULT_CONDITION_MAX_DEPTH,
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_CONTEXT_MAX_BYTES,
  DEFAULT_CONTEXT_MAX_DEPTH,
  DEFAULT_CONTEXT_MAX_FIELDS,
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_EVALUATION_RETENTION_SECS,
  DEFAULT_MAX_RULES_PER_ENTITLEMENT,
  DEFAULT_MAX_RULES_PER_ISSUANCE,
  DEFAULT_MAX_RULES_PER_TENANT,
  loadPolicyConfig,
  resolveConflictPolicy,
} from "../config.js";

describe("loadPolicyConfig (FR-009/014/019/021 defaults)", () => {
  it("returns the documented defaults when the environment is empty", () => {
    expect(loadPolicyConfig({})).toEqual({
      evalTimeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
      conditionMaxBytes: DEFAULT_CONDITION_MAX_BYTES,
      conditionMaxDepth: DEFAULT_CONDITION_MAX_DEPTH,
      conditionMaxComplexity: DEFAULT_CONDITION_MAX_COMPLEXITY,
      contextMaxBytes: DEFAULT_CONTEXT_MAX_BYTES,
      contextMaxDepth: DEFAULT_CONTEXT_MAX_DEPTH,
      contextMaxFields: DEFAULT_CONTEXT_MAX_FIELDS,
      maxRulesPerEntitlement: DEFAULT_MAX_RULES_PER_ENTITLEMENT,
      maxRulesPerTenant: DEFAULT_MAX_RULES_PER_TENANT,
      maxRulesPerIssuance: DEFAULT_MAX_RULES_PER_ISSUANCE,
      absoluteMaxLimit: DEFAULT_ABSOLUTE_MAX_LIMIT,
      evaluationRetentionSecs: DEFAULT_EVALUATION_RETENTION_SECS,
      conflictPolicy: DEFAULT_CONFLICT_POLICY,
    });
  });

  it("keeps a tight sandbox by default (fast timeout, ~90d retention, highest-priority-wins)", () => {
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(50);
    expect(DEFAULT_EVALUATION_RETENTION_SECS).toBe(90 * 24 * 3600);
    expect(DEFAULT_CONFLICT_POLICY).toBe("highest_priority_wins");
  });

  it("honours valid env overrides for every key", () => {
    const cfg = loadPolicyConfig({
      POLICY_EVAL_TIMEOUT_MS: "25",
      POLICY_CONDITION_MAX_BYTES: "4096",
      POLICY_CONDITION_MAX_DEPTH: "8",
      POLICY_CONDITION_MAX_COMPLEXITY: "64",
      POLICY_CONTEXT_MAX_BYTES: "8192",
      POLICY_CONTEXT_MAX_DEPTH: "4",
      POLICY_CONTEXT_MAX_FIELDS: "32",
      POLICY_MAX_RULES_PER_ENTITLEMENT: "10",
      POLICY_MAX_RULES_PER_TENANT: "100",
      POLICY_MAX_RULES_PER_ISSUANCE: "20",
      POLICY_ABSOLUTE_MAX_LIMIT: "500000",
      POLICY_EVALUATION_RETENTION_SECS: "86400",
      POLICY_CONFLICT_POLICY: "highest_priority_wins",
    });
    expect(cfg).toEqual({
      evalTimeoutMs: 25,
      conditionMaxBytes: 4_096,
      conditionMaxDepth: 8,
      conditionMaxComplexity: 64,
      contextMaxBytes: 8_192,
      contextMaxDepth: 4,
      contextMaxFields: 32,
      maxRulesPerEntitlement: 10,
      maxRulesPerTenant: 100,
      maxRulesPerIssuance: 20,
      absoluteMaxLimit: 500_000,
      evaluationRetentionSecs: 86_400,
      conflictPolicy: "highest_priority_wins",
    });
  });

  it("falls back to defaults for non-positive / non-numeric env values", () => {
    const cfg = loadPolicyConfig({
      POLICY_EVAL_TIMEOUT_MS: "0",
      POLICY_CONDITION_MAX_BYTES: "-1",
      POLICY_CONDITION_MAX_DEPTH: "notanumber",
      POLICY_CONDITION_MAX_COMPLEXITY: "",
      POLICY_CONTEXT_MAX_BYTES: "abc",
      POLICY_CONTEXT_MAX_DEPTH: "-4",
      POLICY_CONTEXT_MAX_FIELDS: "0",
      POLICY_MAX_RULES_PER_ENTITLEMENT: "-5",
      POLICY_MAX_RULES_PER_TENANT: "x",
      POLICY_MAX_RULES_PER_ISSUANCE: "0",
      POLICY_ABSOLUTE_MAX_LIMIT: "-100",
      POLICY_EVALUATION_RETENTION_SECS: "nope",
      POLICY_CONFLICT_POLICY: "chaining",
    });
    expect(cfg.evalTimeoutMs).toBe(DEFAULT_EVAL_TIMEOUT_MS);
    expect(cfg.conditionMaxBytes).toBe(DEFAULT_CONDITION_MAX_BYTES);
    expect(cfg.conditionMaxDepth).toBe(DEFAULT_CONDITION_MAX_DEPTH);
    expect(cfg.conditionMaxComplexity).toBe(DEFAULT_CONDITION_MAX_COMPLEXITY);
    expect(cfg.contextMaxBytes).toBe(DEFAULT_CONTEXT_MAX_BYTES);
    expect(cfg.contextMaxDepth).toBe(DEFAULT_CONTEXT_MAX_DEPTH);
    expect(cfg.contextMaxFields).toBe(DEFAULT_CONTEXT_MAX_FIELDS);
    expect(cfg.maxRulesPerEntitlement).toBe(DEFAULT_MAX_RULES_PER_ENTITLEMENT);
    expect(cfg.maxRulesPerTenant).toBe(DEFAULT_MAX_RULES_PER_TENANT);
    expect(cfg.maxRulesPerIssuance).toBe(DEFAULT_MAX_RULES_PER_ISSUANCE);
    expect(cfg.absoluteMaxLimit).toBe(DEFAULT_ABSOLUTE_MAX_LIMIT);
    expect(cfg.evaluationRetentionSecs).toBe(DEFAULT_EVALUATION_RETENTION_SECS);
    // An unrecognized conflict policy can never be configured in (FR-006).
    expect(cfg.conflictPolicy).toBe(DEFAULT_CONFLICT_POLICY);
  });

  it("accepts a fractional absolute authored-max ceiling but floors integer caps", () => {
    expect(loadPolicyConfig({ POLICY_ABSOLUTE_MAX_LIMIT: "1234.5" }).absoluteMaxLimit).toBe(1234.5);
    expect(loadPolicyConfig({ POLICY_CONDITION_MAX_DEPTH: "9.9" }).conditionMaxDepth).toBe(9);
  });
});

describe("resolveConflictPolicy (FR-006)", () => {
  it("passes through the only implemented policy", () => {
    expect(resolveConflictPolicy("highest_priority_wins")).toBe("highest_priority_wins");
  });

  it("falls back to highest-priority-wins for an unknown / missing policy", () => {
    expect(resolveConflictPolicy("chaining")).toBe("highest_priority_wins");
    expect(resolveConflictPolicy(undefined)).toBe("highest_priority_wins");
    expect(resolveConflictPolicy("")).toBe("highest_priority_wins");
  });
});
