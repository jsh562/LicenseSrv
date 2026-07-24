# Analysis Report — E015 Floating & Concurrent Seats

**Feature**: `00016-floating-and-concurrent-seats` | **Date**: 2026-07-24 | **Mode**: analysis → auto-remediation ("apply all")
**Verdict**: PASS (conditional) — 0 CRITICAL, 1 HIGH, 8 MEDIUM, 6 LOW. All findings are cross-artifact consistency drift from the checklist-phase amendments (FR-026 + tightened FRs); none block the MVP. Full requirement coverage verified.

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Consistency (normative conflict) | HIGH | spec FR-022, SC-018 vs Edge Case "Early release/reclaim vs handle" | Handle-TTL bound stated two ways: FR-022/SC-018 bound handle validity by the **lease TTL** (~30 min); the edge case + its security guarantee bound it by the **heartbeat interval** (~10 min). An FR-022-compliant build (handle TTL = lease TTL) legally breaks the edge-case guarantee and weakens force-release. | Bind handle TTL ≤ heartbeat interval in FR-022 + SC-018 to match the security claim. |
| A2 | Consistency (naming) | MEDIUM | spec FR-003/SC-002 (`concurrency_overage`) vs FR-012/Scope/Clarifications ("overage allowance") vs Key Entities ("soft-cap allowance") | One overage field carries three names. | Standardize to `concurrency_overage` / "overage allowance" consistently. |
| A3 | Ambiguity | MEDIUM | spec FR-020 | "a salted hash **or opaque session identifier**" conflicts with FR-001/FR-026 (all scopes salted+hashed). | Drop the "or opaque session identifier" alternative. |
| A4 | Underspecification (dangling ref) | MEDIUM | spec FR-003 | Cites `INV-1`, which is never defined/labeled in the spec (it is a data-model label). | Point FR-003 at the Key Entities Lease invariant. |
| A5 | Coverage (untestable req) | MEDIUM | spec FR-026 (no SC) | Salt provenance/rotation semantics have no success criterion. | Add SC-023 (salt server-held/never-distributed; rotation leaves live leases intact). |
| A6 | Consistency | MEDIUM | spec FR-001 vs FR-022 | FR-001 returns "a signed lease handle" unconditionally; FR-022 makes it default-on/optional. | Soften FR-001 to "(default; plain-authorization opt-out per FR-022)". |
| A7 | Governance drift (traceability) | MEDIUM | plan.md Coverage Map (ends FR-025), config.ts descriptor, Instructions Check PII row | FR-026 not referenced anywhere in plan.md. | Add FR-026 coverage row + salt to config.ts descriptor + cite FR-026 in PII row. |
| A8 | Governance drift (traceability) | MEDIUM | data-model.md header (FR-001..025), INV-8, DDL | Header FR range stale; FR-026 salt storage/rotation mechanism unspecified. | Update header/INV-8 to FR-026; note per-tenant salt storage + rotation (mirror E009). |
| A9 | Consistency (spec↔plan) | LOW | spec FR-008/FR-019 vs plan/contract | Release-route idempotent-200 carve-out (unknown/cross-tenant) documented in plan/contract but not spec. | Add a one-line carve-out note to FR-008/FR-019. |
| A10 | Redundancy | LOW | spec SC-009 vs SC-003 | SC-009's hard-cap clause duplicates SC-003. | Narrow SC-009 to soft-cap metering; cross-ref SC-003. |
| A11 | Underspecification | LOW | spec FR-015/SC-010 | "recently-ended leases" display window unquantified. | Bind to a bounded display window (default 24h). |
| A12 | Consistency | LOW | spec SC-009/FR-018 vs plan/contract | "beyond-allowance" refusal reason not tied to the single `seat_capacity_exhausted` code. | State beyond-allowance reuses `seat_capacity_exhausted` (details discriminator). |
| A13 | Coverage | LOW | spec FR-023/SC-016 | `user` scope has no SC (SC-016 covers session/machine only). | Extend SC-016 to include user scope. |
| A14 | Coverage (already met) | LOW | spec FR-009/FR-021/FR-018 | TTL-invariant, no-hard-delete, audit-denial-enumeration have no dedicated SC. | No spec change — already verified by tasks T007 (config unit), T014 (migration IT), T038 (audit IT). |

## Quality Summaries

- **Spec Quality** (Spec Validator): PASS (conditional). 0 CRITICAL, 1 HIGH (A1), 6 MEDIUM, 8 LOW. No unresolved `[NEEDS CLARIFICATION]`; every P1 story (US1–US3) has ≥1 SC; STF-001 resolved.
- **Compliance** (Policy Auditor on plan.md): PASS-WITH-NOTES. **No CRITICAL project-instructions violation.** All non-negotiables (Principle I/II/III, PII minimization, anti-replay+rate-limit, migration ordering, race-safe accounting) PASS. Notes F1/F2 (FR-026 drift into plan/data-model) + F3 (release carve-out) = A7/A8/A9.

## Coverage Summary (requirement → task)

All FR-001..FR-026 covered; each has exactly one `[COMPLETES]` marker (on 22 distinct tasks). No zero-coverage requirement. Sample: FR-003/004/014/025→T019, FR-005/006/023→T018, FR-007/011/022→T023, FR-009→T013, FR-010→T029, FR-012/013→T031, FR-021→T014, FR-024→T028, FR-026→T011. FR-002 completed by T025 (T020 references but completes FR-001). Every `← T###:Symbol` edge resolves to a matching `→ exports:` (registerLease/deriveHolderKey/LeaseRepo/reclaimSweep/signLeaseHandle). No unmapped/gold-plated tasks (setup/foundational/polish untagged as expected).

## Metrics

- Total Requirements: 26 FR + 23 SC (SC-023 added in remediation) · Total Tasks: 43 · Requirement Coverage: 100% (26/26 with COMPLETES) · CRITICAL issues: 0 · HIGH: 1 (A1, remediated).

## Next Actions

No CRITICAL/HIGH blocker survives remediation. Proceed to `/sddp-implement` after the auto-applied fixes below.
