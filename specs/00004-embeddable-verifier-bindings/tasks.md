# Tasks: Embeddable Verifier Bindings

**Feature**: `00004-embeddable-verifier-bindings` | **Epic**: E003 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Project Mode**: Mixed — new `src/bindings/` subtree wraps the existing, unchanged `src/verifier-core/` (E001). No crypto or parser is reimplemented; every binding wraps the one core (Principle III, FR-004).

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — C-ABI native/.NET binding | P1 🎯 MVP | C-ABI cdylib + cbindgen header + C sample | C program links lib+header, verifies valid offline (reads entitlement), rejects tampered/expired |
| US2 — WASM web/Node binding | P1 🎯 MVP | wasm-pack package + Node/browser sample | Node imports the package, verifies valid offline, rejects tampered and expired (distinct codes) |
| US4 — Cross-binding consistency + quickstart | P1 🎯 MVP | parity test + quickstart README | Same token → same outcome + same reason code in C-ABI and WASM; first verify < 30 min |
| US3 — UniFFI generated bindings | P2 (non-blocking) | uniffi package + Python sample | Python generated binding verifies valid offline, reads entitlements identical to other bindings |

**MVP gate**: US1 + US2 + US4 (all P1). US3 (P2) is explicitly non-blocking for the P1 MVP gate; every US3 task is tagged `[US3]` and lives in its own phase after the P1 phases.

**Foundational note**: The shared `ls-ffi` crate glue (reason-code map, opaque handles, `catch_unwind` panic guard, `ls_abi_version`, and the verify entry exposing the full FR-007 surface) blocks US1 and US2 because all bindings call it. It is built once in Phase 2 and reused by every binding surface (HINT-001, AD-003).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Add the `ls-ffi` crate with a `verifier-core` path dep and a `std` feature gating `catch_unwind` (HINT-004) in src/bindings/ls-ffi/Cargo.toml
- [X] T002 [P] Add `cbindgen`, `wasm-bindgen`, and `uniffi` as dev/build dependencies and declare `cdylib`+`staticlib`+`rlib` crate types in src/bindings/ls-ffi/Cargo.toml
- [X] T003 [P] Create the `src/bindings/` subtree scaffold (`c-abi/`, `wasm/`, `uniffi/`, `README.md` placeholder) per plan Project Structure in src/bindings/
- [X] T004 [P] {FR-017} Define the supported target matrix (`x86_64`/`aarch64`, `wasm32`, UniFFI) + per-target CI jobs that fail on a missing artifact in .github/workflows/bindings.yml

## Phase 2: Foundational (Shared `ls-ffi` Glue — blocks US1 and US2)

- [X] T005 {FR-006,FR-022} Implement the shared `reason_code(&VerifyError) -> u32` map in frozen order, reserved `Internal`=255, in src/bindings/ls-ffi/src/reason.rs → exports: reason_code, INTERNAL
- [X] T006 {FR-006} Document the frozen reason-code integers + `Internal`=255 as the external contract (single source of truth) in src/bindings/ls-ffi/src/reason.rs ← T005:reason_code
- [X] T007 {FR-005} Implement the `catch_unwind` panic guard so no unwind crosses FFI; a caught panic returns `Internal`=255 in src/bindings/ls-ffi/src/guard.rs ← T005:INTERNAL → exports: guard
- [X] T008 {FR-005} Map binding-observable non-unwinding faults (e.g. recoverable alloc failure) to a defined code, not UB; host abort/trap out of scope in src/bindings/ls-ffi/src/guard.rs
- [X] T009 {FR-008,FR-016} Define opaque handles with callee-alloc/explicit-free ownership + a null/invalid-handle guard in src/bindings/ls-ffi/src/lib.rs → exports: LsKeyring, LsResult, BadArgument
- [X] T010 {FR-015} Implement double-free / use-after-free safety: freeing or using a handle twice yields a defined no-op/`BadArgument`, never UB, in src/bindings/ls-ffi/src/lib.rs ← T009:LsKeyring
- [X] T011 {FR-007,FR-021} Implement the shared verify entry over the core verify with typed FR-007 inputs in src/bindings/ls-ffi/src/lib.rs ← T009:LsKeyring ← T007:guard → exports: ls_ffi_verify
- [X] T012 {FR-012,FR-022} Implement `ls_abi_version()` embedding core SemVer + token-format version; document the frozen symbol contract in src/bindings/ls-ffi/src/lib.rs → exports: ls_abi_version
- [X] T013 {FR-014} Ensure no key/raw-token/keyring/fingerprint bytes appear in any returned value, diagnostic, or log (incl. error paths) in src/bindings/ls-ffi/src/lib.rs ← T011:ls_ffi_verify
- [X] T014 [P] {FR-006} Unit test the reason-code map: every `VerifyError` variant maps to its frozen stable integer in src/bindings/ls-ffi/tests/reason.rs ← T005:reason_code
- [X] T015 [P] {FR-005} Unit test the panic guard: a forced panic in a wrapped body returns `Internal`=255 and never unwinds in src/bindings/ls-ffi/tests/guard.rs ← T007:guard
- [X] T016 [P] {FR-008,FR-015,FR-016} Unit test handles: alloc/free balance, double-free no-op, UAF + null → `BadArgument` in src/bindings/ls-ffi/tests/handles.rs ← T009:LsKeyring after:T010

