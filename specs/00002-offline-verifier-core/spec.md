---
feature_branch: "00002-offline-verifier-core"
created: "2026-06-26"
input: "Epic E001 — Offline verifier core: the single, write-once cryptographic core that parses a signed license token, verifies it against a pinned keyring, and evaluates expiry, clock-rollback, fingerprint, and entitlements fully offline; distributed as an embeddable library."
spec_type: "technical"
spec_maturity: "clarified"
epic_id: "E001"
epic_sources: "{SAD:ADR-0001,ADR-0002}{PRD:CAP-003}"
---

# Feature Specification: Offline Verifier Core

**Feature Branch**: `00002-offline-verifier-core`  
**Created**: 2026-06-26  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: clarified  
**Epic ID**: E001  
**Epic Sources**: {SAD:ADR-0001,ADR-0002}{PRD:CAP-003}

## Problem Statement *(mandatory)*

Applications must confirm that a license is valid and learn which features it grants, on the customer's own machine, without a network call — and without each application re-implementing cryptography, which is a frequent source of forgeable or inconsistent checks and licensing CVEs. Without one embeddable verification core, every integration risks bypassable validation and divergent behavior across stacks. This objective delivers the single cryptographic core that verifies a signed license token offline, enforces its time and machine constraints, and exposes its entitlements.

## Scope *(mandatory)*

### Included

- A versioned, self-describing signed license token format and its parser.
- Offline signature verification against a pinned keyring of trusted public keys.
- Local evaluation of expiry, clock-rollback, machine fingerprint, and entitlements.
- A stable verification API suitable for embedding as a library.
- Robustness and performance assurance: fuzzed parser and a repeatable verification benchmark.

### Excluded

- Language bindings (C-ABI, WASM, generated) — separate epic; this core is wrapped, not duplicated.
- Token issuance/signing — owned by the signing service and issuance epics (server side).
- Public-key distribution (CDN/registry) — keys are delivered to clients out of band.
- Online validation, heartbeat, and revocation propagation — offline-first; online enforcement is a later phase.

### Edge Cases & Boundaries

- Malformed, truncated, or non-token input must be rejected without panicking.
- Unknown `key_id` (no matching trusted key) must be rejected distinctly from a bad signature.
- A perpetual token (no expiry) must verify regardless of current time.
- A clock set backward beyond the allowed skew must not revive an expired token.
- Partial hardware drift (a swapped component) must not break an otherwise valid machine-bound token.
- A machine-bound token with no local fingerprint supplied must be refused, not silently passed.
- A token whose envelope is not `LIC1.` or whose `token_version` exceeds the supported range must be rejected as unsupported-version, distinct from malformed.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Token format and offline signature verification (Priority: P1)

Define a versioned, self-describing signed license token and verify it fully offline: parse the envelope, select the trusted key by `key_id`, and verify the signature before any claim is trusted.

**Why this priority**: Foundational — every downstream capability (bindings, issuance, activation) depends on the token format and the verification result.

**Rationale**: A single, versioned, signed token verified locally is the cornerstone of offline-first licensing and the only place cryptography is implemented.

**Deliverables**:
- A versioned token format (signed envelope + claims) with a frozen byte layout and a format/`token_version` field.
- An offline verification entry point that returns a validated license or the first failing check.
- Signature verification against a keyring; nothing in the payload is trusted until the signature verifies.

**Validation Criteria**:
1. **Given** a valid token and a keyring containing its key, **When** verified offline, **Then** verification succeeds and the claims/entitlements are exposed.
2. **Given** a tampered, wrong-key, or unknown-`key_id` token, **When** verified, **Then** verification fails with a distinct reason and no claim is trusted.

### Objective 2 - Temporal and machine-binding constraint evaluation (Priority: P1)

After the signature verifies, enforce expiry, detect clock rollback via a monotonic anchor, match the machine fingerprint with tolerance, and resolve entitlements.

