---
description: "Task list for feature implementation: Air-Gapped Activation (E010)"
---

# Tasks: Air-Gapped Activation

**Feature**: `00011-air-gapped-activation` | **Epic**: E010 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00011-air-gapped-activation/` (spec.md, plan.md, contracts/airgap-api.openapi.yaml, research.md, checklists/{security,api-quality,data-integrity}.md)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (codec encode/decode round-trip, formatVersion + freshness + oversize validation, PII-free envelope) and Testcontainers integration (full round-trip: request file → POST → response file → decode → OFFLINE verify via the E001 WASM core; seat consume + cap refusal no-response-file; idempotent byte-identical replay no-2nd-seat; drift re-match same seat; non-active/too-few/stale/unknown-version/oversize/signer refusals each audited `airgap.denied`; tenant isolation cross-tenant 404; rate-limit 429; audit; perf <1s), plus a ≥80% line+branch coverage gate. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1–US3 are P1 and each is an independently testable slice against the runtime portal via Fastify `inject`; US4 is P2/DEFERRED (the console upload/download variant is out of the MVP).

## Project Mode

`Brownfield` — air-gap is a FILE TRANSPORT over the EXISTING E009 activation module. **No new module, no migration, no SPA in the MVP.** One new file (`src/server/modules/activation/airgap.ts`, the request/response file codec + `processAirGapRequest`), two seam edits to the existing module (`routes.ts` gains `POST /v1/air-gap/activations`; `index.ts`/`ActivationConfig` gains air-gap keys), and two new test files. `@fastify/rate-limit` is already a dependency (E009). Seat cap, K-of-N binding, single-use nonce store-and-replay, tenant isolation, GDPR retention, and the fail-closed sign-after-seat all come from the E009 `activate()` service verbatim (AD-004); the response file's tamper-evidence is the embedded LIC1's Ed25519 signature (AD-003, no second envelope signature, zero new crypto).

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Activate an air-gapped machine via signed file exchange | P1 🎯 MVP | versioned base64url(JSON) request decode + response encode → `processAirGapRequest` calls E009 `activate()` verbatim → package the signed LIC1 → runtime `/v1` portal route | request file → POST → response file → decode → offline verify via the E001 WASM core, zero network (SC-001/002) |
| US2 — Air-gap activation consumes a seat, idempotently | P1 🎯 MVP | inherited seat accounting through the file transport (one seat, race-safe cap, idempotent nonce, cross-transport nonce, drift re-match, tenant isolation) | 2-seat license fills, 3rd refused no-response-file; same-file replay byte-identical no 2nd seat; drift → same seat; cross-tenant 404 (SC-003/004/005/010) |
| US3 — Tamper-evident files and fail-closed validation | P1 🎯 MVP | embedded-LIC1 tamper-evidence + file-layer validation (oversize/malformed/unknown-version/stale) BEFORE `activate()`; every refusal fail-closed + audited | tampered/wrong-machine → rejected at import; malformed/unknown-version/stale/oversize/too-few/non-active/signer each a distinct code, no response file (SC-006/007/008) |
| US4 — Process an air-gap request from the console | P2 · DEFERRED | admin upload request file / download response file behind console RBAC + CSRF (reuses `processAirGapRequest`) | admin uploads → downloads; a viewer cannot |
| Polish | — | PII/key-leakage + audit completeness + rate-limit + retention + perf + coverage + CI | only salted hashes; every refusal audited; 429 audited; ≥80% coverage; <1s process |

**MVP gate**: US1 + US2 + US3 (all P1). US4 is P2/DEFERRED — no console/SPA work in the MVP. The E009 `activate()` service, the E004 signer (via `app.signer`, inherited through `activate()`), and the E001 WASM verifier core (offline verify of the response file in tests) are the integration seams.

## Brownfield Notes

- **Existing flows touched**: `src/server/modules/activation/index.ts` (extend `ActivationConfig` + `loadActivationConfig` with air-gap keys — no other module change); `src/server/modules/activation/routes.ts` (add `POST /v1/air-gap/activations` inside the SAME `@fastify/rate-limit` encapsulated `/v1` context as activate/deactivate, gated on the `activate` scope). No migration, no `src/server/modules/index.ts` seam edit (the module is already registered by E009), no new dependency.
- **`ActivationConfig` (T001) carries the E010 NEW-CONFIG**: request freshness window (default 604800s / 7d, FR-020/AD-005); request + response `formatVersion` (FR-014); max request-file size (the pre-decode oversize guard, FR-019); minimum fingerprint signal count = the E009 K-of-N threshold (`fpMin`, default 3, FR-020 — already enforced by `activate()`, so air-gap adds no separate min-signals check).
- **Inherited from E009 `activate(pool, signer, config, tenantId, {licenseId|licenseKey, signals, nonce, label})`** (mapped 1:1 from the decoded request file): race-safe seat cap + `seat_limit_reached` (FR-004), single-use nonce store-and-replay → `created:false` (FR-005), K-of-N drift re-match reusing the same seat (FR-025), cross-transport shared nonce store (FR-024), `withTenant`/forced-RLS tenant isolation + cross-tenant `license_not_found` (FR-011), `license_not_active` / `insufficient_signals` gates (FR-009), fail-closed sign-after-seat → `503 signer_unavailable` with no row (FR-023), and E009 retention/GDPR erasure on the SAME activation row (FR-027). Air-gap writes the SAME `activation` row with NO origin marker (AD-008); provenance lives ONLY in the `airgap.activated` audit entry (FR-026).
- **File-layer BEFORE activate (HINT-003/FR-028)**: `processAirGapRequest` runs the oversize guard → base64url decode → `formatVersion` check → freshness check → structure check, and ONLY THEN calls `activate()`. A file-layer refusal never reaches the seat-consuming transaction; seat reserve + sign + row insert all roll back atomically inside `activate()`'s one transaction. No refusal — file-layer or business — leaves a partial or duplicated activation.
- **Audit completeness (HINT-006/FR-012)**: the route audits `airgap.activated` (success) and `airgap.denied` (EVERY refusal, INCLUDING the file-layer 400s that are rejected before `activate()` runs). Unlike E009's route, which returns Zod/validation 400s via a direct `validation(reply,…)` that bypasses the denial-audit hook, the air-gap handler routes file-layer refusals through the audit path so "every air-gap refusal is audited" (SC-011) actually holds.
- **Tamper-evidence (AD-003/HINT-002/FR-006)**: the response envelope wraps the SIGNED LIC1 (`machineBoundKey`) that `activate()` returns; its Ed25519 signature IS the tamper-evidence. No second envelope signature and never any private-key material in the envelope/logs/audit. A tampered or wrong-machine response file is rejected at IMPORT (the E001 offline verify fails on the bound machine), not by the portal.
- **Keyring rotation (FR-016)**: mostly inherited — the response `keyId` selects the pinned keyring entry (published by E004, distributed with the SDK), so a credential signed by a rotated key still verifies offline; this epic defines no new key-distribution mechanism (verified by the offline round-trip in T003; see Delivery Notes).
- **Single integration test file**: the plan mandates ONE `airgap.integration.test.ts` (and ONE `airgap.unit.test.ts`). Multiple integration tasks append to that one file and are therefore SEQUENTIAL edits (not `[P]`); only distinct-file tasks (the unit file, `airgap.ts`, `routes.ts`, `airgap.yml`, `vitest.config.ts`) parallelize. Reuse the E009 integration harness (provision an E004 signing key + custody unlock + `activate`-scope API key + WASM `verifyOffline`).
- **Regression focus**: existing E009 online activate/deactivate + registry keep working (the route is additive inside the existing `/v1` rate-limit scope); the `activation` table and E008 `license` snapshot are read/written exactly as E009 does (no schema change); `activate()` is called verbatim (no fork of its logic).

---

## Phase 1: Foundational (Cross-Work-Item Blocker)

**Extend `ActivationConfig` + `loadActivationConfig` with the air-gap keys the codec (US1/US3) and the route (US1) both read. This is the only true cross-work-item blocker — there is no migration, no new module, and no new dependency.**

- [ ] T001 {FR-020} [COMPLETES FR-020] Extend ActivationConfig + loadActivationConfig with air-gap keys (freshness default 604800s/7d, request+response formatVersion, max request-file size; min-signals = E009 fpMin default 3) in src/server/modules/activation/index.ts → exports: ActivationConfig

---

## Phase 2: US1 — Activate an air-gapped machine via signed file exchange (Priority: P1) 🎯 MVP

**Independent test**: on an isolated machine produce a request file for an active license; POST it to `/v1/air-gap/activations` on a connected machine; decode the `200` response file; the embedded machine-bound LIC1 verifies offline (zero network) via the E001 WASM core on the originating machine (SC-001/002). **The integration suite provisions an E004 product signing key + unlocks custody + uses the E001 WASM core for offline verify (reuse the E009 activation test harness).**

- [ ] T002 [P] [US1] {FR-001,FR-006,FR-010,FR-014} Unit: request/response codec encode/decode round-trip + explicit formatVersion tag on BOTH files + PII-free envelope (salted hashes only, no raw ids) in src/server/modules/activation/__tests__/airgap.unit.test.ts
- [ ] T003 [P] [US1] {FR-002,FR-003,FR-006,FR-016} [COMPLETES FR-016] IT: request file → POST /v1/air-gap/activations → 200 {responseFile,created:true} → decode → offline verify via the E001 WASM core, zero network (SC-001/002) in src/server/modules/activation/__tests__/airgap.integration.test.ts
- [ ] T004 [US1] {FR-001,FR-007,FR-014} [COMPLETES FR-001,FR-014] Codec: versioned base64url(JSON) request decode + response encode; unknown/future formatVersion → unknown_format_version; malformed/non-base64url → validation_error in src/server/modules/activation/airgap.ts → exports: decodeRequestFile, encodeResponseFile
- [ ] T005 [US1] {FR-003,FR-006,FR-022} [COMPLETES FR-022] processAirGapRequest: validate file layer → call E009 activate() verbatim → package the signed LIC1 + metadata (activationId/keyId/expiresAt=min(license exp,TTL)/machineId) into the response file in src/server/modules/activation/airgap.ts ← T001:ActivationConfig → exports: processAirGapRequest
- [ ] T006 [US1] {FR-002,FR-012,FR-013} [COMPLETES FR-002] Register POST /v1/air-gap/activations (activate scope; SAME @fastify/rate-limit /v1 context as activate/deactivate; audit airgap.activated on success) in src/server/modules/activation/routes.ts after:T005 ← T005:processAirGapRequest

---

## Phase 3: US2 — Air-gap activation consumes a seat, idempotently (Priority: P1) 🎯 MVP

**Independent test**: process request files for distinct machines up to a 2-seat license's limit; the next distinct-machine request is refused `409 seat_limit_reached` with no response file and no seat; re-processing an already-processed request file returns the BYTE-IDENTICAL original response and does not change the seat count; the air-gap activation appears in the same E009 registry as online activations (SC-003/004/005). All seat/nonce/tenant behavior is inherited from `activate()` — these tasks prove it holds through the file transport.

- [ ] T007 [US2] {FR-003,FR-004,FR-005} [COMPLETES FR-003,FR-004,FR-005] IT: one seat consumed + registry parity with online (SC-003); seats-full → 409 seat_limit_reached, no response file, no seat (SC-004); same-file replay → byte-identical response, created:false, no 2nd seat (SC-005) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T006
- [ ] T008 [US2] {FR-011,FR-021,FR-024,FR-025} [COMPLETES FR-011,FR-021,FR-024,FR-025] IT: cross-tenant license → 404 license_not_found (SC-010); nonce retained via the activation → replay past the freshness window; cross-transport shared nonce (online↔air-gap); drift re-match (new nonce, ≥K) → same seat, created:false, refreshed response in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T007

---

## Phase 4: US3 — Tamper-evident files and fail-closed validation (Priority: P1) 🎯 MVP

**Independent test**: a response file imports and verifies offline, then tampering with it (or presenting it on a machine whose fingerprint doesn't match) makes the offline import/verify reject it — the portal is not involved (SC-006); a malformed / truncated / unknown-format-version / oversize / stale / too-few-signals / non-active-license / signer-unavailable submission is each refused with a DISTINCT code, no response file, and no seat, and each refusal is audited (SC-007/008). File-layer validation runs BEFORE `activate()` (HINT-003), so file errors stay distinct from activation errors and never leave partial state (FR-028).

- [ ] T009 [P] [US3] {FR-008,FR-019} Unit: freshness (producedAt older than the window → stale_request) + oversize guard (pre-decode, validation_error details.reason=oversize) in src/server/modules/activation/__tests__/airgap.unit.test.ts
- [ ] T010 [US3] {FR-006} [COMPLETES FR-006] IT: response imports + verifies offline, then a tampered / wrong-machine response → rejected at IMPORT (E001 offline verify fails, not the portal) (SC-006) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T008
- [ ] T011 [US3] {FR-007,FR-008,FR-009,FR-019,FR-023,FR-028} [COMPLETES FR-007,FR-009,FR-023] IT: malformed / unknown-version / stale / oversize / too-few-signals / non-active / signer-unavailable each a DISTINCT code, no response file, no seat (SC-007/008) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T010
- [ ] T012 [US3] {FR-008,FR-019,FR-028} [COMPLETES FR-008,FR-019,FR-028] Add oversize (pre-decode) + freshness (producedAt window → stale_request) validation BEFORE activate(); fail-closed, no partial state on any refusal in src/server/modules/activation/airgap.ts after:T005 ← T004:decodeRequestFile
- [ ] T013 [US3] {FR-012} Route: audit airgap.denied for EVERY refusal incl the file-layer 400s (validation_error/unknown_format_version/stale_request/oversize) — route them through the audit hook, no direct-return bypass (HINT-006) in src/server/modules/activation/routes.ts after:T006

---

## Phase 5: US4 — Process an air-gap request from the console (Priority: P2) · DEFERRED

**[DEFERRED — out of the MVP.]** A convenience over the authenticated portal endpoint for vendor support operators; the MVP works entirely via the `/v1` portal (US1). The console variant reuses `processAirGapRequest` behind the E009 console session + RBAC + CSRF posture; no `/admin` route or SPA is built in the MVP.

- [ ] T014 [US4] {FR-015} [DEFERRED] IT: an admin uploads a request file and downloads the signed response file (seat consumed); a viewer cannot (console RBAC + CSRF) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T005
- [ ] T015 [US4] {FR-015} [DEFERRED] [COMPLETES FR-015] Console air-gap upload/download (admin requireRole + CSRF) reusing processAirGapRequest, plus the admin SPA view in src/server/modules/activation/routes.ts after:T005 ← T005:processAirGapRequest

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T016 {FR-010,FR-017,FR-018} [COMPLETES FR-010,FR-017,FR-018] Leakage/threat IT: files, logs, and audit carry only salted hashes / pseudonymous machineId; the signing key never appears anywhere; no request-supplied claim trusted (server resolves/matches/checks) (SC-009) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T013
- [ ] T017 {FR-012,FR-026} [COMPLETES FR-012,FR-026] Audit IT: airgap.activated + airgap.denied (every refusal) carry actor/action/reason, never raw ids/nonce/fingerprint; air-gap provenance recorded SOLELY in the audit log (SC-011) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T013
- [ ] T018 {FR-013} [COMPLETES FR-013] Rate-limit IT: over-limit → 429 rate_limited + Retry-After; the throttled attempt is audited (SC-012) in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T013
- [ ] T019 [P] {FR-027} [COMPLETES FR-027] Confirm air-gap-originated rows inherit the E009 retention/erasure path (SAME activation table, no separate air-gap lifecycle) — assertion + note in src/server/modules/activation/airgap.ts
- [ ] T020 Perf IT: a single air-gap process (decode + activate + sign + encode) well under 1s in src/server/modules/activation/__tests__/airgap.integration.test.ts after:T018
- [ ] T021 Enforce ≥80% line+branch coverage of the air-gap codec + route in vitest.config.ts after:T020
- [ ] T022 [P] Add air-gap CI workflow (typecheck + lint, Testcontainers IT + coverage, npm audit --omit=dev --audit-level=high, semgrep) in .github/workflows/airgap.yml

---

## Dependencies

Foundational (Phase 1) → US1 (Phase 2) → US2 (Phase 3) → US3 (Phase 4) → US4 (Phase 5, DEFERRED) → Polish (Phase 6)

- **Phase 1 (Foundational)** has no dependencies; T001 extends `ActivationConfig` and blocks the codec + route.
- **US1 (Phase 2)** builds the codec (`airgap.ts` — T004 decode/encode, then T005 `processAirGapRequest`, same file, sequential) and the runtime route (T006, after:T005). The two TDD tests are just-in-time: T002 (unit) and T003 (IT) are distinct files → `[P]`, both written to fail before T004–T006.
- **US2 (Phase 3)** proves the inherited seat/idempotency/tenant behavior through the file transport — no new implementation; T007/T008 append to the single integration file (sequential, after:T006/T007).
- **US3 (Phase 4)** adds the file-layer validations (T012 `airgap.ts`, after:T005) and the audit-every-refusal route wiring (T013 `routes.ts`, after:T006); T009 (unit) is `[P]`, T010/T011 continue the single integration file (sequential, after:T008/T010).
- **US4 (Phase 5)** is DEFERRED (P2) — the console upload/download variant reuses `processAirGapRequest`; not required for the MVP.
- **Polish (Phase 6)** depends on all P1 stories: leakage/threat (T016), audit completeness (T017), rate-limit (T018) all append to the single integration file after the denial-audit wiring (after:T013); the retention note (T019, `airgap.ts`) and CI (T022, `airgap.yml`) are distinct files → `[P]`; the perf assertion (T020) and the ≥80% coverage gate (T021, after:T020) close out.
- Tasks marked `[P]` run in parallel within their phase (distinct files, no intra-batch dependency). Because the plan mandates ONE `airgap.integration.test.ts`, all integration-test tasks are sequential edits to it and are NOT `[P]`.
- A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references.

## Delivery Notes

- **No new module / migration / SPA (HINT-001, AD-008)**: air-gap is a file transport over E009. The only production files are the new `airgap.ts` and the two seam edits (`routes.ts`, `index.ts`). The `activation` table is written exactly as E009 writes it — no air-gap column, no `formatVersion` column, no migration.
- **Codec shape (AD-002)**: both files are versioned `base64url(JSON)` envelopes (portable, copy-pasteable via USB/email/QR). The request envelope carries `formatVersion`, a license reference (`licenseKey` XOR `licenseId`), `fingerprint.signals` (salted hashes), a single-use `nonce`, `producedAt`, and an optional `label`. The response envelope carries `formatVersion`, `activationId`, the signed `machineBoundKey` (LIC1), `keyId`, `expiresAt`, and the pseudonymous `machineId`. The crypto lives in the embedded LIC1, not the envelope (AD-003).
- **Always-200 + `created` (AD-007)**: the portal always answers `200 {responseFile, created}` — `created:true` on a new seat, `created:false` on an idempotent same-nonce replay (byte-identical original response) OR a K-of-N drift re-match (freshly re-signed response). There is no `201`/`Location` — it is a file-exchange transaction, not a caller-addressable REST resource.
- **Status precedence** (contract §STATUS PRECEDENCE): 401 (no tenant) → 403 (missing `activate` scope) → 429 (rate limit, before body parse) → 400 (file decode/version/freshness/oversize) → 404/409 (license resolution + business rules). The oversize guard and decode run before `activate()`; `activate()` owns 404/409/400-insufficient_signals/503.
- **Keyring rotation (FR-016)**: verified by the offline round-trip (T003) — the `keyId` selects the pinned keyring entry so a rotated-key credential still verifies offline; E004's overlapping keyring keeps prior-key credentials valid through rotation. This epic adds no key-distribution mechanism (inherited assumption; noted, then verified by the offline verify).
- **Test suite as delivered**: two files — `airgap.unit.test.ts` (pure codec + validation) and `airgap.integration.test.ts` (the full round-trip + offline verify + seat/idempotency/refusals + tamper-at-import + tenant isolation + audit + rate-limit + perf). Because there is one integration file, the per-task integration scenarios are enumerated separately but land in that single suite.
- **US4 deferred**: FR-015 (console upload/download) is P2 and out of the MVP; T014/T015 are tagged `[DEFERRED]`. The MVP is US1 + US2 + US3.
