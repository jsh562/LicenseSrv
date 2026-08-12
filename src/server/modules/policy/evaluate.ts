// Highest-priority-wins issuance-path evaluator (E017, FR-006/008/010/014; ADR-0014, AD-004/AD-005/AD-007/AD-008,
// HINT-002/HINT-004/HINT-005, INV-5/INV-6/INV-7/INV-8/INV-11/INV-12).
//
// This is the ISSUANCE-PATH seam E008 consumes to adjust the effective entitlement definition BEFORE the E004
// signer runs (Principle I / FR-008): it performs NO cryptography, never touches the signer, the LIC1 token
// bytes, or the E001 verifier core — it only resolves a (possibly rule-adjusted) entitlement decision the
// snapshot then signs unchanged. An already-issued offline token stays byte-identical (SC-014).
//
// HIGHEST-PRIORITY-WINS (AD-005, FR-006, INV-5): per target entitlement, exactly ONE matching active rule's
// effect applies. Live rules are scanned in a DETERMINISTIC order (`priority DESC`, then the stable
// `(rule_key, version)` tiebreak); the highest-priority MATCHING rule is the winner. Its matched-but-not-applied
// peers are recorded as `considered_rules` (SC-009/SC-010). No effect chaining.
//
// FAIL-CLOSED (HINT-005, INV-7, FR-019/SC-017): each rule's condition is evaluated inside a guard — an error /
// timeout / resource-bound (size/depth/complexity) breach / unguarded absent-field EXCLUDES that rule from the
// match set (the base static decision stands for it); the winning rule's effect is clamped by the trusted applier
// and, if refused (a bound breach), the base decision stands (`fired_rule = NULL`). The per-DECISION rule cap
// (`maxRulesPerIssuance`) is likewise fail-closed, NOT a silent LIMIT: when an entitlement's live rule set
// exceeds the cap, THAT entitlement fails closed to its base decision and the breach is audited (the affected
// entitlement only, never a whole-issuance revert). A bad rule NEVER crashes or blocks the issuance path.
//
// DETERMINISTIC + AUDITED (AD-007/AD-008, INV-6/INV-8/INV-12): the ONLY time source is the injected
// `decisionTimestamp` (exposed as the context `now`); the same context reproduces the same decision, fired rule,
// AND canonical `input_hash`. Every evaluated entitlement appends ONE mode-marked `policy_evaluation` audit row;
// an audit-write failure fails closed to operational logging and NEVER blocks issuance (the caller runs the audit
// in a DEDICATED transaction so only the audit — never the license — rolls back).
import type pg from "pg";

import { withTenant, type TxQuery } from "../../db/client.js";
import type { EffectiveEntitlement } from "../catalog/effective.js";
import { loadPolicyConfig, type PolicyConfig } from "./config.js";
import {
  buildDecisionContext,
  canonicalContextHash,
  type BuildContextOptions,
  type DecisionContext,
} from "./context.js";
import { evaluateCondition, type EvaluateConditionOptions } from "./condition.js";
import { applyEffect, type ApplyEffectResult, type EntitlementBounds, type PolicyEffect } from "./effect.js";
import { PolicyRuleRepo, type EvaluationMode, type PolicyRuleRow, type RuleStatus } from "./rule-repo.js";

/** A resolved entitlement decision value the snapshot carries: an adjusted limit, boolean, or selected tier. */
export type PolicyDecisionValue = boolean | number | string;

/** A logical reference to the exact fired / considered rule version (audit-reproducible, no PII). */
export interface RuleRef {
  rule_id: string;
  rule_key: string;
  version: number;
}

/** One candidate rule for the highest-priority-wins scan (the pure core's input; DB-agnostic). */
export interface CandidateRule {
  id: string;
  ruleKey: string;
  version: number;
  priority: number;
  condition: unknown;
  effect: unknown;
}

/** The pure per-entitlement resolution: the resolved value, the ONE fired rule (or null), and its skipped peers. */
export interface EntitlementDecisionResult {
  decision: PolicyDecisionValue;
  firedRule: RuleRef | null;
  consideredRules: RuleRef[];
  /** True when a matching rule's effect actually adjusted the base value (a rule fired). */
  enforced: boolean;
}

