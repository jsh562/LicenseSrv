# QC Report — E007 No-Code Licensing Catalog

**Feature**: 00008-no-code-licensing-catalog
**Run**: full (first QC for this feature)
**Overall Verdict**: **PASS** (with P2 US6 export deferred)

Independently verified by the QC Auditor (gates) and Story Verifier (US/SC traceability). All runnable
gates pass. Two minor non-blocking Story-Verifier findings were fixed inline before this verdict.

## Test Results

| Suite | Runner | Result |
|-------|--------|--------|
| Full server suite (all epics, real Postgres via Testcontainers) | Vitest 2 | **115 passed / 3 skipped** |
| Catalog module (new) | Vitest 2 | 13 (5 unit + 8 integration) |
| SPA (jsdom + React Testing Library) | Vitest 2 | **35 passed** |

3 skipped = the E006 `DOCKER_SMOKE` image smoke (self-skips; CI-gated). No failures.

## Static Analysis

- **Server typecheck** (`tsc --noEmit`): PASS · **SPA typecheck**: PASS
- **ESLint** (`eslint src/server`, incl. the module-boundary rule): PASS (0 issues). The catalog imports the
  shared `src/server/console/` auth (not another feature module), so the boundary rule is satisfied — proven
  live by the `module-boundary enforcement` test.
- **Semgrep**: CI-only (declared in `.github/workflows/catalog.yml` over `src/server/modules/catalog` +
  `src/server/console` + `src/admin-ui/src/pages/catalog`). Consistent with E002–E006.

## Security Audit

- **Server production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities**
- **SPA production deps**: **0 vulnerabilities**. (Dev-only vite/vitest advisories are informational, not
  shipped — out of scope for the production-audit gate.)

## PI Compliance

No violations. Forced-RLS tenant isolation on all four catalog tables; every mutation `writeAudit` (append-only);
fail-closed RBAC (viewer read / admin write) + CSRF; node-postgres + raw SQL migration 0006 (no ORM); source
under `/src`; the catalog performs no cryptography; the offline verifier core is untouched.

## Requirements Traceability

| User story | Priority | Status |
|-----------|----------|--------|
| US1 — Products | P1 | PASS |
| US2 — Plans | P1 | PASS |
| US3 — Entitlements | P1 | PASS |
| US4 — Per-plan values + effective read model (E008 seam) | P1 | PASS |
| US5 — Browse, RBAC, tenant isolation | P1 | PASS |
| US6 — Declarative export | P2 | **DEFERRED** (T028/T029) |

Success criteria: **SC-001…SC-011 all PASS**. FR-001…FR-016, FR-018/FR-019 mapped to concrete code + tests;
FR-017 (export) deferred with US6.

## Gaps Fixed This Run (Story Verifier findings)

- **CSRF denial now audited** — `console/rbac-middleware.ts` records a security event (`authz.denied … (csrf)`)
  on a CSRF failure, matching the plan's error-handling contract (previously 403 without an event).
- **`catalogApi.getEffective`** — added the effective-plan-definition client method T030 listed (the backend
  route + E008 read model already existed); covered by `api.test.ts`.

## Code Coverage (threshold 80% line + branch)

| Surface | Lines | Branches | Functions |
|---------|-------|----------|-----------|
| Server (Vitest v8) | 92.58% | 82.00% | 96.36% |
| SPA (Vitest v8) | 97.15% | 87.50% | 91.34% |

Both enforce the gate in config. All above threshold.

## Notable Architecture Decision

The shared human-session RBAC (`requireRole` / session / CSRF) was promoted from `modules/admin/` to
`src/server/console/` so the catalog (and future E008/E009 console surfaces) reuse one implementation without a
cross-module import (ADR-0005). Admin imports were rewired; all E005 admin tests still pass.

## Observations (non-blocking)

- **FR-019 reason granularity**: the denial event carries actor/action/target and a category-level reason
  (`authz.denied`); it does not emit a distinct sub-code for no-role vs insufficient-role. Cross-tenant
  attempts return 404 (no-existence-disclosure) rather than a security event, per the documented design.
- **Test-file consolidation**: the per-phase filenames in `tasks.md` are consolidated into
  `catalog.integration.test.ts` + `values.unit.test.ts` (server) and `catalog.test.tsx` + `api.test.ts` (SPA);
  all referenced scenarios are covered.

## Bug Tasks Generated

None. (Two Story-Verifier findings fixed inline this run; the list-default-active and branch-coverage issues
were fixed during implementation.)

## CI

`.github/workflows/catalog.yml` — Testcontainers integration + coverage gate, SPA coverage, production-scope
`npm audit`, and semgrep (CI-only). Satisfies T039/T040.
