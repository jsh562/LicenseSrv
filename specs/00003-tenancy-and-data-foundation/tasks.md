# Tasks: Tenancy and Data Foundation

**Input**: Design documents from `specs/00003-tenancy-and-data-foundation/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `data-model.md`

**Tests**: Included by user request — the hardened Testing Strategy mandates Vitest + Testcontainers real-Postgres integration tests, security gates, and ≥80% lines+branches coverage.

**Organization**: Technical spec — grouped by objective (`OBJ#`). Shared blockers (DB client, initial schema, RLS migration, advisory-locked runner) are lifted into Setup/Foundational per HINT-001 because every objective depends on tenant-scoped access existing.

## Project Mode

`Mixed` (greenfield server subtree)

- Existing Rust `src/verifier-core/` is untouched by this epic.
- `src/server/` (Node/TypeScript + Fastify + Drizzle + Postgres) does not exist yet — Phase 1 scaffolds it (package.json, tsconfig, vitest.config, drizzle.config, Testcontainers, npm-audit/Semgrep wiring).

## Epic / Capability Map

- `[OBJ1]` → Tenant-scoped data access and isolation (repository + forced RLS + pool no-bleed + tenant_id-leading indexes)
- `[OBJ2]` → Schema and gated migrations (initial schema + expand/contract + advisory-locked runner)
- `[OBJ3]` → Append-only audit and modular skeleton (audit write path + module seams + tenant-resolution auth context)

## Brownfield Notes

- Existing flows touched: none — `src/verifier-core/` (Rust) is out of scope and unchanged.
- New subtree only: all work lands under `src/server/`, `migrations/`, and repo-root config for the Node package.
- Regression focus: none in Rust; the new Node package must not break existing repo-root structure.

---

## Phase 1: Setup (Repository / Workspace Delta)

**Scaffold the new `src/server/` Node/TS subtree, tooling, and the non-owner/owner DB roles. No work-item label.**

- [X] T001 Create Node package manifest at repo root in package.json (Fastify, Drizzle ORM, drizzle-kit, pg, Zod; scripts: build, test, test:int, lint, audit, semgrep, migrate) → exports: package.json scripts
- [X] T002 [P] Add strict TypeScript config in tsconfig.json (strict:true, NodeNext, outDir dist, include src/server) after:T001
- [X] T003 [P] Add Vitest config with c8 coverage thresholds (lines ≥80, branches ≥80 over src/server) in vitest.config.ts after:T001 → exports: coverage.thresholds
- [X] T004 [P] Add drizzle-kit config (schema src/server/db/schema.ts, out migrations/, dialect postgresql) in drizzle.config.ts after:T001 → exports: drizzleConfig
- [X] T005 [P] Add ESLint + Prettier config for the server subtree in .eslintrc.cjs and .prettierrc after:T001
- [X] T006 [P] {TR-002} Add Testcontainers Postgres 16.4+ test harness (boot container, provision licensesrv_owner + non-owner licensesrv_app role) in src/server/__tests__/helpers/pgContainer.ts after:T001 → exports: startTestPostgres(), connectAs(role)
- [X] T007 [P] Wire npm audit gate (fail on high/critical) in package.json audit script and CI step in .github/workflows/server-ci.yml after:T001
- [X] T008 [P] Wire Semgrep SAST gate (SQL injection + authz rulesets, fail on high-severity) in semgrep.yml and the CI step in .github/workflows/server-ci.yml after:T007

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**HINT-001 order: DB client + pool, initial Drizzle schema, RLS migration (FORCE + policies + non-owner role + grants + tenant_id-leading indexes), advisory-locked migration runner. Every objective depends on these. No work-item label.**

