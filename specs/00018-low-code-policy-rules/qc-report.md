# QC Report — E017 Low-Code Policy Rules

**Feature**: `00018-low-code-policy-rules` | **Date**: 2026-08-12 | **Iteration**: 2 | **Run**: scoped re-run (prior failures)
**Overall Verdict**: **PASS** — both iteration-1 failures remediated and re-verified with observed-green evidence.

## Changes from Prior Run
| Metric | Iteration 1 | Iteration 2 | Delta |
|--------|-------------|-------------|-------|
| Security (`npm audit --omit=dev --audit-level=high`) | FAIL (1 HIGH `fast-uri`) | **PASS (0 vulnerabilities)** | ✓ fixed |
| SC-015 / FR-003 (`select_tier` at issuance) | PARTIAL (string dropped from token) | **PASSED (numeric tier embedded + audit-matched)** | ✓ fixed |
| Tests (full server suite) | 949 passed / 3 skipped | (scoped) policy 162 + issuance/catalog 41 + affected 46 green | no regression |
| Policy coverage (line/branch) | 91.55 / 80.32 | 91.55 / 80.32 (gate ≥80) | stable |
| Bug tasks open | 2 (T056, T057) | 0 | ✓ closed |

## Bug Fixes Verified (iteration 2)
- **T056** `[BUG:ERROR] {SEC}` — ran `npm audit fix` (non-breaking); `fast-uri` bumped 3.1.4 → 3.1.5. `npm audit --omit=dev --audit-level=high` now **exit 0, found 0 vulnerabilities**. Fastify routing regression-checked (9 route IT green). *(Dev-only advisories in dockerode/hyperid/autocannon remain outside the `--omit=dev` production gate — test/benchmark tooling, not shipped.)*
- **T057** `[BUG:ERROR] {FR-003}` — constrained `select_tier` to NUMERIC tiers end-to-end (`effect.ts`, `validate.ts`, `context.ts` dry-run schema, `catalog/validation.ts`) + aligned the OpenAPI contract; NO token-format change (Principle I / SC-014 intact — snapshot stays `Record<string, boolean|number>`). New IT proves the selected numeric tier is embedded in the SIGNED token (verifies offline via the E001 core) AND equals the `policy_evaluation` audit `decision` — audit-vs-token discrepancy eliminated.

## Test Results
- **Runner**: Vitest 2 (v8 coverage) + @testcontainers/postgresql, PostgreSQL 16.
- **Iteration-1 full suite** (baseline, unchanged code paths): 949 passed / 3 skipped, exit 0.
- **Iteration-2 scoped**: policy module 23 files / 162 passed; issuance+catalog 7 files / 41 passed; affected-set re-run (issuance IT + effect/validate unit + catalog authored-max IT) 4 files / 46 passed. **0 failures.**

## Static Analysis
- eslint (`npm run lint`): 0 errors, 0 warnings. **PASSED**. Typecheck `tsc --noEmit` exit 0. **PASSED**.

## Security Audit
- `npm audit --omit=dev --audit-level=high` → **exit 0, 0 vulnerabilities**. **PASSED**.
- semgrep: CI-only, runs in `.github/workflows/policy.yml` (with a sandbox/no-eval grep gate). Configured, not a local blocker.

## PI Compliance
- **No violations.** Principle I re-confirmed after the T057 fix: no token-format change, no crypto, engine strictly on the issuance/signing path; offline verifier untouched (SC-014). Fail-closed + audit isolation (SC-006/017/020), forced RLS + cross-tenant 404 (FR-015/SC-012) all intact.

## Requirements Traceability
- All 6 user stories PASSED; all 21 FRs implemented (genuine, non-stub). **SC-001..SC-021 all PASSED** (SC-015 now fully passed post-T057). 57 tasks `[X]` (55 feature + 2 bug fixes).

## Traceability Gaps
- **None.** The sole iteration-1 gap (SC-015 `select_tier` string enforcement) is closed.

## Code Coverage
- Policy module `src/server/modules/policy/**`: **91.55% line / 80.32% branch** (≥80 line AND branch gate) — **PASSED**. Global gate satisfied by the full-suite run.

## Checklist Fulfillment (spot-check)
- security / data-integrity / api-quality checklists all `[X]`; sandbox no-eval boundary, forced RLS, append-only audit, fail-closed, no-secret/PII minimization satisfied. No gaps.

## Performance
- `perf.integration.test.ts`: author-time validation fast; bounded evaluation honors timeout/size/depth caps; per-decision rule cap applies at issuance. **PASSED**.

## Accessibility
- No a11y NFRs in spec → SKIPPED (not applicable).

## Browser Runtime Validation
- Admin-ui `PolicyRules.tsx` covered by component tests (8) + build; server-side feature. SKIPPED — not required.

## Manual Testing
- None required.

## Tool Recommendations
- None outstanding. (semgrep runs in CI.)

## Bug Tasks Generated
- **None** this run. T056 and T057 (from iteration 1) both fixed and verified.