function toRef(r: CandidateRule): RuleRef {
  return { rule_id: r.id, rule_key: r.ruleKey, version: r.version };
}

/**
 * The PURE highest-priority-wins core (AD-005, FR-006, INV-5/INV-7). Given the candidate rules targeting ONE
 * entitlement, the decision context, the target's authored bound, and the base value, resolve exactly one
 * decision: scan the rules in a deterministic order (`priority DESC`, then the stable `(rule_key, version)`
 * tiebreak), collect those whose condition MATCHES (a throw — error/timeout/bound/absent-field — fail-closed
 * EXCLUDES that rule), and apply the highest-priority match's effect through the trusted clamp. If the winner's
 * effect is refused (a bound breach) the base decision stands (`fired_rule = NULL`). The matched-but-not-applied
 * rules are recorded as `consideredRules`. No DB, no crypto, no wall-clock — deterministic + side-effect-free.
 */
export function resolveEntitlementDecision(
  candidates: readonly CandidateRule[],
  context: Record<string, unknown>,
  bounds: EntitlementBounds,
  baseValue: PolicyDecisionValue,
  opts: EvaluateConditionOptions = {},
): EntitlementDecisionResult {
  // Deterministic scan order: priority DESC, then a stable (rule_key ASC, version DESC) tiebreak (INV-5/INV-6).
  const ordered = [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0) ||
      b.version - a.version,
  );

  // Collect the MATCHING rules in priority order. Fail-closed (INV-7): any throw from the sandboxed evaluator
  // (unsafe operator refused, timeout, depth/complexity breach, unguarded absent field) EXCLUDES the rule.
  const matching: CandidateRule[] = [];
  for (const rule of ordered) {
    try {
      if (evaluateCondition(rule.condition, context, opts)) matching.push(rule);
    } catch {
      // fail-closed skip: this rule contributes nothing; the base static decision stands for it.
    }
  }

  if (matching.length === 0) {
    return { decision: baseValue, firedRule: null, consideredRules: [], enforced: false };
  }

  const winner = matching[0]!;
  const peers = matching.slice(1).map(toRef);

  // Apply the winner's effect through the SINGLE trusted clamp (effect.ts). Guard defensively so a malformed
  // descriptor can never throw on the issuance path (fail-closed to the base decision).
  let applied: ApplyEffectResult;
  try {
    applied = applyEffect(winner.effect as PolicyEffect, bounds);
  } catch {
    applied = { applied: false, kind: "adjust_limit", target: "", reason: "invalid_effect" };
  }

  if (applied.applied) {
    return { decision: applied.value, firedRule: toRef(winner), consideredRules: peers, enforced: true };
  }
  // The highest-priority match's effect was refused (a bound breach) -> fail-closed: base stands, none fired.
  // The winner joins the considered-but-not-applied set (it matched but did not apply, FR-006/INV-7).
  return { decision: baseValue, firedRule: null, consideredRules: [toRef(winner), ...peers], enforced: false };
}

// --- DB-driven issuance-path evaluation ----------------------------------------------------------------------

/** The composed deps the issuance-path evaluator reads (the RLS pool, the rule repo, the live config). */
export interface EvaluatePolicyDeps {
  pool: pg.Pool;
  repo: PolicyRuleRepo;
  config: PolicyConfig;
}

/** The issuance-path evaluation input: the decision scope + the base effective definition to (maybe) adjust. */
export interface EvaluatePolicyInput {
  /** The caller's tenant (RLS scope); rule lookup + audit are tenant-scoped (FR-015). */
  tenantId: string;
  /** The license the decision is resolved for; required for an `enforced` audit row (NULL only for dry-run). */
  licenseId?: string | null;
  /** The plan whose effective definition is being decided (audit ref). */
  planId?: string | null;
  /** The evaluation mode marking the audit row (default `enforced`, the issuance path). */
  mode?: EvaluationMode;
  /** The injected decision timestamp (epoch millis) — the ONLY time source (exposed as `now`, FR-005/INV-6). */
  decisionTimestamp: number;
  /** The base effective entitlements the engine may adjust within the authored per-entitlement bound. */
  entitlements: readonly EffectiveEntitlement[];
  /** Allow-listed read-only E008 license claim context (minimized to LICENSE_FIELDS). */
  licenseContext?: Record<string, unknown> | null;
  /** Allow-listed read-only E007 plan context (minimized to PLAN_FIELDS). */
  planContext?: Record<string, unknown> | null;
  /** E016 usage aggregates keyed by entitlement key (has()-guarded, numeric leaves only). */
  usageContext?: Record<string, Record<string, unknown>> | null;
}

