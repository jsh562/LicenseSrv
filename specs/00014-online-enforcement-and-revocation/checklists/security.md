# Checklist: Security — Online Enforcement and Revocation
**Created**: 2026-07-18 | **Feature**: [spec.md](../spec.md)

## Signing-Key & Secret Non-Exposure

- [X] CHK001 Is a requirement defined that the private signing key is never present in any validate/heartbeat/CRL body, header, example, log, or audit entry? [Completeness, ADR-0010; contract "PII/SECRECY INVARIANTS"] <!-- Evaluator: Covered by contract "PII/SECRECY INVARIANTS" ("signing key never exposed in any body, header, example, log, or audit entry") + data-model §4 + spec Compliance Check -->
- [X] CHK002 Do the requirements unambiguously classify which enforcement artifacts are PUBLIC (shortLivedToken, machineBoundKey, CRL signature, keyId) versus secret, so a reviewer can confirm nothing secret is returned? [Ambiguity, contract §ShortLivedToken/§RevocationList] <!-- Evaluator: Covered by contract §ShortLivedToken/§MachineBoundKey/§RevocationList (each explicitly PUBLIC; keyId "never key material") vs the secret signing key -->
- [X] CHK003 Is it stated as a requirement that the renewal token and CRL are signed by the EXISTING E004 keyring with no new key custody? [Consistency, FR-002/FR-009, ADR-0010] <!-- Evaluator: Covered by spec FR-002/FR-009 + Assumptions ("no new key custody") + data-model §4 + ADR-0010 -->
- [X] CHK004 Is there a requirement that error `message`/`details` never echo the nonce, token, key material, or a raw identifier? [Completeness, contract §Error] <!-- Evaluator: Covered by contract §Error (code/message/details "never carry a raw identifier, key material, token, or nonce") -->


## Offline-First Preservation & Never-Connected Safety

- [X] CHK005 Is "additive" defined as a measurable non-regression — the E001 verifier core and E009 machineBoundKey offline behaviour are unchanged? [Measurability, FR-012, SC-005] <!-- Evaluator: Covered by spec FR-012 + SC-005 (offline verification unchanged, no regression) + data-model §4 -->
- [X] CHK006 Is the "not revoked-by-default" guarantee for a never-connected client tied to an observable state (NULL last_checkin_at/last_anchor_at = offline credential governs), not just prose? [Clarity, FR-012, data-model §6] <!-- Evaluator: Covered by data-model §2/§6 (NULL last_checkin_at/last_anchor_at = E009 offline credential governs, NOT revoked-by-default) -->
- [X] CHK007 Is there an explicit requirement that the online path must NOT overwrite or shorten the E009 machineBoundKey credential (the short-lived token being a separate artifact)? [Completeness, FR-012, data-model §4] <!-- Evaluator: Covered by data-model §2/§4 ("does NOT overwrite machine_bound_token") + contract "OFFLINE-FIRST PRESERVED" (separate artifact) -->


## Tenant Isolation & RLS

- [X] CHK008 Is a requirement defined that validate/heartbeat/CRL are implicitly tenant-scoped with no caller-widenable tenant parameter? [Completeness, FR-018, contract "TENANT SCOPING"] <!-- Evaluator: Covered by spec FR-018 + contract "TENANT SCOPING" ("NO tenant path/query parameter and it can never be widened by the caller") -->
- [X] CHK009 Is the RLS fail-closed behaviour on an unset `app.current_tenant` GUC (NULL → zero rows) specified as a requirement rather than assumed? [Coverage, data-model §10] <!-- Evaluator: Covered by data-model §10 (NULLIF unset GUC → NULL → predicate matches zero rows; unscoped/cross-tenant query refused) -->
- [X] CHK010 Is there a requirement that a cross-tenant activationId/productId resolves to 404 (never 403) so another tenant's existence is not leaked? [Clarity, FR-018, contract §ActivationNotFound] <!-- Evaluator: Covered by contract "TENANT SCOPING" + §ActivationNotFound/§RevocationListNotFound (cross-tenant id → 404, never 403) -->
- [X] CHK011 Are checkin and revocation_list required to carry ENABLE + FORCE ROW LEVEL SECURITY with the tenant_isolation policy, consistent with E002/E008/E009? [Consistency, data-model §10] <!-- Evaluator: Covered by data-model §10/§11 DDL (ENABLE+FORCE ROW LEVEL SECURITY + tenant_isolation policy on both new tables) -->
- [X] CHK012 Is the least-privilege grant posture (SELECT+INSERT only, no UPDATE/DELETE) on the new tables stated as a security requirement (immutable rows; purge is the platform path)? [Completeness, data-model §10] <!-- Evaluator: Covered by data-model §10 ("GRANT SELECT, INSERT only ... no UPDATE ... no DELETE"; purge is the platform owner path) -->


## Nonce Anti-Replay & Idempotent Replay

