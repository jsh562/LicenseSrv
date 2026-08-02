# Analysis Report — E016 Usage Metering & Aggregation

**Feature**: `00017-usage-metering-and-aggregation` | **Date**: 2026-07-24 | **Mode**: analysis → auto-remediation ("apply all")
**Verdict**: PASS (conditional) — 0 CRITICAL, 4 HIGH, 5 MEDIUM, 8 LOW. All findings are consistency gaps the clarify + checklist amendments introduced; none block the MVP. Full requirement coverage verified (FR-001..021, each with exactly one `[COMPLETES]` task marker; every dependency edge resolves).

## Findings Table

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Consistency (contradiction) | HIGH | spec FR-013 vs FR-020 | FR-013 "operators never see negative usage" is absolute, but FR-020 lets an elevated admin (an operator) read the true signed net. | Scope FR-013 to **viewer-role** operators. |
| A2 | Ambiguity (two senses) | HIGH | spec FR-010/FR-011, Key Entities | "Reproducible" means both recompute-from-raw (in-window) and query-stable (post-prune); post-prune raw is gone. | Define recompute-reproducible (in-window) vs query-stable (durable, post-prune); E014 relies on query-stability. |
| A3 | Underspecification | HIGH | spec FR-004/FR-012/FR-015 | Retention window reference timestamp (event-time vs ingested-at) unspecified; a late event could re-open a partially-pruned bucket → under-count. | Use the event-timestamp acceptance bound for prune too; prune only once a bucket ages past the acceptance window. |
| A4 | Consistency (growth risk) | HIGH | spec SC-020 vs FR-015 / Risk | The distinct-set side table backing UNIQUE_COUNT must survive raw prune, reintroducing unbounded growth FR-015 exists to prevent. | Finalize UNIQUE_COUNT into the durable rollup on bucket close; prune the distinct-set working rows with the raw (bounded to the open window). |
| A5 | Abstraction leak | MEDIUM | spec SC-020 | Names the concrete `usage_unique_value` side table in a tech-agnostic SC. | Restate as an outcome (exact/reproducible after prune); mechanism stays in data-model/plan. |
| A6 | Consistency | MEDIUM | spec SC-008 vs FR-013 | SC-008 asserts reversal adjusts the aggregate unconditionally; FR-013 rejects reversal for UNIQUE_COUNT. | Scope SC-008 to SUM/COUNT. |
| A7 | Underspecification | MEDIUM | spec FR-008/FR-013 | COUNT normal-event quantity contribution undefined (quantity=5 → 1 or 5?). | State COUNT each event contributes its integer quantity (typically +1). |
| A8 | Ambiguity (precedence) | MEDIUM | spec FR-006 vs FR-021 | Overlapping license-state rejections (archived vs inactive) with no precedence. | Define a deterministic per-event refusal precedence. |
| A9 | Coverage | LOW | spec FR-014 vs SC-009 | Flag-clear-on-reversal has no SC. | Extend SC-009. |
| A10 | Coverage | LOW | spec FR-018 | Audit event-type coverage has no SC. | Add SC-021. |
| A11 | Precision | LOW | spec NEW-CONFIG / Clarifications | "~35 days" imprecise for a governing bound. | State "35 days (default, configurable)". |
| A12 | Stale (traceability) | MEDIUM | plan.md API Surface Summary (L95) | Per-event enum omits `license_inactive` while claiming to match the contract. | Add `license_inactive`. |
| A13 | Stale (gate) | LOW | plan.md Instructions Check (Principle II) | Names only 2 of 3 usage tables and omits FR-021. | Add `usage_unique_value` + FR-021 evidence. |
| A14 | Stale (banner) | LOW | data-model.md L4/L82 | Coverage banner FR-001..020 (spec is FR-001..021). | Bump to FR-001..021 / SC-001..020. |
| A15 | Stale (banner) | LOW | contracts/usage-api.openapi.yaml L13-14 | Coverage banner FR-001..020. | Bump to FR-001..021 / SC-001..020. |

## Quality Summaries
- **Spec Quality** (Spec Validator): PASS-WITH-NOTES, 8/10. 0 CRITICAL, 4 HIGH (A1–A4), 4 MEDIUM, 4 LOW. No `[NEEDS CLARIFICATION]`; every P1 story has ≥1 SC; STF-001 resolved.
- **Compliance** (Policy Auditor on plan.md): PASS-WITH-NOTES. No CRITICAL. All non-negotiables PASS. Notes = checklist-introduced staleness (A12–A15).

## Coverage Summary (requirement → task)
All FR-001..FR-021 covered; each has exactly one `[COMPLETES]` marker (21, 1:1) on 45 tasks. No zero-coverage requirement; every `← T###:Symbol` edge resolves to a matching `→ exports:`; no gold-plated tasks (setup/foundational/polish untagged as expected).

## Metrics
- Requirements: 21 FR + 21 SC (SC-021 added in remediation) · Tasks: 45 · Coverage: 100% (21/21) · CRITICAL: 0 · HIGH: 4 (all remediated).

## Next Actions
No CRITICAL/HIGH blocker survives remediation. Proceed to `/sddp-implement` after the auto-applied fixes.
