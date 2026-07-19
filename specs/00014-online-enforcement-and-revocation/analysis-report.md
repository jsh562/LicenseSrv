# Analysis Report — E013 Online Enforcement and Revocation

**Feature**: `00014-online-enforcement-and-revocation` | **Date**: 2026-07-18 | **Mode**: analyze + apply-all
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/online-enforcement-api.openapi.yaml (+ research, 3 checklists)
**Verdict**: **PASS after remediation** — 0 CRITICAL. The Spec Validator FAIL is driven by verification-coverage gaps for the checklist-added FRs (FR-021/022/023) + FR-018/019, and a dual-meaning term; all are MEDIUM/LOW and fixed below. Requirement→task coverage is complete (23/23).

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Underspecification | HIGH | spec FR-023, US4 | Untrusted-signature CRL (forged/tampered) rejection has NO acceptance scenario + NO SC — security-critical, unverifiable | Add a US4 scenario + SC-011 |
| F2 | Underspecification | MEDIUM | spec FR-022, US4 | Client anti-downgrade (reject older signed version) uncovered by SC/scenario | Add SC-012 (+ US4 scenario) |
| F3 | Underspecification | MEDIUM | spec FR-021 | Rate-limiting uncovered by SC; threshold unquantified | Add SC-013 |
| F4 | Underspecification | MEDIUM | spec FR-018, FR-019 | Tenant-scoping + append-only audit have no SC (pre-existing) | Add SC-014 (cross-tenant refused) + SC-015 (flagged audit) |
| F5 | Ambiguity | MEDIUM | spec Glossary/FR-005/FR-013/SC-004/SC-006 | "Bounded staleness" carries two values (≤TTL connected vs max(TTL,next_update)+tolerance worst-case) — a tester can't tell which an SC verifies | Split the term: "propagation delay (connected) ≤ TTL" vs "worst-case bounded staleness = max(…)+tolerance" |
| F6 | Ambiguity | MEDIUM | spec FR-002/007/011/015 | Three offline-runtime bounds (token exp fail-closed, heartbeat grace, offline-tolerance) with no precedence; FR-011 "expiry fail-closed" vs FR-015 "run without fresh anchor" | Add a clause: token `exp` is the hard fail-closed bound; grace + offline-tolerance are ≤ TTL |
| F7 | Ambiguity | MEDIUM | spec FR-020/SC-008 | "nominal load" undefined → SC-008 not reproducible | Define a load profile (rps/concurrency) |
| F8 | Clarity | LOW | spec FR-022/FR-023 | "a client MUST…" vs FR-011 "MAY" — a client that never fetches CRLs trivially satisfies them | Scope as "a client that consults CRLs MUST…" |
| F9 | Clarity | LOW | spec FR-011 | "valid CRL" now spans signature (FR-023) + version (FR-022) | Define "valid CRL" = signature-verified AND version ≥ highest cached |
| F10 | Consistency | MEDIUM | spec Compliance Check | "Advisories resolved" + Offline-first bullet stale — FR-022/023 absent | Add FR-022/023 to Principle III + reconcile the FR-011 fail-open clause with FR-023 |
| F11 | Consistency | LOW | spec US2 AS3 | Two Given/When/Then pairs merged into one scenario | Split into two scenarios |
| F12 | Consistency (table) | MEDIUM | tasks.md §Requirement Coverage | Rollup table ≠ inline tags: FR-003 over-lists T013, FR-007 over-lists T003, FR-014 omits T004 | Fix the three rows to match inline `{FR-###}` tags |
| F13 | Compliance (SHOULD) | ADVISORY | contract RevocationList / CRL FALLBACK | Client FR-022/023 rules not stated in the contract (mapped to "contracts + docs") | Add a 3-client-outcome note (fetch-fail→fail-open / older-version→ignore / bad-sig→untrusted) |
| S1..S4 | Style/dup | LOW | spec FR-004/005/017, FR-002/014, S1 leakage, A4 defaults | Near-duplicate wording + minor leakage + unquantified config defaults | SKIP — correct traceability / complementary gate-vs-content / config defaults belong in Plan (documented) |

## Quality Summaries
- **Spec Quality (Spec Validator)**: FAIL→remediated. 22/25; 0 CRITICAL/structural, no ID defects. Root cause: FR-021/022/023 (+ FR-018/019) added without SCs. FR-022/023↔FR-011 disambiguation itself is well done.
- **Compliance (Policy Auditor)**: PASS — no MUST violations. Principles I/II/III, migration discipline, RLS, no-key-material, rate-limit, air-gap, coverage gate, module placement all satisfied. 1 SHOULD advisory (F13).

## Coverage Summary
All 23 FRs have ≥1 tagged task; all 18 `[COMPLETES]` sit on the last carrier; the single `←T006` import matches `→exports`. No zero-coverage requirement. tasks.md rollup-table drift (F12) is a documentation mismatch, not a coverage gap.

## Metrics
- Requirements: 23 FR · Success criteria: 10 → 15 (post-remediation) · Tasks: 47
- Coverage: 100% (23/23 FR tagged) · CRITICAL: 0 · HIGH: 1 · MEDIUM: 7 · LOW: 4 · Advisory: 1

## Remediation (apply-all)
F1–F11 → spec.md (5 new SCs, term split, offline-bounds clause, nominal-load, CRL-client scoping, Compliance Check, US2 split); F12 → tasks.md coverage table; F13 → contract note. S1–S4 skipped (documented judgment).
