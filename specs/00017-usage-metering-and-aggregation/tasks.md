---
description: "Task list for feature implementation: Usage Metering & Aggregation (E016)"
---

# Tasks: Usage Metering & Aggregation

**Feature**: `00017-usage-metering-and-aggregation` | **Epic**: E016 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00017-usage-metering-and-aggregation/` (spec.md, plan.md, data-model.md, contracts/usage-api.openapi.yaml, checklists/{security,data-integrity,api-quality}.md — all complete) and ADR-0013 (usage-metering ingestion + aggregation model).

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (config resolvers for retention/dedupe window + skew + hourly bucket + rollup interval + rate-limit + batch cap; the dimension-schema allow-list + per-aggregation quantity guard; rollup math per aggregation SUM/COUNT/UNIQUE_COUNT + reversal net + floor-at-zero display), @testcontainers/postgresql integration (idempotent + the CONCURRENT-dedupe race ingest; mixed per-event batch outcomes; watermark rollup correctness incl. late/out-of-order re-open + reversal net; reproducible query; retention prune + UNIQUE_COUNT prune-safety + GDPR erase; RLS isolation; rate-limit; over-cap batch; true-net vs display floor), a Security suite (no secret / API key / signing key / card-PAN in any response, log, or audit; dimension allow-list enforced — SC-013), and a ≥80% line+branch coverage gate on `src/server/modules/usage/**`. Integration tests drive the async rollup deterministically via an injected clock. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1/US2/US3 are P1 (the MVP gate); US4/US5/US6 are P2. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers; the async rollup driven deterministically).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E005/E007/E008/E013/E014/E015) and the Postgres schema (migrations `0000`–`0011`). ADDITIVE / expand-only: one sequential migration `0012_usage_metering.sql` (three new tenant-owned tables — `usage_event` append-only raw, `usage_rollup` durable per-hour aggregate, `usage_unique_value` prune-safe distinct-set side — plus an expand-only `metered` extension of the E007 `entitlement` (`type` CHECK + `aggregation`/`unit`/`allowance` columns); NO change to any existing column or the E007 boolean/integer_limit semantics) and one NEW module `src/server/modules/usage/` registered at the seam AFTER `registerLease`. Reuses the E014 `billing_event` idempotency (`UNIQUE (tenant, source, event_id)` + `INSERT ... ON CONFLICT DO NOTHING`) + fail-open retention-worker pattern, the E014/E015 fail-open unref'd synthetic-actor worker shape, the E005 scoped runtime API key (a NEW `usage.ingest` scope) + console session/RBAC, the E007 catalog entitlement authoring surface, the E008 `license.status` read (fail-closed at ingest), `withTenant()`/`privileged`, `writeAudit`/append-only `audit_log`, `@fastify/rate-limit`, and forced RLS. Metering computes NO money and introduces NO new crypto.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Report usage idempotently and accrue it | P1 🎯 MVP | POST /v1/usage: `usage.ingest` scope fail-closed → per-event validate (dimension allow-list / skew / license-active / entitlement) → batch INSERT ON CONFLICT DO NOTHING → per-batch summary | define a SUM meter; report a batch; re-report identical → accrued once; mixed new/dup/invalid per-event; concurrent same key → exactly once; missing scope → 403 (SC-001/002/003/011/015/016/018) |
| US2 — Query aggregated usage per license | P1 🎯 MVP | watermark hourly rollup (sum/count/unique) + fail-open rollup worker + reproducible query (floor-at-zero display, raw true-net to admin/E014) + GET /admin/licenses/:id/usage + console Usage view | report across two periods; query per license/entitlement/period; re-query identical (reproducible); viewer floored vs admin raw net (SC-004/017/019) |
| US3 — Define a metered entitlement | P1 🎯 MVP | E007 catalog metered kind (aggregation/unit/allowance) + freeze aggregation/unit once any usage exists | define SUM + COUNT meters → same events yield different totals; edit while empty ok; edit once usage exists refused `aggregation_frozen` (SC-005/006) |
| US4 — Late, out-of-order & correction events | P2 | event-time accrual + late-event bucket re-open + retention-window acceptance bound + reference-free signed reversal net | late event within window updates the right period; too-old → stale_event, future → future_event; reversal decreases net without mutating a prior event (SC-007/008) |
| US5 — Signal when a quota is crossed | P2 | over-quota crossing against the true net → derived flag + append-only audit (signal only, never blocks ingest) | cross allowance → overQuota + audit; further events still ingest; reversal below allowance clears the derived flag, crossing audit retained (SC-009) |
| US6 — Retain and prune raw usage bounded | P2 | fail-open owner-role prune worker (raw + keys, rollup survives) + GDPR tenant erase across all three tables | age raw past window → prune, rollup unchanged, re-report fresh accrual; UNIQUE_COUNT exact post-prune; GDPR erase removes all three tables (SC-010/013/020) |

**MVP gate**: US1 + US2 + US3 (all P1) — idempotent high-write accrual, a reproducible per-license aggregate query, and the metered entitlement definition it accrues against form a viable consumption-metering core. US4 + US5 + US6 (P2) are in-scope, not deferred.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds sequential `0012_usage_metering.sql` after `0011`; no change to `0000`–`0011`); `src/server/modules/index.ts` (registers the usage seam AFTER `registerLease`); `src/server/auth/rbac.ts` (adds the `usage.ingest` scope to the `Scope` union: `activate|validate|lease|admin` → `+ usage.ingest`); `src/server/config/index.ts` (adds usage config keys); `src/server/main.ts` (starts the fail-open rollup + retention workers, unref'd, tied to `app.close()`, like the E013 CRL / E014 retention / E015 reclaim workers); `src/server/modules/catalog/{validation.ts,entitlements.ts}` (the metered entitlement kind + freeze-on-usage); `src/admin-ui/` (a Usage page — US2); `.github/workflows/` (adds `usage.yml`, mirroring `lease.yml`); `vitest.config.ts` (coverage glob + gate).
- **Cross-epic reuse points (dependency seams)**: E014 `billing/ledger-repo.ts` ON-CONFLICT idempotency → `usage-repo.ts` batch append (AD-001/HINT-001); E014/E015 fail-open synthetic-actor workers → `rollup-worker.ts` + `retention-worker.ts` (AD-002/AD-007/HINT-004); E007 `catalog/validation.ts`+`entitlements.ts` → the `metered` kind + freeze (FR-008/FR-009, AD-005); E008 `license.status` → `ingest.ts` fail-closed `license_inactive` (FR-021); E005 → the scoped `usage.ingest` runtime key + console session/RBAC (FR-001); E014 billing → reads the true-signed-net `usage_rollup` read-only for true-up (FR-020, never the floored display).
- **Patterns reused**: the `register<Module>` seam + `registerModules` ordering; `withTenant()`/`privileged` as the sole RLS choke point (workers set `app.current_tenant` per-tenant pass, HINT-004); the forced-RLS composite-FK + append-only-ledger migration form (`0010`/`0011`); `@fastify/rate-limit` per key (429 + Retry-After, FR-005); the E014 `payload_summary` allow-list for the dimension schema (HINT-005); Zod validation + `{code,message,details?}` errors.
- **Key constraints folded in**: high-write fast-ack ingest (accept-then-aggregate, no per-event hot counter); exactly-once accrual within the retention window (`UNIQUE (tenant, source, event_id)` + ON CONFLICT DO NOTHING; concurrent producers accrue once); accrual by CLIENT `event_time` bucketed to a FIXED UTC hour; the retention window is the single acceptance bound (too-old → `stale_event` even if the bucket is unrolled); reference-free signed reversals adjust the TRUE signed net (never mutate a prior event; storage NEVER hard-floored — the zero-floor is display only); over-quota is a SIGNAL (flag + audit), never a block; forced-RLS tenant isolation (cross-tenant → not found, unset GUC → zero rows); per-event refusals inside the 200/202 summary vs whole-request HTTP refusals are two disjoint vocabularies (one bad event never fails the batch); no secret/API key/signing key/card-PAN in any response, log, or audit; minimized dimensions (allow-listed, no PII), GDPR-erasable.
- **Regression focus**: the E007 `boolean`/`integer_limit` entitlement semantics + `plan_entitlement` value columns are UNCHANGED (`metered` is an additive third kind); the E014 `billing_event` ledger + true-up logic are untouched (metering exposes the aggregate READ-ONLY and computes no money); E002 RLS/tenant isolation + audit append-only semantics keep working; the three new usage tables are additive + forced-RLS; the runtime plane = the scoped `usage.ingest` API key (NO CSRF), the admin plane = console session + RBAC (viewer reads; admin for `raw=true`).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Extend coverage globs for src/server/modules/usage/** (≥80% line+branch) in vitest.config.ts
- [X] T002 {FR-004,FR-005,FR-015} Usage config keys (retention/dedupe window ~35d, skew future allowance, hourly bucket, rollup interval, ingest rate-limit, max batch cap 1000) in src/server/config/index.ts
- [X] T003 {FR-001} Add the `usage.ingest` runtime scope to the Scope union (activate|validate|lease|admin + usage.ingest) in src/server/auth/rbac.ts
- [X] T004 Module scaffold: registerUsage seam (pool + config + repo + catalog read) + UsageError + app.usage in src/server/modules/usage/index.ts → exports: registerUsage, UsageError
- [X] T005 Register registerUsage after registerLease (end of MODULES) in src/server/modules/index.ts ← T004:registerUsage

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0012` (finalized across T006→T007, same file), the module scaffold + seam (Phase 1), and the shared building blocks — `config.ts` (retention/skew/bucket/interval/rate-limit/cap resolvers), `dimension-schema.ts` (allow-list + per-aggregation quantity guard), and `usage-repo.ts` (batch append ON CONFLICT DO NOTHING + per-event outcome, rollup/watermark upsert, unique-value upsert, reads) — block every delivery story (ingest AND rollup/query/prune compose them). Complete before any US phase. Unit tests (T008–T009) and the migration IT (T013) are TDD-first and precede/verify their implementations.**

- [X] T006 {FR-008} Migration 0012: entitlement expand-only metered extension (type CHECK +metered; aggregation/unit/allowance columns; valid/nonneg/metered-shape CHECKs) in migrations/0012_usage_metering.sql
- [X] T007 {FR-002,FR-003,FR-016,FR-017} Migration 0012: usage_event + usage_rollup + usage_unique_value + composite FKs + UNIQUE dedupe + hourly CHECK + forced RLS/policies + append-only grants + indexes in migrations/0012_usage_metering.sql after:T006
- [X] T008 [P] Unit (TDD): config resolvers — retention/dedupe window + skew allowance + hourly bucket + rollup interval + rate-limit + batch cap in src/server/modules/usage/__tests__/config.unit.test.ts
- [X] T009 [P] Unit (TDD): dimension allow-list (bounded keys, scalar-only, size caps → validation_error) + per-aggregation quantity guard (SUM any signed; COUNT non-zero int; UNIQUE_COUNT positive int) in src/server/modules/usage/__tests__/dimension-schema.unit.test.ts
- [X] T010 [P] {FR-004,FR-005,FR-015} Retention/dedupe window + skew + hourly bucket + rollup interval + rate-limit + batch-cap resolvers in src/server/modules/usage/config.ts → exports: UsageConfig
- [X] T011 [P] {FR-016} Dimension-schema allow-list validator + per-aggregation quantity guard (malformed → per-event validation_error) in src/server/modules/usage/dimension-schema.ts → exports: validateDimensions
- [X] T012 {FR-002,FR-003,FR-017} [COMPLETES FR-003] Batch append (ON CONFLICT DO NOTHING + RETURNING per-event outcome) + rollup/watermark upsert + unique-value upsert + tenant-scoped reads in src/server/modules/usage/usage-repo.ts ← T010:UsageConfig → exports: UsageRepo
- [X] T013 [P] {FR-017} Migration IT (TDD): unset-GUC→0 rows on all three tables + composite FK NO ACTION + dedupe UNIQUE + hourly bucket CHECK in src/server/modules/usage/__tests__/migration.integration.test.ts after:T007

---

## Phase 3: US1 — Report usage idempotently and accrue it (Priority: P1) 🎯 MVP

**Independent test**: define a SUM meter; report a batch of distinct events with idempotency keys → each accrues once and the endpoint fast-acks with a per-batch summary; re-report the identical batch → every event is a `duplicate` no-op (nothing further accrues, SC-001/002); a mixed batch (new + duplicate + a not_found/not_metered/archived/`license_inactive`/`stale_event`/`validation_error` event) accrues the new, no-ops the duplicate, and reports each bad event per-event without failing the batch (SC-003/018); the same `(source, eventId)` submitted concurrently by parallel producers accrues exactly once (SC-015); an over-cap batch → `400 batch_too_large` before any accrual; a key lacking `usage.ingest` → `403 forbidden`, nothing accrued (SC-011/016).

- [X] T014 [P] [US1] {FR-001,FR-007} IT (TDD): batch 200/202 summary; mixed new/duplicate/invalid per-event outcomes; missing scope→403; over-cap→400 pre-accrual (SC-002/011/016) in src/server/modules/usage/__tests__/ingest.integration.test.ts
- [X] T015 [P] [US1] {FR-002} IT (TDD): concurrent-dedupe race — same (source,eventId) parallel producers accrue exactly once, no double-count (SC-001/015) in src/server/modules/usage/__tests__/concurrent-dedupe.integration.test.ts
- [X] T016 [P] [US1] {FR-006,FR-021} IT (TDD): per-event not_found/not_metered/archived/cross-tenant (SC-003) + license_inactive on expired/suspended/revoked (SC-018) in src/server/modules/usage/__tests__/ingest-rejections.integration.test.ts
- [X] T017 [US1] {FR-004,FR-006,FR-016,FR-021} [COMPLETES FR-006,FR-021] Per-event validate: dimension-schema + event-time skew + entitlement (unknown/archived/non-metered) + license-active fail-closed in src/server/modules/usage/ingest.ts ← T011:validateDimensions, T012:UsageRepo
- [X] T018 [US1] {FR-002,FR-007,FR-013} [COMPLETES FR-002,FR-007] Accrue append (ON CONFLICT DO NOTHING) + reference-free signed reversal ingest + per-batch summary assembly in src/server/modules/usage/ingest.ts after:T017
- [X] T019 [US1] {FR-001,FR-005,FR-018} [COMPLETES FR-001] POST /v1/usage route (usage.ingest scope fail-closed, batch cap, fast-ack 200/202, batch-summary audit) in src/server/modules/usage/routes.ts after:T018

---

## Phase 4: US2 — Query aggregated usage per license (Priority: P1) 🎯 MVP

**Independent test**: report events across two hours/periods; run the incremental watermark rollup and query the per-license aggregate per entitlement/period → correct totals per the aggregation type (SUM sums, COUNT counts, UNIQUE_COUNT counts distinct values); re-query the same unchanged window → identical totals (reproducible, SC-004); after a reversal, a `viewer` sees the floor-at-zero display while `admin`/E014 `raw=true` sees the true signed net (SC-017/019); a cross-tenant `licenseId` → `404 not_found`; an over-window span → `400 window_too_large` before aggregation.

- [X] T020 [P] [US2] Unit (TDD): rollup math per aggregation SUM/COUNT/UNIQUE_COUNT + signed reversal net + floor-at-zero display in src/server/modules/usage/__tests__/rollup.unit.test.ts
- [X] T021 [P] [US2] {FR-010} IT (TDD): watermark incremental rollup correctness + idempotent re-run (recompute-not-increment, no double-count) in src/server/modules/usage/__tests__/rollup.integration.test.ts
- [X] T022 [P] [US2] {FR-011,FR-020} IT (TDD): reproducible query per license/entitlement/period; viewer floored vs admin raw true-net (SC-004/017/019) in src/server/modules/usage/__tests__/query.integration.test.ts
- [X] T023 [US2] {FR-010,FR-012,FR-013,FR-014} Incremental hourly rollup (sum/count/unique via usage_unique_value) + late-event bucket re-open + reversal net + over-quota eval in src/server/modules/usage/rollup.ts ← T012:UsageRepo → exports: rollupBucket
- [X] T024 [US2] {FR-010,FR-018} Fail-open tenant-scoped watermark rollup sweeper (on-read open-bucket, synthetic-actor audit) in src/server/modules/usage/rollup-worker.ts after:T023 → exports: rollupSweep
- [X] T025 [US2] {FR-010} [COMPLETES FR-010] Start rollup worker fail-open, unref'd, on app.close() in src/server/main.ts after:T024 ← T024:rollupSweep
- [X] T026 [US2] {FR-011,FR-013,FR-019,FR-020} [COMPLETES FR-013,FR-020] Aggregate query per license/entitlement/period (reproducible; floor-at-zero display; raw true-net bounded to admin/E014) in src/server/modules/usage/query.ts ← T012:UsageRepo → exports: queryUsage
- [X] T027 [US2] {FR-011} GET /admin/licenses/:licenseId/usage route (session + viewer RBAC; raw requires admin; window bound; cross-tenant→404) in src/server/modules/usage/routes.ts after:T019 ← T026:queryUsage
- [X] T028 [US2] {FR-011} [COMPLETES FR-011] usageApi + Usage view (per-license/entitlement aggregate, over-quota) + Shell nav in src/admin-ui/src/pages/usage/Usage.tsx after:T027

---

## Phase 5: US3 — Define a metered entitlement (Priority: P1) 🎯 MVP

**Independent test**: define a SUM meter and a COUNT meter on a plan; report the same event stream to each and confirm SUM sums the quantities while COUNT counts the events (and a UNIQUE_COUNT meter counts distinct dimension values) — a metered kind distinct from boolean/limit (SC-005); edit a metered entitlement's aggregation/unit while it has no usage → succeeds; attempt the same edit once any `usage_event` exists → refused `409 aggregation_frozen` (SC-006).

- [X] T029 [P] [US3] {FR-008,FR-009} IT (TDD): define metered (SUM/COUNT/UNIQUE_COUNT distinct totals SC-005); edit allowed while empty, refused once usage exists (SC-006) in src/server/modules/catalog/__tests__/metered-entitlement.integration.test.ts
- [X] T030 [US3] {FR-008} Metered kind validation (type=metered; aggregation∈sum/count/unique_count; unit; optional allowance; counter-only) in src/server/modules/catalog/validation.ts
- [X] T031 [US3] {FR-008,FR-009} [COMPLETES FR-008,FR-009] Metered create/edit + freeze-on-usage guard (EXISTS usage_event → aggregation_frozen) in src/server/modules/catalog/entitlements.ts after:T030

---

## Phase 6: US4 — Handle late, out-of-order, and correction events (Priority: P2)

**Independent test**: report an event whose client `eventTime` falls in an earlier still-retained hour → that bucket re-opens and its aggregate updates (SC-007); report a too-old event → per-event `stale_event` (rejected even if its target bucket is not yet rolled — the retention window is the single acceptance bound) and a future-dated event beyond skew → `future_event`; report a reference-free signed-negative reversal → the stored true net decreases while no prior event is mutated or deleted (SC-008).

- [X] T032 [P] [US4] {FR-004,FR-012} [COMPLETES FR-004] IT (TDD): late event within window re-opens the correct bucket (SC-007); too-old→stale_event, future→future_event; reversal adjusts net without mutation (SC-008) in src/server/modules/usage/__tests__/late-reversal.integration.test.ts
- [X] T033 [US4] {FR-012} [COMPLETES FR-012] Retention-window single-acceptance-bound + late/out-of-order bucket re-open wiring (unrolled bucket does not extend acceptance) in src/server/modules/usage/rollup.ts after:T023

---

## Phase 7: US5 — Signal when a quota is crossed (Priority: P2)

**Independent test**: set an allowance on a metered entitlement; accrue usage past it → the aggregate is flagged `overQuota` (evaluated against the stored true net) and an append-only audit entry is written; further events still ingest and accrue (no block, SC-009); a later reversal dropping the net below the allowance clears the derived flag while the historical crossing audit entry is retained.

- [X] T034 [P] [US5] {FR-014} IT (TDD): crossing allowance flags overQuota + writes audit; further events still ingest; reversal below allowance clears derived flag, crossing audit retained (SC-009) in src/server/modules/usage/__tests__/over-quota.integration.test.ts
- [X] T035 [US5] {FR-014,FR-018} [COMPLETES FR-014] Over-quota crossing eval against true net + derived over_quota flag + append-only audit (signal only, never blocks ingest) in src/server/modules/usage/rollup.ts after:T023

---

## Phase 8: US6 — Retain and prune raw usage bounded (Priority: P2)

**Independent test**: age raw events + idempotency keys past the retention window and run the fail-open prune → the raw events and keys are gone while the durable rollup aggregate is unchanged, and a re-report of a pruned key is a FRESH accrual (SC-010); a UNIQUE_COUNT meter's aggregate stays exact and reproducible post-prune via the durable `usage_unique_value` side table (SC-020); a tenant GDPR-erasure removes that tenant's `usage_event` + `usage_rollup` + `usage_unique_value` (owner role, tenant-scoped, SC-013).

- [X] T036 [P] [US6] {FR-015,FR-016} IT (TDD): prune ages raw+keys, rollup survives, re-report fresh accrual (SC-010); UNIQUE_COUNT exact post-prune (SC-020); GDPR erase all three tables (SC-013) in src/server/modules/usage/__tests__/retention-gdpr.integration.test.ts
- [X] T037 [US6] {FR-015,FR-016,FR-018} [COMPLETES FR-016] Fail-open owner-role prune (raw+keys, rollup survives) + GDPR tenant erase across all three tables (tenant-scoped, synthetic-actor audit) in src/server/modules/usage/retention-worker.ts after:T023 → exports: retentionSweep, eraseTenantUsage
- [X] T038 [US6] {FR-015} [COMPLETES FR-015] Start retention worker fail-open, unref'd, on app.close() in src/server/main.ts after:T037 ← T037:retentionSweep

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T039 {FR-005,FR-018} [COMPLETES FR-005] Rate-limit ingest per API key (429 rate_limited + Retry-After == details.retryAfterSeconds) + audit limit-exceeded in src/server/modules/usage/routes.ts after:T027
- [X] T040 [P] {FR-018} [COMPLETES FR-018] Audit IT: ingest batch/definition-edit/over-quota/reversal/prune audited; rollup+prune→synthetic actor + ids in src/server/modules/usage/__tests__/audit.integration.test.ts
- [X] T041 [P] {FR-017} [COMPLETES FR-017] Isolation IT: cross-tenant→404/not_found all routes; unset-GUC→0 rows on all three tables (SC-012) in src/server/modules/usage/__tests__/isolation.integration.test.ts
- [X] T042 [P] {FR-019} [COMPLETES FR-019] Security/PII IT: no secret/key/card-PAN in any response/log/audit; dimension allow-list enforced; only refs/dimensions exposed (SC-013) in src/server/modules/usage/__tests__/secret-leakage.test.ts
- [X] T043 [P] Perf IT: ingest fast-ack latency p95 < ~200ms under a high-write burst in src/server/modules/usage/__tests__/perf.integration.test.ts
- [X] T044 Enforce ≥80% line+branch coverage of src/server/modules/usage/** in vitest.config.ts after:T043
- [X] T045 [P] Add usage CI (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep; SHA-pinned actions) in .github/workflows/usage.yml mirroring lease.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8) → Polish (Phase 9)

- **Phase 1 (Setup)** has no dependencies. T002 (config keys) is the retention/skew/bucket/interval/rate-limit/cap source read live by `config.ts` (T010). T003 adds the `usage.ingest` scope to the `Scope` union. T004 (scaffold) + T005 (seam registration, needs T004's `registerUsage`) wire the module after `registerLease`.
- **Phase 2 (Foundational)** depends on Setup. The migration is finalized across T006→T007 (same file, sequential: the E007 `entitlement` metered extension, then the three usage tables + RLS/indexes/grants). The unit tests T008/T009 precede their implementations — TDD-first. T010 (config) + T011 (dimension-schema) are distinct files (parallelizable); T012 (usage-repo — the batch ON-CONFLICT append + per-event outcome, rollup/watermark upsert, unique-value upsert, reads) is the shared data-access every story composes and is `[COMPLETES FR-003]` (append-only access surface). T013 verifies the migration (after:T007). config/dimension-schema/usage-repo are the cross-story blockers: ingest (US1) AND rollup/query/prune (US2/US4/US5/US6) compose them.
- **US1–US3 (P1)** each depend on the Foundational blockers and are independently testable slices. Per-story integration tests are TDD-first and precede implementation. `ingest.ts` is built across T017 (per-event validate + license-active fail-closed) → T018 (accrue append + reversal + summary); `routes.ts` is created in US1 (T019 POST) and extended by US2 (T027 GET) and Polish (T039 rate-limit); `rollup.ts` is built in US2 (T023) and extended by US4 (T033) + US5 (T035); these same-file chains are sequential (`after:`), never `[P]` together.
- **US2 (P1)** builds `rollup.ts` (T023 — hourly aggregation per type, late re-open, reversal net, over-quota eval), the fail-open `rollup-worker.ts` (T024, tenant-scoped, on-read fallback, synthetic-actor audit) started from `main.ts` (T025, after:T024, ← T024 `rollupSweep`), the reproducible `query.ts` (T026, floor-at-zero display + admin/E014 raw true-net, ← T012 `UsageRepo`), the GET route (T027, after:T019, ← T026 `queryUsage`), and the console Usage surface (T028, after:T027).
- **US3 (P1)** extends E007 `catalog/validation.ts` (T030) + `catalog/entitlements.ts` (T031, after:T030) with the metered kind + freeze-on-usage guard.
- **US4 (P2)** extends `rollup.ts` (T033, after:T023) with the retention-window acceptance bound + late-event re-open wiring; its IT (T032) also completes FR-004's event-time-accrual/skew assertions.
- **US5 (P2)** extends `rollup.ts` (T035, after:T023) with the over-quota crossing eval + audit.
- **US6 (P2)** builds `retention-worker.ts` (T037, after:T023 — fail-open owner-role prune + GDPR erase) started from `main.ts` (T038, after:T037, ← T037 `retentionSweep`).
- **Polish (Phase 9)** depends on the delivery routes/handlers: rate-limit completion (T039, after:T027), the audit / isolation / secret-leakage / perf integration suites (T040–T043, distinct files, `[P]`), the coverage gate (T044, after:T043), and CI (T045).
- **Shared same-file chains** (all sequential, never `[P]` together): `migrations/0012_usage_metering.sql` (T006→T007); `ingest.ts` (T017→T018); `routes.ts` (T019→T027→T039); `rollup.ts` (T023→T033→T035); `main.ts` (T025→T038); `config/index.ts` (T002); `vitest.config.ts` (T001→T044).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits are sequential.

## Delivery Notes

- **Idempotent exactly-once accrual (AD-001/HINT-001, INV-1)**: `usage-repo.ts` (T012) appends a batch with a single `INSERT ... ON CONFLICT (tenant_id, source, event_id) DO NOTHING RETURNING id` in one tenant-scoped transaction and derives the per-event summary from `RETURNING` (inserted = new `accepted`; absent = `duplicate` no-op) — never a pre-SELECT then insert (races). The concurrent-dedupe IT (T015) asserts exactly-once under parallel producers minting the same key (SC-001/015). Mirrors the shipped E014 `billing_event` pattern.
- **Watermark rollup + reproducibility (AD-002/AD-003/HINT-002, INV-4/INV-5)**: `rollup.ts` (T023) recomputes each affected FIXED-hourly bucket from the retained raw (not an increment) keyed by `watermark_ingested_at`, so a restart / overlapping sweep / re-processed event yields the IDENTICAL aggregate (no double-count, SC-004). A late event has an older `event_time` (older bucket) but a fresh `ingested_at`, so the sweep re-opens its already-rolled bucket (T033, FR-012). UNIQUE_COUNT is backed by the exact, prune-safe `usage_unique_value` side table (`ON CONFLICT DO NOTHING`; UNIQUE_COUNT = `COUNT(*)` per bucket), so a pruned raw event cannot under-count (SC-020). `rollup-worker.ts` (T024) is fail-open with an on-read open-bucket fallback (ingest never blocked).
- **Per-aggregation quantity + reversal (HINT-002)**: `dimension-schema.ts` (T011) pins the quantity guard — SUM accepts any finite signed `numeric`; COUNT MUST be a non-zero integer (`-1` decrements); UNIQUE_COUNT MUST be a positive integer and a reversal CANNOT retract a distinct value (monotonic within a bucket) — a malformed quantity is a per-event `validation_error`, never coerced or dropped, so it cannot corrupt an aggregate.
- **Reversal net + display floor (AD-004/HINT-003, INV-5)**: a correction is a reference-free signed-negative `usage_event` (T018) that never mutates a prior event; `usage_rollup.value` stores the TRUE signed net (never hard-floored). `query.ts` (T026) applies `max(0, net)` for operator display, but the E014/app internal read and an elevated operator (`admin+`) `raw=true` return the true signed net (SC-017/019); a plain `viewer` requesting `raw=true` is refused `403`.
- **Workers (AD-002/AD-007/HINT-004)**: `rollup-worker.ts` (T024) + `retention-worker.ts` (T037) are modeled on the E014 retention / E015 reclaim workers — unref'd intervals, fail-open (catch+log, never crash, never block the live surface), tenant-scoped (each pass sets `app.current_tenant`; owner-role prune/erase use an explicit `tenant_id` predicate — no statement spans more than one tenant), synthetic-actor audited, tied to `app.close()`. The prune runs on the owner (`privileged`) connection (the app role has NO DELETE grant); the durable rollup + unique-value aggregates survive prune (INV-6), and a GDPR erase (T037) removes all three tables.
- **Fail-closed ingest (FR-001/FR-006/FR-021, INV-3)**: the runtime plane requires the `usage.ingest` scope (no tenant → 401, resolvable key missing scope → 403; nothing accrued, SC-016) with NO CSRF; every event's `licenseId`/`entitlementId` is re-resolved within the key's tenant (cross-tenant → per-event `not_found`, SC-003/012); a license not in an active state → per-event `license_inactive` (T017, SC-018), mirroring the E013 validate refusal. The admin query plane is the console session + RBAC (`viewer` reads; `admin+` for `raw=true`); a cross-tenant `licenseId` → `404` (never `403`).
- **Two refusal vocabularies (AD-008)**: whole-request HTTP errors (`batch_too_large`/`validation_error`/`unauthorized`/`forbidden`/`rate_limited`; `window_too_large` on query) refuse the batch pre-accrual, while per-event `PerEventRejectionCode`s (`not_found`/`not_metered`/`archived`/`license_inactive`/`stale_event`/`future_event`/`validation_error`) are reported inside the 200/202 `rejected[]` — a single bad event never fails the batch (T014/T016).
- **Metering ↔ billing boundary (FR-020/SC-014)**: metering computes NO price/rate/money and accepts/parses/stores NO card-PAN; E014 reads the true-signed-net `usage_rollup` read-only for true-up (the reproducible stored value, not the floored display).
- **Tests**: integration suites use `@testcontainers/postgresql` reusing the billing/lease RLS + migration harness; the async rollup is driven deterministically and time is advanced via an injected clock; the unit tier drives config resolvers, the dimension-schema + quantity guard, and the rollup math per aggregation + reversal net + floor-at-zero display.
- No deferred work: US4/US5/US6 (P2) are fully in-scope; the MVP gate is US1 + US2 + US3.

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T003, T014, T019 | T019 |
| FR-002 | T007, T012, T015, T018 | T018 |
| FR-003 | T007, T012 | T012 |
| FR-004 | T010, T017, T032 | T032 |
| FR-005 | T002, T010, T019, T039 | T039 |
| FR-006 | T016, T017 | T017 |
| FR-007 | T014, T018 | T018 |
| FR-008 | T006, T029, T030, T031 | T031 |
| FR-009 | T029, T031 | T031 |
| FR-010 | T021, T023, T024, T025 | T025 |
| FR-011 | T022, T026, T027, T028 | T028 |
| FR-012 | T023, T032, T033 | T033 |
| FR-013 | T018, T023, T026 | T026 |
| FR-014 | T023, T034, T035 | T035 |
| FR-015 | T036, T037, T038 | T038 |
| FR-016 | T007, T011, T017, T036, T037 | T037 |
| FR-017 | T007, T012, T013, T041 | T041 |
| FR-018 | T019, T024, T035, T037, T039, T040 | T040 |
| FR-019 | T026, T042 | T042 |
| FR-020 | T022, T026 | T026 |
| FR-021 | T016, T017 | T017 |

**Rollup**: 21/21 functional requirements covered (FR-001..FR-021), each with exactly one `[COMPLETES FR-###]` marker. 20 success criteria exercised — SC-001/002/003/011/015/016/018 (US1), SC-004/017/019 (US2), SC-005/006 (US3), SC-007/008 (US4), SC-009 (US5), SC-010/013/020 (US6), SC-012/014 (Polish + query). 3 new tables (`usage_event`/`usage_rollup`/`usage_unique_value`) + an expand-only `entitlement` metered extension via one migration `0012_usage_metering.sql`; 1 runtime ingest + 1 admin query endpoint; 2 fail-open workers (rollup, retention); 1 console page. P1 (US1–US3) forms a viable MVP. No coverage gaps.
