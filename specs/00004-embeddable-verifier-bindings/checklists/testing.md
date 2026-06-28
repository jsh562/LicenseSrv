# Testing Requirements Quality Checklist: Embeddable Verifier Bindings

> Purpose: A unit test for the spec — verifies the requirements specify adequate, verifiable testability for the binding layer, not that any code passes.

**Created**: 2026-06-27 | **Feature**: [spec.md](../spec.md)

## Cross-Binding Parity

- [X] CHK201 Is the cross-binding parity guarantee tied to a verifiable test that the same token yields the same outcome AND the same reason code in both the C-ABI and WASM bindings? [Coverage, Spec FR-006/SC-003] — Spec SC-003 / US4 Independent Test + Plan Testing Strategy "Cross-binding parity" tier and HINT-005 assert same token → same outcome + same reason code in C-ABI and WASM.
- [X] CHK202 Does the spec define which inputs the parity test must cover (at minimum one valid token plus one tampered token), rather than leaving the parity corpus unspecified? [Completeness, Spec SC-003] — Spec SC-003 / US4 Acceptance 1 fix the corpus: the same valid token verifies and the same tampered token yields the same reason code.
- [X] CHK203 Is "identical reason code" expressed against a single closed/stable code set so a parity test has an unambiguous oracle, rather than a per-binding mapping that cannot be compared? [Measurability, Spec FR-006] — Spec FR-006 ("closed reason codes... stable, identical codes") + Plan AD-003 and Error Handling ("closed VerifyError set in fixed order") give one shared code set.
- [X] CHK204 Does the spec state whether the P2 UniFFI/generated binding is in or out of scope for the cross-binding parity assertion, so the parity test boundary is unambiguous? [Ambiguity, Spec FR-003/SC-006] — RESOLVED: added to Spec SC-003 that the parity assertion is scoped to P1 (C-ABI + WASM) and the P2 UniFFI binding is out of scope for parity (covered instead by SC-006).

## C-ABI Integration Test

- [X] CHK205 Is the C-ABI acceptance criterion stated as a real compile + link + run integration (a non-Rust program links the library and header), not merely a unit assertion in Rust? [Coverage, Spec US1/SC-001] — Plan Testing Strategy "Integration (C)" tier: "compile+link+run a C program against the cdylib/header"; Spec US1 Independent Test links the library/header from C/.NET.
- [X] CHK206 Does the spec require the C integration test to cover BOTH a valid-token success path (reads an entitlement) and a tampered/expired-token rejection path? [Completeness, Spec US1 Acceptance/SC-001] — Spec SC-001 + US1 Acceptance 1&2 (valid reads entitlement; tampered/expired rejected); Plan Integration (C) tier now states "verify valid (reads entitlement) + tampered/expired (rejected)".
- [X] CHK207 Is the offline constraint (no network call) stated as a checkable condition for the C integration scenario rather than an implicit assumption? [Measurability, Spec FR-009/SC-001] — Spec US1 Independent Test ("offline (no network)"), SC-001 ("offline"), FR-009 ("no network call"), reinforced by FR-018 (no boundary function may initiate a network call).

## WASM Node/Browser Test

- [X] CHK208 Is the WASM acceptance criterion verifiable across the stated runtimes (browser and Node), with the spec making clear which runtimes are mandatory for the test? [Coverage, Spec US2/SC-002] — Spec SC-002 mandates "(browser and Node)" and US2 Independent Test names "Node (and browser)" as the required runtimes; Plan Integration (WASM) tier runs the WASM package under Node/Vitest.
- [X] CHK209 Does the spec require the WASM test to verify a valid token offline AND reject a tampered or expired token with a defined reason? [Completeness, Spec US2 Acceptance/SC-002] — Spec SC-002 + US2 Acceptance 1&2 (valid offline; tampered/expired rejected "with a defined reason"); Plan Integration (WASM) tier mirrors this.
- [X] CHK210 Is the "expired" token case distinguished from the "tampered" case as a separately testable failure outcome rather than conflated into one rejection? [Edge-Case, Spec SC-002] — RESOLVED: amended Spec SC-002 so the tampered and expired cases are each rejected with their own distinct defined reason code (closed set, FR-006) and asserted separately; Plan Integration (WASM) tier now tests them as two separate cases each asserting its own reason code.

## Fuzz-Before-FFI Entry Gate

