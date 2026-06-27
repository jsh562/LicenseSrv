# Tasks: License Server

**Feature**: `00001-license-server` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Project Mode**: greenfield (monorepo scaffolding is part of this feature)
**Annotation sources**: data-model.md, contracts/openapi.yaml, plan Requirement Coverage Map → `← T###:` / `→ exports:` annotations enabled.

## Epic / Capability Map

| Phase | Scope | Work Items | Priority |
|-------|-------|------------|----------|
| Phase 0 | Foundations / Setup | repo, toolchains, CI, migration harness, Testcontainers, fake KMS signer | — |
| Phase 1 | P1 MVP (offline-first) | US1, US2, US3, US4, US5 | P1 |
| Phase 2 | Online lifecycle | US6, US7 | P2 |
| Phase 3 | Floating seats / usage / policy | US8 | P3 |
| Phase 4 | Polish & Cross-Cutting | security, coverage, perf, docs | — |

Critical ordering from plan Implementation Hints is enforced:
- HINT-001: verifier-core token format + Ed25519 verify FIRST (server signing + all bindings depend on the exact byte layout).
- HINT-002: fuzz the token parser BEFORE exposing FFI/WASM/UniFFI.
- HINT-003: tenant-scoped repository layer + Postgres RLS BEFORE any tenant-scoped route.

---

## Phase 0 — Foundations / Setup

- [ ] T001 Initialize git repo, root `.gitignore`, `README.md`, and `/src` workspace root per Source Code Layout (ENFORCE_SRC_ROOT)
- [ ] T002 [P] Scaffold pnpm/npm workspace at repo root in `package.json` (workspaces: `src/server`, `src/admin-ui`) with shared `tsconfig.base.json` (`strict: true`)
- [ ] T003 [P] Scaffold Cargo workspace at repo root in `Cargo.toml` (members: `src/verifier-core`, `src/bindings/c-abi`, `src/bindings/wasm`, `src/bindings/uniffi`)
- [ ] T004 [P] Configure ESLint + Prettier (TS, strict) in `.eslintrc.cjs`, `.prettierrc`; configure rustfmt + Clippy (`-D warnings`) in `rustfmt.toml`, `clippy.toml`
- [ ] T005 [P] Configure Vitest + c8 coverage in `vitest.config.ts` and `src/server/__tests__/setup.ts` (80% threshold)
- [ ] T006 [P] Configure cargo test, cargo-llvm-cov, and criterion bench harness in `src/verifier-core/Cargo.toml` and `src/verifier-core/benches/verify.rs`
- [ ] T007 [P] Configure cargo-fuzz scaffold in `src/verifier-core/fuzz/Cargo.toml` and `src/verifier-core/fuzz/fuzz_targets/.gitkeep` (targets added in T035)
- [ ] T008 Create Postgres migration harness in `src/server/db/migrate.ts` → exports: runMigrations(pool), migrationDir
- [ ] T009 [P] Configure Testcontainers Postgres 16 fixture in `src/server/__tests__/pg-container.ts` ← T008:runMigrations → exports: withPostgres(fn) after:T008
- [ ] T010 [P] Implement fake KMS signer (deterministic Ed25519 keypair) for tests in `src/server/signing/kms.fake.ts` → exports: FakeKmsSigner.sign(keyId,bytes)
- [ ] T011 [P] Configure CI pipeline in `.github/workflows/ci.yml` (jobs: lint, ts-typecheck, vitest+coverage, cargo test, clippy, semgrep, npm audit, cargo audit, criterion smoke)

---

## Phase 1 — P1 MVP 🎯

Independently testable slice covering US1–US5 and FR-001..FR-022, FR-028..FR-031.
Built in hint order: verifier-core (T012–T028) → fuzz + bindings (T029–T035) → DB schema/repo/RLS (T036–T044) → auth/audit/signing (T045–T054) → server routes + UI (T055–T082).

