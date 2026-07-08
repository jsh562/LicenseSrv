---
description: "Task list for feature implementation: No-Code Licensing Catalog (E007)"
---

# Tasks: No-Code Licensing Catalog

**Feature**: `00008-no-code-licensing-catalog` | **Epic**: E007 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00008-no-code-licensing-catalog/` (spec.md, plan.md, data-model.md, contracts/catalog-api.openapi.yaml, checklists/{security,api-quality,data-integrity}.md)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (value/type, immutability, effective shaping), Testcontainers integration (RLS isolation, RBAC + security_event, duplicate/type-locked/archived 409, archive cascade, audit coverage), RTL/jsdom component tests, and a ≥80% line+branch coverage gate. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). Each P1 story is an independently testable slice — backend stories are Testcontainers-integration-testable via Fastify `inject`; SPA views are component-testable against a mocked `catalogApi`.

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005) and the Postgres schema (migrations `0000`–`0005`), plus the existing React + Vite admin SPA (`src/admin-ui/`, E005). No generic bootstrap: a new `catalog` module registers at the reserved module seam and migration `0006` is expand-only after `0005`.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Define & manage products | P1 🎯 MVP | `product` CRUD + archive-cascade + REST | Admin creates/edits/archives a product; dup key → 409; archived retained but excluded (SC-001/008) |
| US2 — Define & manage plans | P1 🎯 MVP | `plan` CRUD + seat limit + archive + REST | Plan created under a product w/ default seat 1; dup-per-product 409; never re-parented (SC-002) |
| US3 — Define feature entitlements | P1 🎯 MVP | `entitlement` CRUD + type-immutability guard + REST | One boolean + one integer_limit entitlement; type change on a referenced entitlement → 409 (SC-003) |
| US4 — Configure per-plan values + effective read model | P1 🎯 MVP | `plan_entitlement` upsert/remove + effective-plan read (E008 seam) | Set/edit bool+int values persist immediately; type mismatch → 400; effective definition retrievable (SC-004/005/009) |
| US5 — Browse role-gated & tenant-isolated | P1 🎯 MVP | requireRole + CSRF sweep + audited denial + RLS isolation | Viewer 403 + security_event; tenant B cannot see tenant A's catalog (SC-006/007) |
| US6 — Export the catalog declaratively | P2 (non-blocking) | declarative YAML/JSON export route | Export returns all products/plans/entitlements/values — `[DEFERRED]` |
| Frontend + Polish | — | SPA catalog views (FR-015) + coverage/CI hardening | Views render; RequireRole hides admin actions; invalid-value inline error; ≥80% coverage |

**MVP gate**: US1 + US2 + US3 + US4 + US5 (all P1). US6 (P2) is explicitly non-blocking; every US6 task is tagged `[US6] [DEFERRED]` and lives in its own phase after the P1 phases. The effective-plan read model (FR-014, T023) is the **E008 issuance seam**.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds expand-only `0006_catalog.sql` after `0005`, no change to `0000`–`0005`); `src/server/modules/index.ts` (registers the reserved E007 catalog seam alongside `registerSigning`/`registerAdmin`); `src/admin-ui/src/api.ts` (adds `catalogApi`) and `src/admin-ui/src/components/Shell.tsx` (adds a Catalog nav tab).
- **Patterns reused**: `withTenant`/`privileged` (`src/server/db/client.ts`), `writeAudit`/`recordSecurityEvent` (`src/server/audit/index.ts`), `requireRole` + CSRF double-submit (`src/server/modules/admin/rbac-middleware.ts`, `csrf.ts`), the forced-RLS migration form (`migrations/0005_admin_sessions.sql`), Zod route validation + `{code,message,details?}` errors (`src/server/modules/admin/routes.ts`), the SPA `adminApi` client + `RequireRole` + Shell nav (`src/admin-ui/src`).
- **Key constraints folded in**: keys immutable after creation (FR-018, PATCH schemas omit `key`); denial security-event content (FR-019: actor/action/target/reason); per-plan value set/remove audited (SC-011); bounded non-paginated lists cap 1000 (AD-009); archived write-freeze `409 archived` + effective active-only read (AD-010); IDs are `uuid` `PK (tenant_id, id)` (AD-002).
- **Regression focus**: existing E002 RLS/tenant isolation and audit append-only semantics keep working; the four new tables are additive and forced-RLS; the E004 `signing_key.product_id` deferred FK is intentionally NOT applied in `0006`.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Extend coverage include globs to scope src/server/modules/catalog/** and src/admin-ui/src/pages/catalog/** for the >=80% gate in vitest.config.ts and src/admin-ui/vite.config.ts

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**Migration `0006` + the catalog module scaffold + shared validation helpers block every delivery story. Complete before any US phase.**

- [ ] T002 {FR-002,FR-003,FR-004} Create product/plan/entitlement/plan_entitlement tables + composite FKs + UNIQUE keys + value/seat CHECKs + tenant-leading indexes in migrations/0006_catalog.sql
- [ ] T003 {FR-010} Add ENABLE/FORCE RLS + tenant_isolation policy (USING/WITH CHECK app.current_tenant) + grants to licensesrv_app on all four tables in migrations/0006_catalog.sql
- [ ] T004 [P] {FR-005,FR-008} Shared validation (key slug, status filter, value/type) in src/server/modules/catalog/validation.ts → exports: catalogKeySchema, assertValueMatchesType
- [ ] T005 [P] Catalog module config + registerCatalog seam (CatalogConfig; list cap 1000; camelCase mappers) in src/server/modules/catalog/index.ts → exports: CatalogConfig, registerCatalog
- [ ] T006 [P] {FR-010} Integration test 0006: four tables + forced RLS; unset app.current_tenant → 0 rows in src/server/modules/catalog/__tests__/migration.integration.test.ts after:T003

---

## Phase 3: US1 — Define and manage products (Priority: P1) 🎯 MVP

**Independent test**: an admin creates a product (unique key), sees it listed, edits its name (key rejected), and archives it — archiving cascades to its plans and drops it from the default active list while retaining it (SC-001, SC-008).

- [ ] T007 [P] [US1] {FR-001,FR-002} Products CRUD: create 201/dup 409, list ?status, PATCH (key rejected), audit in src/server/modules/catalog/__tests__/products.integration.test.ts after:T005
- [ ] T008 [P] [US1] {FR-013} Product archive: retained, excluded from active list, cascades to plans (SC-008) in src/server/modules/catalog/__tests__/archive.integration.test.ts after:T005
- [ ] T009 [US1] {FR-001,FR-002,FR-012,FR-013} Product repo: create/list(?status cap 1000)/get/update/archive, audited in src/server/modules/catalog/products.ts → exports: createProduct, getProduct
- [ ] T010 [US1] {FR-001,FR-002,FR-018} [COMPLETES FR-001,FR-002] Register products routes (requireRole; CSRF; dup 409) in src/server/modules/catalog/routes.ts → exports: registerCatalogRoutes

---

## Phase 4: US2 — Define and manage plans within a product (Priority: P1) 🎯 MVP

**Independent test**: an admin creates a plan under a product (default seat limit 1), sets an explicit `maxActivations`, edits it (`<1` → 400), confirms it carries its `productId` and is never re-parented, and archives it (SC-002).

- [ ] T011 [P] [US2] {FR-003,FR-004,FR-013} Plan IT: default seat 1, dup 409, get→productId, seat<1 400, archive (SC-002) in src/server/modules/catalog/__tests__/plans.integration.test.ts after:T010
- [ ] T012 [US2] {FR-003,FR-004,FR-012,FR-013} Plan repo: create/list/get(+productId)/update/archive, audited in src/server/modules/catalog/plans.ts after:T009 → exports: createPlan, getPlan
- [ ] T013 [US2] {FR-003,FR-004,FR-018} [COMPLETES FR-003,FR-004] Register plans routes (requireRole; CSRF; dup 409; seat<1 400) in src/server/modules/catalog/routes.ts

---

## Phase 5: US3 — Define feature entitlements (Priority: P1) 🎯 MVP

**Independent test**: an admin defines one `boolean` and one `integer_limit` entitlement (unique key), edits name/description, and finds a type change refused once a plan references the entitlement (`409 entitlement_type_locked`) (SC-003).

- [ ] T014 [P] [US3] {FR-005,FR-006} Entitlement IT: create bool/int, dup 409, type-locked 409, archive (SC-003) in src/server/modules/catalog/__tests__/entitlements.integration.test.ts after:T010
- [ ] T015 [US3] {FR-005,FR-012,FR-013} Entitlement repo: create(bool/int)/list/get/update/archive, audited in src/server/modules/catalog/entitlements.ts → exports: createEntitlement, getEntitlement
- [ ] T016 [US3] {FR-006} Type-immutability guard: plan_entitlement ref check FOR UPDATE, refuse type change 409 in src/server/modules/catalog/entitlements.ts → exports: assertTypeMutable
- [ ] T017 [US3] {FR-005,FR-006,FR-013,FR-018} [COMPLETES FR-005,FR-006,FR-013,FR-018] Register entitlements routes (dup 409, type_locked 409) in src/server/modules/catalog/routes.ts after:T016

---

## Phase 6: US4 — Configure per-plan values + effective read model (Priority: P1) 🎯 MVP

**Independent test**: an admin attaches entitlements to a plan and sets values (boolean on/off, integer-limit ≥0), edits one and confirms it persists immediately with no deploy; a type-mismatched/negative value is rejected 400 with nothing saved; the effective plan definition is retrievable for issuance (SC-004/005/009). **FR-014 (T023) is the E008 issuance seam.**

- [ ] T018 [P] [US4] {FR-007,FR-008} Value/type unit: bool on boolean, int>=0, mismatch/negative rejected in src/server/modules/catalog/__tests__/values.unit.test.ts after:T004
- [ ] T019 [P] [US4] {FR-014} Effective-shape unit: planKey/productKey/maxActivations/entitlements; active-only; empty in src/server/modules/catalog/__tests__/effective.unit.test.ts after:T005
- [ ] T020 [P] [US4] {FR-007,FR-008,FR-009} Value upsert IT: 200 upsert, 400 mismatch/neg, 204 detach, 404 unknown in src/server/modules/catalog/__tests__/values.integration.test.ts after:T017
- [ ] T021 [P] [US4] {FR-014,FR-016} Effective IT: latest values, active-only, archived plan resolves (SC-009) in src/server/modules/catalog/__tests__/effective.integration.test.ts after:T017
- [ ] T022 [P] [US4] {FR-007,FR-008,FR-012} [COMPLETES FR-008] Value repo: type-check→400, active-else-409 archived, upsert 200/detach, audit set+remove in src/server/modules/catalog/values.ts
- [ ] T023 [P] [US4] {FR-014,FR-016} [COMPLETES FR-014,FR-016] Effective plan read model (active-only; E008 seam) in src/server/modules/catalog/effective.ts → exports: getEffectivePlanDefinition
- [ ] T024 [US4] {FR-007,FR-009} [COMPLETES FR-007,FR-009] Register plan-entitlement GET/PUT/DELETE + effective route (requireRole; CSRF) in src/server/modules/catalog/routes.ts after:T022

---

## Phase 7: US5 — Browse the catalog, role-gated and tenant-isolated (Priority: P1) 🎯 MVP

**Independent test**: a viewer browses products/plans/entitlements but a mutation is denied 403 and recorded as a security event with FR-019 content; a second tenant sees none of the first tenant's catalog and a cross-tenant id resolves to 404 (SC-006/007).

- [ ] T025 [P] [US5] {FR-011,FR-019} RBAC IT: viewer 403 + security_event, admin ok, CSRF-missing 403 (SC-006) in src/server/modules/catalog/__tests__/rbac.integration.test.ts after:T024
- [ ] T026 [P] [US5] {FR-010} [COMPLETES FR-010] Tenant-isolation IT: A invisible from B, cross-tenant id 404 in src/server/modules/catalog/__tests__/isolation.integration.test.ts after:T024
- [ ] T027 [US5] {FR-011,FR-019} [COMPLETES FR-011,FR-019] Apply requireRole+CSRF to every catalog route; audited denial w/ FR-019 content in src/server/modules/catalog/routes.ts after:T024

---

## Phase 8: US6 — Export the catalog declaratively (Priority: P2)

**Non-blocking for the P1 MVP gate. Delivered after the P1 phases; reuses the effective read model.**

- [ ] T028 [P] [US6] {FR-017} [DEFERRED] Export IT: declarative doc contains products/plans/entitlements/per-plan values in src/server/modules/catalog/__tests__/export.integration.test.ts after:T024
- [ ] T029 [US6] {FR-017} [DEFERRED] [COMPLETES FR-017] Implement declarative YAML/JSON export + GET /admin/catalog/export route in src/server/modules/catalog/export.ts after:T023

---

## Phase 9: Frontend (React SPA catalog views)

**The catalog views (FR-015) plug into the E005 console shell behind RBAC. Each view is component-testable against a mocked `catalogApi`; the `[US#]` tags mark which story slice a task surfaces.**

- [ ] T030 {FR-015} Extend admin API client with catalogApi (products/plans/entitlements/values/effective; camelCase; CSRF echo) in src/admin-ui/src/api.ts → exports: catalogApi
- [ ] T031 {FR-015} Add a Catalog nav tab to the console shell in src/admin-ui/src/components/Shell.tsx ← T030:catalogApi
- [ ] T032 [P] [US1] {FR-015} Products view (list ?status; create/edit; archive; RequireRole hides admin actions) in src/admin-ui/src/pages/catalog/Products.tsx ← T030:catalogApi
- [ ] T033 [P] [US2] {FR-015} Plans view (list under product; create/edit incl maxActivations; archive) in src/admin-ui/src/pages/catalog/Plans.tsx ← T030:catalogApi
- [ ] T034 [P] [US3] {FR-015} Entitlements view (list; create boolean/integer_limit; edit name/desc; archive) in src/admin-ui/src/pages/catalog/Entitlements.tsx ← T030:catalogApi
- [ ] T035 [P] [US4] {FR-015} PlanValues view (attach entitlements; set bool/int w/ inline invalid-value error; remove) in src/admin-ui/src/pages/catalog/PlanValues.tsx ← T030:catalogApi
- [ ] T036 {FR-015} [COMPLETES FR-015] RTL (mocked catalogApi): views render; RequireRole hides admin actions; invalid-value inline error in src/admin-ui/src/pages/catalog/__tests__/ after:T035

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T037 [P] {FR-012} [COMPLETES FR-012] Audit-coverage: 5 mutation types write actor/action/target (SC-010/011) in src/server/modules/catalog/__tests__/audit.integration.test.ts after:T027
- [ ] T038 Register registerCatalog in src/server/modules/index.ts alongside registerSigning/registerAdmin after:T027 ← T005:registerCatalog
- [ ] T039 [P] Enforce >=80% line+branch coverage of the catalog module + SPA catalog views (Vitest v8) and wire the coverage gate after:T036
- [ ] T040 [P] Add npm audit (--omit=dev --audit-level=high) + semgrep (CI) for the catalog module + SPA to the CI workflow in .github/workflows/

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8, P2 non-blocking) → Frontend (Phase 9) → Polish (Phase 10)