## Phase 3: User Story 1 — C-ABI native/.NET binding (Priority: P1) 🎯 MVP

**Goal**: A C/.NET host links the cdylib + header and verifies a license offline, reading entitlements and rejecting tampered/expired tokens, leak-free.

**Independent test**: Compile + link + run a C program against the cdylib/header — valid token verifies offline and reads an entitlement; tampered and expired are rejected; allocate/verify/free lifecycle reports zero leaks.

- [X] T017 [US1] {FR-001} Declare the `extern "C"` surface (`ls_keyring_*`, `ls_verify`, `ls_result_*`, `ls_abi_version`) in src/bindings/ls-ffi/src/lib.rs ← T011:ls_ffi_verify → exports: ls_verify
- [X] T018 [US1] {FR-008,FR-016} [COMPLETES FR-008] Wrap every C-ABI entry in the panic + null-handle guards → defined code, never UB, in src/bindings/ls-ffi/src/lib.rs ← T009:BadArgument after:T017
- [X] T019 [US1] {FR-001,FR-010} [COMPLETES FR-001] Configure cbindgen and generate the authoritative C header in src/bindings/c-abi/include/licensesrv.h ← T017:ls_verify
- [X] T020 [US1] {FR-009,FR-018} Write the C reference linking lib+header: verify a valid token offline, read an entitlement, reject a tampered token in src/bindings/c-abi/examples/verify.c
- [X] T021 [US1] {FR-001,FR-009} Integration test: compile + link + run the C sample vs cdylib/header — valid reads entitlement, tampered/expired reject in src/bindings/ls-ffi/tests/c_integration.rs
- [X] T022 [US1] {FR-020} [COMPLETES FR-020] Extend the C test over the alloc/verify/free lifecycle, asserting leak-freedom via accounting or a sanitizer in src/bindings/ls-ffi/tests/c_integration.rs

## Phase 4: User Story 2 — WASM web/Node binding (Priority: P1) 🎯 MVP

**Goal**: A JS/TS host imports the WASM package and verifies a license offline in browser, Node, or Electron, reading entitlements and rejecting tampered and expired tokens with distinct reason codes.

**Independent test**: A Node sample imports the wasm-pack package, verifies a valid token offline, gates on an entitlement, and rejects tampered and expired tokens as two separate cases each asserting its own distinct reason code.

