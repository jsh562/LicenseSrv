# Tasks: Offline Verifier Core

**Input**: Design documents from `specs/00002-offline-verifier-core/`
**Prerequisites**: `plan.md` (required), `spec.md` (required)

**Tests**: Test/quality tasks are explicitly requested by the spec's Testing & Quality Policy (fuzz, criterion, coverage, audit/clippy/Semgrep) and are included below.

**Organization**: Grouped by Technical Objective (`OBJ#`). Brownfield conformance refactor — most tasks MODIFY existing files in `src/verifier-core/`; new files are flagged inline.

## Project Mode

`Brownfield`

The `src/verifier-core/` crate already exists and works (token format `LIC1.` + CBOR + Ed25519, offline verify, keyring, monotonic anchor, K-of-N fingerprint, a closed-ish `VerifyError` enum, ~10 integration tests, a criterion bench, a fuzz scaffold; currently `std`). This epic conforms it to the clarified/hardened contract. No greenfield project-init tasks.

## Epic / Capability Map

- `[OBJ1]` → E001 Token format & offline signature verification (`LIC1.` codec, Ed25519 vs keyring, closed error model, SemVer/version policy)
- `[OBJ2]` → E001 Temporal & machine-binding constraint evaluation (expiry/perpetual, anchor rollback, K-of-5 fingerprint, typed entitlements)
- `[OBJ3]` → E001 Keyring & signing-key rotation (multi-key by `key_id`, validity window + revoked flag)

## Brownfield Notes

- Existing flows touched: `src/verifier-core/{Cargo.toml,src/lib.rs,src/token.rs,src/keyring.rs,src/verify.rs,src/anchor.rs,src/fingerprint.rs,tests/verify.rs,benches/verify_bench.rs,fuzz/}`.
- Compatibility / migration concerns: the `LIC1.` byte layout must be FROZEN before any dependent work (HINT-001); `no_std` + `alloc` conversion is foundational (HINT-002); `VerifyError` is closed and append-only — never reorder or remove variants (HINT-003); keyring per-key validity travels with the keyring artifact, NOT the signed token (HINT-004); language bindings are OUT OF SCOPE (epic E003).
- Regression focus: the ~10 existing `tests/verify.rs` cases (valid verify, expiry, perpetual, tamper, wrong-key, unknown-key, rotation, rollback, fingerprint, malformed-no-panic) must keep passing through the refactor.

---

## Phase 1: Setup (Repository / Workspace Delta)

**Toolchain, build-target, and quality-gate config. No work-item label.**

- [ ] T001 Add `wasm32-unknown-unknown` + native x86_64/aarch64 targets via rust-toolchain and install `rustup target add wasm32-unknown-unknown` for the verifier-core build matrix
- [ ] T002 Convert `src/verifier-core/Cargo.toml` to `no_std`+`alloc`: drop `thiserror`, set `serde`/`ed25519-dalek`/`ciborium`/`base64` to default-features-off with `alloc` features, add a `std` feature gate (HINT-002) {TR-016}
- [ ] T003 [P] Install and configure coverage tooling `cargo install cargo-llvm-cov` scoped to `src/verifier-core/src/` (exclude `fuzz/` and `benches/`)
- [ ] T004 [P] Install and configure `cargo install cargo-fuzz` for the existing `src/verifier-core/fuzz/` target (nightly) (HINT-002)
- [ ] T005 [P] Add Semgrep + `cargo audit` config and clippy `-D warnings` invocation for the verifier-core crate

---

## Phase 2: OBJ1 — Token format & offline signature verification (Priority: P1) 🎯 MVP

**Layout-freeze tasks come FIRST (HINT-001) — every later phase depends on the frozen `LIC1.` byte layout and the typed entitlement value.**