- **Phase 1 (Setup)** has no dependencies.
- **Phase 2 (Foundational)** depends on Setup; migration `0006` is authored across T002→T003 (same file, sequential); T004 (validation) and T005 (module config + `registerCatalog`) are independent scaffolds; T006 verifies the migration (after:T003).
- **US1–US5 (P1)** each depend on the Foundational migration + module scaffold and are independently testable slices. The shared `routes.ts` is created in US1 (T010 → `registerCatalogRoutes`) and extended by each later story; per-story integration tests are TDD-first and anchor to the prior phase's route task (`after:T010` / `after:T017` / `after:T024`).
- **US4** builds `values.ts` (T022) and `effective.ts` (T023, the E008 read-model seam) then wires their routes (T024). `effective.ts` reads plan/entitlement rows produced by US2/US3 repos.
- **US5** completes the RBAC/CSRF sweep (T027) and proves tenant isolation (T026) + audited denial (T025) across the full catalog route surface (after:T024).
- **US6 (P2)** is non-blocking for the P1 MVP gate; it reuses the effective read model (T023) and adds only the export module/route.
- **Frontend (Phase 9)** depends on the `catalogApi` client (T030) and the corresponding backend routes; component tests (T036) run against a mocked API and do not block backend delivery.
- **Polish (Phase 10)** depends on all P1 stories being complete: the audit-coverage test (T037) and module registration at the seam (T038) both follow the US5 sweep (after:T027); the coverage gate (T039) follows the SPA tests (after:T036).
- Tasks marked `[P]` can run in parallel within their phase (distinct files, no intra-batch dependency).
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.
