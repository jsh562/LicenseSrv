# Testing Requirements-Quality Checklist: Offline Verifier Core

Purpose: a unit test for the SPEC's testability — verifies the requirements specify adequate, traceable test coverage, panic-safety, performance measurability, and determinism; it does NOT run or assess code.

## Coverage-Target Completeness

- [X] CHK101 Is the ≥80% coverage target stated with a measurable scope (line vs branch) and the tool that produces it, so a reviewer can judge whether the threshold is verifiable? [Measurability, Technical Constraints / plan Testing Strategy]
- [X] CHK102 Does every technical requirement TR-001..TR-018 have at least one component/file in the Requirement Coverage Map that a test could target, leaving no requirement without a coverage anchor? [Completeness, plan Requirement Coverage Map]
- [X] CHK103 Is each P1 objective's Validation Criteria phrased as an independently testable Given/When/Then so coverage of the objective is verifiable rather than asserted? [Measurability, Objectives 1-3 Validation Criteria]
- [X] CHK104 Does the spec specify whether the ≥80% coverage applies to the whole crate or excludes generated/fuzz/bench harness code, removing ambiguity in how coverage is counted? [Ambiguity, Technical Constraints] <!-- Evaluator: Covered by spec.md §Technical Constraints — ≥80% measured over src/, excluding fuzz/ and benches/ harnesses -->>

## Enumerated Edge Cases Traceable to Requirements

- [X] CHK105 Are the spec's enumerated edge cases (malformed, truncated, non-token input) each tied to a verifiable requirement and not just narrative? [Traceability, Edge Cases & Boundaries / TR-001]
- [X] CHK106 Is the unknown-`key_id` case specified as distinct from bad-signature with a requirement a test can assert the distinction against? [Edge-Case, TR-003 / SC-005]
- [X] CHK107 Is the perpetual (no-expiry) token "accept at any time" behavior tied to a requirement that gives a test its expected outcome? [Coverage, TR-004 / Objective 2 VC1]
- [X] CHK108 Is the clock-rollback-beyond-skew case specified so a test has a concrete boundary (current time vs anchor vs skew) to verify against? [Edge-Case, TR-005 / SC-003]
- [X] CHK109 Is partial fingerprint drift (up to N−K changed signals still verifies) tied to a requirement with K and N values a test can parameterize? [Coverage, TR-006 / SC-004]
- [X] CHK110 Is the missing-fingerprint-on-a-bound-token "refuse, not silently pass" case a stated requirement with a verifiable failure reason? [Edge-Case, TR-013 / Edge Cases & Boundaries]
- [X] CHK111 Is the below-K fingerprint rejection case enumerated alongside the at-or-above-K accept case so both sides of the threshold are covered by requirements? [Completeness, TR-006 / Objective 2 VC3]
- [X] CHK112 Does each closed `VerifyError` variant (malformed, unsupported-version, unknown-key, bad-signature, expired, clock-rollback, fingerprint-mismatch, fingerprint-missing) map to at least one edge-case requirement so no variant is untestable? [Coverage, TR-015] <!-- Evaluator: Covered by spec.md §Edge Cases — new case: non-LIC1./out-of-range token_version → unsupported-version, distinct from malformed; completes variant→edge-case mapping -->>

## Fuzzing / Panic-Safety as a Stated Requirement

- [X] CHK113 Is parser panic-freedom on arbitrary input stated as a requirement (not an aspiration) with fuzzing named as the means of demonstration? [Measurability, TR-010 / SC-002]
- [X] CHK114 Does the spec define what "panic-free" excludes (e.g., no `unwrap`/`panic`/OOM-abort on adversarial input) so a fuzz finding can be judged a requirement violation? [Ambiguity, TR-010] <!-- Evaluator: Covered by spec.md §TR-010 — precise panic-free definition (no panic/unwrap/overflow/OOB) plus bounded work (no unbounded recursion, quadratic blow-up, allocation amplification) -->>
- [X] CHK115 Is the fuzz target's input surface scoped to the token parser/envelope so coverage of TR-001's malformed/truncated rejection is unambiguous? [Clarity, TR-001 / TR-010]

## Performance-Benchmark Measurability

- [X] CHK116 Is the <5 ms p99 verification budget stated with the percentile, the operation measured, and "commodity hardware" defined enough to be reproducible? [Measurability, TR-011 / SC-006] <!-- Evaluator: Covered by spec.md §TR-011/SC-006 — named reference baseline (single modern x86_64 core, ~3 GHz post-2018, release build) + representative machine-bound-token workload at p99 -->>
- [X] CHK117 Is the benchmark required to be repeatable (criterion) and tied to a requirement, so a reviewer can confirm the perf claim is verifiable rather than one-off? [Traceability, TR-011 / plan Testing Strategy]
- [X] CHK118 Does the spec note the build configuration the budget applies to (no_std release build) so the benchmark target is unambiguous against the std-build baseline? [Consistency, TR-011 / plan Performance Goals]