- [X] CHK211 Is the fuzz-before-FFI requirement stated as a blocking entry gate (parser must be fuzzed and panic-free before any binding ships) with a verifiable gate condition, not an aspiration? [Measurability, Spec FR-013/SC-007] — Spec FR-013 ("Before any binding exposes the verifier... MUST be fuzzed and panic-free... (entry gate)") + SC-007 ("the parser is fuzzed before any binding ships"); Plan Security tier + HINT-001 sequence the gate before FFI exposure.
- [X] CHK212 Does the spec make clear that the fuzz coverage reuses the core's fuzzed parser, so the gate's source of evidence is traceable rather than ambiguous? [Traceability, Spec FR-013] — Spec FR-013 ("reuses the core's fuzzed parser"); Plan Security tier ("reuse the core's fuzzed parser") and Requirement Coverage Map FR-013 → src/verifier-core/fuzz/ (reused).

## No-Panic on Arbitrary Input

- [X] CHK213 Is the no-panic/no-UB guarantee tied to a verifiable outcome (every input, including malformed/truncated/arbitrary, yields a defined return or error code) rather than stated only as a design intent? [Coverage, Spec FR-005/SC-005] — Spec SC-005 ("No panic or crash crosses the FFI boundary on any input (including malformed tokens); every outcome is a defined return/error code") + FR-005; Plan Unit tier (panic guard) and AD-002 catch_unwind.
- [X] CHK214 Does the spec enumerate the abnormal-input classes (malformed, truncated, arbitrary bytes, null/invalid handle) so test coverage of the no-panic contract is verifiable, not open-ended? [Edge-Case, Spec §Edge Cases/FR-005] — Spec Edge Cases lists "malformed, truncated, or arbitrary input"; FR-016 covers null/invalid handle (→ defined BadArgument); Plan Error Handling table lists "Null / invalid handle".

## Memory Ownership and Leak Safety

- [X] CHK215 Is the memory-ownership contract (who allocates, who frees) specified precisely enough to be asserted by a leak/ownership test rather than described only narratively? [Clarity, Spec FR-008/§Edge Cases] — Spec FR-008 ("explicit... clear allocate/free contract") + FR-015 (double-free/use-after-free safety); Plan AD-004 ("Callee allocates opaque handles freed via explicit ls_*_free; inputs borrowed") and HINT-003.
- [X] CHK216 Does the spec require leak-freedom to be verified (e.g., allocation accounting, ASan/valgrind, or balanced alloc/free counts) rather than merely asserting "leak-free"? [Measurability, Spec FR-008] — RESOLVED: added Spec FR-020 requiring leak-freedom to be verified by a measurable means (balanced alloc/free accounting or a leak sanitizer such as ASan/LeakSanitizer/valgrind) and updated the Plan Integration (C) tier to exercise allocate/verify/free and fail on any leak.
- [X] CHK217 Is the requirement that no key or secret material is returned or logged across the boundary, including on error paths, stated as a checkable assertion for tests? [Coverage, Spec FR-014/SC-007] — Spec SC-007 + FR-014 (define "key or secret material"; no log/return "including on error paths") and FR-006 (returned outcome carries no key/token/offset/fingerprint bytes); Plan now has a "Secret-leakage" test tier asserting this on every path.

## Coverage Threshold

- [X] CHK218 Is the ≥80% coverage target scoped explicitly to the binding glue (not the whole core), giving a measurable, unambiguous denominator? [Measurability, Spec FR-014] — Spec FR-014 ("≥ 80% coverage of the binding glue"); Plan Coverage tier ("≥ 80% of the binding glue") and Requirement Coverage Map FR-014.
- [X] CHK219 Does the spec tie the coverage and dependency-security-scan gates to binding artifacts as release gates, so their pass/fail is a stated acceptance condition? [Traceability, Spec FR-014] — Spec FR-014 ("Binding artifacts MUST meet the project quality gates — dependency security scanning (gate: no CRITICAL... blocks binding release) and ≥80% coverage"); Plan Instructions Check gate + Security/Coverage tiers scope these to binding outputs.

## Version Mismatch

- [X] CHK220 Is binding/core version-mismatch detectability stated as a verifiable behavior (a mismatch is detectable, not silent), so a mismatch test has a defined expected outcome? [Coverage, Spec FR-012] — Spec FR-012 ("a binding/core mismatch is detectable, not silent"); Plan AD-006 and Error Handling table ("ls_abi_version() mismatch detectable by host").
- [X] CHK221 Does the spec specify what "tracking" the core SemVer and token-format version means precisely enough that a test can assert mismatch detection rather than guess at the comparison? [Clarity, Spec FR-012] — Spec FR-012 ("track the core's semantic version and token format version"); Plan AD-006 makes the comparison concrete: "Expose ls_abi_version() + embed core SemVer + token-format version", so a test asserts the exposed version differs on a mismatched build.
- [X] CHK222 Is the unsupported platform/architecture failure stated to occur at build/load time (not verify time), giving a testable failure boundary? [Edge-Case, Spec §Edge Cases] — Spec Edge Cases + FR-017 ("MUST fail clearly at build time or library-load time... never at verify time; the supported target matrix MUST be published").