/** One per-entitlement evaluation record (the audit + reproducibility payload). */
export interface EntitlementEvaluation {
  entitlementKey: string;
  mode: EvaluationMode;
  baseValue: PolicyDecisionValue;
  decision: PolicyDecisionValue;
  firedRule: RuleRef | null;
  consideredRules: RuleRef[];
  /** The canonical minimized decision-context hash (INV-12, reproducible). */
  inputHash: string;
  /** The minimized (allow-listed, no secret/PII) decision-context snapshot (FR-017). */
  inputSnapshot: DecisionContext;
  enforced: boolean;
}

/**
 * The issuance-path evaluation result: the (possibly rule-adjusted) decisions the snapshot signs, the per-
 * entitlement evaluation records, and a DEFERRED `writeAudit` that appends the mode-marked `policy_evaluation`
 * rows. `decisions` carries an entry ONLY for an entitlement that had at least one live active rule; the caller
 * keeps the base value for any key absent from the map (so an issuance with no rules changes no token byte).
 */
export interface EvaluatePolicyResult {
  decisions: Record<string, PolicyDecisionValue>;
  evaluations: EntitlementEvaluation[];
  /**
   * Append the mode-marked `policy_evaluation` audit rows (INV-8, FR-014). Best-effort — it NEVER throws: an
   * audit-write failure is swallowed to operational logging so issuance is never blocked. MUST be called in a
   * DEDICATED transaction AFTER the license row is committed (the license FK), so only the audit — never the
   * license — can roll back on a persistence fault.
   */
  writeAudit(q: TxQuery): Promise<void>;
}

/** The authored per-entitlement bound + id resolved from the E007 `entitlement` row (the effect clamp source). */
interface EntitlementBoundRow {
  id: string;
  ruleMax: number | null;
  ruleEligible: boolean;
  ruleTiers: unknown[] | null;
}

/**
 * Evaluate the tenant's live policy rules against the base effective definition at issuance and resolve the
 * (possibly adjusted) entitlement decisions the snapshot signs (FR-006/008/010/012/014). The ENFORCED (active)
 * set decides the signed value; the report-only PREVIEW set is decided INDEPENDENTLY and its would-be decision is
 * LOGGED (mode=preview) WITHOUT displacing the enforced outcome (FR-012). Highest-priority-wins, deterministic
 * (injected clock), fail-closed, and audited. Reads rules in the evaluator's OWN tenant transaction (a read the
 * sign path never mutates); the returned `writeAudit` appends every mode-marked (enforced|preview) audit row in
 * the caller's post-insert transaction. Performs NO cryptography and touches no token byte (Principle I, INV-11).
 */
