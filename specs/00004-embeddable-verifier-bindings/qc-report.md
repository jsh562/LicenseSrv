# QC Report — Embeddable Verifier Bindings (E003)

> Date: 2026-07-02 | Feature: `specs/00004-embeddable-verifier-bindings/` | Verdict: **PASS** (semgrep SAST deferred to CI; coverage measured under the msvc toolchain because windows-gnu lacks `profiler_builtins`)

## Test Results

- **Rust (`ls-ffi`)** — `cargo test -p ls-ffi`: **22 passed / 0 failed** across 8 test binaries: `reason` (3), `guard` (3), `handles` (6), `c_integration` (2 — compiles+links+runs the C sample via gcc: valid verifies offline + reads entitlement, tampered→5, expired→6, plus 2000-cycle leak-accounting balance), `parity` (1 — C-ABI vs WASM-in-Node identical codes), `determinism` (2), `version` (3), `secret_leakage` (2).
- **Verifier-core** — `cargo test -p verifier-core`: **18 passed / 0 failed** (unchanged core; regression check).
- **WASM (Node)** — `node --test src/bindings/wasm/tests/verify.test.mjs`: **5 passed / 0 failed** (valid offline + entitlements; tampered→5 and expired→6 as two distinct-code cases).
- **Python (UniFFI, P2)** — `python src/bindings/uniffi/tests/test_verify.py`: **4 passed / 0 failed** (valid offline, seats=5, tampered→5, expired→6 — identical to the other bindings).
- **Total: 49 passed / 0 failed.** No failures.

## Static Analysis

- **Clippy** (`cargo clippy -p ls-ffi --all-targets -- -D warnings`): **PASS** — 0 warnings (deny-warnings).
- No JS/TS lint config applies to the minimal binding samples; the server-side ESLint boundary rule is E002's scope.

## Security Audit

- **`cargo audit`**: **PASS** — **0 vulnerabilities** over 166 crate deps. Two informational *unmaintained* advisories on transitive build-tooling crates (`bincode` RUSTSEC-2025-0141, `paste` RUSTSEC-2024-0436, pulled by cbindgen/uniffi build deps) — warnings, not vulnerabilities, not CRITICAL. Gate (no CRITICAL vulns) met.
- **SAST (Semgrep)**: **SKIPPED locally — CI-only.** semgrep is not installed on this machine; the equivalent SAST gate runs in CI. Consistent with the E002 precedent. Not fabricated.
- **No secret leakage** (FR-014): `tests/secret_leakage.rs` (2/2) asserts no key/token/keyring/fingerprint bytes appear in any returned value, `VerifyError` rendering, or observable output on any path including errors.

## PI Compliance

- **Principle I (Offline-First Crypto Verification)**: **PASS** — no network code anywhere in `src/bindings/` (verified by the Story Verifier); every binding calls the core's in-process, no-I/O `verify`; reference samples verify with no network (FR-018/SC-012).
- **Principle III (Single Security Core + Audited)**: **PASS** — every binding (C-ABI, WASM, UniFFI) wraps the one `verifier-core` via the single `ls_ffi_verify`; no per-language cryptography (FR-004). One shared frozen reason-code map (`reason.rs`) proven identical across bindings by the parity test.
- No CRITICAL `project-instructions.md` violations.

## Requirements Traceability

Story Verifier verdict: **PASS**. Every work item and success criterion traces to real source + a verifying test.

| Work Item | Priority | Status |
|---|---|---|
| US1 — C-ABI native/.NET | P1 | PASS (`capi` in lib.rs, header, C sample; c_integration + in-process tests) |
| US2 — WASM web/Node | P1 | PASS (`wasm.rs`, wasm-pack pkg; Node 5/5) |
| US4 — Cross-binding consistency + quickstart | P1 | PASS (`parity.rs`; README quickstart + measured timing) |
| US3 — UniFFI generated (Python) | P2 | PASS (`uniffi.rs`, generated `licensesrv.py`; Python 4/4) |

