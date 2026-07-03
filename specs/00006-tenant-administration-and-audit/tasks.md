---
description: "Task list for feature implementation: Tenant Administration and Audit (E005)"
---

# Tasks: Tenant Administration and Audit

**Input**: Design documents from `specs/00006-tenant-administration-and-audit/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `data-model.md`, `contracts/admin-api.openapi.yaml`

**Tests**: Test tasks ARE included — the spec/plan mandate Vitest unit + Testcontainers integration (server), React Testing Library (SPA), a secret-leakage test, CSRF tests, and ≥80% coverage.

**Organization**: Grouped by user story (`US#`). Each P1 story is an independently testable slice — backend stories are Testcontainers-integration-testable; SPA views are component-testable against a mocked API.

## Project Mode

`Mixed`

- Extends the existing Node/TS server at `src/server/` (E002) — new `src/server/modules/admin/` module and migration `0005`.
- Adds a NEW React + Vite SPA at `src/admin-ui/`.

## Epic / Capability Map

- `[US1]` → E005 sign-in + tenant-scoped session (auth spine) {PRD:CAP-007}
- `[US2]` → E005 RBAC fail-closed authorization + audited denial
- `[US3]` → E005 user & role management + last-owner safeguard
- `[US4]` → E005 runtime API-key lifecycle (create/rotate/revoke)
- `[US5]` → E005 read-only filterable audit view
- `[US6]` → E005 SSO / OIDC interactive auth (P2, non-blocking)
- Frontend + Polish carry the SPA console shell (FR-015, SC-010) and cross-cutting hardening.

## Brownfield Notes

- Existing flows touched: `src/server/modules/index.ts` (module registration), `migrations/` (sequential `0005` after `0004`), `src/server/app.ts` (cookie plugin).
- Patterns reused from E002: `withTenant`/`privileged` (`src/server/db/client.ts`), `writeAudit`/`recordSecurityEvent` (`src/server/audit/index.ts`), the `resolveApiKey` privileged pre-tenant lookup (`src/server/auth/apikey.ts` — mirror for `token_hash`), `authorize`/`Role` (`src/server/auth/rbac.ts`), `hmacKey`/`saltedHash`/`hashEquals` (`src/server/db/hash.ts`), the advisory-locked migration harness (`src/server/db/migrate.ts`), the forced-RLS policy form, and the `Error {code,message,details}` shape.
- Compatibility: migration `0005` is expand-only (additive `ALTER app_user` + new `admin_session`); no changes to `0000`–`0004`, no new audit/role table.
- Regression focus: E002 tenant isolation (RLS), the machine `X-API-Key` path, and the reused `role`/`api_key`/`audit_log` tables must keep working unchanged.

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Scaffold React + Vite SPA workspace in src/admin-ui/ (package.json, vite.config.ts, index.html, tsconfig.json) with React 18 + Vitest + React Testing Library
- [X] T002 [P] {FR-003} Add @fastify/cookie dependency and register the cookie plugin in src/server/app.ts
- [X] T003 [P] Add admin config (cookie flags, session/CSRF secrets, scrypt cost, lockout N=5, TTL<=24h) in src/server/modules/admin/index.ts → exports: AdminConfig, registerAdmin()

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The auth spine — migration 0005 plus session/password/csrf/rbac-middleware — blocks every admin route. Complete before any delivery phase.**

- [X] T004 Author expand-only migration migrations/0005_admin_sessions.sql (ALTER app_user credential/lockout cols + CREATE admin_session + indexes + forced RLS/policy/grants) {FR-001,FR-018}
- [X] T005 [P] {FR-002} Integration test 0005 RLS: admin_session tenant isolation (unset GUC->0 rows; A!=B) in src/server/modules/admin/__tests__/migration.integration.test.ts after:T004
- [X] T006 [P] {FR-017} Unit test scrypt hash + timing-safe verify (never plaintext) in src/server/modules/admin/__tests__/password.unit.test.ts
- [X] T007 {FR-017} Implement scrypt password hash + timing-safe verify in src/server/modules/admin/password.ts ← T003:AdminConfig → exports: hashPassword(pw), verifyPassword(pw,hash)
- [X] T008 [P] {FR-003} Unit test session token gen (opaque 32-byte) + SHA-256 token_hash + validity predicate in src/server/modules/admin/__tests__/session.unit.test.ts
- [X] T009 {FR-001,FR-003} Implement session mgmt (pre-tenant resolve like resolveApiKey) in src/server/modules/admin/session.ts → exports: createSession, resolveSession, revokeSession
- [X] T010 [P] {FR-019} Unit test double-submit CSRF issue + compare (mismatch rejected) in src/server/modules/admin/__tests__/csrf.unit.test.ts
- [X] T011 {FR-019} Implement double-submit CSRF (JS-readable cookie token; validate X-CSRF-Token header) in src/server/modules/admin/csrf.ts → exports: issueCsrfToken(), requireCsrf()
- [X] T012 [US2] {FR-004,FR-005} Implement RBAC preHandler (fail-closed minRole via rbac.authorize; denial->recordSecurityEvent) in src/server/modules/admin/rbac-middleware.ts → exports: requireRole