## Quickstart Time-to-Verify

- [X] CHK223 Is the quickstart "first successful offline verify" target (under 30 minutes) expressed as a measurable success criterion with a defined start/end and integrator profile, rather than a subjective "quickly"? [Measurability, Spec FR-011/SC-004] — Spec SC-004 ("under 30 minutes") with the start/end now defined in the same SC (see CHK224 resolution); Plan adds a "Quickstart time-to-verify" tier that times the documented walkthrough against the 30-minute bound.
- [X] CHK224 Does the spec define what counts as a "new integrator" and a "first successful verify" so SC-004 has an objective pass condition? [Ambiguity, Spec SC-004] — RESOLVED: amended Spec SC-004 to define start = integrator opens the quickstart with only the baseline Assumptions prerequisites (no Rust toolchain/crypto knowledge assumed) and end = the documented sample returns a success verdict for the supplied valid token, with the 30-minute bound measured between those two points.

## P2 Binding Non-Blocking

- [X] CHK225 Is the generated (UniFFI/Python) binding clearly marked P2 and its smoke test framed as non-blocking for the P1 MVP, so test gating does not depend on it? [Consistency, Spec FR-003/US3] — Spec FR-003 "*(P2)*", US3 "(Priority: P2)" ("the two primary targets (US1/US2) already deliver the MVP"); Plan Scale/Scope ("P2 = UniFFI") and Testing Strategy "Integration (UniFFI)" tier marked "(P2)".
- [X] CHK226 Does the spec require the P2 generated binding's entitlement output to be identical to the other bindings, giving its smoke test a comparison oracle when it does run? [Coverage, Spec SC-006] — Spec SC-006 ("reads entitlements identical to the other bindings") + US3 Acceptance 1 ("entitlements identical to the other bindings") give the comparison oracle.

## Determinism and Reproducibility

- [X] CHK227 Does the spec assert that verification is deterministic — the same token, keyring, time, anchor, and fingerprint always yield the same verdict and reason code — so tests can rely on a stable oracle? [Consistency, Spec FR-006/FR-007] — RESOLVED: added Spec FR-019 and SC-008 asserting verification is deterministic for a fixed set of the FR-007 inputs (same verdict + reason code every call, no wall-clock dependence); Plan adds a "Determinism" test tier (and coverage-map FR-019).
- [X] CHK228 Are all verify inputs (token, keyring, current time, monotonic anchor, machine fingerprint) enumerated so a reproducible test fixture can hold them fixed rather than leaving time-dependent inputs implicit? [Completeness, Spec FR-007] — Spec FR-007 enumerates all five inputs ("supply the token, the trusted keyring, current time, monotonic anchor, and machine fingerprint"); FR-019/SC-008 reference the same set as the fixture.
- [X] CHK229 Is the expired-token outcome made reproducible by treating current time as an explicit supplied input rather than wall-clock, so the expiry test is deterministic? [Edge-Case, Spec FR-007/SC-002] — Spec FR-007 makes "current time" a supplied input, and FR-019 ("current time is always the supplied input, never read internally") plus SC-008 make the expired-token outcome reproducible against fixed time.

## Traceability and Completeness

- [X] CHK230 Does every P1 user story (US1, US2, US4) carry an Independent Test that is concrete enough to execute, with a defined valid/invalid pair? [Traceability, Spec §User Scenarios] — Spec US1 (valid offline + reads entitlement / reject tampered), US2 (valid offline + gate feature / reject tampered/expired), US4 (same valid token verifies / same tampered token same reason code) each give an executable Independent Test with a valid/invalid pair.
- [X] CHK231 Is each success criterion (SC-001 through SC-007) traceable to at least one test tier in the plan's Testing Strategy, with no SC left unverified? [Coverage, Spec §Success Criteria] — RESOLVED: every SC now maps to a Plan Testing Strategy tier — SC-001→Integration (C), SC-002→Integration (WASM), SC-003→Cross-binding parity, SC-005→Unit (panic guard), SC-006→Integration (UniFFI), SC-007→Security (fuzz) + new Secret-leakage tier, plus the new SC-008→Determinism tier; the previously untraced SC-004 now maps to the added "Quickstart time-to-verify" tier.
