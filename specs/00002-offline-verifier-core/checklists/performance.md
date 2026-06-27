# Performance Requirements Quality Checklist: Offline Verifier Core

> Purpose: A unit test for the Performance requirements of the spec — checks whether the latency, zero-I/O, benchmark, and scaling requirements are complete, clear, and measurable, not whether the code is fast.

## Latency Target Measurability

- [X] CHK201 Is the latency target expressed with an explicit percentile (p99) rather than an average or unqualified "fast"? [Measurability, Spec §SC-006/TR-011]
- [X] CHK202 Is the hardware baseline for the latency target defined concretely enough to reproduce ("commodity hardware" qualified by CPU class, clock, or named triples) rather than left undefined? [Ambiguity, Spec §TR-011] <!-- Evaluator: Covered by spec.md §TR-011 — reference baseline = single modern 64-bit x86_64 core (~3 GHz, post-2018 class), release build -->

- [X] CHK203 Is the measurement method for the latency target specified (a repeatable benchmark tool/harness) so the p99 figure can be independently reproduced? [Measurability, Spec §TR-011]
- [X] CHK204 Is the unit and scope of the 5 ms budget unambiguous — does it bound a single verify() call end-to-end (parse + signature + temporal + fingerprint + entitlement), or only part of the path? [Clarity, Spec §SC-006/TR-011]
- [X] CHK205 Does the latency requirement state the input conditions under which p99 is measured (token size, keyring size, fingerprint signal count, machine-bound vs perpetual)? [Completeness, Spec §TR-011] <!-- Evaluator: Covered by spec.md §TR-011 — representative valid machine-bound token, all five fingerprint slots, single matching key within a stated keyring size -->


## Zero Network / Zero I/O Guarantee

- [X] CHK206 Is the "no network I/O" guarantee stated as a hard requirement on the verification hot path and scoped to all sub-operations, not only the top-level entry point? [Completeness, Spec §TR-009]
- [X] CHK207 Is the zero-I/O guarantee defined in a way that is verifiable (e.g., no I/O-capable dependencies on the verify path) rather than asserted only in prose? [Measurability, Spec §TR-009]
- [X] CHK208 Are non-network blocking operations (disk, filesystem, syscalls, clock/entropy sources) addressed by the hot-path requirements, or is only network I/O excluded? [Coverage, Spec §TR-009]
- [X] CHK209 Is the host's contract to supply time, fingerprint, and anchor (rather than the core fetching them) stated consistently with the zero-I/O guarantee so verify stays a pure function? [Consistency, Spec §TR-005/Assumptions]

## Benchmark Methodology & Regression Detection

- [X] CHK210 Does the spec or plan require a repeatable, automated benchmark as a deliverable rather than a one-off measurement? [Completeness, Spec §TR-011/Plan Testing Strategy]
- [X] CHK211 Is a performance-regression-detection expectation defined (a threshold or gate that fails when verify exceeds the 5 ms p99 budget) rather than only an initial measurement? [Coverage, Spec §TR-011] <!-- Evaluator: Covered by spec.md §TR-019 — benchmark enforces a regression gate that fails when measured p99 exceeds the budget on the stated baseline -->

- [X] CHK212 Is the benchmark required to run on the same first-class target/baseline as the latency claim, so the reported p99 corresponds to a stated platform? [Traceability, Spec §TR-011/Technical Constraints] <!-- Evaluator: Covered by spec.md §TR-011/TR-019 — benchmark measured over the named x86_64 reference baseline; regression gate evaluates p99 on the stated baseline -->


## no_std / alloc / wasm32 Overhead

- [X] CHK213 Does the latency requirement account for the no_std + alloc build (the conformance target) rather than only the current std build measured at ~37 µs? [Consistency, Spec §Technical Constraints/Plan Performance Goals]
- [X] CHK214 Is the wasm32-unknown-unknown target explicitly in scope for the 5 ms p99 budget, given its interpreter/JIT overhead differs from native triples? [Coverage, Spec §Technical Constraints/SC-006] <!-- Evaluator: Covered by spec.md §TR-011/SC-006 — wasm32 explicitly addressed: benchmarked and reporting p99 against its own stated budget, separate from the native 5 ms budget -->