**Why this priority**: Signature validity alone is insufficient; without these checks an expired or shared license trivially bypasses enforcement.

**Rationale**: Offline enforcement must locally resist clock tampering and bind a node-locked license to its machine while tolerating benign hardware change.

**Deliverables**:
- Expiry evaluation against a host-supplied current time.
- A monotonic clock anchor with a configurable skew (default 48 hours) that rejects implausible backward time.
- A K-of-N machine-fingerprint match (default 3 of 5) tolerant of partial drift.
- Boolean and integer entitlement resolution for feature gating.

**Validation Criteria**:
1. **Given** an expired token, **When** verified, **Then** it is rejected; **Given** a perpetual token, **When** verified at any time, **Then** it is accepted.
2. **Given** a current time earlier than the anchor by more than the skew, **When** verified, **Then** it is rejected as clock-rollback.
3. **Given** at least K of N fingerprint signals matching, **When** verified, **Then** accepted; below K, **Then** rejected.

### Objective 3 - Keyring and signing-key rotation (Priority: P1)

Trust a keyring of multiple public keys selected by `key_id`, so signing keys can rotate without invalidating already-issued tokens.

**Why this priority**: Rotation must be possible from day one; a single hard-coded key cannot be rotated without breaking issued licenses.

**Rationale**: Clients pin a set of trusted keys and select the right one per token, enabling overlapping rotation windows.

**Deliverables**:
- A keyring abstraction mapping `key_id` to a trusted public key.
- Key selection by `key_id` during verification.
- Multi-generation verification (old and new keys valid simultaneously).

**Validation Criteria**:
1. **Given** a keyring holding an old and a new key, **When** verifying tokens signed by either, **Then** both succeed.
2. **Given** a token whose `key_id` is absent from the keyring, **When** verified, **Then** it is rejected as unknown-key.

### Technical Constraints