- [X] T009 {TR-003,TR-014} Implement Postgres client + connection pool with per-transaction envelope and DISCARD ALL reset-on-return, asserting Postgres ≥16.4 in src/server/db/client.ts after:T002 → exports: getPool(), withTransaction(fn), assertPgVersion()
- [X] T010 {TR-005} Define initial Drizzle schema (tenant, user, role, api_key, audit_log; enums; composite tenant_id FKs) in src/server/db/schema.ts after:T004 → exports: tenant, user, role, apiKey, auditLog, schema enums
- [X] T011 [P] {TR-002} Author RLS SQL module (ENABLE+FORCE ROW LEVEL SECURITY, tenant_isolation policy USING/WITH CHECK on app.current_tenant) for all tenant-owned tables in src/server/db/rls.ts after:T010 → exports: rlsStatements
- [X] T012 {TR-002,TR-005} Generate initial expand migration (CREATE TABLEs + enums) via drizzle-kit into migrations/0000_init.sql after:T010
- [X] T013 {TR-004} Add tenant_id-leading composite indexes (user(tenant_id,id)+UNIQUE(tenant_id,email); role(tenant_id,user_id)+UNIQUE; api_key(tenant_id,status)+UNIQUE(key_hash); audit_log(tenant_id,ts DESC)+partial security_event) in migrations/0001_indexes.sql after:T012
- [X] T014 {TR-002,TR-008} Add RLS + role migration: create licensesrv_app (non-owner, non-superuser, NOBYPASSRLS), ENABLE+FORCE RLS + policies, GRANT INSERT/SELECT only on audit_log + REVOKE UPDATE/DELETE in migrations/0002_rls_roles_grants.sql after:T011 ← T011:rlsStatements
- [X] T015 {TR-007,TR-015} Implement advisory-locked migration runner (pg_advisory_lock(hashtext('licensesrv:migrations')), per-migration transaction, unlock; auto-release on session end) in src/server/db/migrate.ts after:T009 → exports: runMigrations(), MIGRATION_LOCK_KEY

---

## Phase 3: OBJ1 — Tenant-scoped data access and isolation (Priority: P1) 🎯 MVP

**Repository wrapper is the ONLY place the tenant GUC is set (HINT-003); RLS is the net, not the gate. Refuse unscoped queries; no pool bleed (HINT-004).**

- [X] T016 [OBJ1] {TR-001,TR-003} Implement tenant repository wrapper (open tx, SET LOCAL app.current_tenant, run scoped queries, hard-refuse when no tenant resolved) in src/server/db/repository.ts after:T015 → exports: withTenant(tenantId,fn), TenantRepository, UnscopedQueryError
- [X] T017 [OBJ1] {TR-001} [COMPLETES TR-001] Add tenant-scoped CRUD helpers for every tenant-owned table that assert tenant_id == resolved tenant on write in src/server/db/repository.ts after:T016 ← T016:TenantRepository
- [X] T018 [P] [OBJ1] {TR-004} [COMPLETES TR-004] Add schema/index assertions exposing the tenant_id-leading index set for verification in src/server/db/repository.ts after:T013
- [X] T019 [P] [OBJ1] {TR-001,TR-002} Integration test: tenant A cannot read or write tenant B across every tenant-owned table (≥2 tenants, representative reads+writes, 100% blocked) in src/server/__tests__/integration/isolation.test.ts after:T017 ← T006:startTestPostgres ← T016:withTenant
- [X] T020 [P] [OBJ1] {TR-001} Integration test: an unscoped tenant-owned query is refused at the repository and matches zero rows under RLS in src/server/__tests__/integration/unscoped-refusal.test.ts after:T017 ← T016:UnscopedQueryError
- [X] T021 [P] [OBJ1] {TR-003} [COMPLETES TR-003] Integration test: pool no-bleed — a reused pooled connection carries no prior tenant context after DISCARD ALL in src/server/__tests__/integration/pool-nobleed.test.ts after:T017 ← T009:getPool
- [X] T022 [P] [OBJ1] {TR-002} [COMPLETES TR-002] Integration test connecting as non-owner licensesrv_app: RLS is forced and owner-only DDL is denied to the app role in src/server/__tests__/integration/rls-forced.test.ts after:T014 ← T006:connectAs

---

## Phase 4: OBJ2 — Schema and gated migrations (Priority: P1) 🎯 MVP

**Migrations only via the advisory-locked runner, never on boot; expand/contract; per-migration transaction (HINT-005, TR-015).**