- [X] CHK215 If the latency budget is met only on native triples and not wasm32, is that distinction stated rather than left implied by a single "commodity hardware" figure? [Ambiguity, Spec §TR-011/Technical Constraints] <!-- Evaluator: Covered by spec.md §TR-011 — 5 ms p99 budget applies to native first-class triples; wasm32 reports against its own stated budget, an explicit distinction -->

- [X] CHK216 Is allocation behavior on the hot path bounded or constrained (so alloc usage does not introduce unbounded or unpredictable latency under no_std+alloc)? [Edge-Case, Spec §Technical Constraints] <!-- Evaluator: Covered by spec.md §TR-020/TR-010 — verify cost and hot-path allocation bounded by enforced size limits; no allocation amplification from attacker-controlled length fields -->


## Payload-Size & Scaling Bounds

- [X] CHK217 Is a maximum token size (or input-length bound) specified so parse and verify cost is bounded against oversized or adversarial input? [Completeness, Spec §TR-001/TR-011] <!-- Evaluator: Covered by spec.md §TR-020 — maximum token size defined and enforced; input exceeding the limit rejected as malformed before full parsing -->

- [X] CHK218 Is a bound or expected scaling defined for keyring size (number of trusted keys searched during key_id selection)? [Completeness, Spec §TR-008/TR-011] <!-- Evaluator: Covered by spec.md §TR-020 — maximum keyring size defined and enforced -->

- [X] CHK219 Is a bound or expected scaling defined for entitlement count resolved from a token, so verify cost does not grow unboundedly with claim count? [Coverage, Spec §TR-007/TR-018] <!-- Evaluator: Covered by spec.md §TR-020 — maximum entitlement count defined and enforced -->

- [X] CHK220 Are the fingerprint signal slots fixed (5 canonical slots, K-of-N) so machine-binding evaluation cost is constant and cannot scale with attacker-controlled input? [Edge-Case, Spec §TR-006]

## Absence of Unbounded Work

- [X] CHK221 Does the parser requirement preclude unbounded work on arbitrary input (no quadratic blowup, unbounded recursion, or allocation amplification) beyond merely being panic-free? [Edge-Case, Spec §TR-001/TR-010] <!-- Evaluator: Covered by spec.md §TR-010 — parser MUST perform bounded work: no unbounded recursion or nesting, no quadratic blow-up, no allocation amplification from attacker-controlled length fields -->

- [X] CHK222 Is the relationship between the panic-free fuzzing requirement and the latency requirement consistent — i.e., do malformed/oversized inputs fail fast within bounded cost rather than triggering pathological slow paths? [Consistency, Spec §TR-010/TR-011] <!-- Evaluator: Covered by spec.md §TR-020 — malformed/oversized/adversarial input rejected fail-fast within bounded cost (no pathological slow paths), keeping TR-010 and TR-011 mutually consistent -->

- [X] CHK223 Is forward-compatible parsing of unknown token_version fields and unknown entitlement value types required to skip rather than iterate unbounded, keeping cost bounded under additive evolution? [Edge-Case, Spec §TR-016/TR-018]

## Traceability

- [X] CHK224 Is every performance constraint (TR-009, TR-011) traceable to a measurable success criterion (SC-006) and a benchmark deliverable in the plan's coverage map? [Traceability, Spec §SC-006/TR-011/Plan Requirement Coverage Map]
- [X] CHK225 Are the latency figures in the plan (current ~37 µs, < 5 ms p99 budget) consistent with the spec's stated target and clearly marked as pre- vs post-no_std measurements? [Consistency, Spec §Plan Performance Goals/TR-011]
