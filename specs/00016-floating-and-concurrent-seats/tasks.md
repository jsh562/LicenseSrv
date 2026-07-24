---
description: "Task list for feature implementation: Floating & Concurrent Seats (E015)"
---

# Tasks: Floating & Concurrent Seats

**Feature**: `00016-floating-and-concurrent-seats` | **Epic**: E015 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00016-floating-and-concurrent-seats/` (spec.md, plan.md, data-model.md, contracts/lease-api.openapi.yaml, checklists/{security,data-integrity,api-quality}.md — all complete) and ADR-0012 (online seat-lease concurrency model).

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (scope→holder-key derivation, TTL/timing + TTL≥3×heartbeat invariant resolvers, overage math, generation-fence/predicate logic, config resolvers, E004 handle sign/verify), @testcontainers/postgresql integration (acquire/renew/release/reclaim on real Postgres + the real E004 signer; the concurrency race — N acquires, exactly C succeed; revoke-reclaim; stale-renew rejection; RLS isolation; rate-limit; registry/force-release RBAC+CSRF), a Security suite (no signing key / raw holder ref / handle secret / raw hardware id / card data in any response, log, or audit — SC-015), and a ≥80% line+branch coverage gate on `src/server/modules/lease/**`. Integration tests use the real E004 signer. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1/US2/US3 are P1 (the MVP gate); US4/US5 are P2. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers + the real E004 signer).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005/E007/E008/E009/E013/E014) and the Postgres schema (migrations `0000`–`0010`). ADDITIVE / expand-only: one migration `0011_leases.sql` (a new `lease` table + forced RLS/policy/grants/indexes, plus expand-only `max_concurrent`/scope/overage/timings/per-reason-policy columns on `plan` (E007) snapshotted onto `license` (E008) alongside `max_activations`; NO change to any existing column) and one NEW module `src/server/modules/lease/` registered at the reserved seam after `registerEnforcement`/`registerBilling`. Reuses the E004 signer (`app.signer`) for the domain-separated `LICSRV-LEASE-v1` lease handle (NO new crypto), the E009 device fingerprint for `machine`-scope holder-keys + optional "activated-devices-only" gating, the E008 `license.status` + snapshot, the E013 revocation event → revoke-reclaim path, the E007 plan attributes, the E005 scoped runtime API key + console session/RBAC/CSRF, `withTenant()`, `writeAudit`/`recordSecurityEvent`, `@fastify/rate-limit`, and `node:crypto`.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Acquire a floating seat, race-safe cap | P1 🎯 MVP | POST /v1/leases: entitlement fail-closed (absent cap / non-active) → scope→holder-key → per-license advisory-lock count+insert (exactly-C-of-N) → single-use token → E004-signed handle | cap 2: two acquire; third→409; many-race→exactly one free seat wins (SC-001/002/003/004/019/020) |
| US2 — Renew by heartbeat + release on exit | P1 🎯 MVP | POST /renew (fence + status/expiry predicate, license re-check, idempotent) + POST /release (idempotent no-op) | renew extends expiry, no extra seat; release frees seat; stale renew→409; release unknown→200 (SC-005/006/008/021) |
| US3 — Auto-reclaim a dead machine's seat | P1 🎯 MVP | TIME-driven fail-open sweeper (bounded oldest-first) reclaims TTL+grace-lapsed leases + revoke-reclaim path; synthetic-actor audit; from main.ts | stop heartbeat → sweeper reclaims → new acquire ok; revoke→proactive reclaim; suspend→timer (SC-007/017) |
| US4 — Overage at capacity (hard / metered soft cap) | P2 | effective cap = max_concurrent + allowance; over-base acquire flagged + metered to append-only audit; beyond allowance refused | hard cap refuses; soft admits within allowance (metered); beyond→refuse (SC-009) |
| US5 — Operator registry + force-release | P2 | GET /admin/licenses/:id/leases (viewer, used-vs-cap, truncated) + POST /admin/leases/:id/force-release (admin + CSRF) + console UI | registry shows live+ended; viewer can't force-release; admin can; cross-tenant→404 (SC-010/012/013) |

**MVP gate**: US1 + US2 + US3 (all P1) — acquire race-safe, renew/release lifecycle, and auto-reclaim form a viable floating-license enforcement core. US4 (P2) + US5 (P2) are in-scope, not deferred.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds expand-only `0011_leases.sql` after `0010`; no change to `0000`–`0010`); `src/server/modules/index.ts` (registers the lease seam AFTER `registerEnforcement`/`registerBilling`); `src/server/config/index.ts` (adds lease config keys); `src/server/main.ts` (starts the fail-open reclaim worker, unref'd, tied to `app.close()`, like the E013 CRL / E014 grace worker); `src/admin-ui/` (a Concurrency/Leases page — US5); `.github/workflows/` (adds `lease.yml`, mirroring `billing.yml`). `vitest.config.ts` (coverage glob + gate).
- **Cross-epic reuse points (dependency seams)**: E004 signer (`app.signer`) → `handle.ts` mints the `LICSRV-LEASE-v1` short-TTL handle (NO new crypto; only the public artifact + opaque key id, never the signing key — HINT-003); E009 device fingerprint → `holder-key.ts` derives the `machine`-scope holder-key and `acquire.ts` reads a current activation under optional gating (FR-023/FR-025); E008 `license.status` + snapshot → `acquire.ts` reads live status and the snapshotted cap/timings (FR-005/FR-006/FR-024); E013 revocation event → `reclaim-worker.ts` revoke-reclaim path (FR-024); E007 plan attributes → `config.ts` resolvers (0011 adds columns); E005 → scoped runtime `lease` API key + console session/RBAC/CSRF.
- **Patterns reused**: the `register<Module>` seam + `registerModules` ordering; `withTenant()`/`privileged` as the sole RLS choke point; E009's proven race-safe seat pattern (E009 `SELECT … FOR UPDATE`; here a per-license `pg_advisory_xact_lock(license_id)` count+insert — AD-001/HINT-001); a monotonic generation fence + `status='live' AND expires_at>now() AND generation=$g` renew guard (AD-003/HINT-002); the E013 `crl-worker` / E014 grace-worker fail-open, unref'd, synthetic-actor pattern (AD-002/HINT-004); the forced-RLS composite-FK + append-only-audit migration form (`0009`/`0010`); `@fastify/rate-limit` sized to heartbeat cadence (HINT-005); Zod validation + `{code,message,details?}` errors.
- **Key constraints folded in**: online-only, server-authoritative live count; race-safe accounting (no over-allocation, no partial lease); reclaim⟂renew never double-count (fence + predicate); `expires_at` server-computed (`last_renewed_at + ttl`), never a client wall clock; TTL ≥ 3× heartbeat (CHECK on plan + license); absent `max_concurrent` ⇒ floating not entitled ⇒ acquire fail-closed (never unlimited, never falling back to `max_activations`); single-use acquire nonce `UNIQUE (tenant_id, nonce)`; per-tenant server-held holder-key salt (never distributed to the client — FR-026); pseudonymous holder-key only, no raw hardware id / no signing key anywhere (SC-015); tenant-isolated fail-closed (cross-tenant → 404, the release route the sole idempotent-200 carve-out).
- **Regression focus**: E009 node-lock (`max_activations`) accounting is UNCHANGED — concurrency is a distinct, independent dimension; E008 `license.status` enum is untouched (E015 READS it and reacts to a revoke event, it does not mutate the lifecycle); E002 RLS/tenant isolation + audit append-only semantics keep working; the new `lease` table is additive + forced-RLS; the runtime plane = scoped `lease` API key (NOT session/CSRF), the admin plane = console session + RBAC + double-submit CSRF.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Extend coverage globs for src/server/modules/lease/** (≥80% line+branch) in vitest.config.ts
- [ ] T002 {FR-009,FR-012,FR-017,FR-026} lease config keys (timings, scope, cap/overage, rate-limit, handle toggle, holder-key salt) in src/server/config/index.ts
- [ ] T003 Module scaffold: registerLease seam (pool + signer + effective + activation-read + config) + LeaseError + app.lease in src/server/modules/lease/index.ts → exports: registerLease, LeaseError
- [ ] T004 Register registerLease after registerEnforcement (end of MODULES, after registerBilling) in src/server/modules/index.ts ← T003:registerLease

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0011`, the module scaffold + seam (Phase 1), and the shared building blocks — `config.ts` (timing/scope/cap/salt resolvers + the TTL≥3×heartbeat invariant), `holder-key.ts` (scope→salted-hash derivation), `handle.ts` (E004-signed lease handle), and `lease-repo.ts` (race-safe acquire, fence renew, release, oldest-first sweep, list) — block every delivery story (acquire AND renew/release/reclaim compose them). Complete before any US phase. Unit tests (T007–T009) are TDD-first and precede their implementations.**

- [ ] T005 {FR-005,FR-009} Migration 0011: plan + license expand-only concurrency snapshot columns + CHECKs (TTL≥3×HB, scope/overage/policy) in migrations/0011_leases.sql
- [ ] T006 {FR-014,FR-019,FR-021} Migration 0011: lease table + indexes (one_live/seat/reclaim/prune) + forced RLS/policy + grants (no DELETE) in migrations/0011_leases.sql
- [ ] T007 [P] Unit (TDD): config resolvers — timings + TTL≥3×HB invariant + scope + cap/overage + rate-limit + salt in src/server/modules/lease/__tests__/config.unit.test.ts
- [ ] T008 [P] Unit (TDD): scope→holder-key salted hash (session/machine/user) + generation-fence predicate + overage math in src/server/modules/lease/__tests__/derive.unit.test.ts
- [ ] T009 [P] Unit (TDD): E004-signed lease handle (LICSRV-LEASE-v1) — tamper-evident verify, TTL-bounded, no key material in src/server/modules/lease/__tests__/handle.unit.test.ts
- [ ] T010 [P] {FR-009,FR-012,FR-017,FR-023,FR-026} Timings + TTL≥3×HB + scope + cap/overage + rate-limit + handle toggle + salt resolvers in src/server/modules/lease/config.ts → exports: LeaseConfig
- [ ] T011 [P] {FR-020,FR-023,FR-026} [COMPLETES FR-026] Scope→holder-key salted hash (session/machine/user; raw never stored) in src/server/modules/lease/holder-key.ts → exports: deriveHolderKey
- [ ] T012 [P] {FR-022} E004-signed short-TTL lease handle (domain LICSRV-LEASE-v1; public + opaque keyId) in src/server/modules/lease/handle.ts → exports: signLeaseHandle
- [ ] T013 {FR-003,FR-007,FR-008,FR-009,FR-010,FR-011} [COMPLETES FR-009] Advisory-lock acquire + fence renew + release + sweep + list in src/server/modules/lease/lease-repo.ts → exports: LeaseRepo
- [ ] T014 [P] {FR-019,FR-021} [COMPLETES FR-021] Migration IT: RLS unset-GUC→0 + FK NO ACTION + one-live + nonce uniq in src/server/modules/lease/__tests__/migration.integration.test.ts after:T006

---

## Phase 3: US1 — Acquire a floating seat with a race-safe concurrency cap (Priority: P1) 🎯 MVP

**Independent test**: configure a license with a concurrency cap of 2; acquire two leases successfully; a third concurrent-session acquire is refused `409 seat_capacity_exhausted`; then fire many simultaneous acquires for one free seat and confirm exactly one succeeds — the live-lease count never exceeds the effective cap. An acquire against a license with no `max_concurrent` is refused fail-closed `403 no_concurrency_entitlement`; against a suspended/revoked/expired license `409 license_not_active`; a replayed `acquireToken` returns the original lease (200) with no second seat; a missing/wrong-scope key → 401/403 (SC-001/002/003/004/011/019/020).

- [ ] T015 [P] [US1] {FR-004,FR-005,FR-006,FR-022} IT (TDD): acquire 201; absent-cap→403; non-active→409; hard-cap→409; signer→503 in src/server/modules/lease/__tests__/acquire.integration.test.ts
- [ ] T016 [P] [US1] {FR-003} IT (TDD): concurrency race — N acquires, exactly C succeed, live≤effective cap (SC-002) in src/server/modules/lease/__tests__/concurrency-race.integration.test.ts
- [ ] T017 [P] [US1] {FR-014,FR-023} IT (TDD): token replay→200 original; one-live re-acquire; machine shares seat (SC-016) in src/server/modules/lease/__tests__/idempotency-scope.integration.test.ts
- [ ] T018 [US1] {FR-005,FR-006,FR-023} [COMPLETES FR-005,FR-006,FR-023] Entitlement fail-closed + scope→holder-key in src/server/modules/lease/acquire.ts ← T011:deriveHolderKey
- [ ] T019 [US1] {FR-003,FR-004,FR-014,FR-022,FR-025} [COMPLETES FR-003,FR-004,FR-014,FR-025] Advisory-lock cap + token replay + gating + handle in src/server/modules/lease/acquire.ts after:T018
- [ ] T020 [US1] {FR-001,FR-002} [COMPLETES FR-001] POST /v1/leases route (lease scope, rate-limited, 201 fresh/200 replay + Location) in src/server/modules/lease/routes.ts after:T019

---

## Phase 4: US2 — Renew a lease by heartbeat and release it on exit (Priority: P1) 🎯 MVP

**Independent test**: acquire a lease, renew it and confirm `expiresAt`/`lastRenewedAt` advance (server-computed) with no extra seat consumed and the live count unchanged; release it and confirm a different session can immediately acquire the freed seat; release again (and an unknown/cross-tenant leaseId) → `200` idempotent no-op that never drives the count below zero; a stale/fenced renew after reclaim → `409 lease_not_renewable`; with signed-handle mode on, a signer fault on renew → `503` leaving the lease and its seat unchanged (SC-005/006/008/021).

- [ ] T021 [P] [US2] {FR-007,FR-011} IT (TDD): renew extends expiry keeps 1 seat; stale/fenced→409; signer→503 unchanged (SC-005/008/021) in src/server/modules/lease/__tests__/renew.integration.test.ts
- [ ] T022 [P] [US2] {FR-008} IT (TDD): release frees seat; idempotent unknown/terminal→200 no-op, never <0 (SC-006) in src/server/modules/lease/__tests__/release.integration.test.ts
- [ ] T023 [US2] {FR-007,FR-011,FR-022,FR-024} [COMPLETES FR-007,FR-011,FR-022] Fence-guarded renew + license re-check + handle refresh in src/server/modules/lease/renew.ts ← T013:LeaseRepo
- [ ] T024 [US2] {FR-008} [COMPLETES FR-008] Idempotent release (unknown/terminal→no-op, never below zero) in src/server/modules/lease/release.ts ← T013:LeaseRepo
- [ ] T025 [US2] {FR-002} [COMPLETES FR-002] POST /v1/leases/:leaseId/renew + /release (lease scope, rate-limited; release 200 no-op) in src/server/modules/lease/routes.ts after:T020

---

## Phase 5: US3 — Automatically reclaim a dead machine's seat (Priority: P1) 🎯 MVP

**Independent test**: with a full cap, acquire a lease and stop heartbeating; advance the injected clock past TTL + grace; confirm the fail-open sweeper reclaims the seat (bounded, oldest-expired-first) so a new acquire succeeds with no operator action; submit a stale renew for the reclaimed lease → `409 lease_not_renewable`; a sweeper fault on one license never blocks acquire/renew/release elsewhere. A revoked license's live leases are proactively reclaimed within the sweep interval while a suspended license's lapse on the TTL+grace timer; every reclamation is attributed to a synthetic worker actor + the lease/license id (SC-007/008/017).

- [ ] T026 [P] [US3] {FR-010} IT (TDD): past TTL+grace→sweeper reclaims, new acquire ok; fail-open one license (SC-007/008) in src/server/modules/lease/__tests__/reclaim.integration.test.ts
- [ ] T027 [P] [US3] {FR-024} IT (TDD): revoke→proactive reclaim in sweep; suspend→timer; renew vs revoked→409 (SC-017/004) in src/server/modules/lease/__tests__/revoke-reclaim.integration.test.ts
- [ ] T028 [US3] {FR-010,FR-018,FR-024} [COMPLETES FR-024] Fail-open sweeper (oldest-first) + revoke-reclaim + synthetic audit in src/server/modules/lease/reclaim-worker.ts → exports: reclaimSweep
- [ ] T029 [US3] {FR-010} [COMPLETES FR-010] Start reclaim worker fail-open, unref'd, on app.close() in src/server/main.ts after:T028 ← T028:reclaimSweep

---

## Phase 6: US4 — Handle overage at capacity (hard refuse or metered soft cap) (Priority: P2)

**Independent test**: with a hard cap, acquire at capacity is refused `409 seat_capacity_exhausted`; enable a soft cap with an allowance of 1 → one acquisition above the base cap succeeds, is flagged `overage: true`, and is metered to the append-only audit log with the concurrency level reached; a further acquisition beyond the allowance is refused (effective cap = `max_concurrent + allowance`; the audit meter is the authoritative record, the lease `overage` boolean is a non-authoritative flag; no card data or raw hardware ids) (SC-009).

- [ ] T030 [P] [US4] {FR-012,FR-013} IT (TDD): hard cap refuse; soft admits in allowance (metered); beyond→refuse (SC-009) in src/server/modules/lease/__tests__/overage.integration.test.ts
- [ ] T031 [US4] {FR-012,FR-013} [COMPLETES FR-012,FR-013] Soft-cap effective-cap admission + over-base overage audit meter in src/server/modules/lease/acquire.ts after:T019

---

## Phase 7: US5 — Operator visibility and force-release of live leases (Priority: P2)

**Independent test**: acquire two leases under a license, open the license's lease registry (GET, viewer RBAC) and confirm both live leases plus a concurrency-used-vs-cap summary appear — pseudonymous `holderKey`, status, acquired/last-renewed/expires timestamps, deterministically ordered, bounded to 1000 with `truncated`, NO handle; a viewer cannot force-release (`403` + security event) while an admin can (seat freed); a missing/mismatched CSRF token on force-release → `403` fail-closed (security event); a cross-tenant `licenseId`/`leaseId` → `404` (SC-010/012/013).

- [ ] T032 [P] [US5] {FR-015} IT (TDD): registry live+ended (pseudonymous, used-vs-cap, truncated); viewer reads; cross-tenant→404 in src/server/modules/lease/__tests__/registry.integration.test.ts
- [ ] T033 [P] [US5] {FR-016} IT (TDD): admin force-release frees seat; viewer→403 sec event; bad CSRF→403 (SC-010/013) in src/server/modules/lease/__tests__/force-release.integration.test.ts
- [ ] T034 [US5] {FR-015} GET /admin/licenses/:licenseId/leases (session + viewer RBAC; bounded 1000 + truncated) in src/server/modules/lease/routes.ts after:T025 ← T013:LeaseRepo
- [ ] T035 [US5] {FR-016,FR-018} [COMPLETES FR-016] POST /admin/leases/:leaseId/force-release (admin RBAC + CSRF, audited, idempotent) in src/server/modules/lease/routes.ts after:T034
- [ ] T036 [US5] {FR-015} [COMPLETES FR-015] leaseApi + Concurrency/Leases page (registry + force-release) + Shell nav in src/admin-ui/src/pages/leases/Leases.tsx after:T035

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T037 {FR-017,FR-018} [COMPLETES FR-017] Rate-limit acquire/renew/release per API key (429 + Retry-After) + audit security event in src/server/modules/lease/routes.ts after:T035
- [ ] T038 [P] {FR-018} [COMPLETES FR-018] Audit IT: every op + denials audited; reclaim→synthetic actor + ids in src/server/modules/lease/__tests__/audit.integration.test.ts
- [ ] T039 [P] {FR-019} [COMPLETES FR-019] Isolation IT: cross-tenant→404 all routes; RLS unset-GUC→0 (SC-012) in src/server/modules/lease/__tests__/isolation.integration.test.ts
- [ ] T040 [P] {FR-020} [COMPLETES FR-020] Security IT: no key/raw holder/handle secret/raw hw/card in any response/log/audit (SC-015) in src/server/modules/lease/__tests__/secret-leakage.test.ts
- [ ] T041 [P] Perf IT: acquire/renew ack latency p95 < ~200ms in src/server/modules/lease/__tests__/perf.integration.test.ts
- [ ] T042 Enforce ≥80% line+branch coverage of src/server/modules/lease/** in vitest.config.ts after:T041
- [ ] T043 [P] Add lease CI (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep; SHA-pinned) in .github/workflows/lease.yml mirroring billing.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → Polish (Phase 8)

- **Phase 1 (Setup)** has no dependencies. T002 (config keys) is the timing/scope/cap/overage/rate-limit/salt source read live by `config.ts` (T010). T003 (scaffold) + T004 (seam registration, needs T003's `registerLease`) wire the module after `registerEnforcement`/`registerBilling`.
- **Phase 2 (Foundational)** depends on Setup. The migration is finalized across T005→T006 (same file, sequential: plan/license columns then the `lease` table + RLS/indexes/grants). The three unit tests T007/T008/T009 precede their implementations — TDD-first. T010 (config), T011 (holder-key), T012 (handle) are distinct files (parallelizable); T013 (lease-repo — the race-safe advisory-lock acquire, fence renew, release, oldest-first sweep, list) is the shared accountant every story composes. T014 verifies the migration (after:T006). config/holder-key/handle/lease-repo are the cross-story blockers: acquire (US1) AND renew/release/reclaim (US2/US3) compose them.
- **US1–US3 (P1)** each depend on the Foundational blockers and are independently testable slices. Per-story integration tests are TDD-first and precede implementation. `acquire.ts` is built across T018 (entitlement + scope→holder-key) → T019 (advisory-lock cap + token replay + gating + handle) and later extended by US4 (T031); `routes.ts` is created in US1 (T020) and extended by US2 (T025), US5 (T034→T035), and Polish (T037); these same-file chains are sequential (`after:`), never `[P]` together.
- **Shared same-file chains** (all sequential, never `[P]` together): `migrations/0011_leases.sql` (T005→T006); `acquire.ts` (T018→T019→T031); `routes.ts` (T020→T025→T034→T035→T037); `main.ts` (T029 starts the reclaim worker fail-open); `config/index.ts` (T002); `vitest.config.ts` (T001→T042).
- **US3 (P1)** builds `reclaim-worker.ts` (T028 — the fail-open, oldest-first, synthetic-actor sweeper that also serves the revoke-reclaim path) and starts it from `main.ts` (T029, after:T028, ← T028 `reclaimSweep`). The renew path's license-state re-check (T023) is the near-real-time half of FR-024; the worker is the proactive half.
- **US4 (P2)** extends `acquire.ts` (T031, after:T019) with soft-cap effective-cap admission + the append-only overage meter.
- **US5 (P2)** adds the admin registry (T034, after:T025, ← T013 `LeaseRepo`), the admin force-release (T035, after:T034, admin RBAC + double-submit CSRF), and the console Concurrency/Leases surface (T036, after:T035).
- **Polish (Phase 8)** depends on the delivery routes/handlers: rate-limit completion (T037, after:T035), the audit / tenant-isolation / secret-leakage / perf integration suites (T038–T041, distinct files, `[P]`), the coverage gate (T042, after:T041), and CI (T043).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits are sequential.

## Delivery Notes

- **Race-safe accounting (AD-001/HINT-001, INV-1)**: `lease-repo.ts` (T013) acquires inside a per-license `pg_advisory_xact_lock(hashtextextended(license_id::text,0))` wrapping an authoritative `count(*) WHERE status='live'` + conditional INSERT, all in ONE transaction so the lock releases at commit — a naive `WHERE live_count < cap` races and over-allocates. The concurrency integration test (T016) asserts exactly-C-of-N against the effective cap `max_concurrent + concurrency_overage` (SC-002). The partial-unique `lease_one_live` index is a SECOND, independent guard for the SAME holder (idempotent re-acquire); the advisory lock guards the AGGREGATE cap across DIFFERENT holders.
- **Reclaim ⟂ renew (AD-003/HINT-002, INV-3)**: renew (T023) updates `WHERE status='live' AND expires_at>now() AND generation=$g` and bumps `generation`; reclaim/release set a terminal status + `ended_at`. A late renew after reclaim/expiry matches 0 rows → `409 lease_not_renewable` (re-acquire); a reclaimed seat is never revived or double-counted. Renew also re-checks live license state (a renew against a revoked license is refused — FR-024).
- **Reclaim worker (AD-002/HINT-004)**: `reclaim-worker.ts` (T028) is modeled on the E013 `crl-worker` / E014 grace-worker — an unref'd interval, fail-open (catch+log, never crash, never blocks the live surface), a BOUNDED batch (configurable max/run, default 1000) selecting oldest-expired-first (ascending `expires_at`) under `status='live' AND expires_at + grace < now`, idempotent across runs. The revoke-triggered reclaim (FR-024) reuses the same sweep query filtered by license. Every reclamation is audited with a synthetic system/worker actor + the affected lease/license id (FR-018).
- **Signed handle (AD-004/HINT-003)**: `handle.ts` (T012) reuses the E004 signer with a DOMAIN-SEPARATED payload (`LICSRV-LEASE-v1`, distinct from the E009 machine-bound credential and the E013 renewal-token/CRL domains); returns only the public artifact + opaque `keyId`, never the signing key. Validity is bounded by (and kept short relative to) the lease TTL. If the signer is unavailable while signed-handle mode is on, acquire fails closed `503` with NO seat consumed and no lease persisted (T019); renew leaves the existing lease and its seat unchanged (T023). A plain-authorization deployment (handle toggle off) returns `leaseHandle`/`keyId` `null` and is unaffected.
- **Holder-key + scope (AD-005/AD-006, FR-023/FR-026)**: `holder-key.ts` (T011) derives the pseudonymous holder-key = salted hash of a CLIENT-SUPPLIED opaque reference, keyed per the snapshotted `concurrency_scope` (`session` default / `machine` = E009 fingerprint / `user`); the raw reference and any raw hardware signal are NEVER stored or logged. The per-tenant/per-product salt is server-held and NEVER distributed to the client (unlike E009's SDK salt — floating is online); a salt rotation disturbs no LIVE lease (renew/release operate on the stored row), only NEW acquires derive under the rotated salt.
- **Snapshot + fail-closed entitlement (AD-006, INV-6)**: `max_concurrent`, scope, overage, timings, and per-reason policy are snapshotted onto `license` at issuance (migration T005), immunizing live leases from later plan edits; `concurrency_require_activation` and `lease_signed_handle` stay plan-level toggles read live at acquire. Absent `max_concurrent` ⇒ acquire refused `403 no_concurrency_entitlement` (never unlimited, never falling back to `max_activations`).
- **Two auth planes**: the runtime plane (`/v1/leases…`) is the scoped `lease` API key (a NEW scope distinct from E009 `activate` / E013 `validate`), fail-closed (401 unauthenticated / 403 missing scope), NO CSRF, rate-limited per key (T037); the admin plane (`/admin/…`) is the console session cookie + RBAC (`viewer` reads the registry, `admin` force-releases) + double-submit CSRF on the mutation. A cross-tenant id resolves to `404` on every route except the idempotent runtime release (a deliberate `200` no-op that frees nothing cross-tenant and is not an enumeration oracle).
- **Tests**: integration suites use `@testcontainers/postgresql` reusing the activation/enforcement/billing RLS + migration harness with the REAL E004 signer; time is advanced via an injected clock; the unit tier drives scope→holder-key derivation, the TTL/timing + TTL≥3×heartbeat invariant resolvers, overage math, the fence/predicate logic, and the E004 handle sign/verify.
- No deferred work: US4 (P2) and US5 (P2) are fully in-scope; the MVP gate is US1 + US2 + US3.

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T020 | T020 |
| FR-002 | T020, T025 | T025 |
| FR-003 | T013, T016, T019 | T019 |
| FR-004 | T015, T019 | T019 |
| FR-005 | T005, T015, T018 | T018 |
| FR-006 | T015, T018 | T018 |
| FR-007 | T021, T023 | T023 |
| FR-008 | T022, T024 | T024 |
| FR-009 | T005, T010, T013 | T013 |
| FR-010 | T013, T026, T028, T029 | T029 |
| FR-011 | T013, T021, T023 | T023 |
| FR-012 | T010, T030, T031 | T031 |
| FR-013 | T030, T031 | T031 |
| FR-014 | T006, T017, T019 | T019 |
| FR-015 | T032, T034, T036 | T036 |
| FR-016 | T033, T035 | T035 |
| FR-017 | T002, T037 | T037 |
| FR-018 | T028, T035, T037, T038 | T038 |
| FR-019 | T006, T014, T039 | T039 |
| FR-020 | T011, T040 | T040 |
| FR-021 | T006, T014 | T014 |
| FR-022 | T012, T019, T023 | T023 |
| FR-023 | T010, T011, T017, T018 | T018 |
| FR-024 | T023, T027, T028 | T028 |
| FR-025 | T019 | T019 |
| FR-026 | T002, T010, T011 | T011 |

**Rollup**: 26/26 functional requirements covered (FR-001..FR-026), each with exactly one `[COMPLETES FR-###]` marker. 22 success criteria exercised — SC-001/002/003/004/011/016/018/019/020/021 (US1), SC-005/006/008 (US2), SC-007/017 (US3), SC-009 (US4), SC-010/012/013 (US5), SC-014/015 (Polish). 1 new table (`lease`) + expand-only `plan`/`license` snapshot columns via one migration `0011_leases.sql`; 3 runtime + 2 admin endpoints; 1 fail-open reclaim worker; 1 console page. P1 (US1–US3) forms a viable MVP. No coverage gaps.
