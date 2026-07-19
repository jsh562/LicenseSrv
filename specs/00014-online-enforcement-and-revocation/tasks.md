---
description: "Task list for feature implementation: Online Enforcement and Revocation (E013)"
---

# Tasks: Online Enforcement and Revocation

**Feature**: `00014-online-enforcement-and-revocation` | **Epic**: E013 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00014-online-enforcement-and-revocation/` (spec.md, plan.md, data-model.md, contracts/online-enforcement-api.openapi.yaml, research.md, checklists/{security,api-quality,data-integrity}.md — all complete)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (verdict logic, short-TTL exp + signed-time, nonce idempotent replay, monotonic anchor, CRL byte-stable projection), @testcontainers/postgresql integration (validate→token verifies offline via the E001 WASM core→heartbeat renew→revoke→refuse; RLS isolation; CRL sign+verify + air-gap file; never-connected non-regression), a Security suite (no key material/no secrets/anti-replay/tenant-scope), an autocannon Performance assertion (p95<120ms; revocation-propagation ≤ renewal window), and a ≥80% line+branch coverage gate on `src/server/modules/enforcement/*`. Integration tests use the real E004 signer. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1/US2/US3/US5 are P1 (the MVP gate); US4 is P2; US6 is P3. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers + the real signer + the E001 WASM verifier).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E004/E005/E007/E008/E009) and the Postgres schema (migrations `0000`–`0008`). ADDITIVE / expand-only: one migration `0009_online_enforcement.sql` (ALTER `activation` +2 columns; new `checkin` + `revocation_list` tables) and one NEW module `src/server/modules/enforcement/` registered at the reserved seam after `registerActivation`. NO changes to any existing table/column. Reuses the E004 signer, E008 `license` read, E009 `activation` read + `machine_bound_token`, E007 `catalog/effective.ts`, `@fastify/rate-limit`, and the `withTenant()` RLS choke point. `@fastify/rate-limit` + `autocannon` are already installed.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Online validate & short-TTL renewal | P1 🎯 MVP | POST /v1/validate → verdict + first short-TTL LIC1 (offline-verifiable, signed server time); nonce anti-replay + idempotent replay | validate→token verifies offline via E001 WASM; same-nonce retry replays original; nonce-forge→409 (SC-001/010) |
| US2 — Revocation & suspension propagation | P1 🎯 MVP | refuse-on-revoked/suspended/expired/deactivated verdict path + reinstate-resumes; bounded staleness ≤ TTL | revoke→next beat 200 revoked, token lapses ≤ TTL; suspend/reinstate; expired/deactivated (SC-002/003/004) |
| US3 — Heartbeat renews only while valid | P1 🎯 MVP | POST /v1/heartbeat re-checks status/expiry/entitlements each beat; grace window; last-seen anchor advance | before-expiry→fresh token + anchor advance; entitlement change reflected; deactivated/expired→refused (SC-003) |
| US5 — Offline-first preserved (never-connected) | P1 🎯 MVP | non-regression: never-connected client stays on E009 credential; machine_bound_token untouched; staleness disclosed | never-connected verifies offline unchanged, not revoked-by-default; stalenessWindow in-band (SC-005/006) |
| US4 — Signed CRL fallback & distribution | P2 | project revoked ids → signed versioned artifact; GET /v1/revocation-list (json + ?format=file, ETag/cache); worker | revoke→next CRL version + next_update advance, signature verifies, air-gap file bytes==json (SC-007) |
| US6 — Clock-tamper resistance | P3 | signed server time + monotonic `last_anchor_at` floor; per-plan offline-tolerance re-anchor gate | clock rolled back→time/token < anchor rejected; beyond tolerance→must re-anchor (SC-009) |

**MVP gate**: US1 + US2 + US3 + US5 (all P1). US4 (P2) + US6 (P3) are in-scope, not deferred. Integration seams: the E004 signer (`app.signer` → short-TTL LIC1 + CRL signature), the E008 `license` snapshot read, the E009 `activation` read (+ `machine_bound_token`), the E007 `getEffectivePlanDefinition`, and the E001 WASM verifier (offline verify in tests).

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds expand-only `0009_online_enforcement.sql` after `0008`; no change to `0000`–`0008`); `src/server/modules/index.ts` (registers the enforcement seam AFTER `registerActivation`); `src/server/config/index.ts` (adds enforcement config keys); `src/server/main.ts` (starts the CRL worker, fail-open, tied to `app.close()` like the E012 canary); `.github/workflows/` (adds `enforcement.yml`).
- **`EnforcementConfig` (T003) carries the NEW-CONFIG**: short-token TTL / renewal window (per-plan), heartbeat cadence + grace window (FR-007), CRL `next_update` TTL, and per-plan offline-tolerance (FR-015). Resolved LIVE per validate/heartbeat via the license's `plan_id` — no `plan` column added (AD-007). SCREAMING_SNAKE env → camelCase config, mirroring `loadActivationConfig`.
- **Patterns reused**: the `register<Module>` seam + `registerModules` ordering (`modules/index.ts`); `withTenant()` (`db/client.ts`) as the sole RLS choke point (FR-018); the E004 `Signer`/`Claims` contract (`signing/token.ts` + `signing/signer.ts`) to re-sign a short-TTL LIC1 and to sign the CRL — no new token type ({SAD:ADR-0010}, HINT-001); the E009 nonce store-and-replay adapted to a TTL-pruned bounded `checkin` table (AD-002, HINT-003); `getEffectivePlanDefinition` (`catalog/effective.ts`, FR-017); `writeAudit`/`recordSecurityEvent` (`audit/`) append-only (FR-019); `@fastify/rate-limit` with the per-API-key `keyGenerator` + `errorResponseBuilder`/`onExceeded` audit pattern from `activation/routes.ts` (FR-021); the forced-RLS composite-FK migration form (`0008_activation.sql`); Zod route validation + `{code,message,details?}` errors; the E012 fail-open worker-startup pattern in `main.ts`.
- **Key constraints folded in**: refusals are `200` + `verdict` (valid/revoked/suspended/expired/deactivated), NOT 4xx — only genuine faults are errors (AD-001, HINT-002); the renewal token reuses the E004 signer + exact LIC1 `Claims` and is NOT persisted; `machine_bound_token` untouched (offline-first, US5, AD-005); the `checkin` nonce store is TTL-pruned (retain ≤ renewal window) and idempotent — a duplicate nonce returns the ORIGINAL `renewed_token`, not a fresh mint (FR-008, AD-002, HINT-003); the CRL is projected on-demand from `license.status='revoked'` but SIGNED as a byte-stable versioned artifact with strictly monotonic `version` (FR-022 anti-downgrade); a signature-invalid CRL is UNTRUSTED (FR-023), distinct from an unreachable CRL fail-open (FR-011); clock-tamper enforcement is CLIENT-side — the server supplies signed time + short `exp` + the monotonic `last_anchor_at` floor; never-connected rollback is BOUNDED, not prevented — disclosed (FR-013, HINT-005).
- **Regression focus**: the E001 offline verifier core and the E009 long-lived `machine_bound_token` credential are UNCHANGED; a never-connected activation keeps `last_checkin_at`/`last_anchor_at` NULL (not revoked-by-default, FR-012); E002 RLS/tenant isolation + audit append-only semantics keep working; both new tables are additive + forced-RLS with SELECT/INSERT-only grants.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Extend coverage globs for src/server/modules/enforcement/** (>=80% gate) in vitest.config.ts
- [ ] T002 {FR-016} Add enforcement config keys (short-token TTL/renewal window, heartbeat cadence+grace, CRL next_update TTL, per-plan offline-tolerance defaults) in src/server/config/index.ts
- [ ] T003 {FR-015,FR-016} [COMPLETES FR-016] EnforcementConfig loader + per-plan window resolver in src/server/modules/enforcement/config.ts → exports: loadEnforcementConfig, resolvePlanWindows

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0009`, the module scaffold + seam, and the three shared building blocks — `enforce.ts` (verdict), `token.ts` (short-TTL mint), `checkin-repo.ts` (nonce store + anchor) — block every delivery story (validate AND heartbeat consume all three). Complete before any US phase. Unit tests (T008–T010) are TDD-first and precede their implementations (T011–T013).**

- [ ] T004 {FR-003,FR-008,FR-009,FR-014} Migration: activation anchor cols + checkin + revocation_list tables (constraints/indexes per data-model §11) in migrations/0009_online_enforcement.sql
- [ ] T005 {FR-018} Migration: ENABLE+FORCE RLS + tenant_isolation policies + GRANT SELECT,INSERT only (no UPDATE/DELETE) on checkin + revocation_list in migrations/0009_online_enforcement.sql
- [ ] T006 Module scaffold: registerEnforcement seam (pool+signer+effective+config) in src/server/modules/enforcement/index.ts → exports: registerEnforcement, EnforcementError
- [ ] T007 Register registerEnforcement after registerActivation in src/server/modules/index.ts ← T006:registerEnforcement
- [ ] T008 [P] Unit (TDD): verdict logic — active→valid; revoked/suspended/expired/deactivated→refuse+reason in src/server/modules/enforcement/__tests__/enforce.unit.test.ts
- [ ] T009 [P] Unit (TDD): short-TTL exp=now+renewalWindow + signed serverTime anchor claim in src/server/modules/enforcement/__tests__/token.unit.test.ts
- [ ] T010 [P] Unit (TDD): idempotent replay returns original outcome/token + guarded anchor non-decrease in src/server/modules/enforcement/__tests__/checkin-repo.unit.test.ts
- [ ] T011 {FR-004,FR-005,FR-006,FR-017} enforce.ts: license/activation/expiry/entitlements → verdict+reason in src/server/modules/enforcement/enforce.ts → exports: evaluateEnforcement, Verdict
- [ ] T012 [P] {FR-002,FR-007,FR-014} [COMPLETES FR-007] token.ts: mint short-TTL LIC1 (exp=now+window, signed serverTime) via E004 signer in src/server/modules/enforcement/token.ts
- [ ] T013 [P] {FR-008,FR-014,FR-019} [COMPLETES FR-008] checkin-repo.ts: TTL-pruned nonce store + idempotent replay + guarded anchor + audit in src/server/modules/enforcement/checkin-repo.ts
- [ ] T014 [P] IT: 0009 tables + forced RLS (unset GUC→0 rows) + guarded anchor rejects decrease in src/server/modules/enforcement/__tests__/migration.integration.test.ts after:T005

---

## Phase 3: US1 — Online validate & short-TTL renewal (Priority: P1) 🎯 MVP

**Independent test**: a connected client calls `POST /v1/validate` for an active license + active activation → `200 verdict:valid` + a `shortLivedToken` that verifies OFFLINE against the product key via the E001 WASM core, carrying `serverTime` + `stalenessWindow`; a same-nonce+same-activation retry replays the ORIGINAL token (no second mint, anchor not advanced twice); a nonce reused for a DIFFERENT activation → `409 nonce_replayed`; missing `validate` scope → 403, unresolvable key → 401, cross-tenant `activationId` → 404 (SC-001/010).

- [ ] T015 [P] [US1] {FR-001,FR-002} IT (TDD): validate valid → token verifies offline (E001 WASM) + staleness (SC-001) in src/server/modules/enforcement/__tests__/validate.integration.test.ts
- [ ] T016 [P] [US1] IT (TDD): same-nonce retry→200 replay original; nonce for a different activation→409 (SC-010) in src/server/modules/enforcement/__tests__/nonce.integration.test.ts
- [ ] T017 [P] [US1] IT (TDD): missing validate scope→403; unresolvable key→401; cross-tenant activationId→404 in src/server/modules/enforcement/__tests__/enforcement-auth.integration.test.ts
- [ ] T018 [US1] {FR-001,FR-013} validate.ts: resolve activation→evaluate→mint(valid)→checkin/replay+anchor→result in src/server/modules/enforcement/validate.ts → exports: validateOnline
- [ ] T019 [US1] {FR-001,FR-021} [COMPLETES FR-001] routes.ts: register POST /v1/validate (validate scope, rate-limited) in src/server/modules/enforcement/routes.ts after:T018

---

## Phase 4: US2 — Revocation & suspension propagation within the renewal window (Priority: P1) 🎯 MVP

**Independent test**: revoke a license via the E008 admin path → the next validate/heartbeat returns `200 verdict:revoked` with NO token, and the outstanding short-lived token lapses within its TTL (bounded staleness ≤ renewal window, measured); a suspended license refuses renewal until reinstated, whereupon the next beat renews; an expired license → `expired`; a deactivated activation → `deactivated` (SC-002/003/004).

- [ ] T020 [P] [US2] {FR-005} IT (TDD): revoke→next beat 200 revoked (no token); token lapses ≤ TTL (SC-002/004) in src/server/modules/enforcement/__tests__/revocation.integration.test.ts
- [ ] T021 [P] [US2] {FR-006} IT (TDD): suspend→refused; reinstate→renews; expired/deactivated verdicts (SC-003) in src/server/modules/enforcement/__tests__/verdict-refusal.integration.test.ts
- [ ] T022 [US2] {FR-005,FR-006} [COMPLETES FR-005,FR-006] enforce.ts: refuse revoked/suspended/expired/deactivated + reinstate-resumes verdict in src/server/modules/enforcement/enforce.ts after:T011

---

## Phase 5: US3 — Heartbeat renews only while license + activation valid (Priority: P1) 🎯 MVP

**Independent test**: a client heartbeats before expiry → a FRESH short-lived token + advanced last-seen anchor; an entitlement/plan change on the license → the renewed token reflects the new effective entitlements (FR-017); a deactivated activation or an expired license → renewal refused with a specific reason; the grace window tolerates N missed beats before the effective authorization lapses (FR-007, no false lockout) (SC-003).

- [ ] T023 [P] [US3] {FR-002,FR-017} IT (TDD): heartbeat→fresh token + anchor; entitlement change reflected (SC-003) in src/server/modules/enforcement/__tests__/heartbeat.integration.test.ts
- [ ] T024 [P] [US3] {FR-004} IT (TDD): deactivated/expired→refused; grace tolerates N missed beats (FR-007) in src/server/modules/enforcement/__tests__/heartbeat-recheck.integration.test.ts
- [ ] T025 [US3] {FR-002,FR-003,FR-004,FR-017} [COMPLETES FR-002,FR-017] heartbeat.ts: re-check status/expiry/entitlements per beat → mint/refuse in src/server/modules/enforcement/heartbeat.ts
- [ ] T026 [US3] {FR-003,FR-004,FR-021} [COMPLETES FR-003,FR-004] routes.ts: register POST /v1/heartbeat (validate scope, rate-limited) in src/server/modules/enforcement/routes.ts after:T025

---

## Phase 6: US5 — Offline-first preserved (never-connected unaffected) (Priority: P1) 🎯 MVP

**Independent test**: an activation that NEVER calls validate/heartbeat keeps verifying its E009 `machine_bound_token` OFFLINE via the E001 core to that credential's own `exp`, is NOT treated as revoked-by-default, and its `last_checkin_at`/`last_anchor_at` stay NULL; validate/heartbeat never overwrite or shorten `machine_bound_token`; every validate/heartbeat response discloses `stalenessWindow` = max(short-token TTL, CRL `next_update`) + offline tolerance (SC-005/006).

- [ ] T027 [P] [US5] {FR-012} IT (TDD): never-connected verifies E009 offline; not revoked-by-default (SC-005) in src/server/modules/enforcement/__tests__/offline-first.integration.test.ts
- [ ] T028 [P] [US5] {FR-013} IT (TDD): validate/heartbeat never mutate machine_bound_token; staleness disclosed (SC-006) in src/server/modules/enforcement/__tests__/staleness.integration.test.ts
- [ ] T029 [US5] {FR-012} [COMPLETES FR-012] Offline-first guard: enforcement reads (never writes) E009 credential + document never-connected gap in src/server/modules/enforcement/README.md
- [ ] T030 [US5] {FR-013} [COMPLETES FR-013] Finalize stalenessWindow disclosure on every EnforcementResult + document bounded-staleness in src/server/modules/enforcement/README.md after:T018

---

## Phase 7: US4 — Signed revocation list (CRL) fallback & distribution (Priority: P2)

**Independent test**: revoke a license → the CRL worker regenerates a signed artifact whose `version` and `next_update` advance; the detached signature verifies against the product keyring; `GET /v1/revocation-list` serves the JSON by default and the SAME canonical bytes as an `application/octet-stream` file under `?format=file`; `Cache-Control`/`ETag` align to `next_update` and a matching `If-None-Match` → `304`; an unknown/cross-tenant `productId` → `404`; the client fail-open vs untrusted-signature vs anti-downgrade rules are documented (SC-007).

- [ ] T031 [P] [US4] {FR-009} IT (TDD): revoke→CRL regen; version+next_update advance; signature verifies; file==json (SC-007) in src/server/modules/enforcement/__tests__/crl.integration.test.ts
- [ ] T032 [P] [US4] {FR-010} IT (TDD): GET revocation-list json/file; ETag/cache→next_update; 304; unknown productId→404 in src/server/modules/enforcement/__tests__/crl-fetch.integration.test.ts
- [ ] T033 [P] [US4] {FR-022} Unit (TDD): CRL canonical byte-stable encoding + monotonic version max+1; older signed version rejected in src/server/modules/enforcement/__tests__/crl.unit.test.ts
- [ ] T034 [US4] {FR-009,FR-022} crl.ts: project revoked ids → canonical doc → sign via E004 + version max+1 in src/server/modules/enforcement/crl.ts → exports: generateCrl, getLatestCrl
- [ ] T035 [US4] {FR-009,FR-019} [COMPLETES FR-009] crl-worker.ts: signed-CRL regen + audit publish; fail-open start from main.ts in src/server/modules/enforcement/crl-worker.ts
- [ ] T036 [US4] {FR-010} revocation-list.ts: GET handler (json+file byte-stable, ETag/cache→next_update, 304) in src/server/modules/enforcement/revocation-list.ts → exports: getRevocationList
- [ ] T037 [US4] {FR-010,FR-021} [COMPLETES FR-010] routes.ts: register GET /v1/revocation-list (validate scope, rate-limited) in src/server/modules/enforcement/routes.ts after:T019
- [ ] T038 [US4] {FR-011,FR-022,FR-023} [COMPLETES FR-011,FR-022,FR-023] Document client CRL rules: fail-open vs untrusted-sig + anti-downgrade version in src/server/modules/enforcement/README.md

---

## Phase 8: US6 — Clock-tamper resistance on renewal (Priority: P3)

**Independent test**: a client rolls its clock back after a check-in → a token/time preceding the server-side monotonic `last_anchor_at` floor is rejected; a client that runs offline beyond the per-plan offline-tolerance window must re-anchor (renew) to continue; the never-connected pure-offline rollback exposure is bounded by the tolerance window (documented, accepted) (SC-009).

- [ ] T039 [P] [US6] {FR-014,FR-015} IT (TDD): rollback→time/token < anchor rejected; beyond tolerance→re-anchor in src/server/modules/enforcement/__tests__/clock-tamper.integration.test.ts
- [ ] T040 [US6] {FR-014,FR-015} [COMPLETES FR-014,FR-015] enforce.ts: reject time/token < last_anchor_at + offline-tolerance re-anchor gate in src/server/modules/enforcement/enforce.ts after:T022

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T041 {FR-021} [COMPLETES FR-021] Verify @fastify/rate-limit on all 3 routes (per API-key, 429+Retry-After, audited) + IT in src/server/modules/enforcement/routes.ts after:T037
- [ ] T042 [P] {FR-019} [COMPLETES FR-019] Audit IT: check-in + CRL publish → actor/action/target; denied/revoked→security_event in src/server/modules/enforcement/__tests__/audit.integration.test.ts
- [ ] T043 [P] {FR-018} [COMPLETES FR-018] Tenant-isolation IT: cross-tenant validate/heartbeat/CRL→404; RLS unset-GUC→0 rows in src/server/modules/enforcement/__tests__/isolation.integration.test.ts
- [ ] T044 [P] {FR-020} [COMPLETES FR-020] Autocannon: validate/heartbeat p95<120ms (SC-008); revocation ≤ renewal window (SC-004) in src/server/modules/enforcement/__tests__/perf.integration.test.ts
- [ ] T045 [P] Security IT: no signing-key/secret in tokens/CRL/audit; no raw machine id persisted in src/server/modules/enforcement/__tests__/secret-leakage.test.ts
- [ ] T046 Enforce >=80% line+branch coverage of the enforcement module in vitest.config.ts after:T044
- [ ] T047 [P] Add enforcement CI workflow (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep) in .github/workflows/enforcement.yml mirroring activation.yml

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US5 (Phase 6) → US4 (Phase 7) → US6 (Phase 8) → Polish (Phase 9)

- **Phase 1 (Setup)** has no dependencies. T002 (config keys) + T003 (EnforcementConfig loader/resolver) are the per-plan window source read live at renewal.
- **Phase 2 (Foundational)** depends on Setup. The migration is finalized across T004→T005 (same file, sequential). T006 (scaffold) + T007 (seam registration, needs T006's `registerEnforcement`) wire the module. The three unit tests T008/T009/T010 precede their implementations T011 (enforce.ts, verdict), T012 (token.ts, short-TTL mint), T013 (checkin-repo.ts, nonce+anchor+audit) — TDD-first. T011/T012/T013 are distinct files (parallelizable); each consumes Setup config and the reused E004 signer / E007 effective read. T014 verifies the migration (after:T005). enforce.ts/token.ts/checkin-repo.ts are the cross-story blockers: BOTH validate (US1) and heartbeat (US3) compose them.
- **US1–US5 (P1)** each depend on the Foundational blockers and are independently testable slices. The shared `enforce.ts` is created in Foundational (T011) and extended by US2 (T022, after:T011) and US6 (T040, after:T022) — same file, sequential. The shared `routes.ts` is created in US1 (T019) and extended by US3 (T026), US4 (T037), and Polish (T041) — same file, sequential. Per-story integration tests are TDD-first.
- **US1** builds `validate.ts` (resolve activation → `evaluateEnforcement` → `mintShortLivedToken` on valid → `recordCheckin`/idempotent replay + advance anchor → `EnforcementResult`) then registers the rate-limited POST /v1/validate route (T019, after:T018).
- **US2** finalizes the refuse-on-revoked/suspended/expired/deactivated verdict path + reinstate-resumes in `enforce.ts` (T022, after:T011); the ITs prove bounded staleness ≤ TTL (SC-002/004).
- **US3** builds `heartbeat.ts` (re-check status/expiry/entitlements per beat, mint fresh or refuse, advance anchor) then registers the rate-limited POST /v1/heartbeat route (T026, after:T025). Grace-window behaviour (FR-007) is exercised by T024 and realized by the token's `renewAfter` (T012).
- **US5** is a non-regression + disclosure slice: it proves the never-connected client is untouched (T027) and finalizes the in-band `stalenessWindow` disclosure (T030, after:T018) — it constrains the online path rather than adding a feature, so it follows US1/US3.
- **US4 (P2)** builds `crl.ts` (project + sign + monotonic version), the `crl-worker.ts` regeneration job started fail-open from `main.ts` (T035, needs T034's `generateCrl`), the `revocation-list.ts` read handler (T036), the rate-limited GET route (T037, after:T019), and documents client fail-open/anti-downgrade/untrusted-signature rules (T038). T036 exposes `getRevocationList` consumed by T037.
- **US6 (P3)** adds the anchor-floor rejection + per-plan offline-tolerance re-anchor gate in `enforce.ts` (T040, after:T022), consuming `resolvePlanWindows` (T003).
- **Polish (Phase 9)** depends on the delivery routes/handlers: rate-limit completion + IT (T041, after:T037), audit IT (T042), tenant-isolation IT (T043), the autocannon perf SLO (T044), the no-key/no-secret leakage suite (T045), the coverage gate (T046, after:T044), and CI (T047).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits (`enforce.ts`, `routes.ts`, `crl.ts`, `main.ts`, `config/index.ts`, and the single migration file) are sequential.

## Delivery Notes

- **Refusal semantics (AD-001, HINT-002)**: validate/heartbeat are enforcement QUERIES — a non-valid outcome is a `200` + `verdict` (revoked/suspended/expired/deactivated) with NO `shortLivedToken`, mapped to `checkin.outcome='refused'` + `reason`. Only genuine faults are errors: 400/401/403/404, `409 nonce_replayed` (nonce reused for a DIFFERENT activation), `429 rate_limited`, `503 signer_unavailable` (valid but could not sign — anchor not advanced, retry within the grace window).
- **Renewal token reuse ({SAD:ADR-0010}, HINT-001, AD-005)**: `mintShortLivedToken` re-signs the EXACT LIC1 `Claims` (`signing/token.ts`) via the existing E004 signer with a near-term `exp` (= renewal window) + a signed-server-time anchor; it is a SEPARATE public artifact, NOT persisted, and `machine_bound_token` is never touched. The client's E001 verifier verifies it unchanged (offline-first, US5). The most-recent minted token is held on the `checkin` row for TTL-window idempotent replay ONLY.
- **Bounded, TTL-pruned anti-replay (AD-002, HINT-003)**: `checkin` is UNIQUE `(tenant_id, nonce)`, retained ≤ the renewal window (a nonce beyond that could only replay an already-expired token, fail-closed). A reused nonce for the SAME activation replays the ORIGINAL `renewed_token` (no second mint, anchor not advanced twice); a nonce for a DIFFERENT activation is rejected 409. This is NOT the E009 permanent per-activation nonce. Retention pruning is the platform owner path (no DELETE grant to the app role).
- **CRL projected but signed (AD-003/004, HINT-004)**: the revoked-id set is projected on-demand from `license.status='revoked'` (+ policy-included deactivated activations); only the SIGNED, byte-stable, versioned artifact is stored in `revocation_list`, `version = max(version)+1` per (tenant, product) inside the generation tx (FR-022 anti-downgrade). Served cacheable (`ETag`=version, `Cache-Control`/`Expires`→`next_update`, `If-None-Match`→304); the JSON and `?format=file` forms cover IDENTICAL canonical bytes so the detached signature verifies the same. Signature-invalid = UNTRUSTED (FR-023); unreachable = fail-open (FR-011) — distinct client behaviours, documented.
- **Clock-tamper is client-side (HINT-005)**: the server supplies signed server time + short `exp` + the monotonic `last_anchor_at` floor (guarded UPDATE, never a trigger) and refuses renewal past the per-plan offline-tolerance window; a never-connected client's pure-offline rollback is BOUNDED by that window, not eliminated — disclosed honestly (FR-013, US6-AC3).
- **Tests**: integration suites use @testcontainers/postgresql reusing the activation/issuance RLS+migration harness; the signer is the REAL E004 signer and the short-TTL token is verified OFFLINE against the E001 WASM core (SC-001). The autocannon perf tier asserts p95<120ms (SC-008) and measures revocation propagation ≤ the renewal window (SC-004).
- No deferred work: US4 (P2) and US6 (P3) are fully in-scope; the MVP gate is US1+US2+US3+US5.

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T015, T018, T019 | T019 |
| FR-002 | T012, T015, T023, T025 | T025 |
| FR-003 | T004, T025, T026 | T026 |
| FR-004 | T011, T024, T025, T026 | T026 |
| FR-005 | T011, T020, T022 | T022 |
| FR-006 | T011, T021, T022 | T022 |
| FR-007 | T012 | T012 |
| FR-008 | T004, T013 | T013 |
| FR-009 | T004, T031, T034, T035 | T035 |
| FR-010 | T032, T036, T037 | T037 |
| FR-011 | T038 | T038 |
| FR-012 | T027, T029 | T029 |
| FR-013 | T018, T028, T030 | T030 |
| FR-014 | T004, T012, T013, T039, T040 | T040 |
| FR-015 | T003, T039, T040 | T040 |
| FR-016 | T002, T003 | T003 |
| FR-017 | T011, T023, T025 | T025 |
| FR-018 | T005, T043 | T043 |
| FR-019 | T013, T035, T042 | T042 |
| FR-020 | T044 | T044 |
| FR-021 | T019, T026, T037, T041 | T041 |
| FR-022 | T033, T034, T038 | T038 |
| FR-023 | T038 | T038 |

**Rollup**: 23/23 functional requirements covered (FR-001..FR-023). 10 success criteria exercised — SC-001/010 (US1), SC-002/003/004 (US2/US3), SC-005/006 (US5), SC-007 (US4), SC-008 (Polish perf), SC-009 (US6). No coverage gaps.
