---
feature_branch: "00004-embeddable-verifier-bindings"
created: "2026-06-27"
input: "Epic E003 — Embeddable verifier bindings: ready-made, distributable bindings (C ABI for native, WASM for web/Node, generated bindings for other languages) that wrap the single Rust verifier core so any stack can verify a license offline in minutes without reimplementing cryptography."
spec_type: "product"
spec_maturity: "draft"
epic_id: "E003"
epic_sources: "{PRD:CAP-004}{SAD:ADR-0002}"
---

# Feature Specification: Embeddable Verifier Bindings

**Feature Branch**: `00004-embeddable-verifier-bindings`  
**Created**: 2026-06-27  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft  
**Epic ID**: E003  
**Epic Sources**: {PRD:CAP-004}{SAD:ADR-0002}

## Problem Statement *(mandatory)*

Vendors integrate license verification into applications written in many languages, but the verifier core is Rust. Without ready-made bindings, every team must hand-roll FFI to call Rust — or, worse, reimplement the cryptography in their own language, which is slow, inconsistent, and a frequent source of licensing CVEs. This feature delivers ready-made, distributable bindings — a C ABI for native and .NET, a WASM package for web/Node/Electron, and generated bindings for other languages — that all wrap the *one* Rust verifier core, so any stack can verify a license offline in minutes with no crypto to reimplement.

## Scope *(mandatory)*

### Included

- A C ABI library and header exposing offline verification for native, C/C++, and .NET (P/Invoke) hosts.
- A WASM package consumable from browsers, Node, and Electron.
- Generated bindings for additional languages (e.g. Python, Kotlin, Swift) from the same core.
- A stable, cross-binding verification API with identical failure reason codes everywhere.
- A reference integration (sample app) per primary target and a quickstart.
- Packaging/distribution of each binding.

### Excluded

- The verifier core itself — owned by epic E001; this feature only wraps it.
- The license server, REST API, issuance, and signing — owned by other epics (verification here is offline only).
- Language-specific business SDKs beyond verification (activation/admin clients) — later/other scope.

### Edge Cases & Boundaries

- A panic or fault inside the core MUST NOT cross the FFI boundary; it MUST surface as a defined error return.
- Memory ownership for any data returned across the boundary MUST be explicit (who allocates, who frees) and leak-free.
- A malformed, truncated, or arbitrary input MUST yield a defined error, never a crash.
- A binding built against a different core/token-format version MUST be detectable (no silent mismatch).
- An unsupported platform/architecture MUST fail clearly at build/load time, not at verify time.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Embed in a native app via the C ABI (Priority: P1)

As a C/C++/.NET/desktop developer, I link the C-ABI library and its header and call a verify function to validate a license offline and read its entitlements — without a Rust toolchain or any cryptography knowledge.

**Why this priority**: Native and .NET (via P/Invoke) are a primary target, and the C ABI is the lingua franca many other languages bind to.

**Independent Test**: A small C (or .NET P/Invoke) program links the library, verifies a valid token offline (no network) and reads an entitlement, and confirms a tampered token is rejected.

**Acceptance Scenarios**:

1. **Given** the C-ABI library + header and a valid token + keyring, **When** the host calls verify offline, **Then** it succeeds and exposes the entitlements.
2. **Given** a tampered or expired token, **When** the host calls verify, **Then** it returns a defined failure code and unlocks nothing.

### User Story 2 - Embed in web/Node via WASM (Priority: P1)

As a JS/TS developer, I import the WASM package and verify a license in the browser, Node, or Electron — offline, with no server call.

**Why this priority**: Web, Electron, and Node are the other primary target, and one WASM build serves all three.

**Independent Test**: A Node (and browser) sample imports the WASM package, verifies a valid token offline, gates a feature on an entitlement, and rejects a tampered/expired token.

**Acceptance Scenarios**:

1. **Given** the WASM package and a valid token + keyring, **When** verified in Node or the browser, **Then** verification succeeds offline and entitlements are readable.
2. **Given** a tampered or expired token, **When** verified, **Then** it fails with a defined reason and the feature stays locked.

### User Story 3 - Embed in other languages via generated bindings (Priority: P2)

As a developer in another language (e.g. Python, Kotlin, Swift), I install a generated binding and verify a license offline, without reimplementing crypto.

**Why this priority**: Covers the long tail of stacks on demand; the two primary targets (US1/US2) already deliver the MVP.

