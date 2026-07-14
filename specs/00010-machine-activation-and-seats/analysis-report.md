# Analysis Report — E009 Machine Activation & Seat Enforcement

**Feature**: `00010-machine-activation-and-seats` | **Date**: 2026-07-13 | **Mode**: analyze + auto-remediate (apply all)

Cross-artifact consistency analysis across spec.md, plan.md, data-model.md, contracts/activation-api.openapi.yaml, tasks.md. No CRITICAL findings. Requirement→task coverage is 100% (24/24). The findings below trace to the three checklist evaluators appending FR-017..024 without matching success criteria and importing some plan-level detail into the product spec.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Coverage (SC) | HIGH | spec.md FR-017/018/020/021/022/023/024, FR-002 | Hardened FRs have no success criterion or acceptance scenario — largely untested as written | Add SC-013..SC-020 mapping each hardened FR to a measurable outcome |
| F2 | Spec purity | MEDIUM | spec.md FR-017/018/020/024 | Product spec leaks wire-level detail (403/`X-CSRF-Token`, `429`/`Retry-After`, `ON DELETE NO ACTION`, `LIC1`) | Acknowledged/skipped — detail is intentional hardening, cross-referenced in plan.md + contract; behavior is clear. Judgment call, left as-is |
| F3 | Testability | MEDIUM | spec.md FR-016 | "minimum required signals" not quantified | Quantify: the K-of-N threshold (K, default 3) is the floor |
| F4 | Consistency | MEDIUM | plan.md API Surface Summary | `/v1` rows omit 429/503, inconsistent with the plan's own Error Handling Strategy + contract | Add 429/503 to the two `/v1` rows |
| F5 | Underspecification | MEDIUM | spec.md FR-019 | Salt-rotation seat interaction unspecified (forced re-activation could re-consume seats) | Add a clause: rotation is rare/operational; superseded activations are reclaimed (or purged by retention) so seats are not permanently lost |
| F6 | Duplication | LOW | spec.md FR-013 vs FR-020; FR-009 vs FR-021; FR-006 vs FR-019 | Overlapping rate-limit / nonce / raw-identifier statements | FR-013 annotated as concretized by FR-020; FR-021/FR-019 already cross-reference FR-009/FR-006 |
| F7 | Traceability drift | LOW | data-model.md header + DDL comment; contract `info` | Stale "FR-001..016" scope headers after FR-017..024 added | Update to FR-001..024 |
| F8 | Traceability | LOW | tasks.md | Several hardened FRs (FR-002/004/008/013/017/019/020/021/022/023/024) lack a `[COMPLETES]` marker (convention only requires it for 3+ task FRs, but QC completeness benefits) | Add `[COMPLETES FR-###]` on each terminal task |

## Quality Summaries

- **Spec Quality** (Spec Validator): FAIL 21/25 — strong structure; the failure is the SC-coverage gap (F1) + implementation-detail leak (F2) + FR-016 quantification (F3). No `[NEEDS CLARIFICATION]` markers; every P1 story has ≥1 SC.
- **Compliance** (Policy Auditor on plan.md): **PASS** — no `project-instructions.md` MUST violation. Forced RLS, `activate`-scope + CSRF, offline-first + key-non-exposure, salted-hash PII minimization, ≥128-bit nonce + 429 rate-limit, append-only audit, race-safe `SELECT FOR UPDATE`, raw-SQL migration all satisfied. `@fastify/rate-limit` (in-memory) is a documented, acceptable deferral (Redis reserved for scale-out). Items PA-1/PA-2/PA-3 = F7/F4/F8.

## Coverage Summary (Requirement → Task)

All 24 FRs map to ≥1 task (100%). Requirements with 3+ tasks each carry a `[COMPLETES]` marker on their terminal task (FR-001→T018, FR-003/009→T017, FR-005/016→T026, FR-006/018→T038, FR-007→T018, FR-010/011→T023, FR-012→T030, FR-014→T037, FR-015→T031). No zero-coverage requirement. All `← T###:Symbol` edges (T010←T004, T026←T008, T033←T032, T034←T032) match their source `→ exports`. No gold-plating (SPA tasks legitimately carry `[US4]` delivery labels without `{FR}` per the spec SPA note).

## Metrics

- Total Requirements (FR): 24 · Total Tasks: 41 · Coverage: 100% · Critical Issues: 0 · High: 1 · Medium: 4 · Low: 3

## Remediation (auto-applied, autopilot)

F1, F3, F4, F5, F6, F7, F8 applied. F2 skipped (requires user judgment — spec-purity vs. intentional testable hardening; the wire detail is authoritative in plan.md + contract). See the Remediation Summary in the workflow output and `autopilot-log.md`.