| Success Criteria | Status |
|---|---|
| SC-001 (native offline verify + reject tampered) | PASS — c_integration (gcc compile+link+run) + in-process C-ABI tests |
| SC-002 (JS offline; tampered+expired distinct codes) | PASS — WASM Node test |
| SC-003 (C-ABI ↔ WASM identical codes) | PASS — parity.rs |
| SC-004 (quickstart first-verify < 30 min) | PASS — README timing (WASM ~0.5s, C ~0.3s) |
| SC-005 (no panic/UB across FFI) | PASS — guard.rs + tests/guard.rs; catch_unwind in ls_verify |
| SC-006 (generated-binding reads identical entitlements) | PASS — Python UniFFI smoke |
| SC-007 (no secret leakage + fuzz-before-ship) | PASS — secret_leakage.rs + committed fuzz corpus + CI fuzz gate |
| SC-008 (deterministic verify) | PASS — determinism.rs (1000× stable, incl. expired) |
| SC-009 (C-ABI leak-free + misuse-safe) | PASS — leak accounting (2000 cycles) + handles.rs |
| SC-010 (per-target artifacts; unsupported fails at build/load) | PASS — CI matrix + artifact upload; README matrix (FR-017) |
| SC-011 (version-mismatch detectable) | PASS — version.rs |
| SC-012 (no network on any path) | PASS — static absence of network APIs + offline samples |

FR-001…FR-022: all 22 mapped to implementation + a verifying test/artifact (no gaps).

## Traceability Gaps

None. All 41 tasks `[X]`; every US/SC/FR traces to source + a test.

## Code Coverage

- **Lines 81.39% (231 lines, 43 missed), Functions 91.89% (37, 3 missed), Regions 79.73%** — threshold **≥ 80% lines met**.
- **Measurement note**: the active toolchain is `stable-x86_64-pc-windows-gnu`, which does **not** ship the `profiler_builtins` runtime, so `-C instrument-coverage` cannot run under it (`error[E0463]: can't find crate for profiler_builtins`). Coverage was therefore measured under the `stable-x86_64-pc-windows-msvc` toolchain over the in-process test subset (reason/guard/handles/determinism/version/secret_leakage). This figure is **conservative** — the excluded `c_integration` (gcc compile-run) and `parity` (node) tests exercise additional `capi` paths that would only raise it. The authoritative full-suite coverage gate runs in CI on Linux (`cargo llvm-cov -p ls-ffi --fail-under-lines 80`, `.github/workflows/bindings.yml`).

## Checklist Fulfillment (spot-check)

- **Security** intent (panic-safety, explicit leak-free/double-free/UAF-safe memory, null-handle→BadArgument, no secret leakage, fuzz-before-FFI): satisfied by guard.rs, handles.rs, secret_leakage.rs, the fuzz corpus + CI gate.
- **Testing** intent (cross-binding parity, C compile-link-run, WASM Node, leak check, determinism, version-mismatch, ≥80% coverage): all present and passing.

## Performance

- No binding-specific latency/throughput NFR (verify performance is the E001 core's, already benchmarked). The DX performance criterion **SC-004** (first offline verify < 30 min) is measured in the quickstart timing table (seconds of command time).

## Accessibility

N/A — no rendered UI (the WASM binding is a JS/Node API surface, not a web page/DOM).

## Browser Runtime Validation

N/A — the WASM binding is validated via Node (`node --test`); there is no browser DOM/navigation surface in this feature.

## Manual Testing

None required.

## Tool Recommendations

- Install `semgrep` locally (`pip install semgrep`) to run the SAST gate outside CI; currently CI-only.
- Local line-coverage requires a toolchain with `profiler_builtins` (windows-msvc or Linux); the windows-gnu default cannot instrument. CI (Linux) enforces the ≥80% gate on the full suite.
- Fuzz entry gate (`cargo-fuzz` ≥ 300s) runs per-PR in CI (nightly); a stable panic-free smoke lives in `verifier-core/tests`.

## Bug Tasks Generated

None.

## Overall Verdict

**PASS** — build, lint (deny-warnings), 49/49 tests across all four bindings, dependency security (0 vulns), requirements traceability (all US/SC/FR), and PI compliance (Principles I + III) all pass; line coverage 81.39% ≥ 80%. Standing conditions, both CI-enforced and both matching prior precedent: **Semgrep SAST runs in CI only** (tool unavailable locally) and **full-suite coverage runs in CI** (the windows-gnu local toolchain lacks `profiler_builtins`; the msvc-measured subset already meets ≥80%).
