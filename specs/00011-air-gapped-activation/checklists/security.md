# Security Checklist: Air-Gapped Activation (E010)
**Created**: 2026-07-15 | **Feature**: [spec.md](../spec.md)

## Tamper-Evidence & Offline Trust Anchor

- [X] CHK001 Is the trust anchor for offline response-file verification specified unambiguously as a pinned Ed25519 public key (keyring), with no reliance on any network re-check? [Clarity, FR-006 / spec §Assumptions] <!-- Evaluator: Covered by spec §Assumptions (Ed25519 sig verified offline against a pinned public key) + contract §OFFLINE VERIFICATION (pinned public key, no online re-check); reinforced by FR-016 -->

- [X] CHK002 Do the requirements state explicitly that the response envelope carries NO separate envelope-level signature and that tamper-evidence rests solely on the embedded LIC1's Ed25519 signature? [Clarity, plan AD-003 / contract ResponseFile] <!-- Evaluator: Covered by plan AD-003 + contract ResponseFile + spec §Assumptions (tamper-evidence is the Ed25519 sig on the embedded credential; no envelope signature) -->

- [X] CHK003 Is the distribution and rotation mechanism of the pinned public key (keyring) to offline clients specified as a requirement, or left undefined? [Completeness, spec §Assumptions] <!-- Evaluator: Resolved — added FR-016 (trust anchor is the E004-published keyring distributed with the SDK; rotation via the E004 overlapping keyring; no new key-distribution mechanism) -->

- [X] CHK004 Is the role of `keyId` for keyring selection/rotation stated as a requirement so a response signed by a rotated key still verifies offline? [Completeness, contract ResponseFileEnvelope.keyId] <!-- Evaluator: Resolved — added FR-016 (keyId selects the keyring entry so a rotated-key credential still verifies offline; overlapping keyring keeps prior-key credentials valid) -->

- [X] CHK005 Do the requirements define "a tampered or wrong-machine response is rejected at import" as a testable outcome (offline verify fails on the bound machine), distinct from any portal-side check? [Measurability, FR-006 / SC-006] <!-- Evaluator: Covered by SC-006 + US3 scenario 1 + contract §OFFLINE VERIFICATION (rejected at import; the portal is not involved) -->

- [X] CHK006 Is the machine-binding tolerance (K-of-N fingerprint match) that governs whether a response verifies on the target machine specified or referenced as a requirement? [Completeness, FR-003 / contract SignalHash] <!-- Evaluator: Covered by FR-003 (K-of-N binding) + contract SignalHash (at least K of N signals match, reusing E009) -->


## Signing-Key & Secret Non-Exposure

- [X] CHK007 Is there an explicit requirement that no private signing-key material appears in the request file, response file, storage, logs, or audit entries? [Completeness, contract §SECRECY & PII / spec §Compliance Check] <!-- Evaluator: Resolved — added FR-017 (private signing-key material never in request/response file, envelope, storage, logs, or audit) -->

- [X] CHK008 Do the requirements state that only the public signed credential plus an opaque `keyId` appear in the response file (no key material)? [Clarity, FR-006 / contract ResponseFileEnvelope] <!-- Evaluator: Resolved — added FR-017 (response file carries only the public machine-bound credential plus an opaque keyId; signing stays in the E004 signer) -->

- [X] CHK009 Is signing-key non-exposure stated as a first-class FR/SC rather than only an implicit Compliance-Check planning follow-up? [Traceability, spec §Compliance Check (Planning follow-ups)] <!-- Evaluator: Resolved — promoted to first-class FR-017 (was only an implicit Compliance-Check follow-up) -->


## Request-File Threat Model

- [X] CHK010 Is the honest-client threat boundary for the request file stated as a requirement — the operator fully controls it, so no request-supplied claim is trusted for security? [Completeness, contract AirGapActivateRequest / research §2] <!-- Evaluator: Resolved — added FR-018 (honest-client threat model: operator controls the file; no request claim trusted for security) -->

- [X] CHK011 Do the requirements state that all invariants (seat cap, K-of-N binding, nonce) are enforced server-side at processing, never derived from request-file claims? [Clarity, FR-003 / FR-005] <!-- Evaluator: Resolved — added FR-018 (every invariant enforced server-side at processing; none trusted verbatim from the file), reinforcing FR-003/FR-005 -->

- [X] CHK012 Is it unambiguous which request fields the server resolves/matches versus trusts (license reference resolved, fingerprint matched, nonce checked — none trusted verbatim)? [Clarity, contract RequestFileEnvelope] <!-- Evaluator: Resolved — FR-018 enumerates resolve/match/check handling (license resolved in tenant, fingerprint matched K-of-N, nonce checked, seat cap enforced) — none trusted verbatim -->


## Request-File Validation & Fail-Closed

