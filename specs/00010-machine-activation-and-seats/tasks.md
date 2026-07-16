---
description: "Task list for feature implementation: Machine Activation & Seat Enforcement (E009)"
---

# Tasks: Machine Activation & Seat Enforcement

**Feature**: `00010-machine-activation-and-seats` | **Epic**: E009 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00010-machine-activation-and-seats/` (spec.md, plan.md, data-model.md, contracts/activation-api.openapi.yaml, research.md, checklists/{security,data-integrity,api-quality}.md)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (K-of-N match, claims+fp builder, seat/nonce logic), Testcontainers integration (activate→signed machine-bound LIC1 that verifies offline via the E001 WASM core, a concurrency/seat-race test proving exactly-S, deactivate/reclaim, drift re-activation, registry, RLS isolation + cross-tenant 404, RBAC 403 + security_event, no-PII/no-key audit), a Performance assertion (<1s activation), RTL/jsdom component tests, and a ≥80% line+branch coverage gate. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). All four stories are P1 — each is an independently testable slice: backend stories are Testcontainers-integration-testable via Fastify `inject`; the SPA Activations view is component-testable against a mocked `activationApi`.

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005/E007/E008) and the Postgres schema (migrations `0000`–`0007`), plus the existing React + Vite admin SPA (`src/admin-ui/`, E005/E007/E008). No generic bootstrap: a new `activation` module registers at the reserved E009 module seam and migration `0008` is expand-only after `0007` (already drafted in data-model.md — the task is to finalize/verify it). Two seam edits are required — register `registerActivation` after `registerIssuance` in `src/server/modules/index.ts`, and add the `@fastify/rate-limit` dependency.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Activate with race-safe seat enforcement | P1 🎯 MVP | seat lock (FOR UPDATE license + count<max) + K-of-N resolve + nonce store-and-replay + sign-after-seat fail-closed → machine-bound LIC1 | 2-seat license, two distinct machines verify offline, 3rd refused 409; N racers→exactly S (SC-001/002/003/004/010) |
| US2 — Deactivate to free a seat | P1 🎯 MVP | soft flip active→deactivated (idempotent) via app DELETE + admin reclaim | fill 1-seat, deactivate, a different machine activates into the freed seat; re-deactivate/unknown→idempotent (SC-005/006) |
| US3 — Tolerate minor hardware drift | P1 🎯 MVP | K-of-N (default 3-of-5) reuse + min-signals guard | change one of five signals→same seat reused + verifies offline; <K signals→new; too-few→400 (SC-007/008) |
| US4 — Browse the activation registry | P1 🎯 MVP | per-license list (pseudonymous) + seats-used/limit + RBAC/CSRF + tenant isolation | two machines listed with identity/status/timestamps + seat summary; viewer 403+security_event; cross-tenant 404 (SC-009/011/012) |
| Frontend + Polish | — | SPA Activations view + rate-limit/perf/audit/coverage/CI hardening | view renders; RequireRole hides reclaim; ≥80% coverage; <1s activation; 429 + Retry-After audited |

**MVP gate**: US1 + US2 + US3 + US4 (all P1). No P2/DEFERRED work in this epic. The E004 signer (via `app.signer`, decorated for E008), the E008 `license` snapshot (via `getLicense`, non-internal import), and the E001 WASM verifier core (offline machine-bound verify in tests) are the integration seams.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (finalizes expand-only `0008_activation.sql` after `0007`; no change to `0000`–`0007`); `src/server/modules/index.ts` (registers the reserved E009 activation seam AFTER `registerIssuance`); `package.json` (adds `@fastify/rate-limit`); `src/admin-ui/src/api.ts` (adds `activationApi`) and `src/admin-ui/src/pages/licensing/Licenses.tsx` (links to a license's activations).
- **`ActivationConfig` (T004) carries the E009 NEW-CONFIG**: fingerprint K/N (default 3-of-5) + clock-skew (`sk`); the per-tenant/product activation salt (server-provisioned, SDK-distributed, rotatable — FR-019); activation rate limits (default 60 req/min per API-key+license — FR-020); nonce entropy floor (≥128-bit) + replay-rejection TTL/window (default 24h — FR-021); machine-bound-credential TTL (effective exp = `min(license exp, credential TTL)` — FR-022); and the stale-activation retention window (default 90 days after deactivation).
- **Patterns reused**: `withTenant`/`privileged` + `SELECT … FOR UPDATE` on the `license` row (E008 lifecycle lock, `src/server/db/client.ts`); `writeAudit`/`recordSecurityEvent` (`src/server/audit/`); `saltedHash` (`src/server/db/hash.ts`, client-side for machine signals); the E004 `Signer`/`Claims` contract with the optional `fingerprint`/`fpMin`/`maxSkewSecs` fields already in `src/server/modules/signing/token.ts` (→ `fp`/`fpk`/`sk`); the console `requireRole` + CSRF double-submit; the runtime `req.tenant` API-key context gated on `scopes.includes("activate")` (mirror signing's `requireAdmin`); the forced-RLS migration form (`0007_licensing.sql`); Zod route validation + `{code,message,details?}` errors; the E008 SPA licensing views + RTL.
- **Key constraints folded in**: race-safe seat cap via the license row lock across count+insert — exactly S of N concurrent attempts succeed (HINT-003, prove with a concurrency test); the partial-unique `(tenant_id,license_id,machine_id) WHERE active` index is the backstop, not the primary guard; sign the machine-bound token ONLY after the seat is secured (sign fault → 503, no activation row — HINT-004); nonce store-and-replay on `UNIQUE (tenant_id,nonce)` (23505 → look up by nonce: same (license,machine) → 200 replay, else 409 `nonce_replayed`); the credential carries `exp = min(license exp, credential TTL)`; existing activation rows are NEVER auto-deactivated on a later license suspend/revoke/expire (FR-023, offline-first tradeoff); a license is never hard-deleted while activations reference it (composite FK `ON DELETE NO ACTION`, FR-024).
- **SPA note**: E009 defines no UI-specific functional requirement (NEW-UI is an implementation signal). The runtime `/v1` activate/deactivate is called by the licensed app/SDK, NOT the console — so no SPA for those. The Activations view/RTL tasks carry `[US4]` delivery labels only and surface the already-implemented, already-tested backend FRs; each FR is completed at its backend task, not in a React view.
- **Regression focus**: existing E002 RLS/tenant isolation and audit append-only semantics keep working; the one new table is additive and forced-RLS; the E008 `license` table is read-only here (no schema change); the runtime plane reuses the existing `req.tenant` API-key context (no new auth infra).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Extend coverage globs for src/server/modules/activation/** + the SPA Activations view (>=80% gate) in vitest.config.ts and src/admin-ui/vite.config.ts

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**Migration `0008` (finalize/verify) + the activation module scaffold & `ActivationConfig` + the two seam edits (register `registerActivation`, add `@fastify/rate-limit`) + the two pure-unit builders (K-of-N fingerprint, machine-bound claims) block every delivery story. Complete before any US phase. The migration is already drafted in data-model.md — T002/T003 finalize/verify the same file. `ActivationConfig` (T004) holds every E009 config key (see Brownfield Notes).**

- [X] T002 {FR-003,FR-006,FR-009,FR-024} [COMPLETES FR-024] Finalize activation table (composite PK/FK ON DELETE NO ACTION, partial-unique active index, UNIQUE nonce, fp_min CHECK) in migrations/0008_activation.sql
- [X] T003 {FR-015} Verify forced RLS + tenant_isolation policy + grants (SELECT/INSERT/UPDATE, no DELETE) in migrations/0008_activation.sql
- [X] T004 [P] {FR-019,FR-021} [COMPLETES FR-019] Module scaffold: registerActivation + ActivationConfig in src/server/modules/activation/index.ts → exports: registerActivation, ActivationConfig
- [X] T005 [P] Add @fastify/rate-limit dependency in package.json
- [X] T006 [P] {FR-005,FR-016} Unit: K-of-N match (>=K reuse; <K new; too-few refuse; deterministic tie-break) in src/server/modules/activation/__tests__/fingerprint.unit.test.ts
- [X] T007 [P] {FR-007,FR-022} Unit: machine-bound claims builder (snapshot->Claims fp/fpk/sk; exp=min(license exp,cred TTL)) in src/server/modules/activation/__tests__/claims.unit.test.ts
- [X] T008 {FR-005,FR-006,FR-016} Fingerprint: K-of-N overlap + salted machine/signal hashes + tie-break in src/server/modules/activation/fingerprint.ts → exports: matchKofN, deriveMachineId
- [X] T009 {FR-007,FR-018,FR-022} [COMPLETES FR-022] Claims builder: snapshot->Claims (fp/fpk/sk, fresh nonce, exp=min(exp,TTL)) in src/server/modules/activation/claims.ts → exports: buildMachineClaims
- [X] T010 Register registerActivation after registerIssuance in src/server/modules/index.ts ← T004:registerActivation
- [X] T011 [P] {FR-015} IT: 0008 activation table + forced RLS; unset app.current_tenant -> 0 rows in src/server/modules/activation/__tests__/migration.integration.test.ts after:T003

---

## Phase 3: US1 — Activate a machine with race-safe seat enforcement (Priority: P1) 🎯 MVP

**Independent test**: issue a 2-seat license; activate two distinct machines and verify each machine-bound credential offline against the product key; a third distinct-machine activation is refused `409 seat_limit_reached` with no row; N machines racing for one free seat → exactly one succeeds; a suspended/revoked/expired license is refused `409 license_not_active`; a same-nonce retry replays the original (SC-001/002/003/004/010). **The integration suite provisions an E004 product signing key + unlocks custody + uses the E001 WASM core for offline verify (reuse the E008 issuance test setup).**

- [X] T012 [P] [US1] {FR-001,FR-007} IT: activate->201 credential verifies offline via E001 WASM core (SC-001) in src/server/modules/activation/__tests__/activate.integration.test.ts
- [X] T013 [P] [US1] {FR-003,FR-004} IT: seat cap fills, over-limit->409 no row (SC-003); N racers->exactly S (SC-002) in src/server/modules/activation/__tests__/seat-race.integration.test.ts
- [X] T014 [P] [US1] {FR-008,FR-023} IT: non-active license->409 license_not_active (SC-004); revoke leaves existing rows active in src/server/modules/activation/__tests__/license-gate.integration.test.ts
- [X] T015 [P] [US1] {FR-009,FR-021} IT: same-nonce retry->200 replay no 2nd seat; nonce-forge->409 nonce_replayed (SC-010) in src/server/modules/activation/__tests__/nonce.integration.test.ts
- [X] T016 [P] [US1] {FR-002} IT: missing activate scope->403 forbidden; unresolvable key->401 (fail-closed) in src/server/modules/activation/__tests__/runtime-auth.integration.test.ts
- [X] T017 [US1] {FR-001,FR-003,FR-004,FR-008,FR-009,FR-021,FR-023} [COMPLETES FR-003,FR-004,FR-008,FR-009,FR-021,FR-023] Activate: seat lock + status gate + K-of-N + nonce replay (>=128-bit, replay window) + sign in src/server/modules/activation/activate.ts
- [X] T018 [US1] {FR-001,FR-002,FR-007,FR-014,FR-018} [COMPLETES FR-001,FR-002,FR-007] Register POST /v1/activations (activate scope; 201/200/409/503) in src/server/modules/activation/routes.ts after:T017

---

## Phase 4: US2 — Deactivate a machine to free a seat (Priority: P1) 🎯 MVP

**Independent test**: fill a 1-seat license, deactivate the machine (by the app via `DELETE /v1/activations/{id}` or by an operator via the console reclaim), then activate a different machine into the freed seat; re-deactivating an already-deactivated or unknown activation succeeds idempotently and the seat count never goes negative; every action is audited (SC-005/006).

- [X] T019 [P] [US2] {FR-010,FR-011} IT: app deactivate frees seat->reuse (SC-005); re-deactivate/unknown->204 idempotent (SC-006) in src/server/modules/activation/__tests__/deactivate.integration.test.ts
- [X] T020 [P] [US2] {FR-010} IT: operator reclaim POST /admin/.../deactivate->200 deactivated, seat freed, audited in src/server/modules/activation/__tests__/reclaim.integration.test.ts
- [X] T021 [US2] {FR-010,FR-011,FR-014} Deactivate service: soft flip active->deactivated + deactivated_at (idempotent; unknown->no-op) in src/server/modules/activation/deactivate.ts
- [X] T022 [US2] {FR-010} Register DELETE /v1/activations/{id} (activate scope; 204 idempotent; 404 unknown) in src/server/modules/activation/routes.ts after:T021
- [X] T023 [US2] {FR-010,FR-011} [COMPLETES FR-010,FR-011] Register admin reclaim deactivate route (requireRole admin+CSRF; 200 idempotent) in src/server/modules/activation/routes.ts after:T021

---

## Phase 5: US3 — Tolerate minor hardware drift (Priority: P1) 🎯 MVP

**Independent test**: activate a machine bound with five signals, change one signal and re-activate → the same activation and seat are re-used (no new seat) and the refreshed credential still verifies offline; a machine sharing fewer than K signals with any active activation is treated as new (consumes a seat only if one is free); a request with fewer than the minimum signals → `400 insufficient_signals` (SC-007/008).

- [X] T024 [P] [US3] {FR-005} IT: drift re-activation (>=K match)->200 same seat, refreshed credential verifies offline (SC-007) in src/server/modules/activation/__tests__/drift.integration.test.ts
- [X] T025 [P] [US3] {FR-005,FR-016} IT: <K signals->new machine (SC-008); too-few->400 insufficient_signals in src/server/modules/activation/__tests__/fingerprint.integration.test.ts
- [X] T026 [US3] {FR-005,FR-016} [COMPLETES FR-005,FR-016] Wire K-of-N + min-signals (400 insufficient_signals) into activate in src/server/modules/activation/activate.ts after:T017 ← T008:matchKofN

---

## Phase 6: US4 — Browse the activation registry (Priority: P1) 🎯 MVP

**Independent test**: activate two machines under a license, then open the license's activation registry in the console — both appear with pseudonymous machine identity, status, and timestamps plus a seats-used-vs-limit summary; the machine-bound credential and raw signal hashes are never returned; a viewer can read but a deactivate is refused 403 + recorded as a security event; a second tenant sees none of the first tenant's activations and a cross-tenant id resolves to 404 (SC-009/011/012).

- [X] T027 [P] [US4] {FR-012} IT: registry lists pseudonymous machines + seatsUsed/limit; no credential/signals; cap 1000 in src/server/modules/activation/__tests__/registry.integration.test.ts
- [X] T028 [P] [US4] {FR-015,FR-017} IT: viewer deactivate->403 + security_event (SC-009); cross-tenant->404 (SC-012) in src/server/modules/activation/__tests__/registry-isolation.integration.test.ts
- [X] T029 [US4] {FR-012} Registry reads: list activations (cap 1000, >1000 most-recent) + seat tally in src/server/modules/activation/registry.ts → exports: listActivations
- [X] T030 [US4] {FR-012} [COMPLETES FR-012] Register GET /admin/licenses/{id}/activations (requireRole viewer; no credential/signals) in src/server/modules/activation/routes.ts after:T029
- [X] T031 [US4] {FR-015,FR-017} [COMPLETES FR-015,FR-017] Apply requireRole+CSRF to admin routes; cross-tenant->404; RBAC/CSRF denial->security_event in src/server/modules/activation/routes.ts after:T030

---

## Phase 7: Frontend (React SPA Activations registry view)

**The Activations view plugs into the E008 Licensing area behind RBAC and surfaces the already-complete backend registry/reclaim FRs (see SPA note in Brownfield Notes — `[US4]` labels mark the story slice; no `{FR}` re-tagging). It is component-testable against a mocked `activationApi`. The runtime `/v1` activate/deactivate is app/SDK-side, so it has no SPA.**

- [X] T032 Extend admin API client with activationApi (listActivations + reclaim deactivate; camelCase; CSRF echo) in src/admin-ui/src/api.ts → exports: activationApi
- [X] T033 [P] [US4] Activations view: per-license registry (machine/status/timestamps + seats-used/limit; admin reclaim) in src/admin-ui/src/pages/licensing/Activations.tsx ← T032:activationApi
- [X] T034 [US4] Wire Activations link into Licenses view in src/admin-ui/src/pages/licensing/Licenses.tsx after:T033 ← T032:activationApi
- [X] T035 RTL (mocked activationApi): registry renders; RequireRole hides reclaim; viewer cannot deactivate in src/admin-ui/src/pages/licensing/__tests__/activations.test.tsx after:T033

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T036 [P] {FR-013,FR-020} [COMPLETES FR-013,FR-020] @fastify/rate-limit on both /v1 routes (per API-key+license, 60/min, 429 + Retry-After, audited) in src/server/modules/activation/routes.ts after:T031
- [X] T037 [P] {FR-014} [COMPLETES FR-014] Audit IT: all actions write actor/action/target; no raw signals/nonce/token/key in src/server/modules/activation/__tests__/audit.integration.test.ts
- [X] T038 [P] {FR-006,FR-018} [COMPLETES FR-006,FR-018] Leakage IT: salted hashes only; signing key never exposed (SC-011) in src/server/modules/activation/__tests__/secret-leakage.test.ts
- [X] T039 [P] Perf IT: single activation (FOR UPDATE + K-of-N + sign + insert) well under 1s in src/server/modules/activation/__tests__/perf.integration.test.ts
- [X] T040 Enforce >=80% line+branch coverage of activation module + SPA Activations view in vitest.config.ts + src/admin-ui/vite.config.ts after:T035
- [X] T041 [P] Add activation CI workflow (typecheck+lint, Testcontainers IT+coverage, SPA tests, npm audit --omit=dev --audit-level=high, semgrep) in .github/workflows/activation.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → Frontend (Phase 7) → Polish (Phase 8)

- **Phase 1 (Setup)** has no dependencies.
- **Phase 2 (Foundational)** depends on Setup; migration `0008` is finalized across T002→T003 (same file, sequential); T004 (module scaffold + `ActivationConfig`), T005 (`@fastify/rate-limit` dependency), T006 (fingerprint unit test), and T007 (claims unit test) are independent; T008 (fingerprint helpers) and T009 (claims builder) consume `ActivationConfig`, `Claims`, and `getLicense`; T010 registers the module at the seam (needs T004's `registerActivation`); T011 verifies the migration (after:T003).
- **US1–US4 (P1)** each depend on the Foundational migration + module scaffold + the two builders and are independently testable slices. The shared `activate.ts` is created in US1 (T017) and extended by US3 (T026, after:T017); the shared `routes.ts` is created in US1 (T018) and extended by US2 (T022/T023), US4 (T030/T031), and Polish (T036); `deactivate.ts` and `registry.ts` are created in their own stories. Per-story integration tests are TDD-first.
- **US1** builds `activate.ts` (FOR UPDATE license → status gate → K-of-N resolve via `matchKofN` → seat count<max → `buildMachineClaims` → `app.signer.sign` only after the seat is secured → nonce store-and-replay; sign fault → 503, no row) then wires the runtime activate route.
- **US2** is the deactivation path: app `DELETE /v1/activations/{id}` (204, idempotent) and admin reclaim (`POST /admin/.../deactivate`, 200, requireRole admin + CSRF), both a soft `active→deactivated` flip that frees the seat.
- **US3** proves K-of-N drift reuse (no new seat, offline re-verify) and the new-machine boundary, and adds the min-signals `insufficient_signals` guard (T026 extends `activate.ts`, after:T017).
- **US4** adds registry reads (`registry.ts`, cap 1000 with >1000 most-recent truncation, seat tally), wires the read route, and completes the RBAC/CSRF sweep (T031) + proves tenant isolation and the viewer-denial security event (T028).
- **Frontend (Phase 7)** depends on the `activationApi` client (T032) and the backend registry/reclaim routes; component tests (T035) run against a mocked API and do not block backend delivery.
- **Polish (Phase 8)** depends on all P1 stories being complete: rate-limit wiring on the runtime routes (T036, after:T031, FR-013/FR-020), audit-coverage (T037), no-PII/no-key leakage (T038), the perf assertion (T039), the coverage gate (T040, after:T035), and CI (T041).
- Tasks marked `[P]` can run in parallel within their phase (distinct files, no intra-batch dependency).
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.

## Delivery Notes

- **Fail-closed sign-after-seat (HINT-004)**: the machine-bound token is signed only after the seat is secured under the license row lock; a signer fault rolls the whole transaction back (503 `signer_unavailable`, no seat, no row) — mirrors E008 issuance. `machine_bound_token` is transiently null between the seat-claim INSERT and the sign UPDATE within the one transaction.
- **Nonce store-and-replay (HINT-004)**: on a `UNIQUE (tenant_id, nonce)` violation (23505) look up by nonce — same (license, machine) → return the original activation (200 idempotent), else 409 `nonce_replayed`. Nonce is ≥128-bit single-use, retained for the bounded replay-rejection window (default 24h, `ActivationConfig`).
- **Race safety (HINT-003)**: the seat cap is enforced by `SELECT … FOR UPDATE` on the `license` row across count+insert (exactly S of N concurrent attempts succeed, SC-002, proven by T013); the partial-unique `activation_one_active` index is the backstop, not the primary guard.
- **Test consolidation (as delivered)**: the backend tests ship as two suites — `src/server/modules/activation/__tests__/fingerprint.unit.test.ts` + `claims.unit.test.ts` (pure logic) and `activation.integration.test.ts` (all US1–US4 acceptance scenarios + migration RLS unset-GUC, rate-limit 429, perf <1s, and the no-PII/no-key audit). Every enumerated scenario is present; the ≥80% line+branch gate passes (server 93.2%/82.1%, SPA 96.8%/87.8%). File names differ from the per-task text only.
- **E004 signer extension (required for AD-003)**: the signer's conformance oracle (`signing/token.ts` `conformanceVerify` + `keystore-signer.ts`) was extended to pass the token's fingerprint to the core, so a machine-bound token (which carries `fp`) can self-verify. Backward-compatible — an ordinary E008 license token passes `null` and behaves exactly as before (all E008/E004 tests remain green).
- **SPA client coverage**: `api.test.ts` gained `licensingApi` + `activationApi` client cases (previously the E008 licensing client was untested at the client level) to keep the SPA function-coverage gate above 80%.
- No P2/DEFERRED tasks: all four user stories are P1 and gate the MVP.
