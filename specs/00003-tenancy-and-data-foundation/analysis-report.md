# Cross-Artifact Analysis Report — 00003-tenancy-and-data-foundation

> Date: 2026-06-27 | Scope: spec.md ↔ plan.md ↔ data-model.md ↔ tasks.md | Mode: analysis + remediation ("apply all")

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Underspecification | HIGH | spec TR-010, SC-011 | Module-boundary "enforcement" is asserted but no mechanism is named, so SC-011 ("blocks a cross-module import") is not independently verifiable. | Name the enforcer (build-failing dependency-boundary lint rule). |
| A2 | Underspecification / contradiction | HIGH | spec TR-016, TR-009, SC-007 | TR-016 ANDs over an API-key "scope" that no requirement defines, and SC-007 covers only role-denial — contradicting the Clarifications claim that SC-007 covers "denial by either." | Define API-key capability scopes in TR-009; extend SC-007 to the scope-deny path. |
| A3 | Ambiguity | HIGH | spec TR-011 | "alertable" is undefined/unmeasurable (no channel/threshold). | Ground it: audited + audit stream exportable for downstream alerting. |
| A4 | Consistency | MEDIUM | spec TR-013 ↔ TR-016 | TR-013 "role MUST determine which operations" overstates after TR-016 makes role one of two gates. | Reword TR-013 to "necessary gate." |
| A5 | Ambiguity | MEDIUM | spec TR-012, SC-008 | "minimized" is a non-testable GDPR principle. | Make concrete: store only the hash, no plaintext lookup identifier retained. |
| A6 | Duplication | LOW | spec Technical Constraints ↔ TR-014 | Postgres patch rule stated three times. | Cross-reference TR-014 from the constraint; drop the floating "current." |
| A7 | Consistency | LOW | spec Technical Constraints | Coverage constraint reads bare "≥80%"; the lines+branches detail lives only in Clarifications. | Fold "lines AND branches ≥80%" into the constraint. |
| A8 | Consistency | LOW | spec Assumptions ↔ TR-014 | Assumptions say "PostgreSQL 16"; TR-014 mandates 16.4+. | Tighten the assumption to 16.4+. |

## Quality Summaries

- **Spec Quality** (Spec Validator): **FAIL** pre-remediation — 3 HIGH (A1–A3) block readiness; 2 MEDIUM (A4–A5); 3 LOW. Most stem from the checklist-hardening amendments (TR-016) and pre-existing soft language (TR-010/011/012). → After remediation (A1–A8 applied): expected **PASS**.
- **Compliance** (Policy Auditor): **PASS** — no MUST/SHOULD violations; Principles II/III satisfied; Requirement Coverage Map covers TR-001…016 including TR-014/015/016; SC→TR→tier map present; ADRs/SAD consistent.

## Coverage Summary (TR → Tasks)

All 16 requirements map to ≥1 task (from the tasks WBS). No zero-coverage requirement.

| Requirement | Tasks | Requirement | Tasks |
|---|---|---|---|
| TR-001 | T016,T017,T019,T020 | TR-009 | T033,T038 |
| TR-002 | T006,T011,T012,T014,T019,T022 | TR-010 | T036,T037 |
| TR-003 | T009,T016,T021 | TR-011 | T035 |
| TR-004 | T013,T018 | TR-012 | T032,T040,T041 |
| TR-005 | T010,T012,T024 | TR-013 | T034,T039 |
| TR-006 | T023,T028 | TR-014 | T009,T029 |
| TR-007 | T015,T025,T027 | TR-015 | T015,T026 |
| TR-008 | T030,T031 | TR-016 | T034,T039 |

## Instructions Alignment Issues

None. Plan PASS against project-instructions v1.1.0.

## Unmapped Tasks

Phase 1 setup (T001–T008) and Phase 6 CI/gate tasks (T043–T045) carry no TR tag — expected for Setup/Polish phases.

## Metrics

- Total requirements: 16 (TR-001…TR-016)
- Total tasks: 45
- Coverage: 100% (16/16)
- Critical issues: 0 | High: 3 | Medium: 2 | Low: 3

## Remediation (applied — "apply all")

A1–A8 applied to spec.md (TR-009/010/011/012/013/016, SC-007/008/011, Technical Constraints, Assumptions). See the remediation summary in the conversation.