**Independent Test**: A Python sample (via the generated binding) verifies a valid token offline and reads its entitlements.

**Acceptance Scenarios**:

1. **Given** a generated binding for the language, **When** the host verifies a valid token offline, **Then** it succeeds and exposes entitlements identical to the other bindings.

### User Story 4 - Integrate in minutes with identical results everywhere (Priority: P1)

As an integrating developer, I follow a quickstart and reach a first successful offline verify quickly, and I can trust that the same token yields the same verdict and the same failure reason code across every binding.

**Why this priority**: "Integrate into any stack easily" plus cross-binding consistency is the core value of this feature; without it the bindings fragment and trust erodes.

**Independent Test**: The same valid token verifies, and the same tampered token yields the same reason code, in both the C-ABI and WASM bindings; a new integrator following the quickstart reaches first-verify quickly.

**Acceptance Scenarios**:

1. **Given** the same token and keyring, **When** verified via the C-ABI and the WASM binding, **Then** both produce the same outcome and the same failure reason code.
2. **Given** the quickstart, **When** a new integrator follows it, **Then** they reach a first successful offline verify quickly.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST provide a C ABI exposing offline verification (parse + verify a `LIC1` token against a trusted keyring) and a C header generated from the core.
- **FR-002**: System MUST provide a WASM build/package consumable from browsers, Node, and Electron.
- **FR-003**: System SHOULD provide generated bindings for additional languages (e.g. Python, Kotlin, Swift) from the same core via a single binding generator. *(P2)*
- **FR-004**: Every binding MUST wrap the single Rust verifier core; cryptography MUST NOT be reimplemented per language.
- **FR-005**: No panic or undefined behavior may cross the FFI boundary; every verification outcome MUST be returned as a defined result or error code. This applies identically to every binding surface (C-ABI, WASM, and UniFFI-generated bindings) — not the C-ABI alone. The requirement covers not only unwinding panics (caught at the boundary) but also non-unwinding faults that are observable to the binding (e.g. a recoverable allocation failure), which MUST also surface as a defined error code rather than propagating as undefined behavior; a host-level abort/trap (e.g. a `wasm32` trap or an unrecoverable OOM abort) is the platform's terminal fault and is out of scope for a defined return.
- **FR-006**: The verifier's closed reason codes MUST map to stable, identical codes across all bindings — the same failure yields the same reason everywhere. The returned outcome (the reason code and any accompanying value the host reads) MUST carry no sensitive detail: no key bytes, no raw token bytes, no buffer offsets, and no fingerprint data may be embedded in the returned result. Reason codes MUST distinguish failure categories enough to be actionable (e.g. tampered/invalid-signature vs. expired vs. malformed) without revealing crypto internals that would aid an attacker.
- **FR-007**: Bindings MUST expose the full offline-verify surface: supply the token, the trusted keyring, current time, monotonic anchor, and machine fingerprint, and read the resulting entitlements.
- **FR-008**: Memory ownership for data returned across the boundary MUST be explicit (clear allocate/free contract) and leak-free.
- **FR-009**: Each primary binding (C-ABI, WASM) MUST ship a reference integration demonstrating offline verification with no network call.
- **FR-010**: Bindings MUST be packaged for distribution (a native shared library + header; a WASM/package-manager-installable package).
- **FR-011**: A quickstart MUST enable a new integrator to reach a first successful offline verify quickly (target: under 30 minutes).
- **FR-012**: Binding versions MUST track the core's semantic version and token format version so a binding/core mismatch is detectable, not silent.
- **FR-013**: Before any binding exposes the verifier over the FFI/WASM boundary, the token parser/verify path MUST be fuzzed and panic-free on arbitrary input (entry gate; reuses the core's fuzzed parser). Measurable gate: a seed corpus covering at least valid, tampered-signature, truncated, oversized (> `MAX_TOKEN_BYTES`), empty, and non-base64 tokens MUST be committed, and per-PR CI MUST run the core's `cargo-fuzz` target for at least 300 seconds (5 minutes) against that corpus with zero crashes, panics, OOMs, or timeouts; any finding MUST be minimized, committed as a regression seed, and fixed before the binding may ship. (No separate nightly soak job is required.)
- **FR-014**: Binding artifacts MUST meet the project quality gates — dependency security scanning (gate: no CRITICAL-severity vulnerabilities; the scan failing this threshold blocks binding release) and ≥ 80% coverage of the binding glue — and MUST NOT log or return key or secret material across the boundary, including on error paths. For this requirement, "key or secret material" means private/signing keys, the raw bytes of the trusted public keyring, the raw token bytes, and any intermediate cryptographic state (e.g. hashes, signature-verification working values); it is not limited to the keyring object.

- **FR-015**: Memory-safety behavior at the boundary MUST be defined and safe against misuse: calling `ls_*_free` (or the equivalent dispose on a handle) more than once, or using a handle after it has been freed, MUST NOT cause a double-free or use-after-free; the contract MUST specify the host's obligation (free each handle exactly once, never use after free) and the binding MUST be implemented so that misuse yields a defined `BadArgument`/no-op result rather than undefined behavior where detectable.

- **FR-016**: Passing a null or otherwise invalid handle to any boundary function MUST return a defined `BadArgument` reason code and MUST NOT dereference null or trigger undefined behavior; this null/invalid-handle contract applies to every entry point that accepts a handle, not the verify call alone.

- **FR-017**: An unsupported platform or architecture MUST fail clearly at build time or library-load time (e.g. a missing target artifact or a load error), never at verify time; the supported target matrix MUST be published so an unsupported target is rejected before any verification is attempted.

- **FR-018**: Verification and every binding error or fallback path MUST be strictly offline: no boundary function may initiate a network call under any outcome (success, failure, or internal error), so that no token, key, or fingerprint data can be exfiltrated via the bindings.

- **FR-019**: Verification MUST be deterministic: for a fixed set of the FR-007 inputs (token, keyring, current time, monotonic anchor, machine fingerprint), every binding MUST always return the same verdict and the same reason code, with no dependence on wall-clock time or other implicit state — current time is always the supplied input, never read internally. This makes verification (including the expired-token outcome) reproducible so tests can hold those inputs fixed and assert a stable verdict/reason-code oracle (SC-008).

- **FR-020**: Leak-freedom of the explicit memory-ownership contract (FR-008) MUST be verifiable, not merely asserted: the C-ABI integration test MUST exercise the allocate/verify/free lifecycle and confirm leak-freedom by a measurable means (balanced allocate/free accounting or running under a leak sanitizer such as ASan/LeakSanitizer or valgrind), so a leak or imbalance fails the test.

- **FR-021**: Each verify-surface input (FR-007) MUST have a defined type/encoding expectation in the binding contract so every binding author interprets it identically — the token as a UTF-8/byte string, each keyring public key as raw key bytes, the machine fingerprint as bytes, and current time and monotonic anchor as the core's defined integer time/counter values.

- **FR-022**: The reason-code integers and the exported ABI symbol set MUST be frozen as an external contract before any binding ships; the binding/core and token-format version MUST be exposed as a host-queryable value (e.g. `ls_abi_version()`) so a mismatch surfaces at library load/initialization, before any verify is attempted (no silent mismatch). Thereafter any change to a frozen reason-code integer or exported ABI symbol is a breaking ABI change requiring a binding major-version bump, while backward-compatible additions follow the binding's SemVer tracking of the core/token-format version (FR-012).

### Key Entities *(include for product or technical specs if feature involves data)*

- **License token**: The signed `LIC1` artifact the host passes to a binding to verify.
- **Keyring**: The set of trusted public keys the host supplies to the binding.
- **Entitlement**: A capability (boolean or limit) read from a verified token.
- **Reason code**: The stable, cross-binding identifier for a verification outcome/failure.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Integrators can link a native shared library, load a WASM module, or install a package for their stack.
- The verifier core (epic E001) exposes a stable embeddable API and a frozen token format the bindings wrap.
- Public verification keys are distributed to client applications out of band.

### Risks

- **Memory-safety / panic across the FFI boundary** *(likelihood: medium, impact: high)*: a fault crossing the C ABI is undefined behavior — mitigate by catching unwinds at the boundary and returning defined error codes, and by fuzzing the parser before exposing bindings.
- **Per-binding maintenance burden** *(likelihood: medium, impact: medium)*: many targets are costly to maintain — mitigate with one core plus generated bindings rather than hand-written ones.
- **Platform/architecture coverage gaps** *(likelihood: medium, impact: medium)*: a missing target blocks an integrator — mitigate by defining and publishing the supported target matrix.

## Implementation Signals *(mandatory)*

- `NEW-CONFIG` — The binding API surface and packaging: C header + WASM package + generated bindings.
- `EXTERNAL-SERVICE` — Depends on the verifier core (epic E001): its embeddable verify API and frozen `LIC1` token format.
- `NEW-UI` — Reference integration sample apps (native + web) demonstrating offline verification.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A non-Rust native program (C or .NET P/Invoke) verifies a valid token offline and reads an entitlement, and rejects a tampered token — with no cryptography implemented in the host language.
- **SC-002** [US2]: A JS/TS program (browser and Node) verifies a valid token offline and rejects a tampered or expired token. The tampered case and the expired case are each rejected with their own distinct defined reason code (from the closed set, FR-006) and are asserted separately, not conflated into a single rejection.
- **SC-003** [US4]: The same valid token verifies, and the same tampered token yields the same failure reason code, in both the C-ABI and the WASM binding (identical cross-binding behavior). The cross-binding parity assertion is scoped to the P1 bindings (C-ABI and WASM); the P2 generated/UniFFI binding is out of scope for this parity test and is instead covered by SC-006.
- **SC-004** [US4]: A new integrator following the quickstart reaches a first successful offline verify in under 30 minutes. Start = the integrator opens the quickstart with only the baseline prerequisites stated in Assumptions (able to link a native shared library or install/load the WASM package; no Rust toolchain or crypto knowledge assumed); end = the documented sample returns a success verdict for the supplied valid token. The 30-minute bound is measured between these two points.
- **SC-005** [US1]: No panic or crash crosses the FFI boundary on any input (including malformed tokens); every outcome is a defined return/error code.
- **SC-006** [US3]: A program in a generated-binding language (e.g. Python) verifies a valid token offline and reads entitlements identical to the other bindings.
- **SC-007** [US1]: No key or secret material is logged or returned across the FFI boundary, including on error paths (FR-014), and the parser is fuzzed before any binding ships (FR-013).
- **SC-008** [US4]: Verification is deterministic — for a fixed set of the FR-007 inputs (token, keyring, current time, monotonic anchor, machine fingerprint), every binding always yields the same verdict and the same reason code; repeating the call with the same fixed inputs never changes the outcome, so tests can hold those inputs constant and rely on a stable oracle.
- **SC-009** [US1]: The C-ABI memory-ownership contract is leak-free and misuse-safe — the allocate/verify/free lifecycle reports zero leaks under the measurable check (FR-020), and a double-free, use-after-free, or null/invalid handle yields a defined `BadArgument`/no-op rather than a crash (FR-008, FR-015, FR-016).
- **SC-010** [US1]: Each primary target ships its distribution artifact (native shared library + header; package-manager-installable WASM package), and an unsupported platform/architecture fails at build or library-load time, never at verify time (FR-010, FR-017).
- **SC-011** [US4]: A binding built against a mismatched core/token-format version is detected via the host-queryable version value at load/initialization, before any verify is attempted, with no silent mismatch (FR-012, FR-022).
- **SC-012** [US1]: No boundary function initiates a network call on any path — success, failure, or internal error — confirmed offline for every primary binding's reference integration (FR-018, FR-009).

## Compliance Check

**Overall**: PASS (no violations) vs project-instructions v1.1.0; the non-blocking gaps raised in audit are closed below.

- Principle III (single security core, no per-language crypto): PASS — FR-004, FR-001, FR-006.
- Principle I (offline-first, no network): PASS — FR-001/002/007/009, SC-001/002/006.
- Security (no panic/UB across FFI; explicit leak-free, double-free/use-after-free-safe memory; no secret leakage; no-network error paths): PASS — FR-005, FR-008, FR-014, FR-015, FR-016, FR-018, SC-005, SC-007.
- Testing & Quality (parser fuzzed before FFI; ≥80% coverage + security scanning of binding artifacts with a no-CRITICAL gate): PASS — FR-013, FR-014.
- Platform coverage (unsupported target fails at build/load, not verify): PASS — FR-017, Edge Cases & Boundaries.
- ADR-0002 (C-ABI/WASM/UniFFI over one Rust core) + frozen `LIC1` + closed reason codes: PASS — FR-001/002/003/006/012.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| C ABI | The C application binary interface — a language-neutral calling/linking convention that native and .NET hosts bind to. |
| WASM | WebAssembly — a portable binary the verifier compiles to, runnable in browsers, Node, and Electron. |
| FFI | Foreign Function Interface — the boundary across which a non-Rust host calls the Rust core. |
| Binding | A language/runtime-specific wrapper that exposes the verifier core to a host stack. |
| Reason code | The stable identifier for a verification outcome, kept identical across all bindings. |
