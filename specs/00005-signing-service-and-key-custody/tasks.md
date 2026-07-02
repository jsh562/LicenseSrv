# Tasks: Signing Service and Key Custody

**Feature**: `00005-signing-service-and-key-custody` | **Epic**: E004 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00005-signing-service-and-key-custody/` (spec.md, plan.md, data-model.md, contracts/signing-keys.openapi.yaml, checklists/)

**Tests**: Included — the spec/plan mandate conformance, integration (Testcontainers), custody-unit, and secret-leakage tests; they are enumerated as tasks and gate their objectives.

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002) and the Postgres schema (migrations `0000`–`0003`). Reuses E002 `withTenant()` + tenant repository, `writeAudit()`/`recordSecurityEvent()`, the advisory-locked migration harness, forced-RLS policy form, and the Fastify `preHandler` tenant-auth + `rbac.ts` `authorize()`. No new crypto primitive is re-derived — Ed25519 is `node:crypto`; the E001 `LIC1` format stays single-sourced by the Rust `verifier-core` used through the E003 WASM package (`src/bindings/wasm/pkg`) as the conformance oracle.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| OBJ1 — Pluggable signer interface + default keystore signer | P1 🎯 MVP | `Signer` + `KeystoreSigner` + config factory | A keystore-minted `LIC1` token verifies via the real `verifier-core` (E003 WASM); no private bytes in response/log/error |
| OBJ2 — Per-product keys + signing-key registry | P1 🎯 MVP | `signing_key` CRUD + key gen + active-key selection + provision/list REST | Two products get distinct `key_id`s; RLS denies cross-tenant read/use; A-token fails under B; audit written |
| OBJ3 — Overlapping rotation + public keyring + REST | P1 🎯 MVP | rotate/revoke/retire + JWKS keyring + rotate/revoke/keyring routes | v1 license still verifies after rotate to v2; revoked key omitted from keyring and never signs |
| OBJ4 — Custody, recovery & fail-closed | P1 🎯 MVP | Shamir k-of-n boot unlock + readiness + recovery runbook | Below k shares → does not unlock, signs nothing (defined error); backend down → refused, no partial token, no key in logs |
| OBJ5 — Optional cloud-KMS / PKCS#11 adapter | P2 (non-blocking) | `KmsSigner` + factory branch | Switching to the KMS adapter needs no caller change and still yields verifiable tokens; key never leaves the backend |

**MVP gate**: OBJ1 + OBJ2 + OBJ3 + OBJ4 (all P1). OBJ5 (P2) is explicitly non-blocking for the P1 gate; every OBJ5 task is tagged `[OBJ5]` and lives in its own phase after the P1 phases.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds `0004`, expand-only, no change to `0000`–`0003`); `src/server/modules/index.ts` (registers the signing module seam); reuses `src/server/db/` (repository + `withTenant` + `migrate.ts`), `src/server/audit/` (`writeAudit`/`recordSecurityEvent`), `src/server/auth/rbac.ts` (`authorize`).
- **Compatibility**: the `Signer` interface is owned here and MUST NOT be forked by E008/E010; config-driven selection keeps callers unchanged when swapping keystore ↔ KMS (TR-017).
- **Regression focus**: existing E002 RLS/tenant isolation and audit append-only semantics must keep working; `product_keyring` is a `security_invoker` view so it never bypasses tenant isolation.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 [P] Add the Shamir secret-sharing lib + a CBOR codec and wire the E003 src/bindings/wasm/pkg conformance-oracle dep in package.json (DEVIATION: hand-rolled minimal CBOR + Shamir/GF256 — no external deps, self-contained/auditable, byte-conformance proven; E003 wasm oracle wired via relative import in token.ts)

---

## Phase 2: Foundational (Cross-Objective Blockers)

**These block every objective: the `0004` migration, the `Signer`/`KeyMaterial` boundary, the LIC1 encoder + runtime conformance oracle, Shamir custody, and the tenant-scoped registry data-access.**

- [X] T002 [P] {TR-004,TR-005} Create signing_key table + tenant-leading indexes, UNIQUE (tenant_id,product_id,key_id), partial-unique active index in migrations/0004_signing_keys.sql
- [X] T003 {TR-004} Add ENABLE/FORCE RLS + tenant_isolation policy (USING/WITH CHECK app.current_tenant) + grants to licensesrv_app in migrations/0004_signing_keys.sql
- [X] T004 {TR-008} Add the product_keyring security_invoker view (public material only; status IN active/rotating/retired) in migrations/0004_signing_keys.sql
- [X] T005 {TR-001,TR-010} Signer interface (sign-only, no export), KeyMaterial boundary, SignerUnavailable in src/server/modules/signing/signer.ts → exports: Signer, KeyMaterial, SignerUnavailable
- [X] T006 {TR-018} LIC1 encoder — CBOR-assemble claims + node:crypto Ed25519 sign, stamp key_id, in src/server/modules/signing/token.ts ← T005:KeyMaterial → exports: assembleLic1Token
- [X] T007 {TR-018} Runtime conformance oracle — verify each minted token via the wasm/pkg core or return a zero-byte error, in src/server/modules/signing/token.ts → exports: mintConformantToken
- [X] T008 {TR-012,TR-013} Shamir k-of-n master-key reconstruct + AES-256-GCM wrap/unwrap in src/server/modules/signing/custody.ts → exports: reconstructMasterKey, wrapPrivateKey, unwrapPrivateKey
- [X] T009 [P] {TR-004} Tenant-scoped signing_key data-access (row mapper + withTenant CRUD under RLS) in src/server/modules/signing/registry.ts → exports: SigningKeyRepo

---

## Phase 3: OBJ1 — Pluggable signer interface + default keystore signer (Priority: P1) 🎯 MVP

**Goal**: A default encrypted-keystore/soft-HSM signer mints `LIC1` tokens without surfacing the private key, and the signer is chosen by config.

**Independent test**: Instantiate the keystore signer, mint a token for a product, verify it offline via the E003 WASM `verifier-core`; inspect response/logs/errors — no private-key bytes (SC-001).

- [X] T010 [OBJ1] {TR-002} Default KeystoreSigner: unwrap key in custody, sign via token, in src/server/modules/signing/keystore-signer.ts ← T007:mintConformantToken → exports: KeystoreSigner
- [X] T011 [OBJ1] {TR-011,TR-018} Fail-closed: custody fault returns SignerUnavailable, zero bytes, no key in error, in src/server/modules/signing/keystore-signer.ts
- [X] T012 [OBJ1] {TR-017} Config-driven signer factory selecting the keystore signer by default in src/server/modules/signing/index.ts ← T010:KeystoreSigner → exports: createSigner
- [X] T013 [OBJ1] {TR-018} Conformance test: keystore-minted tokens verify via wasm/pkg core (SC-001) in src/server/modules/signing/__tests__/conformance.test.ts after:T011

---

## Phase 4: OBJ2 — Per-product keys + signing-key registry (Priority: P1) 🎯 MVP

**Goal**: Per-product Ed25519 key provisioning and a persisted, tenant/product-scoped registry with active-key selection, audited on every change.

**Independent test**: Provision keys for two products/tenants against real Postgres — distinct `key_id`s, RLS denies cross-tenant read/use, a product-A token fails under product-B's key, and each lifecycle event writes an audit entry (SC-002, SC-003).

- [X] T014 [OBJ2] {TR-003} Per-product Ed25519 keypair gen + unique key_id, wrap key via custody, in src/server/modules/signing/registry.ts ← T008:wrapPrivateKey → exports: generateSigningKey
- [X] T015 [OBJ2] {TR-005,TR-014} Provision (first key→active else→rotating) + signing_key.created audit in src/server/modules/signing/registry.ts → exports: provisionSigningKey
- [X] T016 [OBJ2] {TR-006} Active-key selection (status='active') stamping the token key_id in src/server/modules/signing/registry.ts → exports: selectActiveKey
- [X] T017 [OBJ2] {TR-004} Provision route POST …/signing-keys (201+Location, admin RBAC, 4xx) in src/server/modules/signing/routes.ts ← T015:provisionSigningKey → exports: registerSigningRoutes
- [X] T018 [OBJ2] {TR-005,TR-010} [COMPLETES TR-005] List route GET …/signing-keys → 200, viewer+ RBAC, public metadata only, in src/server/modules/signing/routes.ts
- [X] T019 [OBJ2] {TR-004,TR-015} [COMPLETES TR-004] Integration test: RLS isolation, provision, active-key, audit, cross-product, in src/server/modules/signing/__tests__/registry.integration.test.ts

---

## Phase 5: OBJ3 — Overlapping rotation + public keyring + REST (Priority: P1) 🎯 MVP

**Goal**: Rotate a product's active key so new tokens use a new `key_id` while prior-key tokens keep verifying, publish the JWKS keyring, and revoke by omission.

**Independent test**: Rotate v1→v2 and re-publish the keyring — a v1-signed license still verifies and new licenses carry v2; a revoked key is absent from the keyring and never signs; a product-A token fails under product-B (SC-004, SC-005).

- [X] T020 [OBJ3] {TR-007} Rotate — activate new key + prior active→rotating in ONE txn (overlap), in src/server/modules/signing/rotation.ts ← T014:generateSigningKey → exports: rotateKey
- [X] T021 [OBJ3] {TR-009,TR-019} Revoke (status→revoked: off keyring + never selected) and retire (retired never signs, stays publishable until removed; bounded overlap close) in src/server/modules/signing/rotation.ts → exports: revokeKey, retireKey
- [X] T022 [OBJ3] {TR-014} Append-only audit for rotate/retire/revoke (rotated/retired/revoked; revoke → security_event) in src/server/modules/signing/rotation.ts
- [X] T023 [OBJ3] {TR-008,TR-019} JWKS keyring from product_keyring view (active+rotating+retired trusted; kid/kty/crv/alg/x/validity; no private material) in src/server/modules/signing/keyring.ts after:T004 → exports: buildKeyring
- [X] T024 [OBJ3] {TR-007,TR-009} Rotate + revoke routes (200; admin RBAC; 409 rotation_in_flight/already_revoked) in src/server/modules/signing/routes.ts ← T020:rotateKey ← T021:revokeKey
- [X] T025 [OBJ3] {TR-008} [COMPLETES TR-008] Public keyring route GET …/keyring → 200 jwk-set+json, viewer+/public-distribution, in src/server/modules/signing/routes.ts ← T023:buildKeyring
- [X] T026 [OBJ3] {TR-007,TR-009,TR-015} [COMPLETES TR-007,TR-009] Integration: rotate keeps v1, revoke omits, cross-product, in src/server/modules/signing/__tests__/rotation.integration.test.ts
- [X] T027 [OBJ3] {TR-018} [COMPLETES TR-018] Conformance ext: rotated-key tokens verify under the published keyring via wasm/pkg in src/server/modules/signing/__tests__/conformance.test.ts after:T020 (covered in signing.integration.test.ts: pre-rotation token verifies under published keyring, SC-004)

---

## Phase 6: OBJ4 — Custody, recovery & fail-closed operation (Priority: P1) 🎯 MVP

**Goal**: Gate keystore unlock behind Shamir k-of-n at boot, reflect custody state in readiness (not liveness), fail closed on any custody/backend fault, and document backup separation for recovery.

**Independent test**: Start with fewer than k shares — the signer does not unlock, signs nothing, returns a defined error, and readiness fails; with the backend unavailable a signing request is refused with no partial/unsigned token and no key material in logs (SC-006).

- [X] T028 [OBJ4] {TR-011,TR-012} Boot-time unlock — reconstruct master key from k-of-n shares (E006), zeroize on shutdown, in src/server/modules/signing/index.ts ← T008:reconstructMasterKey
- [X] T029 [OBJ4] {TR-011} [COMPLETES TR-011] Readiness (not liveness) reflects custody — below k/backend down → not-ready, signer locked, in src/server/modules/signing/index.ts
- [X] T030 [OBJ4] {TR-013} Write the key-recovery runbook: keystore backup separated from unlock material, k-of-n custodian recovery steps, in deploy/signing-key-recovery.md
- [X] T031 [OBJ4] {TR-012} [COMPLETES TR-012] Custody unit: Shamir split/recombine, envelope wrap/unwrap, fail-closed <k + backend down, in src/server/modules/signing/__tests__/custody.unit.test.ts

---

## Phase 7: OBJ5 — Optional cloud-KMS / PKCS#11 adapter (Priority: P2, non-blocking)

**Non-blocking for the P1 MVP gate.** The self-host MVP is fully served by the default keystore signer (OBJ1–OBJ4); this phase adds managed/hardware custody behind the same interface.

**Independent test**: Configure the deployment to the KMS/PKCS#11 adapter with no caller change — issuance still produces tokens that verify offline, and the private key never leaves the backend (no export path) (SC-007).

- [ ] T032 [OBJ5] {TR-016} [DEFERRED] KMS/PKCS#11 adapter implements Signer (sign-only, no export; opaque-handle scheme) in src/server/modules/signing/kms-signer.ts ← T005:Signer → exports: KmsSigner
- [ ] T033 [OBJ5] {TR-016,TR-017} [DEFERRED] Extend the config-driven factory to select KMS/PKCS#11 vs keystore with no caller change in src/server/modules/signing/index.ts after:T012 ← T032:KmsSigner
- [ ] T034 [OBJ5] {TR-016} [DEFERRED] [COMPLETES TR-016] KMS-swap: no caller change, tokens verify via wasm/pkg, key stays in backend, in src/server/modules/signing/__tests__/conformance.test.ts after:T033

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T035 [P] {TR-010} [COMPLETES TR-010] Secret-leakage: no private-key bytes in any response/log/error on all key paths (SC-001) in src/server/modules/signing/__tests__/secret-leakage.test.ts
- [X] T036 [P] Register the signing module (routes + createSigner + initCustody + readiness) in src/server/modules/index.ts after:T029 ← T017:registerSigningRoutes
- [X] T037 [P] Unit tests (keyring projection, status guards, envelope round-trip) for ≥80% line+branch coverage in src/server/modules/signing/__tests__/signing.unit.test.ts
- [X] T038 [P] Verify the server-ci security gate covers the signing module — npm audit (no critical) + semgrep on src/server/modules/signing — in .github/workflows/server-ci.yml (existing gate globs src/server/** + migrations/**; lint/typecheck/audit/semgrep/coverage all cover the signing module)

---

## Dependencies

Setup → Foundational → OBJ1 → OBJ2 → OBJ3 → OBJ4 → OBJ5 (P2, non-blocking) → Polish

- **Setup (Phase 1)** has no dependencies.
- **Foundational (Phase 2)** depends on Setup (deps installed). Migration tasks T002→T003→T004 edit one file sequentially; T005 (`Signer`) blocks T006/T010/T032; T006→T007 (token) blocks T010; T008 (custody) blocks T010/T014/T028/T031; T009 (registry data-access) blocks T014/T015/T016.
- **OBJ1 (Phase 3)**, **OBJ2 (Phase 4)**, **OBJ3 (Phase 5)**, **OBJ4 (Phase 6)** are all P1 and together form the MVP gate; each is independently testable. OBJ3 rotation depends on OBJ2 key gen/selection (`← T014` on T020); OBJ4 custody wiring depends on the OBJ1 factory (`after:T012` chain via T028).
- **OBJ5 (Phase 7)** is P2 and non-blocking for the P1 gate; it extends the OBJ1 factory (`after:T012`) and the `Signer` from Foundational.
- **Polish (Phase 8)** depends on all P1 objectives (module registration `after:T029`); OBJ5 need not be complete for Polish.
- Tasks marked `[P]` can run in parallel within their phase (distinct files, no intra-batch dependency).
- A task carrying `after:T###` or `← T###:Symbol` must not be `[P]`-batched with the referenced task; all such references here point to prior-phase or earlier-in-phase tasks.
- Same-file sequential edges (e.g. within `registry.ts`, `rotation.ts`, `routes.ts`, `token.ts`, `index.ts`) are implied by task order and are not re-annotated.