- [ ] T006 [OBJ1] {TR-018} Freeze the typed, forward-compatible entitlement value in `src/verifier-core/src/token.rs`: replace untagged `EntValue` with a tagged value (Bool, Int, reserved Unknown variant) so string/enum/date are additive without an `LIC2.` break (HINT-001, AD-002) → exports: EntValue(Bool,Int,Unknown)
- [ ] T007 [OBJ1] {TR-001} Freeze and convert the `LIC1.` codec in `src/verifier-core/src/token.rs` to `no_std`+`alloc` (swap `std::collections::BTreeMap`→`alloc::collections::BTreeMap`); versioned self-describing parse rejecting malformed/truncated input without panic (HINT-001, HINT-002) ← T006:EntValue → exports: Claims, signing_input(), split_transport()
- [ ] T008 [OBJ1] {TR-016} [COMPLETES TR-016] Define the version policy in `src/verifier-core/src/{token.rs,lib.rs}`: `token_version` evolves additively within `LIC1.`, reserve the `LIC2.` envelope for breaking layout changes, document SemVer on the public surface (AD-006) after:T007
- [ ] T009 [OBJ1] {TR-015} Replace `VerifyError` in `src/verifier-core/src/verify.rs` with the closed, append-only, ordered enum (Malformed, UnsupportedVersion, UnknownKey, KeyNotValid, BadSignature, Expired, ClockRollback, FingerprintMismatch, FingerprintMissing) carrying NO secret/diagnostic payload, no leaked offsets/key material/fingerprint values (AD-004, HINT-003) → exports: VerifyError
- [ ] T010 [OBJ1] {TR-002} Define the signed range in `src/verifier-core/src/{token.rs,verify.rs}`: signature covers domain-separated format-version byte + canonical CBOR claims; envelope prefix and appended signature bytes excluded; Ed25519 verify against keyring before trusting any claim ← T007:signing_input
- [ ] T011 [OBJ1] {TR-003} Distinguish unknown-key (UnknownKey) from bad-signature (BadSignature) in `src/verifier-core/src/verify.rs` ← T009:VerifyError, T010
- [ ] T012 [OBJ1] {TR-009} Assert zero network I/O on the verify path in `src/verifier-core/src/verify.rs` (no I/O deps reachable from `verify`)
- [ ] T013 [OBJ1] {TR-012} Stabilize the embeddable verify surface in `src/verifier-core/src/lib.rs`: `#![no_std]` + `extern crate alloc`, re-export `verify(token, keyring, opts) -> Result<VerifiedLicense, VerifyError>` as the single binding-wrappable API (AD-006, HINT-002) after:T009 → exports: verify(), VerifiedLicense, VerifyOptions

---

## Phase 3: OBJ2 — Temporal & machine-binding constraint evaluation (Priority: P1) 🎯 MVP

