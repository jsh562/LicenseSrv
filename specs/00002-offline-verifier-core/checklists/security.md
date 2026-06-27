# Security Requirements Quality Checklist: Offline Verifier Core

> Purpose: A unit test for the spec — verifies that the security requirements for the offline verifier core are complete, clear, consistent, and traceable, not that any code behaves correctly.

## Cryptographic Verification Correctness

- [X] CHK001 Are the requirements explicit that no payload claim may be trusted until the Ed25519 signature verifies, with a defined ordering of parse-then-select-key-then-verify-then-evaluate? [Completeness, Spec TR-002]
- [X] CHK002 Is the exact signed byte range (what the signature covers within the `LIC1.` envelope vs. what is excluded) specified unambiguously? [Ambiguity, Spec TR-001] <!-- Evaluator: Covered by spec.md §TR-002 — signature covers domain-separated format-version byte + canonical CBOR payload; envelope prefix and signature bytes excluded -->
- [X] CHK003 Are the requirements specific about the signature algorithm (Ed25519) and free of conflicting algorithm-agility language elsewhere in the spec? [Consistency, Spec TR-002]
- [X] CHK004 Is it defined how a structurally valid but signature-failing token is distinguished from a token that fails an earlier parse step? [Clarity, Spec TR-001]

## Signing-Key Trust, Keyring Validity & Rotation

- [X] CHK005 Are requirements defined for how the verifier distinguishes an unknown `key_id` from a bad signature? [Completeness, Spec TR-003]
- [X] CHK006 Is the keyring trust model (multiple keys selected by `key_id`, enabling rotation without invalidating issued tokens) fully specified? [Completeness, Spec TR-008]
- [X] CHK007 Are the semantics of the per-key `valid_from` / `valid_until` window defined, including boundary behavior (inclusive vs. exclusive) and which time input they are evaluated against? [Edge-Case, Spec TR-017] <!-- Evaluator: Covered by spec.md §TR-017 — valid_from inclusive, valid_until exclusive, evaluated against host-supplied current time -->
- [X] CHK008 Is the behavior of the reserved revoked flag specified — including what reason code a revoked-key token yields and that it is enforced offline only? [Clarity, Spec TR-017] <!-- Evaluator: Covered by spec.md §TR-015 (adds key-not-valid) and §TR-017 — revoked/out-of-window key rejected with key-not-valid, enforced locally/offline; online propagation out of scope -->
- [X] CHK009 Is overlapping multi-generation verification (old and new keys simultaneously valid) stated as a measurable acceptance outcome? [Measurability, Spec SC-005]
- [X] CHK010 Are requirements consistent on whether keyring per-key validity is part of the signed token or travels with the keyring artifact, with no contradictory statements? [Consistency, Spec TR-017]

## Clock-Tamper Resistance

- [X] CHK011 Is the clock-rollback rule defined as a pure function of (current time, stored anchor, skew) with no hidden state or I/O dependency? [Clarity, Spec TR-005]
- [X] CHK012 Is the next-anchor value the host must persist precisely defined as the maximum of stored anchor and current time (with a future issued-at excluded)? [Completeness, Spec TR-005]
- [X] CHK013 Are requirements unambiguous that a token claim MAY tighten the skew but MUST NEVER loosen it, with the precedence rule stated? [Ambiguity, Spec TR-005]
- [X] CHK014 Is the default skew (48 hours) specified together with its caller-configurable contract and units? [Measurability, Spec TR-005]
- [X] CHK015 Is the rollback rejection boundary defined precisely (current time precedes anchor by exactly the skew vs. beyond the skew)? [Edge-Case, Spec SC-003]
- [X] CHK016 Is it stated that a perpetual (no-expiry) token must verify at any time, and that this does not conflict with the rollback anchor check? [Consistency, Spec TR-004] <!-- Evaluator: Covered by spec.md §TR-004 — perpetual token exempt only from expiry check; the TR-005 clock-rollback check still applies -->

## Fingerprint Salted-Hashing & PII Minimization

