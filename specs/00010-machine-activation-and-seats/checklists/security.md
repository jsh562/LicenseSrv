# Security Requirements Checklist: Machine Activation & Seat Enforcement
**Created**: 2026-07-13 | **Feature**: [spec.md](../spec.md)

## Authentication & Authorization

- [X] CHK001 Is the required `activate` API-key scope for the runtime activation/deactivation surface, and its fail-closed rejection when the scope is absent, unambiguously specified? [Clarity, FR-002] <!-- Evaluator: Covered by spec.md FR-002 + contract runtime plane (401 no tenant context / 403 missing scope, fail-closed) -->

- [X] CHK002 Do the requirements distinguish the fail-closed response for an unresolvable credential (401) from a resolvable credential lacking the `activate` scope (403)? [Clarity, Plan §Error Handling] <!-- Evaluator: Covered by plan.md §Error Handling (Auth row 401/403) + contract ForbiddenScope vs Unauthorized -->

- [X] CHK003 Are the console RBAC role thresholds (viewer reads, admin deactivates) defined for every admin registry operation? [Completeness, FR-012] <!-- Evaluator: Covered by FR-012 + contract x-rbac (GET minRole viewer, deactivate minRole admin) -->

- [X] CHK004 Is CSRF protection for state-changing console operations traceable to a stated requirement rather than existing only in the plan and contract? [Traceability, Plan §Instructions Check] <!-- Evaluator: Resolved — added FR-017 (CSRF double-submit, fail-closed 403, audited security event) to spec.md -->

- [X] CHK005 Are the two authentication planes (runtime API-key header vs. admin session cookie) specified without overlap or contradiction over which credential each surface accepts? [Consistency, FR-002] <!-- Evaluator: Covered by FR-002 + Assumptions + contract two-auth-planes (X-API-Key vs admin_session) -->

- [X] CHK006 Does a requirement state that an RBAC-denied deactivation attempt is both refused and recorded as a security event? [Completeness, SC-009] <!-- Evaluator: Covered by SC-009 + FR-014 + data-model §7 (denied RBAC deactivation audited as security_event) -->

## Multi-Tenant Isolation

- [X] CHK007 Do the requirements mandate forced RLS tenant isolation on the `activation` table, failing closed when the tenant context is unset? [Completeness, FR-015] <!-- Evaluator: Covered by FR-015 + MIGRATION signal (forced RLS) + data-model §11 (NULLIF GUC → zero rows, fail-closed) -->
- [X] CHK008 Is it stated consistently across all operations that a cross-tenant reference resolves to not-found (404) rather than forbidden (403)? [Consistency, SC-012] <!-- Evaluator: Covered by SC-012 + FR-015 + Edge Cases + contract (every 404 note: cross-tenant resolves to 404, never 403) -->
- [X] CHK009 Do the requirements confirm the tenant scope is derived only from the authenticated credential and can never be widened by a caller-supplied parameter? [Clarity, FR-015] <!-- Evaluator: Covered by contract TENANT SCOPING (no tenant path/query param; never widened) + FR-015 + data-model §11 -->
- [X] CHK010 Is the tenant-isolation guarantee stated for both the read (registry list) and mutate (deactivate) paths? [Coverage, FR-015] <!-- Evaluator: Covered by FR-015 (neither read nor mutate) + SC-012 + contract (GET registry and deactivate both 404 cross-tenant) -->

## PII Minimization & Data Protection

