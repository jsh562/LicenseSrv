---
description: "Task list for feature implementation: Billing-driven Entitlement Automation (E014)"
---

# Tasks: Billing-driven Entitlement Automation

**Feature**: `00015-billing-driven-entitlement-automation` | **Epic**: E014 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00015-billing-driven-entitlement-automation/` (spec.md, plan.md, data-model.md, contracts/billing-api.openapi.yaml, research.md, checklists/{security,data-integrity,api-quality}.md — all complete)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (HMAC test vectors + timestamp tolerance, idempotency dedup, event→action mapper per type, grace-expiry compute, stale-event guard, adapter normalization), @testcontainers/postgresql integration (webhook→verify→dedupe→E008 lifecycle change with a real license; duplicate idempotent; bad-sig reject; cancel→grace→worker→suspend; refund→revoke; RLS isolation; secret never returned; reconciliation), a Security suite (no card/PAN anywhere; secret never in a response; constant-time compare; tenant scope), and a ≥80% line+branch coverage gate on `src/server/modules/billing/*`. Integration tests use the real E004 signer. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1/US2/US3 are P1 (the MVP gate); US4/US5 are P2; US6 is P3. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers + the real E004 signer + HMAC signature vectors).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005/E007/E008/E013) and the Postgres schema (migrations `0000`–`0009`). ADDITIVE / expand-only: one migration `0010_billing.sql` (new `billing_connection` + `subscription` + `billing_event` tables + a secret-excluding view; NO change to the E008 `license` table/enum) and one NEW module `src/server/modules/billing/` registered at the reserved seam after `registerEnforcement`. Reuses the E008 issuance/lifecycle services (`issueLicense`/`suspendLicense`/`reinstateLicense`/`revokeLicense`), the E004 signer + keystore custody (webhook-secret envelope encryption), E007 `getEffectivePlanDefinition`, `@fastify/rate-limit`, the console session/RBAC/CSRF (E008 admin pattern), `withTenant()`, `writeAudit`/`recordSecurityEvent`, and `node:crypto` (HMAC). `@fastify/rate-limit` is installed.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Verified, idempotent webhook ingestion | P1 🎯 MVP | POST /v1/billing/webhooks/{connectionId}: verify raw-body HMAC + timestamp recency BEFORE parse → dedupe by provider_event_id → fast ack `{received,outcome}` | valid-signed→accepted once; bad/missing sig→401 no state change; duplicate id→200 duplicate no-op (SC-001/002) |
| US2 — Subscription lifecycle drives license lifecycle | P1 🎯 MVP | provision on subscription-created (E008 issue + 1:1 link per plan map); extend on renewal (E007 effective entitlements); audit with the event id | created→provision+link; renewal→extend+active; every mutation audited with provider_event_id (SC-003/008) |
| US3 — Grace period then auto-suspend | P1 🎯 MVP | grace overlay (billing_state→grace/past_due + grace_expires_at) driving E008 active↔suspended; TIME-driven fail-open grace worker; recovery on payment | cancel/fail→grace (usable); grace elapsed→worker auto-suspends; payment during grace→reinstate (SC-004/005) |
| US4 — Refund / chargeback → revocation | P2 | refund/chargeback → E008 revoke (terminal); revoked-not-resurrected guard | refund→revoke; a later event does not resurrect a revoked license (SC-006) |
| US5 — Operator connects a provider & configures policy | P2 | admin /admin/billing/connections CRUD (secret write-only) + rotate-secret (transition window) + plan-map/grace policy; RBAC + CSRF; minimal console surface | create (secret never returned); rotate→old+new both accepted during window (SC-007) |
| US6 — Reconciliation & missed-event recovery | P3 | periodic + on-demand provider sync self-heal (recency-guarded, fail-open) + POST /admin/billing/reconcile (async 202) | missed cancel→reconcile→corrected; out-of-order event ignored (SC-009/010) |

**MVP gate**: US1 + US2 + US3 (all P1). US4 (P2) + US5 (P2) + US6 (P3) are in-scope, not deferred. Integration seams: the E004 signer (`app.signer` + keystore custody), the E008 issuance/lifecycle services, the E007 `getEffectivePlanDefinition`, the console session/RBAC/CSRF, and `withTenant()`/`writeAudit`.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds expand-only `0010_billing.sql` after `0009`; no change to `0000`–`0009` or the E008 `license` table/enum); `src/server/modules/index.ts` (registers the billing seam AFTER `registerEnforcement`); `src/server/config/index.ts` (adds billing config keys); `src/server/app.ts` (a raw-body content-type parser scoped to the webhook route — HMAC needs raw bytes, HINT-001); `src/server/main.ts` (starts the grace + reconcile workers fail-open, tied to `app.close()` like the E013 CRL worker); `src/admin-ui/` (a minimal operator billing surface — US5); `.github/workflows/` (adds `billing.yml`).
- **`BillingConfig` (T003) carries the NEW-CONFIG**: grace defaults (FR-011), the signature timestamp tolerance + stale-event horizon (FR-002/016), the per-connection + per-IP rate-limit thresholds (FR-019), the ledger retention horizon (FR-021, above the idempotency floor / ≥48h), and the secret rotation transition window (FR-022). SCREAMING_SNAKE env → camelCase config, mirroring `loadEnforcementConfig`.
- **Patterns reused**: the `register<Module>` seam + `registerModules` ordering (`modules/index.ts`); `withTenant()` (`db/client.ts`) as the sole RLS choke point (FR-014); the E008 issuance/lifecycle services (`modules/issuance/licenses.ts` `issueLicense`, `modules/issuance/lifecycle.ts` suspend/reinstate/revoke) — E014 DRIVES `license.status`, it does not re-implement it; the E004 keystore custody for envelope-encrypting the inbound webhook secret (a DISTINCT class from the Ed25519 signing key, HINT-004); `getEffectivePlanDefinition` (`catalog/effective.ts`, FR-006); `writeAudit`/`recordSecurityEvent` (`audit/`) append-only (FR-013); `@fastify/rate-limit`; the console session/RBAC/CSRF from the E008/E009 admin routes; the E013 fail-open worker-startup pattern in `main.ts`; the forced-RLS composite-FK + append-only-ledger migration form (`0009_online_enforcement.sql`); Zod validation + `{code,message,details?}` errors.
- **Key constraints folded in**: verify→dedupe→apply ORDER — HMAC over the RAW body BEFORE any parse (raw-body parser, HINT-001), constant-time compare, timestamp recency rejecting stale AND future-skew, current+prev secret during rotation; idempotency = `UNIQUE(tenant_id,provider,provider_event_id)` + `ON CONFLICT DO NOTHING` IN THE SAME TX as the side effect (HINT-002) — a duplicate is an ACK value (`duplicate`), NEVER a stored row (stored outcomes = applied/deadletter/rejected); grace is an OVERLAY on `subscription.billing_state`, NOT a license status (HINT-003) — it drives E008 `active↔suspended`, auto-suspend runs in the TIME-driven fail-open worker, `canceled`→suspend (recoverable), refund/chargeback→revoke (terminal, not resurrected); the webhook secret is envelope-encrypted, NEVER returned (`ConnectionPublic` has no secret field), rotatable current+prev (HINT-004); NO card/PAN data anywhere (`payload_summary` minimized allow-list), workers fail-open, stale events (older `occurred_at`) ignored (HINT-005); time-driven worker + reconciliation mutations are audited with a SYNTHETIC system actor + subscription id (no provider event id), FR-013.
- **Regression focus**: the E008 `license`/`customer` tables + status enum are UNCHANGED (grace is additive); E002 RLS/tenant isolation + audit append-only semantics keep working; all three new tables are additive + forced-RLS; the admin plane = console session + RBAC + CSRF (E008 pattern), the webhook plane = `providerSignature` HMAC (NOT X-API-Key/session).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Extend coverage globs for src/server/modules/billing/** (>=80% gate) in vitest.config.ts
- [X] T002 {FR-011,FR-016,FR-019,FR-021,FR-022} billing config keys (grace, ts-tolerance/stale, rate-limit, retention, rotation window) in src/server/config/index.ts
- [X] T003 {FR-011,FR-016,FR-019,FR-021,FR-022} BillingConfig loader + grace/tolerance/retention/rotation resolver (retention > idempotency floor) in src/server/modules/billing/config.ts
- [X] T004 {FR-002} Raw-body content-type parser SCOPED to the webhook route (raw bytes for HMAC; JSON unchanged elsewhere — HINT-001) in src/server/app.ts

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0010`, the module scaffold + seam, and the shared building blocks — `signature.ts` (verify), `events.ts` (canonical model + mapper + stale guard), the three repos, and the adapters — block every delivery story (webhook ingestion AND lifecycle consume them). Complete before any US phase. Unit tests (T009–T011) are TDD-first and precede their implementations.**

- [X] T005 {FR-003,FR-012,FR-021} Migration 0010: 3 tables + indexes (UNIQUE idempotency (tenant,provider,event_id), UNIQUE 1:1 (tenant,license_id), grace + BRIN prune) in migrations/0010_billing.sql
- [X] T006 {FR-014,FR-015} Migration 0010: ENABLE+FORCE RLS + tenant_isolation policies + grants (append-only ledger) + secret-excluding billing_connection_public view in migrations/0010_billing.sql
- [X] T007 Module scaffold: registerBilling seam (pool + signer + effective + custody + config) + BillingError in src/server/modules/billing/index.ts → exports: registerBilling, BillingError
- [X] T008 Register registerBilling after registerEnforcement in src/server/modules/index.ts ← T007:registerBilling
- [X] T009 [P] Unit (TDD): HMAC-raw-body vectors + recency (stale AND future-skew) + constant-time + current/prev secret in src/server/modules/billing/__tests__/signature.unit.test.ts
- [X] T010 [P] Unit (TDD): event→action mapper (per type) + stale-event guard + adapter normalization (allow-list, no card/PAN) in src/server/modules/billing/__tests__/events.unit.test.ts
- [X] T011 [P] Unit (TDD): idempotency dedup ON CONFLICT DO NOTHING (duplicate = no 2nd row) + dead-letter outcome shape in src/server/modules/billing/__tests__/ledger-repo.unit.test.ts
- [X] T012 [P] {FR-002} signature.ts: verify raw-body HMAC-SHA256 + timestamp recency + constant-time (adapter header, current+prev secret) in src/server/modules/billing/signature.ts
- [X] T013 [P] {FR-004,FR-016} events.ts: canonical model + adapter interface + event→action mapper + stale-event guard in src/server/modules/billing/events.ts → exports: CanonicalEvent
- [X] T014 [P] {FR-003,FR-020} ledger-repo.ts: idempotency dedup (INSERT ... ON CONFLICT DO NOTHING in-tx) + dead-letter + ledger reads in src/server/modules/billing/ledger-repo.ts
- [X] T015 [P] {FR-011,FR-015,FR-022} connection-repo.ts: CRUD + E004 secret custody (current+prev) + grace policy in src/server/modules/billing/connection-repo.ts → exports: ConnectionRepo
- [X] T016 [P] {FR-012} subscription-repo.ts: resolve by external id, 1:1 link (set once), state/grace/anchor in src/server/modules/billing/subscription-repo.ts → exports: SubscriptionRepo
- [X] T017 {FR-004,FR-018} [COMPLETES FR-004] adapters: stripe + generic → CanonicalEvent + allow-list summary (no card/PAN) in src/server/modules/billing/adapters/ ← T013:CanonicalEvent
- [X] T018 [P] {FR-021} [COMPLETES FR-021] 0010 IT: forced RLS (unset GUC→0) + idempotency + 1:1 link + secret excluded in src/server/modules/billing/__tests__/migration.integration.test.ts after:T006

---

## Phase 3: US1 — Verified, idempotent webhook ingestion (Priority: P1) 🎯 MVP

**Independent test**: the provider POSTs a validly-signed event (in-tolerance timestamp) → `200 {received:true, outcome}` and it is processed exactly once; a missing/invalid signature → `401 invalid_signature` with NO state change and NO ledger row; a stale/future-dated timestamp → `400 stale_timestamp`; the same `provider_event_id` redelivered → `200 outcome:duplicate`, an idempotent no-op that writes no second row and re-applies nothing (SC-001/002).

- [X] T019 [P] [US1] {FR-001,FR-002} IT (TDD): valid-signed→once; bad/missing sig→401 no change; stale/future ts→400 in src/server/modules/billing/__tests__/webhook-verify.integration.test.ts
- [X] T020 [P] [US1] {FR-003} IT (TDD): same event_id redelivered→200 duplicate no-op (applied once, no 2nd row) in src/server/modules/billing/__tests__/idempotency.integration.test.ts
- [X] T021 [US1] {FR-001,FR-002,FR-003} [COMPLETES FR-002,FR-003] webhook.ts: verify→dedupe→apply in one tx, fast ack in src/server/modules/billing/webhook.ts
- [X] T022 [US1] {FR-001,FR-019} [COMPLETES FR-001] routes.ts: POST /v1/billing/webhooks/:connectionId (providerSignature, rate-limited) in src/server/modules/billing/routes.ts after:T021

---

## Phase 4: US2 — Subscription lifecycle drives license lifecycle (Priority: P1) 🎯 MVP

**Independent test**: a subscription-created/activated event provisions a license via the E008 issuance path per the connection plan map and links it 1:1 to the subscription; a renewal / invoice-paid event extends the linked license (E007 effective entitlements) and keeps it active with any grace cleared; every billing-driven mutation appends an `audit_log` row carrying the triggering `provider_event_id` (SC-003/008).

- [X] T023 [P] [US2] {FR-005} IT (TDD): subscription-created→provision (E008) + 1:1 link per plan map; unmapped→deadletter in src/server/modules/billing/__tests__/provision.integration.test.ts
- [X] T024 [P] [US2] {FR-006,FR-013} IT (TDD): renewal/invoice-paid→extend + active, grace cleared; audited w/ event id in src/server/modules/billing/__tests__/renewal.integration.test.ts
- [X] T025 [US2] {FR-005,FR-012,FR-013} [COMPLETES FR-005,FR-012] lifecycle.ts: provision (E008 issue) + link sub (set once) + audit in src/server/modules/billing/lifecycle.ts ← T016:SubscriptionRepo
- [X] T026 [US2] {FR-006,FR-013} [COMPLETES FR-006] lifecycle.ts: extend on renewal (E007 effective, keep active, clear grace) + audit in src/server/modules/billing/lifecycle.ts after:T025

---

## Phase 5: US3 — Grace period on cancel/payment-failure, then auto-suspend (Priority: P1) 🎯 MVP

**Independent test**: a cancellation or payment-failure event moves the linked license into a bounded grace window (`billing_state`=grace/past_due, `grace_expires_at` set, license stays `active`/usable, not immediately suspended); after the window elapses with no recovery the TIME-driven fail-open grace worker drives E008 `suspend` (even with no further webhook); a successful payment during grace (or from suspended) reinstates the license via E008 and clears grace (SC-004/005).

- [X] T027 [P] [US3] {FR-007} IT (TDD): cancel/fail→grace/past_due, license stays active, grace_expires_at set, no suspend in src/server/modules/billing/__tests__/grace.integration.test.ts
- [X] T028 [P] [US3] {FR-008,FR-009} IT (TDD): grace elapsed→worker suspends; payment in grace/suspended→reinstate+clear in src/server/modules/billing/__tests__/grace-worker.integration.test.ts
- [X] T029 [US3] {FR-007,FR-011,FR-013} [COMPLETES FR-007,FR-011] lifecycle.ts: grace overlay on cancel/fail (→grace/past_due, grace_expires_at) in src/server/modules/billing/lifecycle.ts after:T026
- [X] T030 [US3] {FR-009,FR-013} [COMPLETES FR-009] lifecycle.ts: recovery-on-payment (reinstate via E008 if suspended, clear grace) in src/server/modules/billing/lifecycle.ts after:T029
- [X] T031 [US3] {FR-008,FR-013} [COMPLETES FR-008] grace-worker.ts: grace-expiry→E008 suspend (TIME-driven, fail-open, synthetic audit); from main.ts in src/server/modules/billing/grace-worker.ts

---

## Phase 6: US4 — Refund / chargeback → revocation (Priority: P2)

**Independent test**: a refund or chargeback event on a linked subscription drives E008 `revoke` (terminal, `billing_state`=refunded); any later billing event for that subscription is an idempotent no-op that does NOT resurrect the revoked license (SC-006).

- [X] T032 [P] [US4] {FR-010} IT (TDD): refund/chargeback→revoke (terminal); a later event does not resurrect a revoked license in src/server/modules/billing/__tests__/revoke.integration.test.ts
- [X] T033 [US4] {FR-010,FR-013} [COMPLETES FR-010] lifecycle.ts: refund/chargeback→E008 revoke (terminal, not-resurrected guard) + audit in src/server/modules/billing/lifecycle.ts after:T030

---

## Phase 7: US5 — Operator connects a provider & configures policy (Priority: P2)

**Independent test**: an operator (admin RBAC + CSRF) creates a billing connection with a write-only signing secret + plan map + grace policy → stored and used to verify/map webhooks, with the secret NEVER returned by any response or the public view; a `viewer` can list connections (secret-excluded); rotate-secret keeps BOTH the old and new secret valid during the bounded transition window, then drops the superseded secret (SC-007).

- [X] T034 [P] [US5] {FR-015} IT (TDD): create connection (secret write-only, never returned); list via view; cross-tenant→404 in src/server/modules/billing/__tests__/connections.integration.test.ts
- [X] T035 [P] [US5] {FR-022} IT (TDD): rotate-secret→current+prev both accepted in window; superseded dropped after in src/server/modules/billing/__tests__/rotation.integration.test.ts
- [X] T036 [US5] {FR-015} routes.ts: admin /admin/billing/connections POST/GET/PATCH (RBAC admin+CSRF, planMap validated vs E007) in src/server/modules/billing/routes.ts after:T022 ← T015:ConnectionRepo
- [X] T037 [US5] {FR-022} [COMPLETES FR-022] routes.ts: POST /admin/billing/connections/:id/rotate-secret (current+prev window, never returned) in src/server/modules/billing/routes.ts after:T036
- [X] T038 [US5] {FR-015} [COMPLETES FR-015] Minimal operator billing surface (connection + plan map + grace policy; secret write-only) in src/admin-ui/ billing page after:T037

---

## Phase 8: US6 — Reconciliation & missed-event recovery (Priority: P3)

**Independent test**: simulate a missed cancel webhook (license left active while the provider shows cancelled) → run reconciliation (periodic or POST /admin/billing/reconcile, async `202 {jobId}`) → the license is corrected to grace/suspended per policy against the provider's authoritative state, recency-guarded, fail-open; an out-of-order event older than `last_applied_event_at` is ignored (ledger `outcome:rejected`, `reason:stale_event`) and never regresses newer state (SC-009/010).

- [X] T039 [P] [US6] {FR-017} IT (TDD): missed cancel (active, provider canceled)→reconcile→corrected to grace/suspended in src/server/modules/billing/__tests__/reconcile.integration.test.ts
- [X] T040 [P] [US6] {FR-016} IT (TDD): out-of-order (older than last_applied_event_at)→ignored (rejected, stale_event) in src/server/modules/billing/__tests__/stale-event.integration.test.ts
- [X] T041 [US6] {FR-017,FR-013} reconcile-worker.ts: periodic + on-demand self-heal (recency-guarded, fail-open, synthetic audit); from main.ts in src/server/modules/billing/reconcile-worker.ts → exports: reconcile
- [X] T042 [US6] {FR-017} [COMPLETES FR-017] routes.ts: POST /admin/billing/reconcile (RBAC admin+CSRF, async 202 {jobId}) in src/server/modules/billing/routes.ts after:T037 ← T041:reconcile
- [X] T043 [US6] {FR-016} [COMPLETES FR-016] events.ts: finalize stale-event guard (occurred_at ≤ last_applied_event_at→rejected) for webhook + reconcile in src/server/modules/billing/events.ts after:T013

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T044 {FR-019} routes.ts: rate-limit wiring — webhook per-connection + per-IP (pre-resolution) + admin; 429 + Retry-After; audited in src/server/modules/billing/routes.ts after:T042
- [X] T045 {FR-020} [COMPLETES FR-020] routes.ts: GET /admin/billing/subscriptions + /events (ledger + dead-letter; viewer RBAC) in src/server/modules/billing/routes.ts after:T044
- [X] T046 [P] {FR-013} [COMPLETES FR-013] Audit IT: webhook→audit w/ event id; worker/reconcile→synthetic actor + sub id in src/server/modules/billing/__tests__/audit.integration.test.ts
- [X] T047 [P] {FR-014} [COMPLETES FR-014] Isolation IT: cross-tenant webhook/admin→404; RLS unset-GUC→0 rows in src/server/modules/billing/__tests__/isolation.integration.test.ts
- [X] T048 [P] {FR-018} [COMPLETES FR-018] Security IT: no card/PAN in ledger (webhook + reconcile); secret never in response/log/view in src/server/modules/billing/__tests__/secret-leakage.test.ts
- [X] T049 [P] {FR-019} [COMPLETES FR-019] Perf IT: webhook ack latency < ~200ms (fast ack; durable processing decoupled) in src/server/modules/billing/__tests__/perf.integration.test.ts
- [X] T050 Enforce >=80% line+branch coverage of src/server/modules/billing/** in vitest.config.ts after:T049
- [X] T051 [P] Add billing CI workflow (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep) in .github/workflows/billing.yml mirroring activation.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8) → Polish (Phase 9)

- **Phase 1 (Setup)** has no dependencies. T002 (config keys) + T003 (`BillingConfig` loader/resolver) are the grace/tolerance/threshold/retention/rotation source read live at verify + apply time. T004 registers the raw-body parser scoped to the webhook route (HMAC needs raw bytes, HINT-001) without breaking JSON parsing elsewhere.
- **Phase 2 (Foundational)** depends on Setup. The migration is finalized across T005→T006 (same file, sequential). T007 (scaffold) + T008 (seam registration, needs T007's `registerBilling`) wire the module. The three unit tests T009/T010/T011 precede their implementations — TDD-first. T012 (signature), T013 (events), T014 (ledger-repo), T015 (connection-repo), T016 (subscription-repo) are distinct files (parallelizable); T017 (adapters) consumes T013's `CanonicalEvent` so it is sequential after T013 (not `[P]`-batched with it). T018 verifies the migration (after:T006). signature/events/ledger/connection/subscription are the cross-story blockers: webhook ingestion (US1) AND lifecycle (US2/US3/US4) compose them.
- **US1–US3 (P1)** each depend on the Foundational blockers and are independently testable slices. The `webhook.ts` orchestrator (T021) verifies→dedupes→applies in one tx and calls the lifecycle `applyAction` seam by INJECTION (not a static import), so US1 is testable before US2 lands the mapper — a valid unmapped event dead-letters, a bad signature rejects inline, a duplicate acks `duplicate`. Per-story integration tests are TDD-first.
- **Shared same-file chains** (all sequential, never `[P]` together): the migration `0010_billing.sql` (T005→T006); `lifecycle.ts` — created in US2 (T025) and extended by T026→T029→T030→T033 (US2→US3→US4) via `after:` edges; `routes.ts` — created in US1 (T022) and extended by US5 (T036→T037), US6 (T042), and Polish (T044→T045); `events.ts` — created in Foundational (T013) and finalized in US6 (T043, after:T013); `main.ts` — the grace worker (T031) and reconcile worker (T041) each start fail-open from it; `config/index.ts` (T002); `app.ts` (T004).
- **US4 (P2)** adds the refund/chargeback→revoke terminal transition + revoked-not-resurrected guard in `lifecycle.ts` (T033, after:T030).
- **US5 (P2)** builds the admin connection routes (T036, after:T022, ← T015 `ConnectionRepo`), rotate-secret (T037, after:T036), and the minimal console surface (T038, after:T037). The signing secret is write-only end to end (never in a response or the public view).
- **US6 (P3)** builds `reconcile-worker.ts` (T041, started fail-open from main.ts), the async reconcile route (T042, after:T037, ← T041 `reconcile`), and finalizes the shared stale-event guard in `events.ts` (T043, after:T013).
- **Polish (Phase 9)** depends on the delivery routes/handlers: rate-limit completion (T044, after:T042), the registry reads (T045, after:T044), the audit / tenant-isolation / no-card-data+secret / perf integration suites (T046–T049, distinct files, `[P]`), the coverage gate (T050, after:T049), and CI (T051).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits (the single migration, `lifecycle.ts`, `routes.ts`, `events.ts`, `main.ts`, `config/index.ts`, `app.ts`) are sequential.

## Delivery Notes

- **verify → dedupe → apply ORDER (AD-001/002, HINT-001/002)**: `handleWebhook` (T021) resolves `{connectionId}`, recomputes the provider HMAC over the RAW bytes (T012 `verifySignature`, current + in-window previous secret, constant-time) and checks the signed-timestamp recency BEFORE any parse; only then does it normalize (adapter), dedupe, and apply. Idempotency is `INSERT ... ON CONFLICT (tenant_id,provider,provider_event_id) DO NOTHING` in the SAME tx as the lifecycle side effect (T014) — a redelivery conflicts and acks `duplicate` without a second row or a re-applied change. A signature/timestamp failure is rejected inline (4xx) with NO ledger row and NO state change; an unmapped/unhandled or disabled-connection event dead-letters (`outcome:deadletter`) and still acks `200`.
- **Grace is an OVERLAY (AD-003, HINT-003)**: `subscription.billing_state` (active/past_due/grace/canceled/refunded) drives the E008 `active↔suspended` / `→revoked` machine — the `license.status` enum is UNTOUCHED. During past_due/grace the license stays `active` (usable) with `grace_expires_at` set; grace-elapse → E008 `suspend` runs in the TIME-driven fail-open worker (T031), not only on webhook arrival; a successful payment reinstates (T030); refund/chargeback revokes (terminal, T033, never resurrected).
- **Webhook secret custody (AD-004, HINT-004)**: the inbound-HMAC secret is envelope-encrypted via the E004 keystore custody (a LOWER tier than the no-read/no-export Ed25519 key — it must be readable server-side to recompute the HMAC), rotatable via `signing_secret_ref` + `signing_secret_prev` + `secret_rotated_at`, and is NEVER returned (`ConnectionPublic` / `billing_connection_public` exclude it). It is a DISTINCT secret class from the Ed25519 signing key.
- **Fail-open workers + no card data (HINT-005)**: the grace and reconcile workers never crash the app on a provider/reconcile fault (the E013 canary/CRL-worker pattern); the adapters persist only a minimized, closed allow-list `payload_summary` — no card/PAN/CVV/expiry/PII — on BOTH the webhook and reconciliation ingest paths; stale events (older `occurred_at`) are ignored via the recency guard (T043). Time-driven worker + reconciliation mutations are audited with a SYNTHETIC system actor + subscription id (no provider event id), FR-013.
- **Two auth planes**: the webhook plane is `providerSignature` HMAC (NOT X-API-Key/session, NO CSRF); the admin plane is the console session cookie + RBAC (`admin` for connection management + reconcile, `viewer` for the registries) + double-submit CSRF on every mutation — the E008/E009 admin pattern.
- **Tests**: integration suites use @testcontainers/postgresql reusing the issuance/activation RLS + migration harness with the REAL E004 signer; the unit tier drives HMAC signature test vectors, the idempotency dedup, the event→action mapper per type, the grace-expiry compute, the stale-event guard, and adapter normalization.
- No deferred work: US4 (P2), US5 (P2), and US6 (P3) are fully in-scope; the MVP gate is US1 + US2 + US3.

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T019, T021, T022 | T022 |
| FR-002 | T004, T012, T019, T021 | T021 |
| FR-003 | T005, T014, T020, T021 | T021 |
| FR-004 | T013, T017 | T017 |
| FR-005 | T023, T025 | T025 |
| FR-006 | T024, T026 | T026 |
| FR-007 | T027, T029 | T029 |
| FR-008 | T028, T031 | T031 |
| FR-009 | T028, T030 | T030 |
| FR-010 | T032, T033 | T033 |
| FR-011 | T002, T003, T015, T029 | T029 |
| FR-012 | T005, T016, T025 | T025 |
| FR-013 | T024, T025, T026, T029, T030, T031, T033, T041, T046 | T046 |
| FR-014 | T006, T047 | T047 |
| FR-015 | T006, T015, T034, T036, T038 | T038 |
| FR-016 | T002, T003, T013, T040, T043 | T043 |
| FR-017 | T039, T041, T042 | T042 |
| FR-018 | T017, T048 | T048 |
| FR-019 | T002, T003, T022, T044, T049 | T049 |
| FR-020 | T014, T045 | T045 |
| FR-021 | T002, T003, T005, T018 | T018 |
| FR-022 | T002, T003, T015, T035, T037 | T037 |

**Rollup**: 22/22 functional requirements covered (FR-001..FR-022). 10 success criteria exercised — SC-001/002 (US1), SC-003/008 (US2), SC-004/005 (US3), SC-006 (US4), SC-007 (US5), SC-009/010 (US6). 3 new tables (`billing_connection`, `subscription`, `billing_event`) + secret-excluding view via one expand-only migration; webhook + 7 admin endpoints. No coverage gaps.