export async function evaluatePolicy(
  deps: EvaluatePolicyDeps,
  input: EvaluatePolicyInput,
): Promise<EvaluatePolicyResult> {
  const { pool, repo, config } = deps;
  const mode: EvaluationMode = input.mode ?? "enforced";
  const decisions: Record<string, PolicyDecisionValue> = {};
  const evaluations: EntitlementEvaluation[] = [];

  const contextCaps: BuildContextOptions = {
    maxBytes: config.contextMaxBytes,
    maxDepth: config.contextMaxDepth,
    maxFields: config.contextMaxFields,
  };
  const condOpts: EvaluateConditionOptions = {
    timeoutMs: config.evalTimeoutMs,
    maxBytes: config.conditionMaxBytes,
    maxDepth: config.conditionMaxDepth,
    maxComplexity: config.conditionMaxComplexity,
    now: input.decisionTimestamp,
  };

  if (input.entitlements.length > 0) {
    await withTenant(pool, input.tenantId, async (q) => {
      const bounds = await loadEntitlementBounds(q, input.entitlements);

      const toCandidate = (r: PolicyRuleRow): CandidateRule => ({
        id: r.id,
        ruleKey: r.ruleKey,
        version: r.version,
        priority: r.priority,
        condition: r.condition,
        effect: r.effect,
      });

      for (const ent of input.entitlements) {
        const boundRow = bounds.get(ent.key);
        if (!boundRow) continue; // no matching entitlement row -> nothing to evaluate (base stands)

        // Live rules for this target entitlement, deterministic priority order. Fetch `cap + 1` so an OVER-CAP
        // rule set is DETECTABLE — the per-issuance cap fails CLOSED (below), it is NOT a silent LIMIT truncation.
        const perIssuanceCap = config.maxRulesPerIssuance;
        const live = await repo.selectLiveRulesForEntitlement(q, boundRow.id, perIssuanceCap + 1);
        // Split the live set into the ENFORCED (active) set and the report-only PREVIEW set. The two are decided
        // INDEPENDENTLY (FR-012, T043): the active set resolves the enforced decision the snapshot signs, while a
        // preview rule's would-be decision is LOGGED (mode=preview) but NEVER displaces the active decision.
        const active = live.filter((r) => (r.status as RuleStatus) === "active");
        const preview = live.filter((r) => (r.status as RuleStatus) === "preview");
        if (active.length === 0 && preview.length === 0) continue; // no live rule -> base stands silently (no audit)

        const entBounds: EntitlementBounds = {
          ruleMax: boundRow.ruleMax,
          ruleEligible: boundRow.ruleEligible,
          ruleTiers: boundRow.ruleTiers,
          absoluteMax: config.absoluteMaxLimit,
        };

        let context: DecisionContext;
        try {
          context = buildDecisionContext(
            {
              decisionTimestamp: input.decisionTimestamp,
              license: input.licenseContext ?? undefined,
              plan: input.planContext ?? undefined,
              entitlement: {
                key: ent.key,
                type: ent.type,
                value: ent.value,
                baseValue: ent.value,
                ruleMax: boundRow.ruleMax,
                ruleEligible: boundRow.ruleEligible,
                ruleTiers: boundRow.ruleTiers ?? undefined,
              },
              usage: input.usageContext?.[ent.key],
            },
            contextCaps,
          );
        } catch {
          // Fail-closed: an over-bound / over-deep context can never reach the evaluator -> base decision stands.
          continue;
        }
        const inputHash = canonicalContextHash(context);
        const ctxRecord = context as unknown as Record<string, unknown>;

        // --- ENFORCED (active) branch: resolves the (possibly adjusted) decision the snapshot signs (FR-006/008). ---
        if (active.length > 0) {
          // FR-019 per-DECISION rule cap (INV-7, SC-017): when the ACTIVE set for THIS entitlement exceeds the
          // configured per-issuance cap, FAIL CLOSED for this entitlement ONLY -> its base static decision stands
          // (no rule fires) and the breach is AUDITED (a fail-closed skip, NOT a silent LIMIT truncation and NOT a
          // whole-issuance revert). The base value is left in the caller's map by omission.
          if (active.length > perIssuanceCap) {
            evaluations.push({
              entitlementKey: ent.key,
              mode,
              baseValue: ent.value,
              decision: ent.value,
              firedRule: null,
              consideredRules: [],
              inputHash,
              inputSnapshot: context,
              enforced: false,
            });
          } else {
            const resolved = resolveEntitlementDecision(
              active.map(toCandidate),
              ctxRecord,
              entBounds,
              ent.value,
              condOpts,
            );
            decisions[ent.key] = resolved.decision;
            evaluations.push({
              entitlementKey: ent.key,
              mode,
              baseValue: ent.value,
              decision: resolved.decision,
              firedRule: resolved.firedRule,
              consideredRules: resolved.consideredRules,
              inputHash,
              inputSnapshot: context,
              enforced: resolved.enforced,
            });
          }
        }

        // --- PREVIEW (report-only) branch (T043/T044, FR-012, INV-8): decided INDEPENDENTLY of the active set as
        // if the preview rules were the winning active set for this entitlement; the would-be decision is LOGGED
        // (mode=preview) but is NEVER written to `decisions` — the enforced outcome is unchanged. ---
        if (preview.length > 0) {
          if (preview.length > perIssuanceCap) {
            evaluations.push({
              entitlementKey: ent.key,
              mode: "preview",
              baseValue: ent.value,
              decision: ent.value,
              firedRule: null,
              consideredRules: [],
              inputHash,
              inputSnapshot: context,
              enforced: false,
            });
          } else {
            const previewResolved = resolveEntitlementDecision(
              preview.map(toCandidate),
              ctxRecord,
              entBounds,
              ent.value,
              condOpts,
            );
            // Intentionally NOT assigned to `decisions[ent.key]` — a preview rule never enforces (FR-012).
            evaluations.push({
              entitlementKey: ent.key,
              mode: "preview",
              baseValue: ent.value,
              decision: previewResolved.decision,
              firedRule: previewResolved.firedRule,
              consideredRules: previewResolved.consideredRules,
              inputHash,
              inputSnapshot: context,
              enforced: previewResolved.enforced,
            });
          }
        }
      }
    });
  }

  const writeAudit = async (q: TxQuery): Promise<void> => {
    for (const ev of evaluations) {
      try {
        await repo.appendEvaluation(q, {
          licenseId: input.licenseId ?? null,
          planId: input.planId ?? null,
          entitlementKey: ev.entitlementKey,
          firedRule: ev.firedRule ?? undefined,
          consideredRules: ev.consideredRules.length > 0 ? ev.consideredRules : null,
          inputHash: ev.inputHash,
          inputSnapshot: ev.inputSnapshot,
          decision: ev.decision,
          mode: ev.mode,
        });
      } catch (e) {
        // INV-8: an audit-write failure fails closed to operational logging and NEVER blocks issuance. (Within a
        // single pg transaction a failed statement aborts it; the caller isolates writeAudit in its own tx.)
        console.error("[policy] policy_evaluation audit append failed", e);
      }
    }
  };

  return { decisions, evaluations, writeAudit };
}