- [X] T023 [OBJ2] {TR-006} [COMPLETES TR-006] Document and enforce expand/contract policy (additive expand first; destructive contract deferred ≥2 releases) in migrations/README.md and a drizzle.config guard in drizzle.config.ts after:T004
- [X] T024 [P] [OBJ2] {TR-005} [COMPLETES TR-005] Integration test: foundational schema (tenant, user, role, api_key, audit_log) is created via the migration harness in src/server/__tests__/integration/schema-applied.test.ts after:T015 ← T015:runMigrations
- [X] T025 [P] [OBJ2] {TR-007} Integration test: two concurrent runners — only one applies migrations, the other waits then no-ops (advisory lock single-runner) in src/server/__tests__/integration/migration-singlerunner.test.ts after:T015 ← T015:MIGRATION_LOCK_KEY
- [X] T026 [P] [OBJ2] {TR-015} [COMPLETES TR-015] Integration test: a failed migration leaves no half-applied schema (per-migration tx) and a crashed runner auto-releases the advisory lock in src/server/__tests__/integration/migration-atomicity.test.ts after:T015 ← T015:runMigrations
- [X] T027 [P] [OBJ2] {TR-007} [COMPLETES TR-007] Integration test: migrations run only as a discrete advisory-locked step and never implicitly on app boot in src/server/__tests__/integration/migration-gated.test.ts after:T015 ← T015:runMigrations
- [X] T028 [P] [OBJ2] {TR-006} Integration test: the N-1 prior schema runs unchanged against the migrated schema (expand/contract verified) in src/server/__tests__/integration/expand-contract.test.ts after:T024 ← T015:runMigrations
- [X] T029 [OBJ2] {TR-014} [COMPLETES TR-014] Add Postgres 16.4+ minimum + 30-day patch-policy assertion and deployment config note in src/server/db/client.ts and deploy/postgres-version.md after:T009 ← T009:assertPgVersion

---

## Phase 5: OBJ3 — Append-only audit and modular skeleton (Priority: P1) 🎯 MVP

**Append-only audit (INSERT/SELECT only, no UPDATE/DELETE grant); module seams; tenant-resolution API-key auth; RBAC + scope-AND-role fail-closed.**

- [X] T030 [OBJ3] {TR-008} Implement append-only audit writer that inserts (actor, action, target, ts, security_event) in the mutation's transaction via the repository in src/server/audit/index.ts after:T016 ← T016:withTenant → exports: writeAudit(entry), recordSecurityEvent()
- [X] T031 [OBJ3] {TR-008} [COMPLETES TR-008] Integration test: every mutation produces an append-only audit row and the app role is denied UPDATE/DELETE on audit_log in src/server/__tests__/integration/audit-appendonly.test.ts after:T030 ← T030:writeAudit ← T006:connectAs
- [X] T032 [P] [OBJ3] {TR-012} Implement hashing utilities (HMAC-SHA-256 api_key.key_hash, salted SHA-256 user.email_hash) in src/server/db/hash.ts → exports: hashApiKey(raw), hashEmail(email)
- [X] T033 [OBJ3] {TR-009} Implement API-key tenant-resolution auth (hash lookup, resolve single tenant, expose to repository) in src/server/auth/apikey.ts after:T032 ← T032:hashApiKey → exports: resolveTenantFromApiKey(rawKey), AuthContext(tenantId,scopes)
- [X] T034 [OBJ3] {TR-013,TR-016} Implement RBAC + scope-AND-role fail-closed authz (permit only if API-key scope AND tenant role each allow; deny→security event) in src/server/auth/rbac.ts after:T033 ← T033:AuthContext → exports: authorize(ctx,operation)
- [X] T035 [OBJ3] {TR-011} [COMPLETES TR-011] Wire cross-tenant access block + security_event audit in the repository and auth path in src/server/db/repository.ts and src/server/audit/index.ts after:T034 ← T030:recordSecurityEvent
- [X] T036 [OBJ3] {TR-010} Implement Fastify bootstrap + modular-monolith skeleton with reserved boundary-enforced module seams (E004..E009) in src/server/app.ts and src/server/modules/index.ts after:T033 ← T033:resolveTenantFromApiKey → exports: buildApp(), moduleRegistry
- [X] T037 [P] [OBJ3] {TR-010} [COMPLETES TR-010] Add module-boundary enforcement (ESLint boundary rule) + a test that a cross-module import violating reserved seams is blocked in src/server/__tests__/unit/module-boundary.test.ts after:T036 ← T036:moduleRegistry
- [X] T038 [P] [OBJ3] {TR-009} [COMPLETES TR-009] Integration test: a valid tenant-scoped API key resolves to exactly one tenant enforced on every query in src/server/__tests__/integration/apikey-resolution.test.ts after:T033 ← T033:resolveTenantFromApiKey
- [X] T039 [P] [OBJ3] {TR-013,TR-016} [COMPLETES TR-013] [COMPLETES TR-016] Integration test: RBAC denies an unauthorized role; scope-AND-role fail-closed denial is surfaced as an auditable security event in src/server/__tests__/integration/rbac-failclosed.test.ts after:T035