- [X] CHK013 Are both replay outcomes specified unambiguously — same nonce/same activation replays the ORIGINAL result, while a nonce reused for a DIFFERENT activation is rejected 409? [Ambiguity, FR-008, contract §NonceReplayed] <!-- Evaluator: Covered by contract "ANTI-REPLAY NONCE" + §NonceReplayed + data-model §4a (same nonce/same activation replays original; different activation → 409) -->
- [X] CHK014 Is there a requirement that no replay can forge a SECOND renewal token or advance the monotonic anchor twice? [Completeness, FR-008, SC-010, data-model §4a] <!-- Evaluator: Covered by contract "ANTI-REPLAY NONCE" ("no second token is minted and the monotonic anchor is not advanced twice") + data-model §4a -->
- [X] CHK015 Is the nonce single-use/entropy expectation quantified (≥128-bit, single-use) rather than described vaguely? [Measurability, contract §EnforcementRequest.nonce] <!-- Evaluator: Covered by contract §EnforcementRequest.nonce ("MUST be high-entropy (>=128-bit, single-use)") -->
- [X] CHK016 Is the boundedness of the TTL-pruned nonce store justified against replay safety (a pruned nonce could only reproduce an already-expired token)? [Clarity, data-model §4a/§9] <!-- Evaluator: Covered by data-model §4a ("a replay of the nonce could at most reproduce an already-expired token ... so forgetting it is safe") -->
- [X] CHK017 Is there a requirement that the nonce is never echoed in any response or error body? [Coverage, contract "ANTI-REPLAY NONCE"] <!-- Evaluator: Covered by contract "ANTI-REPLAY NONCE" + §EnforcementRequest.nonce + §NonceReplayed ("nonce is never echoed in any response or error") -->


## Rate Limiting & Abuse Resistance

- [X] CHK018 Is a requirement defined that validate, heartbeat, AND CRL-fetch are each rate-limited per (API key/activation), with the outcome specified (429 + Retry-After, audited)? [Completeness, FR-021, contract §RateLimited] <!-- Evaluator: Covered by spec FR-021 + contract "RATE LIMITING" + §RateLimited (429 + Retry-After header + audited) -->
- [X] CHK019 Is the rate-limiting rationale traced to protecting the p95<120ms SLO and deterring brute-force/replay pressure, so the requirement's intent is testable? [Traceability, FR-021, FR-020] <!-- Evaluator: Covered by spec FR-021 ("so abuse cannot degrade the p95 SLO or enable brute-force/replay pressure") + contract "RATE LIMITING"/§RateLimited -->


## CRL Integrity, Versioning & Fail-Open/Fail-Closed