- [X] T023 [US2] {FR-002,FR-007} Implement the `wasm-bindgen` surface exposing FR-007 inputs + entitlement reads in src/bindings/ls-ffi/src/wasm.rs ← T011:ls_ffi_verify → exports: verify
- [X] T024 [US2] {FR-005} [COMPLETES FR-005] Guard the WASM surface so panics/faults + null inputs return the same codes as the C-ABI, no UB, in src/bindings/ls-ffi/src/wasm.rs ← T007:guard
- [X] T025 [US2] {FR-002,FR-010} [COMPLETES FR-002] Build the installable WASM package via wasm-pack (npm layout, `wasm32-unknown-unknown` target) in src/bindings/wasm/ ← T023:verify
- [X] T026 [US2] {FR-009,FR-018} [COMPLETES FR-018] Write the Node/browser reference: import the package, verify offline, gate on an entitlement in src/bindings/wasm/examples/node-verify.mjs
- [X] T027 [US2] {FR-002,FR-009} [COMPLETES FR-009] Node/Vitest test: valid verifies offline; tampered and expired rejected as two cases, each its own code in src/bindings/wasm/tests/verify.test.mjs

## Phase 5: User Story 4 — Cross-binding consistency + quickstart (Priority: P1) 🎯 MVP

**Goal**: The same token yields the same verdict and reason code across the C-ABI and WASM bindings, and a new integrator reaches a first successful offline verify in under 30 minutes.

**Independent test**: A parity test feeds the same valid and same tampered token through C-ABI and WASM and asserts identical outcome + reason code; a timed quickstart walkthrough reaches first verify in < 30 min.

- [X] T028 [US4] {FR-006} [COMPLETES FR-006] Cross-binding parity test: same valid + tampered token yield the same reason code in C-ABI and WASM in src/bindings/ls-ffi/tests/parity.rs after:T021,T027
- [X] T029 [US4] {FR-019} Determinism test: repeated verify with fixed FR-007 inputs always yields the same verdict + code, incl. expired in src/bindings/ls-ffi/tests/determinism.rs
- [X] T030 [US4] {FR-012,FR-022} [COMPLETES FR-022] Version-mismatch test: `ls_abi_version()` surfaces a core/token-format mismatch at load in src/bindings/ls-ffi/tests/version.rs
- [X] T031 [US4] {FR-011} [COMPLETES FR-011] Write the quickstart README from baseline to a first offline verify (C-ABI + WASM paths), targeting < 30 min in src/bindings/README.md after:T020,T026
- [X] T032 [US4] {FR-011} Timed quickstart walkthrough: follow the README from baseline to first offline verify, recording elapsed time vs the 30-min bound in src/bindings/README.md after:T031

## Phase 6: User Story 3 — UniFFI generated bindings (Priority: P2 — non-blocking)

**Goal (P2, non-blocking for MVP)**: A generated binding (e.g. Python) verifies a license offline and reads entitlements identical to the C-ABI/WASM bindings, via the single generator with no per-language crypto.

**Independent test**: A Python sample via the generated binding verifies a valid token offline and reads entitlements identical to the other bindings.

- [X] T033 [P] [US3] {FR-003,FR-005} Implement the UniFFI surface reusing the shared reason-code map + panic model in src/bindings/ls-ffi/src/uniffi.rs ← T011:ls_ffi_verify ← T005:reason_code
- [X] T034 [US3] {FR-003,FR-010} Generate and package the Python (UniFFI) binding via `uniffi-bindgen` in src/bindings/uniffi/ after:T033
- [X] T035 [US3] {FR-003} Write the generated-binding Python sample verifying a valid token offline (no network) and reading entitlements in src/bindings/uniffi/examples/verify.py after:T034
- [X] T036 [US3] {FR-003} [COMPLETES FR-003] Python UniFFI smoke test (non-blocking): generated binding verifies offline + reads entitlements like others in src/bindings/uniffi/tests/test_verify.py

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T037 {FR-013} Commit the fuzz seed corpus (valid, tampered-sig, truncated, oversized, empty, non-base64) for the core's `cargo-fuzz` target in src/verifier-core/fuzz/corpus/parse_token/
- [X] T038 {FR-013} [COMPLETES FR-013] Wire the per-PR fuzz gate: core `cargo-fuzz` ≥ 300s on the corpus, zero crashes/panics/OOMs/timeouts, in .github/workflows/bindings.yml after:T037
- [X] T039 {FR-014} Secret-leakage test: assert no returned value, diagnostic, or log on any path (incl. errors) carries key/token/keyring/fp bytes in src/bindings/ls-ffi/tests/secret_leakage.rs
- [X] T040 {FR-014} [COMPLETES FR-014] Wire `cargo audit` + WASM/npm + UniFFI dep scans (gate: no CRITICAL) and `cargo-llvm-cov` ≥ 80% glue into CI in .github/workflows/bindings.yml after:T038
- [X] T041 {FR-010,FR-017} [COMPLETES FR-010] Publish per-target artifacts (shared lib + header; npm WASM pkg) + the target matrix; unsupported target fails at build/load in src/bindings/README.md

