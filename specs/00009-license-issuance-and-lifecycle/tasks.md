---
description: "Task list for feature implementation: License Issuance and Lifecycle (E008)"
---

# Tasks: License Issuance and Lifecycle

**Feature**: `00009-license-issuance-and-lifecycle` | **Epic**: E008 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00009-license-issuance-and-lifecycle/` (spec.md, plan.md, data-model.md, contracts/licensing-api.openapi.yaml, research.md, checklists/{security,api-quality,data-integrity}.md)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (claims builder snapshot→Claims, state-machine transitions, transfer-limit), Testcontainers integration (issue→signed LIC1 that verifies offline via the E001 core, snapshot immutability, lifecycle + invalid-transition 409, transfer-limit 409, archived-plan 409, signer-unavailable 503, RLS isolation, RBAC + security_event, customer erasure, audit coverage), a Performance assertion (FR-017), RTL/jsdom component tests, and a ≥80% line+branch coverage gate. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). Each P1 story is an independently testable slice — backend stories are Testcontainers-integration-testable via Fastify `inject`; SPA views are component-testable against a mocked `licensingApi`.

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005/E007) and the Postgres schema (migrations `0000`–`0006`), plus the existing React + Vite admin SPA (`src/admin-ui/`, E005/E007). No generic bootstrap: a new `issuance` module registers at the reserved E008 module seam and migration `0007` is expand-only after `0006`. Two sibling seam edits are required — the E004 signer DI decorator and the E007 effective-read-model id extension.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Issue a signed license | P1 🎯 MVP | snapshot effective def + build Claims + `app.signer.sign` → LIC1 + store | Admin issues under a plan for a customer; token verifies offline via the E001 core; archived 409; signer 503 (SC-001/002/003) |
| US2 — Revoke a license | P1 🎯 MVP | lifecycle state machine + revoke (terminal, idempotent) | Revoke active/suspended→revoked; re-revoke no-op; revoked reinstate/transfer refused (SC-004/008) |
| US3 — Suspend and reinstate | P1 🎯 MVP | active↔suspended transitions | Suspend active→suspended; reinstate suspended→active; invalid transition 409 (SC-005/008) |
| US4 — Transfer to another customer | P1 🎯 MVP | transfer + per-license transfer limit | Transfer within limit; at-limit 409; revoked transfer refused (SC-006) |
| US5 — Registry + customers + key retrieval | P1 🎯 MVP | customers CRUD/erase + registry list/get + get-key + RBAC/RLS sweep | Registry shows status/customer/plan/expiry + retrieve key; viewer 403 + security_event; A≠B (SC-007/009/010) |
| US6 — Reissue after key rotation | P2 (non-blocking) | re-sign same terms with current key | Reissue → new keyId/token, terms unchanged; revoked 409 — `[DEFERRED]` |
| Frontend + Polish | — | SPA issuance/registry/customer views + coverage/perf/CI hardening | Views render; RequireRole hides admin actions; inline errors; ≥80% coverage; p95<1s |

**MVP gate**: US1 + US2 + US3 + US4 + US5 (all P1). US6 (P2) is explicitly non-blocking; every US6 task is tagged `[US6] [DEFERRED]` and lives in its own phase after the P1 phases. The E004 signer (via `app.signer`) and the E007 effective-plan read model are the integration seams.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds expand-only `0007_licensing.sql` after `0006`, no change to `0000`–`0006`); `src/server/modules/index.ts` (registers the reserved E008 issuance seam alongside `registerSigning`/`registerAdmin`/`registerCatalog`); `src/server/modules/signing/index.ts` (adds the `app.signer` DI decorator — the E008/E010 seam, mirroring `signerReady`); `src/server/modules/catalog/effective.ts` (extends `getEffectivePlanDefinition` to also return `productId`+`planId`, with an added id-case in `src/server/modules/catalog/__tests__/catalog.integration.test.ts`); `src/admin-ui/src/api.ts` (adds `licensingApi`) and `src/admin-ui/src/components/Shell.tsx` (adds a Licensing nav tab).
- **Patterns reused**: `withTenant`/`privileged` (`src/server/db/client.ts`), `writeAudit`/`recordSecurityEvent` (`src/server/audit/index.ts`), the shared console `requireRole` + CSRF double-submit (`src/server/console/`), the module seam (`src/server/modules/index.ts`), the forced-RLS migration form (`migrations/0006_catalog.sql`), Zod route validation + `{code,message,details?}` errors + the `guard()` error→HTTP pattern (`src/server/modules/catalog/routes.ts`), the E004 `Signer`/`Claims` contract + `SignerError` (`src/server/modules/signing/{signer,token}.ts`), the SPA `catalogApi`/`RequireRole`/Shell nav (`src/admin-ui/src`).
- **Key constraints folded in**: point-in-time snapshot copied at issue (catalog edits never mutate an issued license, FR-006); the signing key is never in any response/log/audit (FR-003/SC-010, only the public LIC1 token); the signer conformance-verifies before return + stamps `key_id` (HINT-002); fail-closed `503 signer_unavailable` with no partial license (FR-004/HINT-005); app-enforced lifecycle state machine in one tenant tx `FOR UPDATE` (HINT-004); `transfer_count` bounded by `IssuanceConfig.transferLimit` (env, default 3, AD-006); revoke idempotent; customer erasure anonymizes-if-licensed else hard-deletes (FR-019); IDs are `uuid` `PK (tenant_id, id)` (AD-002); bounded non-paginated lists cap 1000 (AD-009).
- **SPA note**: E008 defines no UI-specific functional requirement (NEW-UI is an implementation signal). The SPA view/RTL tasks carry `[US#]` delivery labels only and surface the already-implemented, already-tested backend FRs — each FR is completed at its backend task, not in a React view.
- **Regression focus**: existing E002 RLS/tenant isolation and audit append-only semantics keep working; the two new tables are additive and forced-RLS; the E004 `signing_key.product_id` deferred FK is intentionally NOT applied in `0007`; the effective-read-model extension is additive and backward-compatible (the added catalog test case guards it).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Extend coverage include globs to scope src/server/modules/issuance/** and src/admin-ui/src/pages/licensing/** for the >=80% gate in vitest.config.ts and src/admin-ui/vite.config.ts

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**Migration `0007` + the issuance module scaffold + the two sibling seam edits (`app.signer` decorator, effective-read-model id extension) + the claims builder block every delivery story. Complete before any US phase. T006 also adds an id-extension case to `src/server/modules/catalog/__tests__/catalog.integration.test.ts`.**

- [ ] T002 {FR-002,FR-015,FR-019} Create customer + license tables (composite FKs, UNIQUE(tenant_id,ref), status/seat/transfer CHECKs, tenant-leading indexes) in migrations/0007_licensing.sql
- [ ] T003 {FR-015} Add ENABLE/FORCE RLS + tenant_isolation policy + grants to licensesrv_app on customer+license in migrations/0007_licensing.sql
- [ ] T004 [P] Issuance module scaffold: IssuanceConfig (transferLimit, default 3) + registerIssuance seam in src/server/modules/issuance/index.ts → exports: registerIssuance, IssuanceConfig
- [ ] T005 [P] {FR-003} Signer DI seam: app.decorate("signer", module.signer) (like signerReady) in src/server/modules/signing/index.ts → exports: app.signer
- [ ] T006 [P] {FR-002,FR-006} Extend getEffectivePlanDefinition to return productId+planId in src/server/modules/catalog/effective.ts → exports: EffectivePlanDefinition
- [ ] T007 [P] {FR-002} Unit: claims builder maps snapshot→Claims (perpetual null exp; entitlements {key:value}; nonce) in src/server/modules/issuance/__tests__/claims.unit.test.ts
- [ ] T008 {FR-002,FR-003} Claims builder: snapshot→E001 Claims (ids, issuedAt=now, exp, maxActivations, ent map, nonce) in src/server/modules/issuance/claims.ts → exports: buildClaims after:T006
- [ ] T009 [P] {FR-015} IT: 0007 tables + forced RLS; unset app.current_tenant → 0 rows in src/server/modules/issuance/__tests__/migration.integration.test.ts after:T003

---

## Phase 3: US1 — Issue a signed license (Priority: P1) 🎯 MVP

**Independent test**: an admin issues a license under an active plan for a customer and receives a signed LIC1 key that verifies offline against the product's key and embeds the entitlements, seat limit, and expiry; a perpetual (no-expiry) license is supported; an archived plan → 409 and an unavailable signer → 503 with no license created (SC-001/002/003). **The integration suite provisions an E004 product signing key + unlocks custody (reuse the E004 signing test setup).**

- [ ] T010 [P] [US1] {FR-001,FR-002,FR-003} IT: issue→LIC1 verifies offline; perpetual+time-limited; embeds ent/seat/expiry (SC-002) in src/server/modules/issuance/__tests__/issue.integration.test.ts
- [ ] T011 [P] [US1] {FR-005,FR-006} IT: archived 409 plan_not_issuable; snapshot immutable after catalog edit (SC-003) in src/server/modules/issuance/__tests__/snapshot.integration.test.ts
- [ ] T012 [P] [US1] {FR-004} IT: signer-unavailable (no active key / locked) → 503, no license created in src/server/modules/issuance/__tests__/signer.integration.test.ts
- [ ] T013 [US1] {FR-001,FR-002,FR-004,FR-005,FR-006,FR-017} [COMPLETES FR-002,FR-006] Issue service (snapshot+claims+sign; archived 409/signer 503) in src/server/modules/issuance/licenses.ts
- [ ] T014 [US1] {FR-001,FR-003} [COMPLETES FR-001,FR-003] Register POST /admin/licenses issue route (requireRole admin+CSRF; 201/404/409/503) in src/server/modules/issuance/routes.ts

---

## Phase 4: US2 — Revoke a license (Priority: P1) 🎯 MVP

**Independent test**: an admin revokes an active (or suspended) license → terminal `revoked`; re-revoking is an idempotent 200 no-op; a revoked license refuses reinstate/transfer with a clear 409; every action is audited (SC-004/008).

- [ ] T015 [P] [US2] {FR-010} Unit: lifecycle state machine transitions (valid/invalid/terminal; revoke idempotent) (SC-008) in src/server/modules/issuance/__tests__/lifecycle.unit.test.ts
- [ ] T016 [P] [US2] {FR-007} IT: revoke active/suspended→revoked; idempotent no-op; revoked reinstate/transfer refused 409 (SC-004) in src/server/modules/issuance/__tests__/revoke.integration.test.ts
- [ ] T017 [US2] {FR-007,FR-010,FR-014} Lifecycle state machine + revoke service (FOR UPDATE, validate, update+audit; idempotent) in src/server/modules/issuance/lifecycle.ts
- [ ] T018 [US2] {FR-007} [COMPLETES FR-007] Register POST /admin/licenses/{id}/revoke route (requireRole admin+CSRF; 200 idempotent) in src/server/modules/issuance/routes.ts after:T017

---

## Phase 5: US3 — Suspend and reinstate a license (Priority: P1) 🎯 MVP

**Independent test**: an admin suspends an active license (`active→suspended`) and later reinstates it (`suspended→active`); suspending a non-active or reinstating a non-suspended license → 409 invalid_transition, leaving it unchanged; both actions audited (SC-005/008).

- [ ] T019 [P] [US3] {FR-008} IT: suspend active→suspended; reinstate suspended→active; not-active/not-suspended 409 (SC-005/008) in src/server/modules/issuance/__tests__/suspend.integration.test.ts
- [ ] T020 [US3] {FR-008,FR-010,FR-014} Add suspend + reinstate to lifecycle state machine (active↔suspended; audit) in src/server/modules/issuance/lifecycle.ts after:T017
- [ ] T021 [US3] {FR-008} [COMPLETES FR-008] Register suspend + reinstate routes (requireRole admin+CSRF; 409 invalid_transition) in src/server/modules/issuance/routes.ts after:T020

---

## Phase 6: US4 — Transfer a license to another customer (Priority: P1) 🎯 MVP

**Independent test**: an admin transfers an active/suspended license to another customer within its transfer limit — `customerId` changes, `transferCount` increments, action audited; a transfer at/over the limit → 409 transfer_limit_exceeded; a revoked license → 409 invalid_transition; an unknown target customer → 404 (SC-006).

- [ ] T022 [P] [US4] {FR-009} Unit: transfer-limit logic (count<limit ok; at-limit refused) in src/server/modules/issuance/__tests__/transfer.unit.test.ts
- [ ] T023 [P] [US4] {FR-009} IT: transfer→new customer + count++; at-limit 409; revoked 409; unknown customer 404 (SC-006) in src/server/modules/issuance/__tests__/transfer.integration.test.ts
- [ ] T024 [US4] {FR-009,FR-010,FR-014} Add transfer to lifecycle (check transfer_count<transferLimit, reassign customer_id, count++, audit) in src/server/modules/issuance/lifecycle.ts after:T017
- [ ] T025 [US4] {FR-009,FR-010} [COMPLETES FR-009,FR-010] Register transfer route (requireRole admin+CSRF; 409 limit/invalid; 404) in src/server/modules/issuance/routes.ts after:T024

---

## Phase 7: US5 — Browse the registry, register customers, retrieve keys (Priority: P1) 🎯 MVP

**Independent test**: an admin registers/lists customers (dup ref → 409) and erases one (anonymize-if-licensed else hard-delete, 204, no PII in the audit); browses the registry (status/customer/plan/expiry) with `?status/customerId/planId` filters and retrieves a license's signed key; a viewer can read but a mutation is denied 403 + recorded as a security event; a second tenant sees none of the first tenant's licenses/customers and a cross-tenant id resolves to 404 (SC-007/009/010).

- [ ] T026 [P] [US5] {FR-011,FR-019} IT: register(dup 409)/list/get; erase anonymize-vs-hard-delete (204); no-PII erase audit in src/server/modules/issuance/__tests__/customers.integration.test.ts
- [ ] T027 [P] [US5] {FR-012,FR-013} IT: registry list(filters)+get+get-key LIC1; key absent from list/meta (SC-007/010) in src/server/modules/issuance/__tests__/registry.integration.test.ts
- [ ] T028 [P] [US5] {FR-015,FR-016} [COMPLETES FR-015] IT: RLS isolation A≠B (cross-tenant 404); viewer 403+security_event (SC-009) in src/server/modules/issuance/__tests__/isolation.integration.test.ts
- [ ] T029 [P] [US5] {FR-011,FR-014,FR-019} [COMPLETES FR-019] Customers: register/list/get; erase anonymize-if-licensed else hard-delete; audit no-PII in src/server/modules/issuance/customers.ts
- [ ] T030 [P] [US5] {FR-012,FR-013} Registry reads: list(filters, cap 1000)/get/get-key; expose status in src/server/modules/issuance/licenses.ts after:T013
- [ ] T031 [US5] {FR-011} [COMPLETES FR-011] Register customer routes GET/POST /admin/customers + GET/DELETE /{id} (requireRole; CSRF; 409 dup) in src/server/modules/issuance/routes.ts after:T029
- [ ] T032 [US5] {FR-012} [COMPLETES FR-012] Register registry routes GET /admin/licenses[+filters] + GET /{id} + /{id}/key (requireRole viewer) in src/server/modules/issuance/routes.ts after:T030
- [ ] T033 [US5] {FR-014,FR-016} [COMPLETES FR-016] Apply requireRole+CSRF to all issuance routes; audited denial → security_event in src/server/modules/issuance/routes.ts after:T032

---

## Phase 8: US6 — Reissue a license after signing-key rotation (Priority: P2)

**Non-blocking for the P1 MVP gate. Delivered after the P1 phases; the MVP works via the E004 overlapping keyring (old tokens still verify). Reuses the lifecycle tx + the claims builder + `app.signer`.**

- [ ] T034 [P] [US6] {FR-018} [DEFERRED] IT: reissue → new keyId/token; terms/snapshot unchanged; revoked 409; signer 503 in src/server/modules/issuance/__tests__/reissue.integration.test.ts
- [ ] T035 [US6] {FR-018} [DEFERRED] [COMPLETES FR-018] Add reissue (rebuild claims + app.signer.sign, rewrite token/key_id) + register reissue route in src/server/modules/issuance/lifecycle.ts

---

## Phase 9: Frontend (React SPA issuance + registry + customer views)

**The licensing views plug into the E005 console shell behind RBAC and surface the already-complete backend FRs (see SPA note in Brownfield Notes — `[US#]` labels mark the story slice; no `{FR}` re-tagging). Each view is component-testable against a mocked `licensingApi`.**

- [ ] T036 Extend admin API client with licensingApi (customers+licenses+lifecycle; camelCase; CSRF echo) in src/admin-ui/src/api.ts → exports: licensingApi
- [ ] T037 Add a Licensing nav tab to the console shell in src/admin-ui/src/components/Shell.tsx ← T036:licensingApi
- [ ] T038 [P] [US1] Issue view (issue form; signer-unavailable + validation inline errors; RequireRole) in src/admin-ui/src/pages/licensing/Issue.tsx ← T036:licensingApi
- [ ] T039 [P] [US5] Licenses view (registry list + filters + key retrieval; RequireRole hides admin actions) in src/admin-ui/src/pages/licensing/Licenses.tsx ← T036:licensingApi
- [ ] T040 [P] [US5] Customers view (register/list; erase) in src/admin-ui/src/pages/licensing/Customers.tsx ← T036:licensingApi
- [ ] T041 RTL (mocked licensingApi): issue form, registry+key, customers; RequireRole hides admin; signer/invalid-transition inline errors in src/admin-ui/src/pages/licensing/__tests__/ after:T040

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T042 [P] Register registerIssuance alongside signing/catalog in src/server/modules/index.ts ← T004:registerIssuance
- [ ] T043 [P] {FR-017} [COMPLETES FR-017] Perf: single issuance (snapshot+sign+conformance+insert) well under 1s (SC-001) in src/server/modules/issuance/__tests__/perf.integration.test.ts
- [ ] T044 [P] {FR-014} [COMPLETES FR-014] Audit IT: all 7 actions write actor/action/target; no signing-key/PII (SC-010) in src/server/modules/issuance/__tests__/audit.integration.test.ts
- [ ] T045 Enforce >=80% line+branch coverage of issuance module + SPA licensing views in vitest.config.ts + src/admin-ui/vite.config.ts after:T041
- [ ] T046 [P] Add licensing CI workflow (typecheck+lint, Testcontainers IT+coverage, SPA tests, npm audit --omit=dev --audit-level=high, semgrep) in .github/workflows/licensing.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8, P2 non-blocking) → Frontend (Phase 9) → Polish (Phase 10)

- **Phase 1 (Setup)** has no dependencies.
- **Phase 2 (Foundational)** depends on Setup; migration `0007` is authored across T002→T003 (same file, sequential); T004 (module scaffold), T005 (the `app.signer` decorator seam in the signing module), T006 (the effective-read-model id extension in the catalog module, plus its added catalog integration test case), and T007 (claims unit test) are independent; T008 (claims builder) needs T006's `productId`/`planId`; T009 verifies the migration (after:T003). T005 and T006 are the two designated integration seams.
- **US1–US5 (P1)** each depend on the Foundational migration + module scaffold + claims builder and are independently testable slices. The shared `routes.ts` is created in US1 (T014) and extended by each later story; the shared `lifecycle.ts` state machine is created in US2 (T017) and extended by US3/US4 (after:T017). The shared `licenses.ts` is created in US1 (T013) and extended by US5 registry reads (T030, after:T013). Per-story integration tests are TDD-first.
- **US1** builds `licenses.ts` (issue: snapshot the effective read model via `getEffectivePlanDefinition`, `buildClaims`, `app.signer.sign`, store token/keyId; fail-closed archived 409 / signer 503) then wires the issue route.
- **US2/US3/US4** are the lifecycle state machine: revoke (terminal, idempotent), suspend/reinstate, transfer (bounded by `IssuanceConfig.transferLimit`) — each in one tenant tx `FOR UPDATE` with audit; invalid transitions → 409.
- **US5** adds customers (`customers.ts`) + registry reads (`licenses.ts`), wires their routes, and completes the RBAC/CSRF sweep (T033) + proves tenant isolation (T028) and customer erasure (T029) across the full route surface.
- **US6 (P2)** is non-blocking for the P1 MVP gate; it re-signs the same terms with the current key and adds only the reissue transition + route.
- **Frontend (Phase 9)** depends on the `licensingApi` client (T036) and the corresponding backend routes; component tests (T041) run against a mocked API and do not block backend delivery.
- **Polish (Phase 10)** depends on all P1 stories being complete: module registration at the seam (T042, ← T004), the performance assertion (T043, FR-017), audit-coverage (T044, FR-014), the coverage gate (T045, after:T041), and CI (T046).
- Tasks marked `[P]` can run in parallel within their phase (distinct files, no intra-batch dependency).
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.
