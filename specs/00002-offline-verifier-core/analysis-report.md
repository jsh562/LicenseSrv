# Cross-Artifact Analysis Report — 00002-offline-verifier-core

> Date: 2026-06-27 | Scope: spec.md ↔ plan.md ↔ tasks.md | Mode: analysis + remediation ("apply all")

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Underspecification | HIGH | spec TR-020, Clarifications | Maximum token/keyring/entitlement sizes are "defined" but no concrete values are given; TR-011 references a "stated keyring size" that is never stated. Untestable. | Pin concrete defaults (token ≤ 8 KiB, keyring ≤ 32 keys, entitlements ≤ 256); mark overridable. |
| A2 | Underspecification | HIGH | spec TR-011, SC-006, TR-019 | The `wasm32` p99 budget is referenced ("its own stated budget") but no number exists, so the regression gate (TR-019) cannot evaluate wasm. | State a concrete wasm32 p99 budget (≤ 25 ms p99). |
| A3 | Underspecification / latent break | HIGH | spec TR-014 | Salt scope is "recommended per-product," not a MUST, and issuer/host salt agreement is unspecified — if they differ, K-of-N (TR-006) silently fails for a legitimate machine. | Make salt scope a normative MUST (per-product, identical between issuer and host). |
| A4 | Consistency / latent bug | MEDIUM | spec TR-005 | Persisted anchor = max(stored, now, issued-at). A future-dated `issued-at` advances the anchor past real time → later legitimate verifies rejected as rollback (anchor poisoning / self-lockout). | Drop `issued-at` from the max (cap at current time); reject tokens with `issued-at` > now + skew. |
| A5 | Duplication | MEDIUM | spec TR-010 ↔ TR-020 | Bounded-cost / no-pathological-slow-path guarantee is asserted in both TR-010 and TR-020. | Keep the guarantee in TR-010; have TR-020 reference it. |
| A6 | Ambiguity | LOW | spec TR-011 | Baseline uses soft qualifiers ("~3 GHz", "post-2018 class"); not a pinned reference for full reproducibility. | Acceptable; tighten wording (single modern x86_64 core, release build) — design may pin a SKU later. |
| A7 | Completeness | LOW | spec TR-003 | TR-003 frames key outcomes as only unknown-key vs bad-signature; omits the third `key-not-valid` axis (TR-015/TR-017). | Note the third outcome for completeness. |
| A8 | Convention | LOW | tasks T029 | T029 (cross-cutting contract test) re-tags TR-005/006/007/017 after their `[COMPLETES]` tasks (T016/T019/T022/T025); strict reading wants COMPLETES on the last-tagged task. | Accept convention (COMPLETES marks implementation; T029 is validation) or move markers. No functional gap. |
| A9 | Ambiguity | LOW | spec TR-006 | "higher-value plans" is non-testable business narrative (core only enforces K). | Harmless; optional reword. |

## Quality Summaries

- **Spec Quality** (Spec Validator): **FAIL** pre-remediation — 3 HIGH underspecifications (A1–A3) gate readiness; no hard contradiction among the clarify/checklist amendments; 1 MEDIUM anchor-poisoning (A4), 1 MEDIUM duplication (A5). → After remediation (A1–A5 applied): expected **PASS**.
- **Compliance** (Policy Auditor): **PASS** — no MUST/SHOULD violations; Instructions Check correctly treats Principle II as N/A for a verify-only library; coverage map complete (TR-001…020); Architecture Decisions consistent with ADR-0001/0002 and the SAD.

## Coverage Summary (TR → Tasks)

All 20 requirements map to ≥1 task (from the structured task list). No zero-coverage requirement.

| Requirement Key | Has Task? | Task IDs |
|-----------------|-----------|----------|
| TR-001 | Yes | T007, T029 |
| TR-002 | Yes | T010, T029 |
| TR-003 | Yes | T011, T029 |
| TR-004 | Yes | T014, T029 |
| TR-005 | Yes | T015, T016, T029 |
| TR-006 | Yes | T017, T019, T029 |
| TR-007 | Yes | T021, T022, T029 |
| TR-008 | Yes | T023, T029 |
| TR-009 | Yes | T012 |
| TR-010 | Yes | T027, T028 |
| TR-011 | Yes | T031, T033 |
| TR-012 | Yes | T013 |
| TR-013 | Yes | T018, T029 |
| TR-014 | Yes | T020 |
| TR-015 | Yes | T009, T025 |
| TR-016 | Yes | T002, T008 |
| TR-017 | Yes | T024, T025, T029 |
| TR-018 | Yes | T006, T021 |
| TR-019 | Yes | T032 |
| TR-020 | Yes | T026, T030 |

## Instructions Alignment Issues

None. Plan PASS against project-instructions v1.1.0.

## Unmapped Tasks

T001, T003, T004, T005 (Setup) and T034, T035 (Polish/QC) carry no TR tag — expected for Setup/Polish phases, not gold-plating.

## Metrics

- Total requirements: 20 (TR-001…TR-020)
- Total tasks: 35
- Coverage: 100% (20/20)
- Critical issues: 0 | High: 3 | Medium: 2 | Low: 4

## Remediation (applied — "apply all")

A1–A5 applied to spec.md; A6/A7 reworded; A8/A9 noted (convention/non-blocking). See the remediation summary in the conversation. Concrete values chosen: max token 8 KiB, max keyring 32 keys, max entitlements 256; wasm32 budget ≤ 25 ms p99 — adjust if the design intends different limits.
