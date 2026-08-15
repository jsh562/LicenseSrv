# QC Report — E018 Reseller and White-label Tenancy

**Feature**: `00019-reseller-and-white-label-tenancy` | **Date**: 2026-08-14 | **Iteration**: 1 | **Run**: full
**Overall Verdict**: **PASS** — all checks green on the first iteration; no bug tasks generated.

## Test Results
- **Runner**: Vitest 2 (v8 coverage) + @testcontainers/postgresql, PostgreSQL 16.
- **Full server suite**: 1083 passed / 3 skipped, 168 files passed / 1 skipped — exit 0.
- **Reseller module**: 19 files, 130 passed, 0 failed.
- **Admin touched-module regression** (admin/users.ts last-owner + first-admin): 4 files, 24 passed.
- **Admin-ui**: build OK, 13 component tests pass.
- **Failures**: none.

## Static Analysis
- eslint (`npm run lint` → `eslint src/server`): 0 errors, 0 warnings. **PASSED**.
- `tsc --noEmit`: exit 0. **PASSED**.

## Security Audit
- `npm audit --omit=dev --audit-level=high` → **exit 0, 0 vulnerabilities** (re-confirmed). **PASSED**.
- semgrep: CI-only — runs in `.github/workflows/reseller.yml` alongside a no-RLS-broadening **isolation lint** (bans `parent_reseller_id` in any RLS policy predicate, `SET ROLE`/`withTenant` bypass, and raw `pool.query` in module sources). Configured, not a local blocker.

## PII Compliance / Non-negotiables
- **No violations.** Story Verifier confirmed all non-negotiables:
  - **Principle II (isolation crux)**: the per-tenant `tenant_isolation` RLS predicate is verifiably UNCHANGED (`0014` keeps `tenant_id = app.current_tenant`); subtree reads run on the `privileged` seam filtered by `parent_reseller_id` after ownership assertion; reseller actions descend under the sub-tenant's own `app.current_tenant` (`gate.ts`). Downward-only → 404 no disclosure (never 403); upward/lateral/IDOR blocked; unset-GUC → 0 rows on all three tables — all proven by `isolation-escalation.integration.test.ts` across two resellers.
  - **Dual-identity audit (FR-009)**: `actor_reseller_id` on every reseller action + denied escalation (`security_event=true`), stored independently of the mutable `parent_reseller_id` (survives transfer); append-only (`audit_log` grant SELECT,INSERT only — verified).
  - **FR-017 metadata-only**: `SubTenantRow` structurally carries no license/usage/activation data; enforced by a forbidden-substring test.
  - **Principle I**: no signer/verifier/token/crypto surface touched; a signed token verifies byte-identical before/after reseller suspension (SC-009 test).
  - **Branding (FR-006/007/008)**: per-field precedence + reseller locks + trust-signal exclusion (disjoint from the 8 brandable fields); hierarchy-safe lock presentation.

## Requirements Traceability
- All 5 user stories **PASSED** (US1/US2/US3 P1 MVP; US4/US5 P2). All 17 FRs implemented with genuine (non-stub) code, each with exactly one `[COMPLETES]` task. **SC-001..SC-015 all PASSED.** 52 tasks `[X]`.

## Traceability Gaps
- **None.**

## Code Coverage
- Reseller module `src/server/modules/reseller/**`: **91.21% line / 82.05% branch** (Functions 94.90%) — ≥80 line AND branch gate → **PASSED**. Global gate satisfied by the full-suite run.
- Lowest-branch files (absorbed by the directory aggregate): `routes.ts` 70.77%, `lifecycle.ts` 73.91%, `gate.ts` 75.00% — all above the 80% line gate; directory branch aggregate 82.05% passes.

## Checklist Fulfillment (spot-check)
- CHL001 Security / CHL002 Data Integrity / CHL003 API Quality all `[X]` (118 items). Security/Data-Integrity intent spot-checked against implementation: no-RLS-broadening, downward-only 404, append-only dual-identity audit, one-binding-per-host, metadata-only, trust-signal exclusion — all satisfied. No gaps.

## Performance / Accessibility
- No performance/a11y NFRs in spec → SKIPPED (not applicable). Admin-plane operations; subtree reads bounded + indexed; branding resolution a small per-tenant lookup.

## Browser Runtime Validation
- Admin-ui reseller pages covered by component tests (13) + build; server-side feature. SKIPPED — not required.

## Manual Testing
- None required.

## Tool Recommendations
- None outstanding (semgrep + isolation lint run in CI).

## Non-blocking Observations (from Story Verifier)
1. Verification was static-analysis-based in that pass; runtime pass/fail was independently confirmed by the QC Auditor's scoped test runs (130 reseller + 24 admin) and the full-suite green (1083 passed).
2. `toSubTenantWire` derives a sub-tenant's display status from `deletedAt` (no separate tenant lifecycle column exists); the reseller read-only cascade is reported separately via `readOnly`. Matches the metadata-only contract shape — not a spec violation.

## Bug Tasks Generated
- **None.** QC passed on the first iteration.