/**
 * Resolve the id + authored per-entitlement bound (rule_max / rule_eligible / rule_tiers) for the effective
 * entitlements by key, in ONE tenant-scoped query. The composite bound feeds both the rule lookup (by id) and
 * the trusted effect clamp (AD-003, INV-4). RLS scopes the read to the caller's tenant (FR-015).
 */
async function loadEntitlementBounds(
  q: TxQuery,
  entitlements: readonly EffectiveEntitlement[],
): Promise<Map<string, EntitlementBoundRow>> {
  const keys = entitlements.map((e) => e.key);
  const r = await q(
    "SELECT id, key, rule_max, rule_eligible, rule_tiers FROM entitlement WHERE key = ANY($1)",
    [keys],
  );
  const out = new Map<string, EntitlementBoundRow>();
  for (const row of r.rows as {
    id: string;
    key: string;
    rule_max: string | number | null;
    rule_eligible: boolean;
    rule_tiers: unknown[] | null;
  }[]) {
    out.set(row.key, {
      id: row.id,
      ruleMax: row.rule_max === null ? null : Number(row.rule_max),
      ruleEligible: row.rule_eligible,
      ruleTiers: row.rule_tiers,
    });
  }
  return out;
}

/** Convenience: bind {@link evaluatePolicy} to freshly-loaded deps (used where a composed seam isn't at hand). */
export function makeEvaluator(pool: pg.Pool, config: PolicyConfig = loadPolicyConfig()): {
  evaluate: (input: EvaluatePolicyInput) => Promise<EvaluatePolicyResult>;
} {
  const repo = new PolicyRuleRepo();
  return { evaluate: (input) => evaluatePolicy({ pool, repo, config }, input) };
}