- [ ] T014 [OBJ2] {TR-004} Implement expiry/perpetual evaluation in `src/verifier-core/src/verify.rs`: reject when `expires_at` precedes host now; accept no-expiry token at any time; perpetual exempts ONLY the expiry check (rollback still applies) after:T013 ← T009:VerifyError
- [ ] T015 [OBJ2] {TR-005} Refactor the clock anchor in `src/verifier-core/src/anchor.rs` to a pure function of (now, stored anchor, skew) returning the next anchor to persist (max of stored anchor and now; a token's issued-at MUST NOT advance the anchor past now, and issued-at > now+skew is rejected); caller-configurable skew (default 48h) tightenable (never loosenable) by a signed token claim (AD-001) → exports: Anchor::next_to_persist(), DEFAULT_SKEW_SECS
- [ ] T016 [OBJ2] {TR-005} Wire the anchor result + effective skew (caller option intersected with token-claim tightening) into `src/verifier-core/src/verify.rs` and surface the next-anchor-to-persist on `VerifiedLicense`; reject ClockRollback when now precedes anchor beyond skew after:T015 ← T015:Anchor::next_to_persist [COMPLETES TR-005]
- [ ] T017 [OBJ2] {TR-006} Define the 5 canonical salted-hash slots (machine id, CPU, disk/volume, MAC, OS-install id) and token-raisable K in `src/verifier-core/src/fingerprint.rs`: default K=3 of 5, a signed claim MAY raise K (never lower), tolerate partial drift (AD-005) → exports: fingerprint_matches(), DEFAULT_FP_THRESHOLD, FP_SLOTS
- [ ] T018 [OBJ2] {TR-013} Refuse a machine-bound token when no local fingerprint is supplied (FingerprintMissing) rather than silently passing, in `src/verifier-core/src/verify.rs` after:T017 ← T009:VerifyError
- [ ] T019 [OBJ2] {TR-006} Enforce K-of-5 (effective K = max of caller K and token-claim K) in `src/verifier-core/src/verify.rs`; below threshold → FingerprintMismatch after:T017,T018 ← T017:fingerprint_matches [COMPLETES TR-006]
- [ ] T020 [OBJ2] {TR-014} Document/assert salted-hash-only fingerprint handling in `src/verifier-core/src/fingerprint.rs`: core compares pre-salted hashes, never retains raw hardware identifiers or the salt (GDPR minimization) after:T017
- [ ] T021 [OBJ2] {TR-007,TR-018} Create the typed entitlement resolver in `src/verifier-core/src/entitlement.rs` (NEW FILE): absent boolean→false, absent integer→None (caller default), unknown value type→treated as absent/ignored forward-compatibly ← T006:EntValue → exports: resolve_bool(), resolve_int() [COMPLETES TR-018]
- [ ] T022 [OBJ2] {TR-007} Expose entitlement resolution on `VerifiedLicense` in `src/verifier-core/src/verify.rs` (`has`/`limit` delegating to the resolver) and re-export the module from `src/verifier-core/src/lib.rs` after:T021 ← T021:resolve_bool,resolve_int [COMPLETES TR-007]

---

## Phase 4: OBJ3 — Keyring & signing-key rotation (Priority: P1) 🎯 MVP

- [ ] T023 [OBJ3] {TR-008} Convert `src/verifier-core/src/keyring.rs` to `no_std`+`alloc` (swap `std::collections::BTreeMap`→`alloc::collections::BTreeMap`); preserve multi-key selection by `key_id` enabling rotation without invalidating issued tokens (HINT-002) → exports: Keyring::get(), Keyring::add()
- [ ] T024 [OBJ3] {TR-017} Add the per-key validity window (`valid_from` inclusive / `valid_until` exclusive) + revoked flag to the keyring entry in `src/verifier-core/src/keyring.rs`; enforced offline; travels with the keyring artifact, not the signed token (AD-003, HINT-004) after:T023 → exports: KeyEntry(valid_from,valid_until,revoked)
- [ ] T025 [OBJ3] {TR-017,TR-015} Enforce the validity window + revoked flag in `src/verifier-core/src/verify.rs`, evaluated against host-supplied now: a key outside its window or revoked → the new `KeyNotValid` reason (distinct from UnknownKey/BadSignature) after:T024 ← T024:KeyEntry, T009:VerifyError [COMPLETES TR-017]

---

## Phase 5: Hardening & Non-Functional

**Size bounds, fail-fast, fuzzing, benchmark + regression gate, wasm32 bench, coverage, and security scans. No work-item label.**

- [ ] T026 {TR-020} Define and enforce max token size, max keyring size, and max entitlement count in `src/verifier-core/src/{token.rs,verify.rs}`: reject oversized input as Malformed BEFORE full parsing, bounding verify cost and hot-path allocation (fail-fast within bounded cost) after:T007,T009 [COMPLETES TR-020]
- [ ] T027 {TR-010} Harden the parser for bounded work in `src/verifier-core/src/token.rs`: no unbounded recursion/nesting, no quadratic blow-up, no allocation amplification from attacker-controlled length fields (keeps TR-010/TR-011/TR-020 mutually consistent) after:T026
- [ ] T028 {TR-010} Update the `cargo-fuzz` target `src/verifier-core/fuzz/fuzz_targets/parse_token.rs` to drive the hardened parser/verify and run it panic-free (no unwrap/expect/overflow/OOB) on arbitrary bytes (HINT-002) after:T027 [COMPLETES TR-010]
- [ ] T029 {TR-001,TR-002,TR-003,TR-004,TR-005,TR-006,TR-007,TR-008,TR-013,TR-017} Extend `src/verifier-core/tests/verify.rs` for the new contract: typed entitlements (absent/unknown), keyring validity window + revoked (KeyNotValid), configurable/token-raised K, anchor next-to-persist return, fingerprint-missing, unknown-key vs bad-sig, and the unsupported-version (`LIC2.`/`token_version` over range) edge after:T013,T016,T019,T022,T025
- [ ] T030 {TR-020} Add a size-bound rejection test (oversized token / keyring / entitlement count → Malformed fail-fast) to `src/verifier-core/tests/verify.rs` after:T026
- [ ] T031 {TR-011} Update `src/verifier-core/benches/verify_bench.rs` to benchmark a representative valid machine-bound token (all 5 fp slots, single matching key in a stated keyring size) and confirm < 5 ms p99 on the named x86_64 reference baseline after the `no_std` conversion (HINT-005) after:T013,T019
- [ ] T032 {TR-019} Add the performance-regression gate to `src/verifier-core/benches/verify_bench.rs` that FAILS when measured p99 exceeds the budget on the stated baseline (AD-006) after:T031 [COMPLETES TR-019]
- [ ] T033 {TR-011} Add a `wasm32-unknown-unknown` benchmark path for verify in `src/verifier-core/benches/verify_bench.rs` reporting its p99 against its 25 ms p99 budget after:T031 [COMPLETES TR-011]
- [ ] T034 Run `cargo-llvm-cov` and confirm ≥80% line coverage over `src/verifier-core/src/` (excluding `fuzz/` and `benches/`) after:T029,T030
- [ ] T035 Run `cargo audit` + clippy `-D warnings` + Semgrep over `src/verifier-core/` and resolve all findings after:T029

---

## Dependencies

**Phase order**: Phase 1 (Setup) → Phase 2 (OBJ1) → Phase 3 (OBJ2) → Phase 4 (OBJ3) → Phase 5 (Hardening). All three objectives are P1; the layout-freeze rule below overrides naive parallelism.

- **Setup first**: T001–T005 precede all code work. The `no_std`+`alloc` Cargo conversion (T002) is foundational (HINT-002) and blocks the module `no_std` conversions (T007, T013, T023).
- **Layout freeze FIRST (HINT-001)**: T006 (typed entitlement value) → T007 (frozen `LIC1.` byte layout) → T008 (version policy) MUST precede everything that depends on the byte layout — codec consumers, entitlement resolver (T021), bench (T031), and all downstream epics (E003/E004/E008). Do not change the layout after T007/T008 complete.
- **Error model before reason-emitting checks**: T009 (closed `VerifyError`) precedes T011, T014, T016, T018, T019, T025, T026 which all emit reasons.
- **OBJ1 → OBJ2/OBJ3**: The stable verify surface (T013) blocks the temporal/binding wiring (T014, T016, T022) and is referenced by OBJ3 enforcement.
- **OBJ2 internal**: T015 (anchor pure fn) → T016 (wire + return next-anchor); T017 (slots+K) → T018/T019 (fingerprint enforcement); T006 (EntValue) → T021 (resolver) → T022 (expose).
- **OBJ3 internal**: T023 (keyring no_std) → T024 (validity fields) → T025 (enforce + `KeyNotValid`).
- **Hardening depends on delivery**: size bounds (T026) before parser hardening (T027) before fuzz (T028); contract tests (T029/T030) after the features they cover; bench (T031) before regression gate (T032) and wasm32 bench (T033); coverage (T034) and scans (T035) last.
- **Parallel safety**: `[P]` tasks (T003, T004, T005) touch disjoint config and share no `after:`/`←` edges with each other. No `[P]` task is batched with a task it depends on.