- The verification path MUST perform no network I/O.
- Offline verification MUST complete within 5 ms p99 on commodity hardware.
- The token parser MUST be panic-free on arbitrary input (fuzzed).
- The token format MUST be versioned and forward-compatibly parsed; cryptography MUST be implemented once and reused, never duplicated per consumer.
- The core MUST satisfy the project quality gates: ≥ 80% test coverage measured over the library crate (`src/`), excluding the fuzz (`fuzz/`) and benchmark (`benches/`) harnesses; dependency-audit and SAST security scanning (`cargo audit`, Semgrep); and parser fuzzing.
- The core MUST be `no_std` + `alloc` compatible, with `wasm32-unknown-unknown` and common 64-bit desktop/server triples as first-class build targets (a prerequisite for the WASM and C-ABI bindings).

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: Language bindings (epic E003) depend on this core's verification API as the single surface they wrap.
- **IP-002**: The signing service (epic E004) and issuance (epic E008) depend on this token format; its byte layout is a freeze point and changes are breaking.
- **IP-003**: Client applications embed a keyring of public keys published by the signing service (epic E004); this core consumes that keyring.

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST define a versioned, self-describing signed license token and parse it, rejecting malformed or truncated input without panicking.
- **TR-002**: System MUST verify the token's Ed25519 signature against a pinned keyring before trusting any claim in the payload. The signature MUST cover the domain-separated format-version byte and the canonical CBOR claims payload; the envelope prefix and the appended signature bytes are excluded from the signed range.
- **TR-003**: System MUST reject tampered, wrong-key, and unknown-`key_id` tokens, distinguishing unknown-key, bad-signature, and key-not-valid (TR-017) as separate outcomes.
- **TR-004**: System MUST reject a token whose expiry precedes the host-supplied current time, and MUST accept a perpetual (no-expiry) token at any time. A perpetual token is exempt only from the expiry check; the clock-rollback check (TR-005) still applies.
- **TR-005**: System MUST detect clock rollback using a persisted monotonic anchor with a caller-configurable skew (default 48 hours), rejecting verification when the current time precedes the anchor beyond the skew. Verification MUST be a pure function of the supplied current time, stored anchor, and skew, and MUST return the anchor value the host should persist (the maximum of the stored anchor and the current time; a token's `issued-at` MUST NOT advance the anchor beyond the current time, and a token whose `issued-at` exceeds the current time plus the skew MUST be rejected); the host owns anchor durability. A signed token claim MAY tighten the tolerated skew (never loosen it).
- **TR-006**: System MUST evaluate machine binding by matching at least K of N salted-hash fingerprint signals, tolerating partial drift, and MUST reject below the threshold. The canonical signal set is five slots — machine id, CPU, disk/volume, MAC, and OS-install id — with a default K of 3 of 5; a signed token claim MAY raise K (never lower it) to demand stronger binding for higher-value plans.
- **TR-007**: System MUST resolve boolean and integer entitlements from a verified token for feature gating. Resolving an absent boolean entitlement MUST return false; an absent integer entitlement MUST return no value (the caller supplies a default); a present entitlement whose value type is unknown MUST be treated as absent (ignored), consistent with TR-018.
- **TR-008**: System MUST support a keyring of multiple trusted public keys selected by `key_id`, enabling rotation without invalidating issued tokens.
- **TR-009**: The verification path MUST perform no network I/O.
- **TR-010**: The token parser MUST be fuzzed and remain panic-free on arbitrary input. "Panic-free" means no panic, `unwrap`/`expect` failure, arithmetic-overflow panic, or out-of-bounds access on any byte input; the parser MUST also perform bounded work — no unbounded recursion or nesting, no quadratic blow-up, and no allocation amplification from attacker-controlled length fields.
- **TR-011**: Offline verification MUST complete within 5 ms p99 on the reference baseline — a single modern 64-bit x86_64 core in a release build — measured by a repeatable benchmark over a representative valid, machine-bound token (all five fingerprint slots supplied, a single matching key within the maximum keyring size of TR-020). The 5 ms p99 budget applies to the native first-class triples; the `wasm32-unknown-unknown` target MUST also be benchmarked against a budget of 25 ms p99.
- **TR-012**: The core MUST expose a stable verification API consumable as an embeddable library (the surface that language bindings wrap).
- **TR-013**: When a token is machine-bound but no local fingerprint is supplied, the system MUST refuse verification rather than silently pass.
- **TR-014**: Machine fingerprint signals MUST be consumed as salted hashes; the core MUST NOT retain raw hardware identifiers or other personal data (GDPR minimization). Salting MUST be applied by the host/issuer before signals reach the core using a per-product salt and scope that MUST be identical between the issuer (when baking the fingerprint binding) and the host (at verify time); otherwise the K-of-N match is undefined. The core compares pre-salted hashes and never receives raw signals or the salt.
- **TR-015**: Verification MUST return one of a closed, append-only set of distinct failure reasons (at least: malformed, unsupported-version, unknown-key, key-not-valid, bad-signature, expired, clock-rollback, fingerprint-mismatch, fingerprint-missing); these reason codes are a stable contract preserved identically across all language bindings. A failure result MUST expose only the coded reason and MUST NOT include secret-bearing or diagnostic detail (key material, raw or hashed fingerprint values, internal byte offsets).
- **TR-016**: The public verification API MUST follow semantic versioning, and the token format MUST evolve additively / forward-compatibly within the `LIC1.` envelope (`token_version`); any breaking byte-layout change MUST adopt a new envelope version (`LIC2.`) rather than silently altering `LIC1.`.
- **TR-017**: The keyring contract MUST carry an optional per-key validity window (`valid_from` inclusive / `valid_until` exclusive, evaluated against the host-supplied current time) and a revoked flag, enforced locally and offline; a token signed by a key outside its validity window or marked revoked MUST be rejected with the `key-not-valid` reason. Online revocation propagation remains out of scope.
- **TR-018**: The entitlement value model MUST reserve a forward-compatible typed value variant so additional value types (string, enum, date) can be added later without a breaking token-format change; the MVP MUST evaluate boolean and integer entitlements and MUST ignore unknown value types forward-compatibly.
- **TR-019**: The verification benchmark MUST enforce a performance-regression gate that fails when measured p99 exceeds the budget on the stated baseline.
- **TR-020**: The core MUST define and enforce a maximum token size (default 8 KiB), maximum keyring size (default 32 keys), and maximum entitlement count (default 256), each overridable by the host; input exceeding any limit MUST be rejected as malformed before full parsing, bounding verify cost and hot-path allocation. Oversized or adversarial input MUST be rejected fail-fast; the parser's bounded-work guarantees are specified in TR-010.

### Key Entities *(include for product or technical specs if feature involves data)*

- **License token**: The signed, transportable artifact (`LIC1.`-prefixed) carrying the claims and signature.
- **Claims**: license/product/plan/customer identifiers, issued-at and expiry, max activations, entitlements, max version, maintenance-until, `key_id`, token version, nonce, and optional fingerprint binding.
- **Keyring**: The set of trusted public keys indexed by `key_id`, each with an optional validity window (`valid_from` / `valid_until`) and a reserved revoked flag enforced offline.
- **Entitlement**: A value a token grants — boolean or integer in the MVP, modeled as a forward-compatible typed value so string/enum/date can be added later.
- **Fingerprint**: The set of per-signal machine hashes used for K-of-N matching.
- **Clock anchor**: The highest trustworthy timestamp ever observed, persisted by the host to detect rollback.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The host supplies the current time, the local machine fingerprint signals, and a persisted monotonic anchor at verification time.
- Public verification keys are distributed to clients out of band (embedded at build or fetched and pinned).
- Entitlement keys and their meaning are defined by the product catalog, not by this core.

### Risks

- **Client-side bypass on attacker-controlled machines** *(likelihood: high, impact: medium)*: local checks can be patched out — accept as casual-piracy deterrence; gate the highest-value features behind periodic online checks in a later phase.
- **Token-format evolution breaking older clients** *(likelihood: low, impact: high)*: mitigate with a versioned format, forward-compatible parsing, and fuzzing.
- **Fingerprint over-tolerance enabling license sharing** *(likelihood: medium, impact: medium)*: tune the K-of-N threshold and document the tradeoff.

## Implementation Signals *(mandatory)*

- `NEW-CONFIG` — Versioned license token format and the public-key keyring contract.
- `NEW-ENTITY` — In-memory token claims and entitlement model (verified, not persisted by this core).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A valid token verifies offline and exposes its entitlements; tampered, wrong-key, expired, and wrong-machine tokens are rejected 100% of the time.
- **SC-002** [OBJ1]: Arbitrary or malformed input never causes a panic or crash (demonstrated by fuzzing).
- **SC-003** [OBJ2]: An expired license cannot be made valid by setting the clock backward beyond the configured skew.
- **SC-004** [OBJ2]: A machine with up to N−K changed fingerprint signals still verifies, and below the threshold it is rejected.
- **SC-005** [OBJ3]: Tokens signed under a rotated key continue to verify while both keys are present in the keyring; a token referencing an absent `key_id` is rejected as unknown-key.
- **SC-006** [OBJ1]: Offline verification completes in under 5 ms (p99) on the reference baseline (native x86_64 single core) with zero network calls; the `wasm32` target is benchmarked against its 25 ms p99 budget.

## Clarifications

### Session 2026-06-26

- Q: Is the verify API + `LIC1.` byte layout a formally versioned public contract? -> A: Yes — SemVer on the public API; the token evolves additively within `LIC1.` via `token_version`; breaking layout changes adopt a new `LIC2.` envelope (TR-016).
- Q: What are the canonical fingerprint signals and is the threshold configurable? -> A: Five canonical salted-hash slots (machine id, CPU, disk/volume, MAC, OS-install id); default K = 3 of 5; a signed token claim may raise K (TR-006).
- Q: What is the core's clock-anchor contract and is the skew configurable? -> A: Verify is a pure function of (now, stored anchor, skew) and returns the anchor to persist (max of stored anchor and now; a token's issued-at cannot advance the anchor past now); the host owns durability; skew is caller-configurable (default 48h) and tightenable by a token claim (TR-005).
- Q: How are verification failures exposed to callers? -> A: A closed, append-only set of distinct reason codes, stable identically across all bindings (TR-015).
- Q: Are entitlement values limited to bool/int? -> A: Evaluate bool/int for the MVP, but reserve a forward-compatible typed value variant so string/enum/date are additive later (TR-018).
- Q: What platform/build constraint must the core meet? -> A: `no_std` + `alloc`, with `wasm32` and common 64-bit desktop/server targets first-class (Technical Constraints).
- Q: Does the keyring carry per-key validity now? -> A: Yes — optional `valid_from`/`valid_until` + a reserved revoked flag, enforced offline; online revocation stays out of scope (TR-017).

