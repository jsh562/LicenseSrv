# QC Report — E005 Tenant Administration & Audit

**Feature**: 00006-tenant-administration-and-audit
**Run**: full (first QC for this feature)
**Overall Verdict**: **PASS**

The admin console (Fastify `/admin` API + React SPA) is implemented, independently verified by the QC
Auditor and Story Verifier, and all required QC categories pass. Two minor spec-literal gaps the Story
Verifier surfaced (FR-018 lockout configurability, FR-005 no-role audit branch) were fixed inline and
covered by new tests before this verdict.

## Test Results

| Suite | Runner | Result |
|-------|--------|--------|
| Server (all epics, real Postgres via Testcontainers) | Vitest 2 | **82 passed / 82** |
| Admin module only | Vitest 2 | 24 passed (5 unit + 19 integration) |
| SPA (jsdom + React Testing Library) | Vitest 2 | **25 passed / 25** |
| **Combined** | | **107 passed / 107**, 0 failed |

No failures. Server suite runs serially against a fresh Postgres 16 container.

## Static Analysis

- **Server typecheck** (`tsc --noEmit`): PASS (exit 0)
- **SPA typecheck** (`tsc --noEmit`): PASS (exit 0)
- **ESLint** (`eslint src/server`, incl. module-boundary rule): PASS (0 issues)
- **Semgrep**: CI-only (declared in `.github/workflows/admin.yml`, config `p/typescript` + `p/owasp-top-ten` over `src/server/modules/admin` + `src/admin-ui/src`). Not run locally — consistent with E002/E003/E004 precedent.

## Security Audit

- **Server production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities**
- **SPA production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities**
- **WARNING (informational, non-blocking)**: the SPA's full dependency tree carries dev-only advisories
  (vite dev-server `server.fs.deny` bypass; vitest UI-server file read; launch-editor UNC on Windows).
  These require running a dev/UI server that is never started in CI or production; the shipped bundle
  (production deps) audits clean. Resolving them would force a vite 8 / vitest 4 major bump. Gated on the
  shipped surface via the CI `--audit-level=high` step. An `esbuild ^0.25` override is pinned to clear
  the transitive esbuild advisory.

## PI Compliance

No violations. Uses node-postgres with raw SQL migrations (project-instructions v1.2.0), the E002
`withTenant`/`privileged` + forced-RLS + append-only audit foundation, and fail-closed RBAC. No Drizzle.

## Requirements Traceability

| Work item | Priority | Status |
|-----------|----------|--------|
| US1 — Sign in to a tenant-scoped console | P1 | PASS |
| US2 — RBAC gates privileged actions | P1 | PASS |
| US3 — Manage users & roles (last-owner safeguard) | P1 | PASS |
| US4 — Manage runtime API keys | P1 | PASS |
| US5 — Review the audit log | P1 | PASS |
| US6 — Sign in via SSO | P2 | **DEFERRED** (T033/T034, non-blocking) |

Success criteria: **SC-001…SC-007, SC-009, SC-010, SC-011 PASS**. SC-008 (SSO) deferred with US6.

## Traceability Gaps

- **Test-file layout** differs from the per-story filenames named in `tasks.md`: the suite consolidates
  them into `auth-primitives.unit`, `auth.integration`, `routes.integration`, `secret-leakage` (server)
  and `api`/`ui`/`app` (SPA). Every referenced scenario is covered; only filenames differ. No missing
  coverage. (Documentation-level, not functional.)

## Gaps Fixed This Run (Story Verifier findings)

- **FR-018 (configurability)** — lockout threshold + window were compile-time constants. Now
  operator-configurable via `AdminConfig` (`ADMIN_MAX_FAILED_LOGINS`, `ADMIN_LOCKOUT_SECONDS`; safe
  defaults 5 / 900s), threaded `index.ts → routes.ts → auth.login`. New tests: `loadAdminConfig` unit
  (defaults / overrides / clamping) + integration proving a custom threshold of 2 locks on the 2nd fail.
- **FR-005 (audit completeness)** — the `role === null` denial branch in `rbac-middleware.ts` now emits
  an `authz.denied` security event like the below-minRole branch (deny-by-default fully audited).

## Code Coverage (threshold 80% line + branch)

| Surface | Lines | Branches | Functions |
|---------|-------|----------|-----------|
| Server (Vitest v8) | 93.09% | 80.79% | 97.41% |
| SPA (Vitest v8) | 97.54% | 87.69% | 92.72% |

Both enforce the gate in config (`vitest.config.ts`, `src/admin-ui/vite.config.ts`). All above threshold.

## Checklist Fulfillment (spot-check)

- **[Security]**: credentials scrypt-hashed & never emitted (secret-leakage test); session token cookie-only
  (httpOnly+Secure+SameSite=Strict); CSRF double-submit enforced; RBAC fail-closed + audited; RLS tenant
  isolation on `admin_session`. PASS.
- **[Testing]**: unit + real-Postgres integration + HTTP inject + SPA component tests; coverage gate wired. PASS.

## Performance / Accessibility

No performance or accessibility NFRs in `spec.md` beyond standard security posture → not separately gated.

## Browser Runtime Validation

SPA views are covered by React Testing Library component tests (login flow, shell nav, RBAC hiding,
users/api-keys/audit views, secret-once reveal). No live-browser scenario required for the P1 gate;
`RUNTIME_VALIDATION = covered by component suite`.

## Bug Tasks Generated

None. (Two Story-Verifier findings were fixed inline this run, not deferred to bug tasks.)

## CI

`.github/workflows/admin.yml` — server integration (Testcontainers), SPA coverage gate, production-scope
`npm audit --audit-level=high`, and semgrep (CI-only). Satisfies T046/T047.
