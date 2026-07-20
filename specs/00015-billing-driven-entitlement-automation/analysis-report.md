# Analysis Report — E014 Billing-driven Entitlement Automation

**Feature**: `00015-billing-driven-entitlement-automation` | **Date**: 2026-07-19 | **Mode**: analyze + apply-all
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/billing-api.openapi.yaml (+ research, 3 checklists)
**Verdict**: **PASS after remediation** — 0 CRITICAL. The Spec Validator FAIL is driven by missing SC coverage for the checklist-strengthened security FRs + a few consistency lags; all MEDIUM/LOW and fixed below. Requirement→task coverage is complete (22/22).

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Underspecification | MEDIUM | spec FR-013/014/018/019/021/022 | The strengthened/security FRs have no dedicated SC | Add SC-011 (FR-014), SC-012 (FR-018), SC-013 (FR-019), SC-014 (FR-022), SC-015 (FR-021); reword SC-008 to cover FR-013 |
| F2 | Consistency | MEDIUM | spec SC-008 vs FR-013 | SC-008 says "triggering provider event id" but FR-013 now covers worker mutations with no event id (synthetic actor) | Reword SC-008: attributable to a provider event id OR a synthetic system source |
| F3 | Consistency | MEDIUM | spec FR-015 vs FR-022 | Dual-ownership: both state "secret never returned" + rotation window | Narrow FR-015 to the config capability; delegate secret custody/rotation to FR-022 by reference |
| F4 | Ambiguity | MEDIUM | spec FR-005/009/011/019/020 | Unquantified: "sane defaults", "acks fast" (no ack-latency target); FR-005 issue-vs-activate rule; FR-009 "where recovery is allowed" undefined | Quantify ack-latency (<200ms); state issue-vs-activate rule; drop the FR-009 qualifier (only revoked is terminal → recovery always allowed from suspended) |
| F5 | Consistency | MEDIUM | plan FR-019 refs + contract | Amended FR-019 requires per-connection AND per-source-IP (pre-resolution flood guard); plan/contract say per-connection only (data-model §11 inv.8 has per-IP) | Update plan FR-019 refs + contract webhook description to dual-granularity |
| F6 | Consistency (marker) | MEDIUM | tasks.md T025 / coverage table | FR-005 has no `[COMPLETES]` inline marker (coverage table says T025 completes it, but T025 has `[COMPLETES FR-012]` only) | Add `[COMPLETES FR-005]` to T025 |
| F7 | Consistency | LOW | spec Compliance Check | Stale — doesn't cite FR-022; FR-013 line only provider-event-id framing | Add FR-022 + FR-013 synthetic-actor to the Compliance Check |
| F8 | Coverage | LOW | spec SC-001, SC-002 | SC-001 omits FR-002 future-skew reject; SC-002 omits FR-003 concurrent-race | Extend SC-001 (future-skew) + SC-002 (concurrent redelivery) |
| F9 | Duplication | LOW | spec FR-021 vs FR-018 | FR-021 restates the no-card-data clause | FR-021 reference FR-018's boundary; keep FR-021 on retention/GDPR |
| F10 | Traceability | LOW | plan FR-013 coverage; data-model FR-range | Plan FR-013 maps only to lifecycle.ts (synthetic-actor path not surfaced); data-model header comments say FR-001..FR-021 (stale) | Add plan FR-013 note (grace-worker/reconcile-worker); update data-model range to FR-022 |
| S1 | Content (spec) | SKIP | spec FR-002/003/019/022 | Product-spec mechanism leakage (projection name, "committed transactionally", 429/Retry-After header format) | WON'T-FIX heavy strip — deliberately added for testability, traceable to data-model/contract; the validator deems the security properties defensible; a light touch only |

## Quality Summaries
- **Spec Quality (Spec Validator)**: FAIL→remediated. 21/25; 0 CRITICAL/HIGH. All structural + consistency gates pass (IDs contiguous FR-001..022, every SC→[US#], every P1 story has an SC, payment/card boundary consistent, grace-overlay coherent). Root cause: the checklist-strengthened security FRs lack SCs.
- **Compliance (Policy Auditor)**: PASS — no MUST violations. Principles I/II/III, payment/card boundary, migration discipline, RLS, no-new-key-custody, ADR-0011 traceability all satisfied. 1 MEDIUM (F5 per-IP propagation) + 2 LOW.

## Coverage Summary
All 22 FRs have ≥1 tagged task; the single completion-marker gap is FR-005 (F6). The 5 cross-task `←`/`→` imports all resolve. Tasks-table drift limited to the FR-005 row (F6).

## Metrics
- Requirements: 22 FR · Success criteria: 10 → 15 (post-remediation) · Tasks: 51
- Coverage: 100% (22/22 FR tagged) · CRITICAL: 0 · HIGH: 0 · MEDIUM: 6 · LOW: 4 · Skip: 1

## Remediation (apply-all)
F1–F4, F7–F9 → spec.md (5 new SCs, SC-008/001/002 reword, FR-015 narrow, FR-005/009/011/019 clarity, FR-021 ref, Compliance Check); F5 → plan.md + contract (dual-granularity rate-limit); F6 → tasks.md (FR-005 marker); F10 → plan.md + data-model.md. S1 skipped (documented).