---

## Phase 6: Hardening & Non-Functional

**GDPR export/erase, security scans, coverage, and remaining integration suite. No work-item label.**

- [X] T040 [P] {TR-012} Implement GDPR tenant export (tenant-scoped read across user/role/api_key/audit_log → portable bundle) in src/server/db/gdpr.ts after:T017 ← T016:withTenant → exports: exportTenantData(tenantId)
- [X] T041 {TR-012} [COMPLETES TR-012] Implement GDPR tenant erase (hard-delete/pseudonymize rows; redact audit before/after/target_id while preserving actor/action/ts; tenant tombstone via deleted_at) in src/server/db/gdpr.ts after:T040 ← T040:exportTenantData → exports: eraseTenantData(tenantId)
- [X] T042 [P] Integration test: GDPR export returns all tenant-owned rows and erase removes/redacts personal data while preserving immutable audit event records in src/server/__tests__/integration/gdpr.test.ts after:T041 ← T041:eraseTenantData
- [X] T043 [P] Run security gate: npm audit (0 high/critical) + Semgrep (0 high-severity SAST) and record results in the CI step in .github/workflows/server-ci.yml after:T039
- [X] T044 [P] Enforce coverage gate: c8 ≥80% lines AND branches over src/server/ in vitest.config.ts and the CI step after:T042
- [X] T045 Run the full Testcontainers integration suite (isolation, unscoped-refusal, pool no-bleed, RLS forced, migration single-runner/atomicity/gated/expand-contract, audit append-only, RBAC fail-closed, GDPR) as a CI job in .github/workflows/server-ci.yml after:T044

---

## Dependencies

**Phase graph**: Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (OBJ1) → Phase 4 (OBJ2) → Phase 5 (OBJ3) → Phase 6 (Hardening). OBJ1/OBJ2/OBJ3 are all P1; OBJ1 must land first because the repository wrapper and forced RLS are the substrate OBJ2 and OBJ3 build on.

**HINT-ordered hard edges**:

- **HINT-001 (RLS/repository-first)**: T009 (DB client + pool) → T010 (schema) → T011/T014 (RLS migration: FORCE + policies + grants) → T015 (advisory-locked runner) → T016 (repository wrapper). No OBJ1/OBJ2/OBJ3 task may start before T016 exists.
- **HINT-002 (non-owner role)**: T014 creates `licensesrv_app` as non-owner, non-superuser, `NOBYPASSRLS`; T006 provisions it for tests; T022 and T031 connect as that role and assert owner-DDL/audit-mutation denial. The app role must never be the table owner or a superuser.
- **HINT-003 (repository is the only GUC setter)**: only T016 sets `app.current_tenant` (via `SET LOCAL`); T017, T030, T033, T035, T040, T041 and all queries must route through `withTenant`/the repository — never query Drizzle outside it. RLS is the net, not the gate.
- **HINT-004 (DISCARD ALL no-bleed)**: T009 resets pooled connections with `DISCARD ALL` on return; T021 is the pool-reuse no-bleed test.
- **HINT-005 (advisory-locked, never-on-boot, expand/contract)**: T015 is the only migration entry point; T023 enforces expand/contract; T025/T026/T027 assert single-runner, atomicity/lock-release, and gated (never-on-boot) execution.

**Parallelism**:

- `[P]` tasks within a phase touch disjoint files and may run together.
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.
- Phase 1: T002–T008 are `[P]` after T001. Phase 2: T011 is `[P]` after T010; the rest are sequential per the HINT-001 chain. Phases 3–6: test tasks are `[P]` once their producing implementation task is complete.