- [X] CHK011 Do the requirements unambiguously state that only salted signal hashes — never raw hardware identifiers — are stored? [Clarity, FR-006] <!-- Evaluator: Covered by FR-006 (store only salted hashes; never persist/log raw identifiers) + Scope + data-model §2 -->
- [X] CHK012 Is "raw hardware identifier" defined precisely enough to test whether a given stored or logged field violates the minimization rule? [Measurability, FR-006] <!-- Evaluator: Covered by research §1 (enumerates raw signals: GUID/MAC/CPU/disk/board) + contract SignalHash pattern (base64url 32-byte digest) + data-model §2 (hashes are text digests only) -->
- [X] CHK013 Do the requirements state that raw hardware identifiers are never logged, in addition to never stored? [Completeness, SC-011] <!-- Evaluator: Covered by FR-006 (never persist OR log) + FR-014 (audit without raw hw ids) + SC-011 -->
- [X] CHK014 Is the provisioning, distribution, and rotation policy of the client-side activation salt used to derive the stored hashes specified? [Completeness, Plan §AD-004] <!-- Evaluator: Resolved — added FR-019 (per-tenant/product server-provisioned salt, SDK-distributed offline, rotation → re-activation) to spec.md; AD-004 + NEW-CONFIG updated -->
- [X] CHK015 Are the GDPR erasability requirements for activation records defined, including which fields are erased versus retained? [Completeness, Spec §Key Entities] <!-- Evaluator: Covered by data-model §9 (label nulled; hashes remain pseudonymous) + Key Entities (retention-bounded GDPR erase path) -->
- [X] CHK016 Is the retention/purge bound for stale activation records quantified as a measurable period rather than left as "retention-bounded"? [Measurability, Spec §Key Entities] <!-- Evaluator: Resolved — quantified default 90 days after deactivation (configurable) in Key Entities + data-model §9 + NEW-CONFIG -->
- [X] CHK017 Is there a requirement constraining the optional `label` field so it cannot carry a raw identifier, and defining how that constraint is enforced? [Coverage, FR-006] <!-- Evaluator: Covered by data-model §2/§9 (label pseudonymous, never a raw id, bounded, GDPR-nulled, never machine identity) + contract label (maxLength 200, pseudonymous) -->

## Anti-Replay Nonce & Rate Limiting

- [X] CHK018 Are the single-use nonce semantics stated distinctly for the same-nonce retry (replays the original result) versus a nonce reused to forge a different activation (rejected)? [Clarity, FR-009] <!-- Evaluator: Covered by FR-009 (both cases distinguished) + data-model §6 (store-and-replay table) + contract ANTI-REPLAY NONCE -->
- [X] CHK019 Is the activation nonce TTL / validity window bounded and quantified in the requirements? [Measurability, Spec §Implementation Signals] <!-- Evaluator: Resolved — added FR-021 (bounded replay-rejection window, default 24h); NEW-CONFIG + data-model §6 quantified -->
- [X] CHK020 Is the minimum nonce entropy stated as a mandatory (MUST) threshold rather than an advisory (SHOULD)? [Clarity, FR-009] <!-- Evaluator: Resolved — FR-021 mandates MUST ≥128-bit single-use; contract nonce changed SHOULD→MUST; data-model §6 updated to MUST -->
- [X] CHK021 Are the rate-limit thresholds, time windows, and keying dimension (per tenant / per API key) specified as requirements? [Completeness, FR-013] <!-- Evaluator: Resolved — added FR-020 (keyed per API key + per license, default 60 req/min); AD-008 updated -->
- [X] CHK022 Do the requirements define the response code and audit behavior when the runtime rate limit is exceeded? [Coverage, FR-013] <!-- Evaluator: Resolved — FR-020 + 429 rate_limited response + Retry-After added to contract; plan Error Handling row added; audit via FR-014 -->
- [X] CHK023 Is the scope of rate limiting (which runtime routes are covered — activate only, or deactivate too) unambiguously defined? [Clarity, Plan §AD-008] <!-- Evaluator: Resolved — FR-020 + AD-008 state rate limiting covers BOTH activate and deactivate runtime routes -->
- [X] CHK024 Is the nonce uniqueness scope (per tenant) specified consistently with the cross-tenant isolation model? [Consistency, FR-009] <!-- Evaluator: Covered by data-model §6 (per-tenant uniqueness matches RLS scope) + AD-005 (UNIQUE (tenant_id, nonce)) -->

## Key & Credential Secrecy