---

## Dependencies

**Phase order**: Setup (P1) → Foundational (P2) → US1 (P3) → US2 (P4) → US4 (P5) → US3 (P6, P2 priority) → Polish (P7).

- **Setup (T001–T004)**: no dependencies. T002–T004 are `[P]` (distinct files).
- **Foundational (T005–T016)**: depends on Setup. T005 (reason map) and T007 (guard) and T009 (handles) are the spine; T011 (verify entry) depends on all three. T014–T016 unit tests are `[P]` against their respective modules. Foundational blocks US1 and US2 (all bindings call the shared glue).
- **US1 (T017–T022)**: depends on Foundational (T011 verify entry, T009 handles, T007 guard). T019 header depends on T017 symbols; T020–T022 chain on the C sample and integration test.
- **US2 (T023–T027)**: depends on Foundational (T011, T005, T007). Independent of US1 and may run in parallel with Phase 3 after Foundational completes.
- **US4 (T028–T032)**: depends on US1 (T021) and US2 (T027) for the parity test (T028); T029/T030 depend only on Foundational glue; T031/T032 depend on both samples.
- **US3 (T033–T036, P2)**: depends on Foundational (T011, T005). Non-blocking for the P1 MVP gate — may be deferred without affecting US1/US2/US4.
- **Polish (T037–T041)**: T037→T038 fuzz gate is the FR-013 entry gate (run before binding release); T039 depends on T013; T040 depends on T038; T041 depends on the C header (T019), WASM package (T025), and quickstart (T031).

**Parallelizable batches** (no `[P]` task shares a batch with its `after:`/`←` dependency):
- Setup: T002, T003, T004 in parallel after T001.
- Foundational unit tests: T014, T015, T016 in parallel once their target modules (T005, T007, T010) exist.
- Cross-story: US1 (Phase 3) and US2 (Phase 4) proceed in parallel once Foundational is complete; US3 (Phase 6) may start in parallel too but is P2/non-blocking. T033 is `[P]` as it only consumes Foundational outputs.

## Requirement Coverage

| Req | Tasks | Req | Tasks |
|-----|-------|-----|-------|
| FR-001 | T017, T019 | FR-012 | T012, T030 |
| FR-002 | T023, T025 | FR-013 | T037, T038 |
| FR-003 | T033, T034, T035, T036 | FR-014 | T013, T039, T040 |
| FR-004 | T011, T017, T023, T033 (all wrap the one core) | FR-015 | T010, T016 |
| FR-005 | T007, T008, T015, T024 | FR-016 | T009, T018 |
| FR-006 | T005, T006, T014, T028 | FR-017 | T004, T041 |
| FR-007 | T011, T023 | FR-018 | T020, T026 |
| FR-008 | T009, T016, T018, T022 | FR-019 | T029 |
| FR-009 | T020, T021, T026, T027 | FR-020 | T022 |
| FR-010 | T019, T025, T034, T041 | FR-021 | T011 |
| FR-011 | T031, T032 | FR-022 | T005, T012, T030 |

| SC | Task | SC | Task |
|----|------|----|------|
| SC-001 | T021 | SC-007 | T039 |
| SC-002 | T027 | SC-008 | T029 |
| SC-003 | T028 | SC-009 | T022 |
| SC-004 | T032 | SC-010 | T041 |
| SC-005 | T015, T024 | SC-011 | T030 |
| SC-006 | T036 | SC-012 | T020, T026 |