## Key-Rotation / Multi-Generation Test Coverage

- [X] CHK119 Is multi-generation verification (old and new key valid simultaneously) tied to a requirement with both-succeed expected outcomes a test can assert? [Coverage, TR-008 / SC-005]
- [X] CHK120 Is per-key validity-window and revoked-flag enforcement specified with testable accept/reject conditions (within/outside `valid_from`/`valid_until`, revoked set)? [Edge-Case, TR-017] <!-- Evaluator: Covered by spec.md §TR-017 — inclusive valid_from / exclusive valid_until vs host time, revoked flag enforced now; out-of-window or revoked key rejected with key-not-valid -->>
- [X] CHK121 Does the absent-`key_id` rejection requirement give a distinct reason code a rotation test can verify against the unknown-key contract? [Traceability, TR-008 / TR-003]

## no_std Build / Target Verification

- [X] CHK122 Is the `no_std`+`alloc` constraint stated as a verifiable build requirement (e.g., the crate compiles without `std`) rather than an undisclosed assumption? [Measurability, Technical Constraints / AD-001]
- [X] CHK123 Are the first-class targets (`wasm32-unknown-unknown`, common 64-bit desktop/server triples) enumerated so a build/CI matrix can verify each? [Completeness, Technical Constraints / plan Target Platform]
- [X] CHK124 Is "no network I/O on the verify path" specified in a way a test or dependency-audit can verify (e.g., no I/O dependencies), not just asserted? [Measurability, TR-009]

## Stable-Error-Code and Token-Format Contract Coverage

- [X] CHK125 Is the closed, append-only `VerifyError` set specified with a stable discriminant ordering so a test can guard against reorder/removal across bindings? [Consistency, TR-015 / AD-004 / HINT-003]
- [X] CHK126 Is the `LIC1.` byte layout described as a freeze point precisely enough that a golden/contract test can detect an unintended layout change? [Measurability, TR-016 / IP-002]
- [X] CHK127 Is forward-compatible parsing (additive `token_version`, ignore unknown entitlement value types) tied to a requirement giving tests an explicit "accept and ignore unknown" expectation? [Edge-Case, TR-018 / TR-016]
- [X] CHK128 Is the SemVer policy on the public API stated so a reviewer can require an API-surface/contract test for breaking-change detection? [Traceability, TR-016 / AD-006]
- [X] CHK129 Is the `LIC2.`-on-breaking-change rule specified so a test can assert `LIC1.` is never silently altered? [Clarity, TR-016]

## Determinism / Reproducibility of Tests

- [X] CHK130 Does the spec establish that verification is a pure function of (now, stored anchor, skew) so tests are deterministic without wall-clock or persistence dependencies? [Measurability, TR-005 / Clarifications]
- [X] CHK131 Is the host-supplied nature of time, fingerprint, and anchor stated so tests inject fixed inputs and remain reproducible? [Clarity, Assumptions / TR-005]
- [X] CHK132 Are deterministic test keys / fixtures implied or required so signature and rotation tests are reproducible rather than relying on randomly generated material? [Consistency, plan Testing Strategy]
- [X] CHK133 Is the anchor-to-persist return value (max of stored anchor and now, excluding a future issued-at) specified so a test can assert the exact returned anchor deterministically? [Measurability, TR-005]

## Cross-Cutting Testability and Traceability

- [X] CHK134 Does each Success Criterion SC-001..SC-006 map to a requirement and an objective so its verification is traceable end-to-end? [Traceability, Success Criteria]
- [X] CHK135 Is the "rejected 100% of the time" claim in SC-001 reducible to enumerated, individually testable cases (tampered, wrong-key, expired, wrong-machine)? [Measurability, SC-001]
- [X] CHK136 Is the salted-hash / no-raw-PII-retention requirement specified so a test or review can verify the core never stores raw hardware identifiers? [Coverage, TR-014]
- [X] CHK137 Are boolean and integer entitlement resolution outcomes specified with expected values so feature-gating tests have concrete assertions? [Clarity, TR-007 / TR-018] <!-- Evaluator: Covered by spec.md §TR-007 — absent bool→false, absent int→no value (caller default), unknown value type→treated as absent/ignored -->>
- [X] CHK138 Is the token-claim-tightens-skew and token-claim-raises-K behavior (never loosen/lower) stated with directionality a test can assert in both directions? [Edge-Case, TR-005 / TR-006]
- [X] CHK139 Does the testing strategy distinguish unit vs integration scope so a reviewer can confirm end-to-end verify paths (valid/invalid/rotation/rollback/fingerprint) are covered, not only module units? [Completeness, plan Testing Strategy]
- [X] CHK140 Are the security gates (cargo audit, Semgrep SAST, fuzzing) stated as required, passing conditions so their absence is a detectable requirements gap rather than optional tooling? [Measurability, Technical Constraints / plan Testing Strategy]