---

## Phase 3: US1 - Sign in to a tenant-scoped admin console (Priority: P1) 🎯 MVP

**Independent test**: a seeded admin signs in (tenantSlug+email+password), gets a session cookie, calls /me, signs out, and the ended session is rejected on the next request.

- [X] T013 [P] [US1] {FR-001,FR-003} Integration test login->cookie->me->logout; expired/revoked rejected next request in src/server/modules/admin/__tests__/auth.integration.test.ts after:T009
- [X] T014 [P] [US1] {FR-018} Integration test lockout: 5 fails->429 + Retry-After + security_event; generic error in src/server/modules/admin/__tests__/lockout.integration.test.ts after:T009
- [X] T015 [US1] {FR-001,FR-014,FR-018} Implement login/logout/me + lockout in src/server/modules/admin/auth.ts ← T007:verifyPassword ← T009:createSession → exports: login, logout, me
- [X] T016 [US1] {FR-018} [COMPLETES FR-018] Wire lockout counters + audit events (login_failed/login_locked/login_throttled) in src/server/modules/admin/auth.ts ← T015:login after:T015
- [X] T017 [US1] {FR-001,FR-003} [COMPLETES FR-001] Register /admin/auth routes (login security:[]; SameSite=Strict cookie) in src/server/modules/admin/routes.ts ← T015:login ← T011:requireCsrf
- [ ] T018 [US1] {FR-002,FR-003} [COMPLETES FR-002,FR-003] Integration test session RLS: A cannot access B; owner-status gate in src/server/modules/admin/__tests__/session.integration.test.ts after:T017

---

## Phase 4: US2 - Role-based access control gates privileged actions (Priority: P1) 🎯 MVP

**Independent test**: a viewer is blocked (403) from a privileged action with an audited security event; an admin succeeds.

- [X] T019 [P] [US2] {FR-004,FR-005} Integration test: viewer 403 + authz.denied security_event; admin allowed in src/server/modules/admin/__tests__/rbac.integration.test.ts after:T012
- [X] T020 [US2] {FR-005} [COMPLETES FR-005] Wire audited-denial (authz.denied) + fail-closed default in src/server/modules/admin/rbac-middleware.ts ← T012:requireRole after:T012
- [X] T021 [US2] {FR-004} [COMPLETES FR-004] Apply requireRole(minRole) to every /admin route per the contract x-rbac table in src/server/modules/admin/routes.ts ← T012:requireRole after:T017

---

## Phase 5: US3 - Manage users and their roles (Priority: P1) 🎯 MVP

**Independent test**: an admin creates a user, assigns/changes a role, deactivates them (deactivated cannot sign in); last-owner demote/deactivate is refused 409; every change is audited.

- [X] T022 [P] [US3] {FR-006,FR-007} Integration test create/role-change/deactivate + audit; deactivated cannot sign in in src/server/modules/admin/__tests__/users.integration.test.ts after:T012
- [X] T023 [P] [US3] {FR-008} Integration test last-owner: demote/deactivate final owner -> 409; race-safe in src/server/modules/admin/__tests__/last-owner.integration.test.ts after:T012
- [X] T024 [US3] {FR-006,FR-007,FR-014} Implement user + role mgmt (create/invite; role swap in-tx; deactivate; writeAudit) in src/server/modules/admin/users.ts → exports: createUser, updateUser
- [X] T025 [US3] {FR-008} [COMPLETES FR-008] Implement race-safe last-owner guard (SELECT..FOR UPDATE on active owners in-tx) -> 409 + security_event in src/server/modules/admin/users.ts after:T024
- [X] T026 [US3] {FR-006} [COMPLETES FR-006] Register /admin/users routes (list; create 201; PATCH 200/404/409) + CSRF + admin RBAC in src/server/modules/admin/routes.ts ← T024:createUser after:T024

---

## Phase 6: US4 - Manage runtime API keys (Priority: P1) 🎯 MVP

**Independent test**: an admin creates a scoped key (secret shown once), lists metadata (no secret), rotates (new secret once, old stops authenticating), revokes (stops authenticating); every step audited.

- [X] T027 [P] [US4] {FR-009,FR-010} Test create(secret-once)/list/rotate/revoke + audit; revoked key fails auth in src/server/modules/admin/__tests__/apikeys.integration.test.ts after:T012
- [X] T028 [US4] {FR-009,FR-010,FR-014} [COMPLETES FR-014] Implement api-key lifecycle (secret once; rotate=create+revoke; writeAudit) in src/server/modules/admin/apikeys.ts → exports: createApiKey
- [X] T029 [US4] {FR-010} [COMPLETES FR-010] Register /admin/api-keys routes (list; create/rotate secret-once; revoke) + CSRF + admin RBAC in src/server/modules/admin/routes.ts after:T028

---

## Phase 7: US5 - Review the audit log (Priority: P1) 🎯 MVP

**Independent test**: a reviewer opens the audit view, sees actor/action/target/timestamp entries scoped to their tenant, filters by from/to/securityEvent/actor, and confirms no create/update/delete path exists.

