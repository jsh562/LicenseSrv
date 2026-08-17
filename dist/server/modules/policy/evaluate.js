import { withTenant } from "../../db/client.js";
import { loadPolicyConfig } from "./config.js";
import { buildDecisionContext, canonicalContextHash, } from "./context.js";
import { evaluateCondition } from "./condition.js";
import { applyEffect } from "./effect.js";
import { PolicyRuleRepo } from "./rule-repo.js";
function toRef(r) {
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
export function resolveEntitlementDecision(candidates, context, bounds, baseValue, opts = {}) {
    // Deterministic scan order: priority DESC, then a stable (rule_key ASC, version DESC) tiebreak (INV-5/INV-6).
    const ordered = [...candidates].sort((a, b) => b.priority - a.priority ||
        (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0) ||
        b.version - a.version);
    // Collect the MATCHING rules in priority order. Fail-closed (INV-7): any throw from the sandboxed evaluator
    // (unsafe operator refused, timeout, depth/complexity breach, unguarded absent field) EXCLUDES the rule.
    const matching = [];
    for (const rule of ordered) {
        try {
            if (evaluateCondition(rule.condition, context, opts))
                matching.push(rule);
        }
        catch {
            // fail-closed skip: this rule contributes nothing; the base static decision stands for it.
        }
    }
    if (matching.length === 0) {
        return { decision: baseValue, firedRule: null, consideredRules: [], enforced: false };
    }
    const winner = matching[0];
    const peers = matching.slice(1).map(toRef);
    // Apply the winner's effect through the SINGLE trusted clamp (effect.ts). Guard defensively so a malformed
    // descriptor can never throw on the issuance path (fail-closed to the base decision).
    let applied;
    try {
        applied = applyEffect(winner.effect, bounds);
    }
    catch {
        applied = { applied: false, kind: "adjust_limit", target: "", reason: "invalid_effect" };
    }
    if (applied.applied) {
        return { decision: applied.value, firedRule: toRef(winner), consideredRules: peers, enforced: true };
    }
    // The highest-priority match's effect was refused (a bound breach) -> fail-closed: base stands, none fired.
    // The winner joins the considered-but-not-applied set (it matched but did not apply, FR-006/INV-7).
    return { decision: baseValue, firedRule: null, consideredRules: [toRef(winner), ...peers], enforced: false };
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
export async function evaluatePolicy(deps, input) {
    const { pool, repo, config } = deps;
    const mode = input.mode ?? "enforced";
    const decisions = {};
    const evaluations = [];
    const contextCaps = {
        maxBytes: config.contextMaxBytes,
        maxDepth: config.contextMaxDepth,
        maxFields: config.contextMaxFields,
    };
    const condOpts = {
        timeoutMs: config.evalTimeoutMs,
        maxBytes: config.conditionMaxBytes,
        maxDepth: config.conditionMaxDepth,
        maxComplexity: config.conditionMaxComplexity,
        now: input.decisionTimestamp,
    };
    if (input.entitlements.length > 0) {
        await withTenant(pool, input.tenantId, async (q) => {
            const bounds = await loadEntitlementBounds(q, input.entitlements);
            const toCandidate = (r) => ({
                id: r.id,
                ruleKey: r.ruleKey,
                version: r.version,
                priority: r.priority,
                condition: r.condition,
                effect: r.effect,
            });
            for (const ent of input.entitlements) {
                const boundRow = bounds.get(ent.key);
                if (!boundRow)
                    continue; // no matching entitlement row -> nothing to evaluate (base stands)
                // Live rules for this target entitlement, deterministic priority order. Fetch `cap + 1` so an OVER-CAP
                // rule set is DETECTABLE — the per-issuance cap fails CLOSED (below), it is NOT a silent LIMIT truncation.
                const perIssuanceCap = config.maxRulesPerIssuance;
                const live = await repo.selectLiveRulesForEntitlement(q, boundRow.id, perIssuanceCap + 1);
                // Split the live set into the ENFORCED (active) set and the report-only PREVIEW set. The two are decided
                // INDEPENDENTLY (FR-012, T043): the active set resolves the enforced decision the snapshot signs, while a
                // preview rule's would-be decision is LOGGED (mode=preview) but NEVER displaces the active decision.
                const active = live.filter((r) => r.status === "active");
                const preview = live.filter((r) => r.status === "preview");
                if (active.length === 0 && preview.length === 0)
                    continue; // no live rule -> base stands silently (no audit)
                const entBounds = {
                    ruleMax: boundRow.ruleMax,
                    ruleEligible: boundRow.ruleEligible,
                    ruleTiers: boundRow.ruleTiers,
                    absoluteMax: config.absoluteMaxLimit,
                };
                let context;
                try {
                    context = buildDecisionContext({
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
                    }, contextCaps);
                }
                catch {
                    // Fail-closed: an over-bound / over-deep context can never reach the evaluator -> base decision stands.
                    continue;
                }
                const inputHash = canonicalContextHash(context);
                const ctxRecord = context;
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
                    }
                    else {
                        const resolved = resolveEntitlementDecision(active.map(toCandidate), ctxRecord, entBounds, ent.value, condOpts);
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
                    }
                    else {
                        const previewResolved = resolveEntitlementDecision(preview.map(toCandidate), ctxRecord, entBounds, ent.value, condOpts);
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
    const writeAudit = async (q) => {
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
            }
            catch (e) {
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
async function loadEntitlementBounds(q, entitlements) {
    const keys = entitlements.map((e) => e.key);
    const r = await q("SELECT id, key, rule_max, rule_eligible, rule_tiers FROM entitlement WHERE key = ANY($1)", [keys]);
    const out = new Map();
    for (const row of r.rows) {
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
export function makeEvaluator(pool, config = loadPolicyConfig()) {
    const repo = new PolicyRuleRepo();
    return { evaluate: (input) => evaluatePolicy({ pool, repo, config }, input) };
}
