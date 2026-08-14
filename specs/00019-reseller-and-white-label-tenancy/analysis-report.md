# Analysis Report — E018 Reseller and White-label Tenancy

**Feature**: `00019-reseller-and-white-label-tenancy` | **Date**: 2026-08-12 | **Mode**: analysis → auto-remediation ("apply all")
**Verdict**: PASS — 0 CRITICAL, 1 HIGH, 4 MEDIUM, 4 LOW. Spec Validator PASS (internal consistency clean post-clarify/checklist); Policy Auditor PASS (Principles I–III + PII + migration ordering all clear). All findings are coverage/consistency polish, not blockers. All 17 FRs covered 1:1 by exactly one `[COMPLETES]` task (50 tasks); every dependency/import edge resolves.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Coverage gap | HIGH | spec FR-017 / US1 | The flagship privacy control (metadata-only) has NO acceptance scenario and NO SC — the Compliance PII row leans entirely on FR-017 yet nothing makes it testable. | Add `SC-013 [US1]` (reseller denied license/usage/activation data) + a US1 acceptance scenario. |
| A2 | Duplication | MEDIUM | spec FR-001 vs FR-010 | FR-010 restates create-or-promote (FR-001) + quota (FR-003), adding only "first reseller-admin". | Narrow FR-010 to the net-new element (establishing the first reseller-admin) and cross-ref FR-001/FR-003. |
| A3 | Coverage gap | MEDIUM | spec FR-015 | The operator move's branding effect (preserve overrides, re-resolve locks to destination, dual-side branding-context audit) has no SC (SC-010 covers only offboarding). | Add `SC-014 [US4]` for the move branding/lock re-resolution + dual audit. |
| A4 | Cross-artifact (data) | MEDIUM | data-model/migration `reseller` vs contract `OffboardResult.graceEndsAt` | The contract returns/refreshes `graceEndsAt` but `reseller` has no stable offboarding-start timestamp; deriving from mutable `updated_at` is fragile. | Add expand-only `offboarding_started_at timestamptz NULL` to `reseller` in `0014`; `graceEndsAt = offboarding_started_at + grace_window`. |
| A5 | Coverage gap (task) | MEDIUM | tasks.md vs contract `updateResellerQuota`/`listResellers`/`getReseller` | The operator-only quota-change (the FR-003 operator enforcement point) + operator reseller list/get have no dedicated task. | Add operator-plane tasks for `PATCH /quota` (operator-only, CSRF, audited) + list/get reads. |
| A6 | Coverage gap | LOW | spec SC-007 | The truly-unset/empty tenant scope (no GUC → 0 rows) is asserted only in Edge Cases; SC-007 covers only the outside-subtree case. | Extend SC-007 to include unset/empty scope → zero rows (fail-closed). |
| A7 | Coverage gap | LOW | spec FR-016 | Last-owner protection has no SC (Edge Case only). | Add `SC-015 [US4]` (or tag as inherited E005 regression control). |
| A8 | Consistency | LOW | spec FR-013 / Key Entities vs data-model/contract | Spec presents verification binary (verified/unverified); the data-model + contract use a three-state `pending → verified → active` lifecycle. | Note the pending/active states in FR-013/Key Entities to align with the artifacts. |
| A9 | Cross-artifact (doc) | LOW | plan Project Structure vs tasks T001/T048/T049 | `vitest.config.ts` and `.github/workflows/reseller.yml` are task-edited but absent from the plan's Project Structure. | Add a Build/CI line to the plan's Project Structure. |

## Quality Summaries
- **Spec Quality** (Spec Validator): PASS, 5/6 dimensions clean. Zero `[NEEDS CLARIFICATION]`; all six clarify/checklist amendments verified consistent across Scope/Stories/FR/SC/Edge-Cases/Glossary. Sole material gap = A1 (FR-017 coverage).
- **Compliance** (Policy Auditor on plan.md + cross-check): PASS. No CRITICAL/principle violation. Principle I (no crypto/token surface), Principle II (RLS predicate unchanged, scoped-descent, 404-no-disclosure, CSRF, dual-identity audit), Principle III (append-only, trust signals non-white-label), PII (metadata-only, public DNS token), migration ordering all confirmed. Isolation tests present (T009/T014/T016/T029).

## Coverage Summary (requirement → task)
All FR-001..FR-017 covered; each has exactly one `[COMPLETES]` marker (17, 1:1) on 50 tasks. Completers: FR-001→T037, FR-002→T017, FR-003→T019, FR-004→T018, FR-005→T031, FR-006→T027, FR-007→T025, FR-008→T026, FR-009→T032, FR-010→T038, FR-011→T039, FR-012→T040, FR-013→T046, FR-014→T028, FR-015→T041, FR-016→T042, FR-017→T020. No zero-coverage requirement; every `← T###:Symbol` edge resolves. A5 adds operator quota/read tasks (supporting FR-003, not a new completer).

## Metrics
- Requirements: 17 FR + (12→15 SC after remediation) · Tasks: 50 (+ A5 additions) · Coverage: 100% (17/17) · CRITICAL: 0 · HIGH: 1 (remediated).

## Next Actions
No CRITICAL/HIGH blocker survives remediation. Proceed to `/sddp-implement` (or `/sddp-implement-qc-loop`).