- [X] CHK020 Is the fail-open-on-fetch / fail-closed-on-expiry rule stated unambiguously (fetch failure → fall back to token-TTL enforcement; token expiry still fails closed)? [Ambiguity, FR-011, contract "CRL FALLBACK"] <!-- Evaluator: Covered by spec FR-011 + contract "CRL FALLBACK" (fetch failure fails OPEN to token-TTL; token EXPIRY fails CLOSED) -->
- [X] CHK021 Is there a requirement preventing CRL downgrade/rollback — an older signed version cannot supersede a newer one (monotonic version)? [Coverage, FR-009, data-model §5, US4-AC1] <!-- Evaluator: Resolved — added FR-022 (server strictly-monotonic version + client MUST reject/ignore an older-versioned CRL; anti-downgrade/rollback) to spec.md; plan Requirement Coverage Map row added. Server-side monotonicity was in data-model §5/US4-AC1; the client anti-downgrade obligation was implicit. -->
- [X] CHK022 Is the CRL signature required to cover a canonical, byte-stable encoding so the JSON and `?format=file` forms verify identically? [Consistency, contract §RevocationList, data-model §5] <!-- Evaluator: Covered by contract "CRL FALLBACK"/§RevocationList (detached signature over canonical encoding; both forms same canonical bytes) + data-model §5 -->
- [X] CHK023 Is a requirement defined for how a client treats a CRL whose SIGNATURE fails to verify, as distinct from a fetch failure? [Completeness, FR-011] <!-- Evaluator: Resolved — added FR-023 to spec.md (signature-invalid CRL treated as UNTRUSTED: ignore/never cache, fall back to short-TTL enforcement; DISTINCT from FR-011 fetch fail-open); plan Requirement Coverage Map row added. -->
- [X] CHK024 Is the `next_update > generated_at` validity horizon specified, with a requirement that cache TTL not exceed `next_update`? [Measurability, data-model §8, contract "CACHING"] <!-- Evaluator: Covered by data-model §8 (CHECK next_update > generated_at) + contract "CACHING" (Cache-Control/Expires align to nextUpdate) + spec FR-010 -->
- [X] CHK025 Is the per-product CRL signing scope (signed by the product's E004 key, verified against product_keyring) stated as a requirement? [Clarity, FR-009, data-model §5] <!-- Evaluator: Covered by data-model §5 + plan AD-004 (per-product E004 key, keyId stamped, verified against product_keyring) -->


## Clock-Tamper Resistance

- [X] CHK026 Is the monotonic anchor defined with an observable invariant (last_anchor_at non-decreasing; a request asserting a time/token preceding it is rejected)? [Measurability, FR-014, data-model §6] <!-- Evaluator: Covered by data-model §6 (guarded UPDATE keeps last_anchor_at non-decreasing; a request asserting a time/token preceding it is rejected) + spec FR-014 -->
- [X] CHK027 Is the split of clock-tamper responsibilities specified (client persists anchor + rejects rollback; server supplies signed time + refuses renewal) so no enforcement gap is left ambiguous? [Ambiguity, plan HINT-005, contract "CLOCK-TAMPER RESISTANCE"] <!-- Evaluator: Covered by plan HINT-005 + contract "CLOCK-TAMPER RESISTANCE" (client persists anchor + rejects rollback; server supplies signed time + short exp + refuses renewal) -->
- [X] CHK028 Is the per-plan offline-tolerance window's bounding of pure-offline rollback specified AND disclosed as bounded-not-eliminated? [Clarity, FR-015, US6-AC3] <!-- Evaluator: Covered by spec FR-015 + US6-AC3 + Risks + contract "CLOCK-TAMPER RESISTANCE" (rollback only BOUNDED, not eliminated — disclosed) -->
- [X] CHK029 Is signed server time required to be embedded in the renewed token AND equal to the check-in anchor / `serverTime`? [Consistency, FR-014, contract §EnforcementResult.serverTime] <!-- Evaluator: Covered by spec FR-014 + contract §EnforcementResult.serverTime (equals anchor embedded in token and check-in's stored time) + data-model §6 -->


## Bounded Staleness & Revoke-by-Non-Reissue

- [X] CHK030 Is the bounded-staleness window defined by an explicit formula (= max(token TTL, CRL next_update) + offline tolerance) and required to be disclosed in-band on every response? [Measurability, FR-013, SC-006, contract §StalenessWindow] <!-- Evaluator: Covered by spec FR-013 + SC-006 (explicit formula) + contract §StalenessWindow/"BOUNDED-STALENESS DISCLOSURE" (returned on every validate/heartbeat response) -->
- [X] CHK031 Are the renewal re-check gates enumerated as requirements (license active, not expired, activation active, entitlements re-read fresh)? [Completeness, FR-004/FR-005/FR-017] <!-- Evaluator: Covered by spec FR-004 (license status, activation status, expiry, entitlements re-checked) + FR-017 (fresh entitlements) + FR-005 -->
- [X] CHK032 Is the staleness bound for a revoked/suspended binding (outstanding token lapses within ≤ one renewal-window TTL) stated measurably? [Measurability, FR-005, SC-002/SC-004] <!-- Evaluator: Covered by spec FR-005 ("outstanding token expires within the bounded renewal window (staleness ≤ TTL)") + SC-002/SC-004 -->


## Authentication, Scope & Refusal Semantics

- [X] CHK033 Is the required `validate` scope and its fail-closed precedence (401 → 403 → 404) specified unambiguously for all three endpoints? [Ambiguity, contract "SCOPE", FR-018] <!-- Evaluator: Covered by contract "SCOPE" (all three ops require `validate`; fail-closed 401 precedes 403 precedes 404) + spec FR-018 -->
- [X] CHK034 Is the refusal-semantics rule (revoked/suspended/expired/deactivated = 200 verdict, not 4xx) specified consistently so a refusal is not conflated with a protocol error nor leaks beyond the verdict? [Consistency, AD-001, contract "REFUSAL SEMANTICS"] <!-- Evaluator: Covered by plan AD-001 + contract "REFUSAL SEMANTICS" + §Verdict (refusals = 200 + verdict, genuine faults use standard errors) -->


## Audit & Security Events

- [X] CHK035 Is a requirement defined that every validate/heartbeat outcome and CRL publication is appended to the append-only audit_log in the same transaction? [Completeness, FR-019, data-model "Audit"] <!-- Evaluator: Covered by spec FR-019 + data-model "Audit" convention + §4/§5 ("appends one row to the existing audit_log ... in the same transaction") -->
- [X] CHK036 Is the `security_event` flag requirement defined for denied/revoked renewals and security-relevant refusals (including forbidden-scope attempts)? [Clarity, FR-019, contract §ForbiddenScope] <!-- Evaluator: Covered by spec FR-019 (denied/revoked renewals + security-relevant refusals MUST be flagged) + data-model "Audit" (security_event=true) + contract §ForbiddenScope (denied attempt audited) -->


## PII / GDPR

- [X] CHK037 Is there a requirement that check-in / last-seen data holds only signed timestamps + ids + a short-lived token and carries no raw machine identifier? [Completeness, data-model §9, Key Entities] <!-- Evaluator: Covered by data-model §9 + Conventions + spec Key Entities + contract "PII/SECRECY INVARIANTS" (check-in store holds only signed timestamps + ids + short-lived token; no raw machine identifier) -->
- [X] CHK038 Is the retention/erasability posture for check-in data specified measurably (TTL-pruned to renewal-window + skew; purge via the platform owner path; no DELETE grant to the app role)? [Measurability, data-model §9] <!-- Evaluator: Covered by data-model §9 (TTL-pruned to max(renewal-window TTL)+skew; platform owner retention path; no DELETE grant to app role) -->