### Verifier Core — token format + offline verify (US3, HINT-001 FIRST)

- [ ] T012 [US3] {FR-005,FR-030} Define CBOR token claim struct + `token_version=1` layout in `src/verifier-core/src/token.rs` → exports: TokenV1 (claims per data-model.md license/signing_key)
- [ ] T013 [US3] {FR-030} [COMPLETES FR-030] Implement `LIC1.<base64url(token)>` encode/decode in `src/verifier-core/src/encode.rs` after:T012 → exports: encode_lic1(), decode_lic1()
- [ ] T014 [US3] {FR-011} Implement key_id-indexed public keyring in `src/verifier-core/src/keyring.rs` → exports: Keyring.insert(key_id,VerifyingKey), Keyring.get(key_id)
- [ ] T015 [US3] {FR-008} Implement offline Ed25519 verify (signature + claim decode) in `src/verifier-core/src/verify.rs` after:T013,T014 → exports: verify_offline(&str,&Keyring)
- [ ] T016 [US3] {FR-012} Implement monotonic clock anchor (48h skew, AD-001) in `src/verifier-core/src/anchor.rs` → exports: Anchor.check(now,expires_at,skew) after:T012
- [ ] T017 [US3] {FR-015} Implement 3-of-5 salted-hash fingerprint match (AD-003) in `src/verifier-core/src/fingerprint.rs` → exports: Fingerprint(signals), match_kofn(&Fingerprint,&Fingerprint,k)
- [ ] T018 [US3] {FR-008,FR-009} Implement entitlement evaluation + reject expired/wrong-machine in verify path `src/verifier-core/src/verify.rs` after:T015,T016,T017 → exports: verify_offline()
- [ ] T019 [US5] {FR-016} Implement air-gap request/response file model (signed) in `src/verifier-core/src/airgap.rs` after:T012,T017 → exports: build_request_file(), import_response_file()

#### Verifier Core — tests (test-first / red-green per Testing Policy)