- [X] CHK025 Is the "signing key never exposed" non-negotiable traceable to a dedicated requirement stating the key is never returned, logged, or included in any response, header, or audit entry? [Traceability, Spec §Compliance Check] <!-- Evaluator: Resolved — added FR-018 (signing private key never returned/logged/included in any body/header/example/audit; only public LIC1 + opaque key id returned) -->
- [X] CHK026 Is it specified that only the public machine-bound LIC1 credential is returned, and only by the activate operation? [Clarity, FR-007] <!-- Evaluator: Covered by FR-007 + FR-018 + contract MachineBoundKey (returned ONLY by POST /v1/activations) + data-model §10 -->
- [X] CHK027 Do the requirements state that the registry never returns the machine-bound credential nor the raw signal hashes? [Completeness, SC-011] <!-- Evaluator: Covered by SC-011 + FR-012 + contract registry GET (NO machineBoundKey, NO raw signal hashes) -->
- [X] CHK028 Is the machine-bound credential TTL specified and reconciled against the license expiry (inherited `exp` versus a separately configured TTL)? [Consistency, Spec §Implementation Signals] <!-- Evaluator: Resolved — added FR-022 (effective expiry = min(license exp, credential TTL)); data-model §3 reconciliation note + NEW-CONFIG -->
- [X] CHK029 Is the offline-revocation gap (a deactivated or revoked credential still verifies offline until expiry) documented as an accepted, bounded tradeoff? [Completeness, Spec §Risks] <!-- Evaluator: Covered by spec Risks (Offline revocation lag, accepted tradeoff) + data-model §3 (status not in token) -->

## Fingerprint Integrity

- [X] CHK030 Do the requirements address the risk of an attacker forging or replaying fingerprint signal hashes to impersonate a machine or evade the seat limit? [Coverage, FR-005] <!-- Evaluator: Resolved — added honest-client Assumption + "Fingerprint-hash fabrication" Risk (mitigated by nonce anti-replay FR-009/FR-021, seat locking FR-003, rate limiting FR-020; attestation out of scope) -->
- [X] CHK031 Is the minimum required signal count (the N floor) to form a reliable binding defined as a measurable threshold? [Measurability, FR-016] <!-- Evaluator: Covered by Assumptions (default 3-of-5, server config) + FR-016 + data-model §5/§8 (config-driven floor) + contract insufficient_signals (signalsRequired) -->
- [X] CHK032 Are the default K-of-N values and their configurability stated clearly enough to separate server defaults from client-supplied values? [Clarity, Spec §Assumptions] <!-- Evaluator: Covered by Assumptions (configurable server defaults, not per-request client choices) + FR-005 + contract Fingerprint (K/N are SERVER defaults) -->
- [X] CHK033 Does a requirement confirm that K/N and the clock-skew window are server-controlled and cannot be influenced per-request by a client? [Consistency, Spec §Assumptions] <!-- Evaluator: Covered by Assumptions + contract Fingerprint schema (threshold + skew are server defaults, not in payload) + data-model §5/§8 -->

## Audit & Security Events

- [X] CHK034 Do the requirements mandate an append-only audit entry for every activation, deactivation, and denied/limit-exceeded attempt? [Completeness, FR-014] <!-- Evaluator: Covered by FR-014 (append-only entry for every activation/deactivation/denied or limit-exceeded attempt) -->
- [X] CHK035 Is it specified that audit entries carry actor, action, and target but never raw hardware identifiers, secrets, or nonces? [Clarity, FR-014] <!-- Evaluator: Resolved — tightened FR-014 to exclude nonces and signed credentials (in addition to raw hw ids and secrets) from audit entries -->
- [X] CHK036 Are the attempt categories that must be flagged as security events (RBAC-denied, CSRF failure) enumerated consistently between the spec and the contract? [Consistency, SC-009] <!-- Evaluator: Resolved — FR-017 now enumerates CSRF failure as an audited security event alongside SC-009 RBAC denial, matching contract Forbidden response -->
- [X] CHK037 Do the requirements state whether runtime authentication failures (missing scope, invalid API key) are audited alongside denied attempts? [Coverage, FR-014] <!-- Evaluator: Covered by plan §Error Handling (Auth row: 401/403 fail-closed + audit security event) + FR-014 + contract ForbiddenScope (denied attempt audited) -->