- [X] CHK017 Are requirements explicit that fingerprint signals are consumed only as salted hashes and that no raw hardware identifier or personal data is retained? [Completeness, Spec TR-014]
- [X] CHK018 Is the canonical five-slot signal set (machine id, CPU, disk/volume, MAC, OS-install id) enumerated and frozen? [Completeness, Spec TR-006]
- [X] CHK019 Is the K-of-N match rule, default K (3 of 5), and the claim-may-raise-never-lower constraint specified without ambiguity? [Ambiguity, Spec TR-006]
- [X] CHK020 Is the behavior for a machine-bound token with no local fingerprint supplied defined as an explicit refusal rather than a silent pass? [Edge-Case, Spec TR-013]
- [X] CHK021 Is partial-drift tolerance (up to N−K changed signals still verifies) stated as a measurable acceptance outcome? [Measurability, Spec SC-004]
- [X] CHK022 Is the salt's origin/scope specified (who supplies it, whether per-deployment) so the salted-hash requirement is implementable and verifiable? [Clarity, Spec TR-014] <!-- Evaluator: Covered by spec.md §TR-014 — salting applied by host/issuer (recommended per-product scope) before signals reach the core; core compares pre-salted hashes, never sees raw signals or salt -->

## Parser Panic-Safety & Fuzzing

- [X] CHK023 Are requirements explicit that malformed, truncated, or non-token input is rejected without panicking on arbitrary input? [Completeness, Spec TR-010]
- [X] CHK024 Is the fuzzing obligation stated with a measurable acceptance criterion (no panic/crash demonstrated by fuzzing)? [Measurability, Spec SC-002]
- [X] CHK025 Is panic-freedom defined to cover the full parse surface (envelope, CBOR claims, signature decode) and not only the outer prefix check? [Coverage, Spec TR-001]

## Error-Information Leakage & Reason-Code Contract

- [X] CHK026 Is the closed, append-only failure-reason set enumerated completely (malformed, unsupported-version, unknown-key, bad-signature, expired, clock-rollback, fingerprint-mismatch, fingerprint-missing)? [Completeness, Spec TR-015]
- [X] CHK027 Are the reason codes required to be stable identically across all language bindings, with append-only / never-reorder constraints stated? [Consistency, Spec TR-015]
- [X] CHK028 Do requirements specify that failure reasons expose only a coded reason and no secret-bearing detail (e.g., key material, raw fingerprint, internal offsets)? [Edge-Case, Spec TR-015] <!-- Evaluator: Covered by spec.md §TR-015 — failure result exposes only the coded reason, no secret-bearing/diagnostic detail (key material, raw or hashed fingerprint values, internal byte offsets) -->
- [X] CHK029 Is each enumerated reason code traceable to the specific check that produces it, with no overlapping or undefined reasons? [Traceability, Spec TR-015]

## Token-Format Integrity & Versioning

- [X] CHK030 Is the versioning policy unambiguous — SemVer on the public API, additive evolution within `LIC1.` via `token_version`, and a new `LIC2.` envelope required for any breaking byte-layout change? [Ambiguity, Spec TR-016]
- [X] CHK031 Is the requirement that an unsupported version yields a distinct `unsupported-version` reason (rather than malformed) stated clearly? [Clarity, Spec TR-015]
- [X] CHK032 Is forward-compatible handling of unknown entitlement value types specified (ignored additively, no breaking change), and is it consistent with the reserved typed-value variant? [Consistency, Spec TR-018]
- [X] CHK033 Is the byte-layout freeze treated as a breaking-change boundary for downstream consumers (signing/issuance), with that contract stated? [Traceability, Spec IP-002]

## Verify-Only (No Private Key) Boundary

- [X] CHK034 Do requirements explicitly exclude token issuance/signing and any private-key handling from this core's scope? [Completeness, Spec §Scope/Excluded]
- [X] CHK035 Is the verification path's no-network-I/O obligation stated as an enforceable, measurable constraint (zero network calls)? [Measurability, Spec TR-009]
- [X] CHK036 Are public-key distribution and out-of-band keyring delivery defined as host responsibilities outside this core's boundary, with no contradicting in-scope statement? [Consistency, Spec §Scope/Excluded]
- [X] CHK037 Is the host-supplied input contract (current time, fingerprint signals, persisted anchor) defined as the trust boundary, clarifying what the core does and does not own? [Clarity, Spec §Assumptions]
- [X] CHK038 Is the client-side-bypass risk on attacker-controlled machines acknowledged with a stated security posture (deterrence, later online gating) rather than an unstated assumption of tamper-proofing? [Coverage, Spec §Risks]