- [X] CHK013 Are the distinct refusal reasons for malformed/truncated, unknown-format-version, stale, non-active-license, and too-few-signals each specified as separate, testable codes? [Coverage, FR-007/008/009 / contract Error enum] <!-- Evaluator: Covered by contract Error enum (validation_error, unknown_format_version, stale_request, license_not_active, insufficient_signals — distinct codes) + FR-007/008/009 -->

- [X] CHK014 Do the requirements unambiguously distinguish `validation_error` (undecodable/malformed) from `unknown_format_version` (decodable but unsupported version)? [Clarity, FR-007 / contract §FILE FORMAT VERSIONING] <!-- Evaluator: Covered by contract §FILE FORMAT VERSIONING (undecodable → validation_error vs decodable-but-unsupported → unknown_format_version) + plan HINT-003 -->

- [X] CHK015 Is "fail-closed — no response file, no seat, no partial activation" stated as an invariant common to every refusal path? [Completeness, FR-004/007/009 / SC-004/007/008] <!-- Evaluator: Covered by FR-004/007/009 + spec §Scope (fail-closed refusals return no response file) + contract 400/409 refusals (no seat, no response file, no partial activation) -->

- [X] CHK016 Is a maximum request-file size (oversize / decompression-bomb guard) specified as a requirement, not only implied by the contract's `maxLength`? [Completeness, contract RequestFile.maxLength] <!-- Evaluator: Resolved — added FR-019 (configured max request-file size; oversize refused before decode with distinct validation_error details.reason=oversize) + NEW-CONFIG + contract RequestFile note -->

- [X] CHK017 Is the format-version trust boundary specified — that an unknown/future version is refused before any activation logic runs? [Clarity, plan HINT-003 / FR-014] <!-- Evaluator: Covered by plan HINT-003 (validate file layer + formatVersion BEFORE activate()) + contract §STATUS PRECEDENCE (file decode/version precedes business rules) + FR-014 -->

- [X] CHK018 Is the minimum required number of fingerprint signals a named, configurable threshold in the requirements, or left unquantified? [Measurability, FR-009 / contract insufficient_signals] <!-- Evaluator: Resolved — added FR-020 (minimum fingerprint signal count = E009 K-of-N threshold, default 3, configurable via NEW-CONFIG) -->


## Anti-Replay & Freshness

- [X] CHK019 Is the single-use nonce requirement stated with its entropy/uniqueness expectation (e.g., >=128-bit) in a requirement rather than only in the contract? [Measurability, FR-005 / contract RequestFileEnvelope.nonce] <!-- Evaluator: Resolved — added FR-020 (single-use nonce, at least 128-bit entropy) promoting the contract value to a requirement -->

- [X] CHK020 Do the requirements clearly distinguish an idempotent replay (same request → original response, no new seat) from a nonce reused to forge a different activation (refused)? [Clarity, FR-005 / contract nonce_replayed] <!-- Evaluator: Covered by FR-005 (same file replays original response, no extra seat; reused-to-forge is refused) + contract nonce_replayed -->

- [X] CHK021 Is the request-file freshness window quantified (a configured maximum age with a stated default) in the requirements? [Measurability, FR-008 / plan AD-005] <!-- Evaluator: Resolved — added FR-020 (freshness window default 7 days / 604800s, configurable), promoting plan AD-005's default into a requirement -->

- [X] CHK022 Is replay behavior across the freshness boundary defined — can a stored nonce still be replayed after `producedAt` exceeds the window, and which check takes precedence? [Completeness, FR-005 / FR-008] <!-- Evaluator: Resolved — added FR-021 (used nonce retained via the activation record; idempotent replay holds past the freshness window; freshness gates only first processing) -->

- [X] CHK023 Is the precedence between the nonce store and the freshness window specified so the two anti-replay controls cannot contradict each other? [Consistency, FR-005 / FR-008] <!-- Evaluator: Resolved — FR-021 sets precedence: an already-processed request replays/refuses via the nonce store regardless of age; freshness applies only to a not-yet-seen file -->

- [X] CHK024 Is the retention/lifetime of the nonce store specified so idempotent replay stays available for the file's realistic circulation lifetime? [Completeness, FR-005] <!-- Evaluator: Resolved — FR-021 ties nonce retention to the life of the persisted activation record, so idempotent replay stays available as long as the activation exists -->


## PII Minimization

- [X] CHK025 Is it specified that only salted signal hashes / pseudonymous `machineId` appear in files, storage, and logs, never raw hardware identifiers? [Completeness, FR-010 / SC-009] <!-- Evaluator: Covered by FR-010 + SC-009 + contract §SECRECY & PII (only salted hashes / pseudonymous machineId; never a raw hardware identifier) -->

- [X] CHK026 Is the pseudonymous `machineId` defined unambiguously (salted hash, not a raw id, not a bare UUID) as a requirement? [Clarity, contract ResponseFileEnvelope.machineId] <!-- Evaluator: Covered by FR-010 (pseudonymous machine identity) + contract ResponseFileEnvelope.machineId (salted hash derived from the fingerprint; not a raw identifier and not a UUID) -->