- [X] T030 [P] [US5] {FR-011,FR-012,FR-013} Test audit read + filters (from/to/securityEvent/actor + cursor); assert no CUD in src/server/modules/admin/__tests__/audit.integration.test.ts after:T012
- [X] T031 [US5] {FR-011,FR-012} Implement read-only filtered audit query (from/to; securityEvent; actor exact; cursor) in src/server/modules/admin/audit.ts → exports: listAuditEntries
- [X] T032 [US5] {FR-013} [COMPLETES FR-013] Register GET-only /admin/audit route (viewer RBAC; no CUD verb; append-only) in src/server/modules/admin/routes.ts ← T031:listAuditEntries after:T031

---

## Phase 8: US6 - Sign in via single sign-on (Priority: P2)

**Non-blocking for the P1 MVP gate. Delivered after the P1 phases; layers onto the ADR-0008 session seam.**

- [ ] T033 [P] [US6] {FR-016} Integration test SSO/OIDC sign-in yields tenant-scoped session equivalent to direct login in src/server/modules/admin/__tests__/sso.integration.test.ts after:T017
- [ ] T034 [US6] {FR-016} [COMPLETES FR-016] Implement SSO/OIDC auth issuing an admin_session via the session seam in src/server/modules/admin/sso.ts ← T009:createSession

---

## Phase 9: Frontend (React SPA console shell + views)

**The console shell + login/users/api-keys/audit views (FR-015, SC-010). Each view is component-testable with a mocked API; the [US#] tags mark which story slice a task surfaces.**

- [ ] T035 {FR-015} Implement typed admin API client (camelCase, cookie creds, X-CSRF-Token echo) in src/admin-ui/src/api.ts ← contracts/admin-api.openapi.yaml → exports: adminApi
- [ ] T036 [US1] {FR-015} Implement Login page (tenantSlug+email+password form; generic error) in src/admin-ui/src/pages/Login.tsx ← T035:adminApi
- [ ] T037 [US1] {FR-015} Implement console Shell (nav across users/api-keys/audit; inherits session scope) in src/admin-ui/src/components/Shell.tsx ← T035:adminApi → exports: Shell
- [ ] T038 [US2] {FR-015} Implement RequireRole guard (hide actions above session role; SC-010) + App/main wiring in src/admin-ui/src/components/RequireRole.tsx ← T037:Shell ← T035:adminApi
- [ ] T039 [P] [US3] {FR-015} Implement Users view (list, create/invite, change role, deactivate; metadata only) in src/admin-ui/src/pages/Users.tsx ← T035:adminApi
- [ ] T040 [P] [US4] {FR-015} Implement ApiKeys view (list metadata; create showing secret once; rotate; revoke) in src/admin-ui/src/pages/ApiKeys.tsx ← T035:adminApi
- [ ] T041 [P] [US5] {FR-015} Implement Audit view (read-only table + from/to/securityEvent/actor filters) in src/admin-ui/src/pages/Audit.tsx ← T035:adminApi
- [ ] T042 {FR-015} [COMPLETES FR-015] Component tests (RTL, mocked API): login, shell nav, RequireRole hides actions, users/api-keys/audit views render in src/admin-ui/src/__tests__/ after:T041

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T043 {FR-017} [COMPLETES FR-017] Secret-leakage test: no password/hash/session token in any response, header, log, or audit snapshot in src/server/modules/admin/__tests__/secret-leakage.test.ts
- [X] T044 {FR-019} [COMPLETES FR-019] CSRF test: state-changing /admin without valid X-CSRF-Token rejected; login exempt in src/server/modules/admin/__tests__/csrf.integration.test.ts after:T021
- [X] T045 Register the admin module in src/server/modules/index.ts alongside registerSigning ← T003:registerAdmin after:T032
- [ ] T046 [P] Enforce >=80% line+branch coverage of the admin server module (Vitest v8) and wire the coverage gate in the admin test config
- [ ] T047 [P] Add npm audit (no high/critical) + semgrep (CI-only) for the admin module and SPA to the CI workflow

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8, P2 non-blocking) → Frontend (Phase 9) → Polish (Phase 10)

- **Phase 1 (Setup)** has no dependencies.
- **Phase 2 (Foundational)** depends on Setup; T004 (migration) blocks T005; T007/T009/T011/T012 are the auth spine consumed by every delivery phase.
- **US1–US5 (P1)** each depend on the Foundational auth spine (session / rbac-middleware / csrf) and are independently testable slices. Across stories they may proceed in parallel once Phase 2 completes, subject to the `after:T###` edges.
- **US6 (P2)** is non-blocking for the P1 MVP gate; it depends only on the session seam (T009 / T017).
- **Frontend (Phase 9)** depends on the API client (T035) and the corresponding backend stories; component tests (T042) run against a mocked API and do not block backend delivery.
- **Polish (Phase 10)** depends on all P1 stories being complete; module registration (T045) depends on all backend routes (through T032).
- Tasks marked `[P]` can run in parallel within their phase (distinct files, no intra-batch dependency).
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.