- [ ] T020 [P] [US3] {FR-005} Unit test token claim round-trip in `src/verifier-core/src/token.rs` (#[cfg(test)]) ← T012:TokenV1
- [ ] T021 [P] [US3] {FR-030} Unit test LIC1 encode/decode + malformed prefix in `src/verifier-core/src/encode.rs` (#[cfg(test)]) ← T013:encode_lic1
- [ ] T022 [P] [US3] {FR-011} Unit test keyring rotation (multi key_id select) in `src/verifier-core/src/keyring.rs` (#[cfg(test)]) ← T014:Keyring
- [ ] T023 [P] [US3] {FR-008,FR-009} Unit test valid/tampered/wrong-key verify in `src/verifier-core/tests/verify_test.rs` ← T015:verify_offline
- [ ] T024 [P] [US3] {FR-012} Unit test clock-rollback rejection beyond 48h skew in `src/verifier-core/tests/anchor_test.rs` ← T016:Anchor
- [ ] T025 [P] [US3] {FR-015} Unit test 3-of-5 drift tolerance + sub-threshold reject in `src/verifier-core/tests/fingerprint_test.rs` ← T017:match_kofn
- [ ] T026 [US3] {FR-009} [COMPLETES FR-009] Integration test reject matrix (tampered/expired/wrong-key/wrong-machine) in `src/verifier-core/tests/reject_matrix_test.rs` after:T018
- [ ] T027 [US3] {FR-008} [COMPLETES FR-008] Criterion benchmark Ed25519 verify incl. decode (<5ms, HINT-004) in `src/verifier-core/benches/verify.rs` ← T018:verify_offline after:T018
- [ ] T028 [US5] {FR-016} Unit test air-gap request/response round-trip in `src/verifier-core/tests/airgap_test.rs` ← T019:import_response_file

### Verifier Core — fuzz BEFORE bindings (HINT-002)

- [ ] T029 [US3] {FR-009} cargo-fuzz target for token parser (no panics across boundary) in `src/verifier-core/fuzz/fuzz_targets/token_parse.rs` ← T013:decode_lic1, T015:verify_offline after:T021,T023

### Verifier Core — language bindings (after fuzz; FR-010)

- [ ] T030 [P] [US3] {FR-010} Expose C ABI verify via cbindgen in `src/bindings/c-abi/src/lib.rs` + `src/bindings/c-abi/cbindgen.toml` ← T018:verify_offline after:T029 → exports: lic_verify_offline()
- [ ] T031 [P] [US3] {FR-010} Expose WASM verify via wasm-pack in `src/bindings/wasm/src/lib.rs` ← T018:verify_offline after:T029 → exports: verifyOffline(key,keyring)
- [ ] T032 [P] [US3] {FR-010} Expose UniFFI bindings in `src/bindings/uniffi/src/lib.rs` + `src/bindings/uniffi/verifier.udl` ← T018:verify_offline after:T029 → exports: verify_offline()
- [ ] T033 [US3] {FR-010} [COMPLETES FR-010] Binding parity test (C ABI / WASM / UniFFI same verdict on shared vectors) in `src/bindings/parity_test.rs` after:T030,T031,T032
- [ ] T034 [US3] {FR-005} [COMPLETES FR-005] Shared test-vector fixtures (canonical signed tokens) in `src/verifier-core/tests/vectors/lic1.json` after:T026 → exports: vectors
- [ ] T035 [US3] {FR-009} Wire cargo-fuzz corpus seed from vectors in `src/verifier-core/fuzz/corpus/.gitkeep` after:T034

### DB schema, tenant repository + RLS (HINT-003 — before any tenant route)

- [ ] T036 {FR-017} Define Drizzle schema for tenant/user/role/api_key in `src/server/db/schema.ts` → exports: tenants, users, roles, apiKeys
- [ ] T037 {FR-029,FR-002,FR-003} Extend schema: product/signing_key/plan/entitlement/plan_entitlement in `src/server/db/schema.ts` after:T036 → exports: products, signingKeys, plans, entitlements
- [ ] T038 {FR-022} Extend schema: customer/license/activation/audit_log in `src/server/db/schema.ts` after:T037 → exports: schema, customers, licenses, activations, auditLog
- [ ] T039 {FR-017} Author initial migration + Postgres RLS policies (tenant_id row filter) in `src/server/db/migrations/0001_init.sql` ← T038:schema after:T038
- [ ] T040 {FR-017} Implement tenant-scoped repository guard (asserts tenant_id on every read/write) in `src/server/db/repository.ts` after:T039 → exports: TenantRepo(tenantId).scope(table)
- [ ] T041 {FR-022} Implement salted-hash helpers (fingerprint/external_ref/key_hash) in `src/server/db/hash.ts` → exports: saltedHash(value), hmacLookup(value)
- [ ] T042 {FR-017} [COMPLETES FR-017] Integration test cross-tenant isolation (repo guard + RLS deny) in `src/server/__tests__/isolation.test.ts` ← T009:withPostgres, T040:TenantRepo after:T040
- [ ] T043 [P] {FR-017} Unit test repository tenant-scope assertions in `src/server/db/__tests__/repository.test.ts` ← T040:TenantRepo
- [ ] T044 [P] {FR-022} Unit test salted-hash determinism + non-reversibility in `src/server/db/__tests__/hash.test.ts` ← T041:saltedHash

### Auth, RBAC, audit, rate limit (cross-route foundation)

- [ ] T045 {FR-028} Implement console session auth (email+password, argon2id, tenant-scoped session) in `src/server/auth/session.ts` after:T040,T041 → exports: login(email,pw), requireSession
- [ ] T046 {FR-018} Implement runtime API-key auth + RBAC scope check in `src/server/auth/apikey.ts` ← T040:TenantRepo, T041:hmacLookup → exports: requireApiKey(scopes)
- [ ] T047 {FR-020} Implement append-only audit writer (actor/action/target/ts, insert-only) in `src/server/audit/log.ts` ← T040:TenantRepo → exports: audit(actor,action,target,before,after)
- [ ] T048 {FR-021} Implement rate-limit middleware + nonce/idempotency store in `src/server/middleware/ratelimit.ts` → exports: rateLimit(opts), consumeNonce(nonce)
- [ ] T049 [P] {FR-018,FR-028} Unit test session + API-key/RBAC accept/deny in `src/server/auth/__tests__/auth.test.ts` ← T045:login, T046:requireApiKey
- [ ] T050 [P] {FR-020} Integration test audit append-only (no UPDATE/DELETE) in `src/server/__tests__/audit.test.ts` ← T009:withPostgres, T047:audit

### Token signing via KMS (US2, FR-019/FR-029)

- [ ] T051 {FR-019} Implement KMS signer interface (sign via KMS, key never in memory) in `src/server/signing/kms.ts` ← T010:FakeKmsSigner → exports: KmsSigner.sign(keyId,bytes)
- [ ] T052 {FR-005,FR-029} Implement token builder (claims → CBOR → KMS sign → LIC1) in `src/server/signing/token.ts` ← T051:KmsSigner, T034:vectors after:T034 → exports: signLicense()
- [ ] T053 {FR-019} [COMPLETES FR-019] Unit test signer never returns/logs private key + KMS-only path in `src/server/signing/__tests__/kms.test.ts` ← T051:KmsSigner
- [ ] T054 {FR-029} [COMPLETES FR-029] Implement per-product key creation/rotation + jwks assembly in `src/server/signing/keyring.ts` after:T037,T051 → exports: createProductKey(), buildJwks()

### US1 — Configure Licensing Catalog No-Code

- [ ] T055 [US1] {FR-001,FR-002,FR-003} Implement catalog CRUD route handlers (products/plans/entitlements) in `src/server/routes/catalog.ts` after:T044,T047 → exports: registerCatalogRoutes
- [ ] T056 [US1] {FR-002} Implement entitlement resolution (bool/int, plan default + per-license override) in `src/server/services/entitlements.ts` ← T038:schema → exports: resolveEntitlements()
- [ ] T057 [US1] {FR-003} [COMPLETES FR-003] Implement plan-model validation (node-locked/subscription/perpetual/trial, max_version, maintenance_until) in `src/server/services/plan.ts` → exports: validatePlan(input)
- [ ] T058 [P] [US1] {FR-001} Zod request schemas for catalog endpoints in `src/server/routes/catalog.schema.ts` → exports: ProductInput, PlanInput, EntitlementInput
- [ ] T059 [US1] {FR-001,FR-002} [COMPLETES FR-001] [COMPLETES FR-002] Integration test no-code catalog CRUD + tenant scoping + persisted edits in `src/server/__tests__/catalog.test.ts` after:T055,T056,T057
- [ ] T060 [P] [US1] {FR-001} Admin UI: catalog screens (product/plan/entitlement create+edit) in `src/admin-ui/src/pages/Catalog.tsx` ← contracts/openapi.yaml after:T055
- [ ] T061 [P] [US1] {FR-028} Admin UI: interactive login screen + session handling in `src/admin-ui/src/auth/Login.tsx` ← T045:login after:T045

### US2 — Issue a Signed License

- [ ] T062 [US2] {FR-004} Implement license issuance service (resolve plan → build claims → sign → persist key_hash) in `src/server/services/issue.ts` after:T052,T056,T047 → exports: issueLicense()
- [ ] T063 [US2] {FR-004,FR-005} Implement POST /admin/v1/licenses route in `src/server/routes/licenses.ts` after:T062,T046,T045 → exports: registerLicenseRoutes
- [ ] T064 [US2] {FR-006} Implement license status PATCH (revoke/suspend/reinstate; block activation/renewal) in `src/server/routes/licenses.ts` ← T047:audit after:T063
- [ ] T065 [US2] {FR-007} [COMPLETES FR-007] Implement license transfer with transfer_limit enforcement in `src/server/services/transfer.ts` after:T038,T047 → exports: transferLicense()
- [ ] T066 [P] [US2] {FR-004,FR-005} Zod schemas for issuance/status/transfer in `src/server/routes/licenses.schema.ts` → exports: IssueInput, StatusInput, TransferInput
- [ ] T067 [US2] {FR-004} [COMPLETES FR-004] Integration test issue → signed key returned, recorded, private key never exposed (SC-003) in `src/server/__tests__/issue.test.ts` after:T063
- [ ] T068 [US2] {FR-006} [COMPLETES FR-006] Integration test revoke/suspend/reinstate blocks new activations in `src/server/__tests__/lifecycle.test.ts` ← T009:withPostgres after:T064
- [ ] T069 [P] [US2] {FR-004} Admin UI: issue-license + license detail (entitlements/expiry/seat/status, no private key) in `src/admin-ui/src/pages/Licenses.tsx` ← contracts/openapi.yaml after:T063

### US4 — Node-Locked Activation with Seat Limits

- [ ] T070 [US4] {FR-013,FR-031} Implement race-safe activation accounting (SELECT…FOR UPDATE seat count, default seat 1, trial dedup) in `src/server/services/activation.ts` after:T038,T017,T041 → exports: activate()
- [ ] T071 [US4] {FR-013,FR-021} Implement POST /v1/activations route (nonce anti-replay, 409 seat/revoked) in `src/server/routes/activations.ts` after:T070,T046,T048 → exports: registerActivations
- [ ] T072 [US4] {FR-014} [COMPLETES FR-014] Implement DELETE /v1/activations/{id} (deactivate, free seat) in `src/server/routes/activations.ts` ← T047:audit after:T071
- [ ] T073 [US4] {FR-031} [COMPLETES FR-031] Enforce default-seat-1 + one-active-trial-per-fingerprint in `src/server/services/activation.ts` ← T070:activate after:T070
- [ ] T074 [P] [US4] {FR-013} Zod schema for activation/deactivation in `src/server/routes/activations.schema.ts` → exports: ActivateInput
- [ ] T075 [US4] {FR-013} [COMPLETES FR-013] Integration test seat cap, (N+1) refusal, deactivate frees slot, concurrent last-seat no over-allocation (SC-006) in `src/server/__tests__/activation.test.ts` after:T072,T073
- [ ] T076 [US4] {FR-021} [COMPLETES FR-021] Integration test nonce replay rejection + rate-limit throttle (SC-009) in `src/server/__tests__/ratelimit.test.ts` after:T048,T071

### US5 — Air-Gapped Activation via File Exchange

- [ ] T077 [US5] {FR-016} Implement POST /v1/airgap/request (validate request → sign response → consume seat) in `src/server/routes/airgap.ts` after:T019,T070,T052,T046 → exports: registerAirgap
- [ ] T078 [US5] {FR-016} [COMPLETES FR-016] Integration test air-gap file round-trip activates + offline verify, no network from machine (SC-007) in `src/server/__tests__/airgap.test.ts` after:T077
- [ ] T079 [P] [US5] {FR-016} Admin UI: air-gap portal (upload request file → download response file) in `src/admin-ui/src/pages/Airgap.tsx` ← contracts/openapi.yaml after:T077

### US3 — Runtime support endpoints (entitlements + jwks)

- [ ] T080 [US3] {FR-011} Implement GET /v1/jwks public keyring endpoint in `src/server/routes/jwks.ts` ← T054:buildJwks after:T054 → exports: registerJwksRoutes
- [ ] T081 [US3] {FR-008} Implement GET /v1/entitlements resolve endpoint in `src/server/routes/entitlements.ts` after:T056,T046 → exports: registerEntitlementRoutes
- [ ] T082 [US3] {FR-008} E2E test embed verifier: offline verify valid key + reject tampered/expired (SC-004, SC-005) in `src/verifier-core/tests/e2e_offline.rs` ← T018:verify_offline after:T034

---

## Phase 2 — P2 Online Lifecycle (US6, US7)

### US6 — Online Validation, Heartbeat & Revocation Propagation

- [ ] T083 [US6] {FR-023} Add revocation/CRL + short-token model to schema in `src/server/db/schema.ts` ← T038:schema after:T038 → exports: revocations, shortTokens
- [ ] T084 [US6] {FR-023} Implement short-lived token renewal + revocation check service in `src/server/services/renewal.ts` ← T052:signLicense after:T064,T083 → exports: renewToken(token)
- [ ] T085 [US6] {FR-023} Implement POST /v1/validate (online validate + heartbeat + signed freshness anchor) in `src/server/routes/validate.ts` after:T084,T048 → exports: registerValidateRoutes
- [ ] T086 [US6] {FR-023} [COMPLETES FR-023] Integration test revoked license stops validating after renewal; never-connected client unaffected in `src/server/__tests__/validate.test.ts` after:T085

### US7 — Billing-Driven Lifecycle with Grace Periods

- [ ] T087 [US7] {FR-024} Add webhook + grace-period fields to schema in `src/server/db/schema.ts` ← T083:revocations after:T083 → exports: webhooks
- [ ] T088 [US7] {FR-024} Implement idempotent billing webhook handler (provision/extend/suspend + grace) in `src/server/routes/webhooks.ts` after:T087,T064,T047 → exports: registerWebhookRoutes
- [ ] T089 [US7] {FR-024} [COMPLETES FR-024] Integration test subscription-cancelled → grace → suspend; duplicate webhook idempotent in `src/server/__tests__/webhooks.test.ts` ← T009:withPostgres after:T088

### Floating seats (US8 scope but P2 per spec FR-025)

- [ ] T090 [US8] {FR-025} Implement floating-seat lease service (lease + auto-reclaim dead machines) in `src/server/lease/lease.ts` after:T070,T083 → exports: leaseSeat(), reclaimExpired()
- [ ] T091 [US8] {FR-025} [COMPLETES FR-025] Integration test lease at capacity refuses/queues; lease expiry reclaims seat in `src/server/__tests__/lease.test.ts` ← T009:withPostgres after:T090

---

## Phase 3 — P3 Usage Metering & Low-Code Policy (US8)

- [ ] T092 [US8] {FR-026} Add usage_event schema (idempotency_key unique) in `src/server/db/schema.ts` ← T038:schema after:T038 → exports: usageEvents
- [ ] T093 [US8] {FR-026} [COMPLETES FR-026] Implement idempotent usage ingestion + aggregation in `src/server/usage/usage.ts` after:T092,T048 → exports: ingestUsage(event), aggregateUsage(licenseId)
- [ ] T094 [US8] {FR-026} Integration test same usage event reported twice counted once in `src/server/__tests__/usage.test.ts` ← T009:withPostgres after:T093
- [ ] T095 [US8] {FR-027} [COMPLETES FR-027] Implement sandboxed low-code rules layer (guarded expressions, no free-form code) in `src/server/policy/rules.ts` after:T056 → exports: evalPolicy(rule,ctx)
- [ ] T096 [US8] {FR-027} Unit test policy sandbox rejects unsafe expressions + evaluates guarded rules in `src/server/policy/__tests__/rules.test.ts` ← T095:evalPolicy

---

## Phase 4 — Polish & Cross-Cutting

- [ ] T097 [P] {FR-022} [COMPLETES FR-022] Implement GDPR export + delete of customer personal data in `src/server/routes/customers.ts` after:T044,T047 → exports: registerCustomerRoutes
- [ ] T098 [P] {FR-020} [COMPLETES FR-020] Add optional audit hash-chain (prev_hash tamper-evidence) + verify tool in `src/server/audit/chain.ts` ← T047:audit after:T050
- [ ] T099 Wire Semgrep ruleset + `npm audit` + `cargo audit` gates into CI in `.github/workflows/ci.yml` after:T011
- [ ] T100 Enforce coverage gates (c8 ≥80% server, cargo-llvm-cov ≥80% core) in CI in `.github/workflows/ci.yml` after:T099
- [ ] T101 [P] Author integrator embedding docs (C ABI / WASM / UniFFI) + keyring pinning guide in `docs/integrating-verifier.md` after:T033
- [ ] T102 [P] Author admin no-code console + air-gap operator guide in `docs/admin-console.md` after:T079

---

## Dependencies

### Phase graph

```
Phase 0 (Setup) ──► Phase 1 (P1 MVP) ──► Phase 2 (P2) ──► Phase 3 (P3)
                              └──────────────────────────► Phase 4 (Polish)
```

- **Phase 0** has no dependencies; T009/T010 depend on T008 (migration harness) within the phase.
- **Phase 1** depends on Phase 0 (toolchains, migration harness, Testcontainers, fake KMS signer).
- **Phase 2 (P2)** and **Phase 3 (P3)** depend on Phase 1 (schema base T038, lifecycle T064, signer T052, activation T070).
- **Phase 4 (Polish)** depends on the relevant Phase 1 deliverables (CI T011, audit T047/T050, bindings T033, UI T079) and may run in parallel once those exist.

### Critical ordering (plan Implementation Hints — strict)

- **HINT-001**: verifier-core token format + Ed25519 verify (T012–T018) precede server signing (T051–T054) and all bindings (T030–T032). Server token builder T052 has `after:T034` (shared vectors) and `after:T051`.
- **HINT-002**: fuzz the token parser (T029) precedes C ABI / WASM / UniFFI exposure (T030, T031, T032 each `after:T029`).
- **HINT-003**: tenant-scoped repository + RLS (T039–T040) precede every tenant-scoped route. Catalog (T055), licenses (T063), activations (T071), airgap (T077) all transitively depend on T040.

### Key cross-task edges

- DB schema chain: T036 → T037 → T038 → T039 (migration+RLS) → T040 (repo guard).
- Signing chain: T010 (fake KMS) → T051 → T052 (← T034 vectors) → T054 (jwks) / T062 (issuance).
- Activation chain: T070 → T071 → T072; seat/trial rules T073; air-gap T077 reuses T070 + T019 + T052.
- Bindings parity: T030/T031/T032 → T033 (parity) using shared vectors T034.

### Parallelization notes

- Phase 0: T002–T007, T009–T011 are `[P]` (distinct files) after T001/T008 where noted.
- Verifier-core unit tests T020–T025 are `[P]` (separate test files / modules).
- Bindings T030/T031/T032 are `[P]` (distinct crates) — all gated `after:T029`, none batched with T029.
- Admin UI screens T060/T061/T069/T079 are `[P]` (distinct components), each gated `after:` its backing route/service.
- Polish T097/T098/T101/T102 are `[P]` (distinct files), each gated `after:` its prerequisite. T099→T100 are sequential (both edit `.github/workflows/ci.yml`).

### Requirement coverage (all FRs mapped)

| Phase | Requirements covered |
|-------|----------------------|
| Phase 1 (P1) | FR-001..FR-022, FR-028, FR-029, FR-030, FR-031 |
| Phase 2 (P2) | FR-023, FR-024, FR-025 |
| Phase 3 (P3) | FR-026, FR-027 |

No FR is unmapped. P1 requirements FR-001..FR-022 and FR-028..FR-031 each have at least one Phase-1 task; P2/P3 requirements are deferred to Phases 2–3 as required by the spec.
