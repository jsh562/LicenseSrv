# Analysis Report — E010 Air-Gapped Activation

**Feature**: `00011-air-gapped-activation` | **Date**: 2026-07-16 | **Mode**: analyze + auto-remediate (apply all)

Cross-artifact analysis across spec.md (FR-001..028), plan.md, contracts/airgap-api.openapi.yaml, tasks.md
(22 tasks). No CRITICAL. **Requirement→task coverage is 100% (28/28), every FR has a `[COMPLETES]`, and all
`← T###:Symbol` edges match their `→ exports`.** The findings are plan↔spec drift from the checklist pass that
appended FR-016..028 (tasks.md was synced; the plan and the spec's SC set were not).

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Coverage (plan) | HIGH | plan.md Requirement Coverage Map | Map stops at FR-015; FR-016..028 unmapped | Extend the map with FR-016..028 (per tasks.md) |
| F2 | Coverage (SC) | HIGH | spec.md SC-001..012 | FR-016/017/019/022/023/024/025/027 have no success criterion | Add SC-013..020; extend SC-007 to name oversize |
| F3 | Spec purity | HIGH | spec.md FR-016..028 | Product FRs leaked plan/code detail — worst: FR-026 cites "plan AD-008"; FR-028 names the `activate()` function; FR-020 "604800 seconds" | Strip the AD-ID ref + function name + second-precision; broader wire detail accepted (authoritative in plan/contract, keeps FRs testable) |
| F4 | Consistency (plan) | MEDIUM | plan.md Error Handling + API Surface | FR-019 oversize guard not named (only generic `validation_error`) | Add the pre-decode oversize guard to the Error Handling row |
| F5 | Consistency (plan) | MEDIUM | plan.md AD-005 vs AD-007 | Freshness-reject (AD-005) vs idempotent-replay (AD-007/FR-005) unreconciled — a same-file re-submit after the window reads as `stale_request` | Add FR-021's reconciliation: freshness gates first-sight only; the nonce store owns replay past the window |
| F6 | Consistency (plan) | MEDIUM | plan.md AD table / Coverage Map | FR-022/024/025 absent from the plan body | Covered by the Coverage-Map extension (F1) + an AD-007 note on drift re-match + cross-transport nonce |
| F7 | Testability | MEDIUM | spec.md FR-018, FR-026 | Read as rationale prose more than testable assertions | Light reword to assertions (partly via F3) |
| F8 | Duplication | LOW | spec.md FR-005/021/024/018 (nonce); FR-028 re-enumeration; FR-008/020 (freshness) | Overlapping restatements | ACCEPTED — the FR IDs are referenced by tasks T003–T019; merging would break the coverage map + violate the ID-preservation convention. Redundant but non-contradictory (reconciliation logic is correct). |

## Quality Summaries

- **Spec Quality** (Spec Validator): FAIL 20/24 — structure sound; the failure is implementation-detail leakage
  (F3) + missing SCs for the hardened FRs (F2). No `[NEEDS CLARIFICATION]`; every P1 story has ≥1 SC.
- **Compliance** (Policy Auditor on plan.md): FAIL on completeness (not on any Core Principle) — the four
  principles (offline-first, key-non-exposure, single-core, tenant isolation, audit, PII, no-ORM) are all
  honored; the FAIL is the unmapped FR-016..028 (F1), the missing oversize guard (F4), and the AD-005/007
  tension (F5). All are remediated below.

## Coverage Summary (Requirement → Task)

All 28 FRs map to ≥1 task (100%); each carries a `[COMPLETES]` on its terminal task. FR-015 is `[DEFERRED]`
(P2, US4). No zero-coverage requirement; no gold-plating; all cross-phase dependency edges (T005←T001,
T006←T005, T012←T004, T015←T005) match their producer's `→ exports`.

## Metrics

- Total Requirements (FR): 28 · Total Tasks: 22 · Coverage: 100% · Critical: 0 · High: 3 · Medium: 4 · Low: 1

## Remediation (auto-applied, autopilot)

F1, F2, F4, F5, F6, and the F3/F7 targeted edits applied to plan.md + spec.md. F8 accepted (documented) — the
task-referenced FR IDs must be preserved, so the non-contradictory duplication is not merged.