### Session 2026-06-26 (checklist hardening)

- Q: Are the keyring validity-window bounds inclusive/exclusive and against which time? -> A: `valid_from` inclusive, `valid_until` exclusive, evaluated against the host-supplied current time (TR-017).
- Q: Which reason code does a revoked / out-of-window key produce? -> A: A new append-only `key-not-valid` reason; the revoked flag is enforced in the MVP (TR-015, TR-017).
- Q: Who supplies the fingerprint salt and at what scope? -> A: The host/issuer applies salting before signals reach the core (recommended per-product); the core compares pre-salted hashes and never sees raw signals or the salt (TR-014).
- Q: How does entitlement resolution behave for absent/unknown entries? -> A: Absent boolean -> false; absent integer -> no value (caller default); unknown value type -> treated as absent/ignored (TR-007, TR-018).
- Q: What is the performance baseline and does the budget apply to wasm32? -> A: Reference baseline = a single modern x86_64 core (release build); the 5 ms p99 applies to native triples, with `wasm32` benchmarked against a 25 ms p99 budget; a regression gate enforces the budgets (TR-011, TR-019, SC-006).
- Q: Are input/keyring/entitlement sizes bounded? -> A: Yes — maximum token size (8 KiB), keyring size (32 keys), and entitlement count (256), each host-overridable, are defined and enforced, rejecting oversized input fail-fast within bounded cost (TR-020).
- Q: What does "panic-free" mean and is parser work bounded? -> A: No panic/unwrap/overflow/OOB on any input, plus bounded work (no unbounded recursion, quadratic blow-up, or allocation amplification) (TR-010).

## Compliance Check

**Overall**: PASS (no violations) — the minor gaps the audit raised are closed in TR-014 and Technical Constraints.

- Principle I (Offline-First / Ed25519 / pinned keyring): PASS — TR-002, TR-009, SC-006.
- Principle III (Single Security Core, crypto implemented once): PASS — Technical Constraints, IP-001, TR-012.
- Security (keyring + rotation, clock-tamper): PASS — TR-005, TR-008, SC-003, SC-005.
- Testing (fuzzing, performance benchmark, coverage, security scanning): PASS — TR-010, TR-011, Technical Constraints.
- PII / GDPR minimization for fingerprint and customer identifiers: addressed — TR-014.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| License token | The signed, transportable artifact an application verifies to allow use and unlock features. |
| Keyring | The set of trusted public keys a client pins, selected by `key_id`. |
| Key rotation | Issuing tokens under a new signing key while clients still trust prior public keys. |
| Machine fingerprint | A set of salted hardware/OS signal hashes identifying a machine, matched K-of-N. |
| Monotonic anchor | The highest timestamp ever observed, used to detect and reject clock rollback. |
| Entitlement | A named capability a token grants, as a boolean flag or integer limit. |
| Offline verification | Validating a token on-device with no network call. |
