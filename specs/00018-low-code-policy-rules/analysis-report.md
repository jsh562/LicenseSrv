# Analysis Report — E017 Low-Code Policy Rules (pass 2)

**Feature**: `00018-low-code-policy-rules` | **Date**: 2026-08-11 | **Mode**: analysis → auto-remediation ("apply all")
**Verdict**: PASS (conditional) — 0 CRITICAL, 2 HIGH, 6 MEDIUM, 3 LOW. All findings are consistency drift the checklist pass (FR-019/020/021 + a retention worker + `considered_rules`) introduced against the spec's NEW-WORKER signal, FR-020's bounds reference, and the plan's Data-Model-Summary/Structure. Coverage verified: all FR-001..021 covered by exactly one `[COMPLETES]` task marker (55 tasks); every dependency edge resolves. (Note: the plan Requirement Coverage Map is NOT stale — it already carries FR-019/020/021 and the new codes.)

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Consistency (contradiction) | HIGH | spec Impl Signals `NEW-WORKER` vs FR-014 | NEW-WORKER still says "none required"; FR-014 + tasks (T048) + data-model add a `policy_evaluation` retention-prune worker. | Declare the retention-prune worker in NEW-WORKER (fail-open, owner-role, config window). |
| A2 | Underspecification (dangling ref) | HIGH | spec FR-020/SC-018 vs FR-004/FR-009 | FR-020 references "the SAME size/AST-depth/field-count bounds as the real context", but FR-009's caps are on the CONDITION and FR-004 is a field allow-list — the context caps don't exist. | Add explicit decision-context size/JSON-depth/field-count caps to NEW-CONFIG + FR-004; FR-020/SC-018 reference those. |
| A3 | Coverage gap | MEDIUM | spec FR-014 (no SC) | The retention-window clause has no success criterion. | Add SC-021 (rows older than the window pruned; within-window retained). |
| A4 | Underspecification | MEDIUM | spec FR-006 vs FR-012 | Preview-vs-active interaction under highest-priority-wins is unspecified (does a preview rule participate in the active priority ordering?). | State preview rules are decided independently of the enforced active set; the logged would-be decision is the effect the preview rule would apply if it were the winning active rule. |
| A5 | Ambiguity | MEDIUM | spec FR-019 | Cap scoping self-conflicting (per-entitlement vs per-tenant vs both) + relationship to the per-issuance evaluated-rule cap unstated. | Name three distinct caps: per-entitlement set cap, per-tenant set cap, per-issuance evaluated-rule cap. |
| A6 | Ambiguity | MEDIUM | spec FR-019 vs FR-010 | Per-decision-cap fail-closed blast radius (whole issuance vs affected entitlement) unstated. | Fail-closed is per-entitlement (consistent with FR-010), not whole issuance. |
| A7 | Consistency | MEDIUM | spec Key Entities `policy_evaluation` | Omits the considered-but-not-applied field mandated by FR-006/FR-014/SC-009. | Add the considered-but-not-applied attribute to the Key Entity. |
| A8 | Coverage | LOW | spec FR-003 (select-tier no SC) | No SC verifies a select-tier outcome. | Extend an SC to assert select-tier resolves to a plan-defined tier / refuses an undefined tier. |
| A9 | Consistency | LOW | spec FR-014/SC-009 vs FR-005 | "input snapshot or hash" (either/or) vs FR-005's mandatory `input_hash`. | Align to "input_hash (plus optional snapshot)". |
| A10 | Doc drift | MEDIUM | plan Data Model Summary (`policy_evaluation`) | Omits the `considered_rules` column. | Add it. |
| A11 | Doc drift | MEDIUM | plan Project Structure + config.ts bullet | Omits `retention-worker.ts` + `main.ts` prune start + the retention-window config key. | Add them (aligns with A1). |
| A12 | Doc drift | LOW | plan context.ts bullet / Data Model Summary / determinism+testing rows | Canonical input-hash (INV-12) not reflected. | Note the canonical-hash responsibility. |

## Quality Summaries
- **Spec Quality** (Spec Validator): PASS-WITH-FIXES, ~11/13. 0 CRITICAL, 2 HIGH (A1/A2), 5 MEDIUM, 3 LOW. No `[NEEDS CLARIFICATION]`; every P1 story has ≥1 SC.
- **Compliance** (Policy Auditor on plan.md): PASS-WITH-NOTES. **No CRITICAL; Principle I structurally cleared and consistent across all four artifacts.** The Coverage Map + new error codes are already present (not stale). Drift = plan Data-Model-Summary/Structure lag (A10–A12) + the spec NEW-WORKER contradiction (A1).

## Coverage Summary (requirement → task)
All FR-001..FR-021 covered; each has exactly one `[COMPLETES]` marker (21, 1:1) on 55 tasks. FR-019's completer is T026 (author-time cap) with the eval-side cap in T035; FR-014's completer is T048 (retention worker). No zero-coverage requirement; every `← T###:Symbol` edge resolves; no gold-plated tasks.

## Metrics
- Requirements: 21 FR + 21 SC (SC-021 added in remediation) · Tasks: 55 · Coverage: 100% (21/21) · CRITICAL: 0 · HIGH: 2 (all remediated).

## Next Actions
No CRITICAL/HIGH blocker survives remediation. Proceed to `/sddp-implement`.