- [X] CHK027 Do the requirements state that nonce and fingerprint values themselves are never echoed in responses, errors, or audit entries? [Coverage, contract §AUDIT / §ERROR MODEL] <!-- Evaluator: Covered by contract §AUDIT (never the nonce or fingerprint values) + Error schema (nonce never echoed; nonce_replayed details omit the value) + FR-012 (no secrets) -->

- [X] CHK028 Is the salt provenance/handling for fingerprint hashes referenced (client-computed salted hashes) so PII minimization is verifiable end-to-end? [Traceability, contract SignalHash / research §4] <!-- Evaluator: Covered by contract SignalHash (salted hash computed by the CLIENT; raw ids never transmitted/stored/returned) + research §4 -->


## Tenant Isolation & Authorization

- [X] CHK029 Is fail-closed tenant isolation stated so a cross-tenant license reference resolves to not-found (404) and never discloses another tenant's existence (never 403)? [Clarity, FR-011 / SC-010 / contract §TENANT SCOPING] <!-- Evaluator: Covered by FR-011 + SC-010 + contract §TENANT SCOPING (cross-tenant reference → 404 license_not_found, never 403) -->

- [X] CHK030 Is the `activate`-scope API-key authorization requirement for the portal stated, with distinct 401 (no tenant) vs 403 (missing scope) outcomes? [Completeness, FR-002 / contract §STATUS PRECEDENCE] <!-- Evaluator: Covered by FR-002 + contract §SINGLE AUTH PLANE / §STATUS PRECEDENCE (no tenant → 401; resolved key lacking activate scope → 403) -->

- [X] CHK031 Is the status-precedence ordering (auth → authz → rate-limit → file decode → business rules) specified so overlapping failures resolve deterministically? [Consistency, contract §STATUS PRECEDENCE] <!-- Evaluator: Covered by contract §STATUS PRECEDENCE (explicit 5-step order: 401 → 403 → 429 → 400 decode/version → 404/409 business rules) -->


## Rate Limiting & Abuse

- [X] CHK032 Is the air-gap portal rate-limit requirement quantified (a stated rate, keyed per API key), rather than only "reuse the E009 posture"? [Measurability, FR-013 / contract §SINGLE AUTH PLANE] <!-- Evaluator: Covered by contract §SINGLE AUTH PLANE (keyed per API key, default 60 req/min, limiter runs before body parse) — the quantified value backing FR-013 -->

- [X] CHK033 Is it required that a throttled attempt is both refused with a distinct reason AND audited? [Coverage, FR-013 / SC-012] <!-- Evaluator: Covered by SC-012 (refused with a distinct reason AND the throttled attempt audited) + contract §RateLimited + FR-013 -->


## Audit & Traceability

- [X] CHK034 Is append-only audit required for every processed request AND every refusal, including the file-layer 400s rejected before activation runs? [Completeness, FR-012 / SC-011 / plan HINT-006] <!-- Evaluator: Covered by FR-012 + SC-011 + plan HINT-006 (audit EVERY refusal incl. file-layer 400s via airgap.denied, before activate() runs) + contract §AUDIT -->

- [X] CHK035 Do the requirements specify that audit entries capture actor, action, and reason with no raw hardware identifiers, secrets, nonce, or fingerprint values? [Clarity, FR-012 / contract §AUDIT] <!-- Evaluator: Covered by FR-012 (actor, action, reason; no raw hardware ids or secrets) + contract §AUDIT (never the nonce or fingerprint values) -->

- [X] CHK036 Is each security-related SC-### (SC-006..012) traceable to a stated FR so every security outcome has an owning requirement? [Traceability, spec SC-006..012] <!-- Evaluator: Covered — SC-006→FR-006, SC-007→FR-007, SC-008→FR-008/009, SC-009→FR-010, SC-010→FR-011, SC-011→FR-012, SC-012→FR-013; each SC has an owning FR -->


## Requirement Gaps & Ambiguities

- [X] CHK037 Do the requirements specify credential-expiry semantics (`expiresAt`) and how the offline verifier enforces them against a local clock, given air-gapped clock drift? [Completeness, contract ResponseFileEnvelope.expiresAt] <!-- Evaluator: Resolved — added FR-022 (expiresAt = min(license expiry, activation TTL); enforced offline by the E001 core against the local clock; clock drift an accepted offline tradeoff per E009) -->

- [X] CHK038 Is signer-unavailable handling stated as a fail-closed security requirement (transaction rolls back, no seat consumed), not only a contract 503 behavior? [Completeness, contract §SignerUnavailable] <!-- Evaluator: Resolved — added FR-023 (signer-unavailable fails closed: rollback, no seat consumed, no activation persisted, no response file, 503 signer_unavailable; re-submit is idempotent) -->

