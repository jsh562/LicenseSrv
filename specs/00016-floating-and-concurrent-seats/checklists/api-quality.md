# API Quality Checklist: Floating & Concurrent Seats
**Created**: 2026-07-23 | **Feature**: [spec.md](../spec.md)

## Endpoint Coverage & Success Paths

- [X] CHK001 Are the success responses for all five endpoints (acquire 201/200, renew 200, release 200, registry 200, force-release 200) each specified with a defined response-body schema? [Completeness, plan §API Surface Summary] <!-- Evaluator: Covered by contracts/lease-api.openapi.yaml §paths — LeaseGrant (acquire 201/200, renew 200), ReleaseResult (release 200), LeaseRegistry (registry 200), ForceReleaseResult (force-release 200); plan §API Surface Summary -->

- [X] CHK002 Is the acquire success split between 201 (a new seat consumed) and 200 (idempotent re-use of the original lease) unambiguous, including which fields differ and that `Location` is present on 201 and absent on 200? [Clarity, FR-014/SC-011] <!-- Evaluator: Covered by contract §/v1/leases 201/200 — Location required on 201 / absent on 200, and the 200 body notes id/holderKey/acquiredAt are the already-bound lease's while handle/expiresAt/lastRenewedAt/concurrencyUsed reflect current state -->

- [X] CHK003 Is the server-set expiry (`expiresAt`) plus TTL/heartbeat/grace guidance defined as part of every acquire and renew success body? [Completeness, FR-001/FR-007/FR-009] <!-- Evaluator: Resolved — made `graceSeconds` a required field of LeaseGrant (contract) so the full expiresAt + ttlSeconds/heartbeatIntervalSeconds/graceSeconds triad is present in every acquire/renew success body -->


## Refusal Paths & Error Envelope

- [X] CHK004 Does every refusal reason resolve to a distinct enumerated snake_case `code` in the `{code,message,details?}` envelope, with no two reasons collapsing to one code? [Completeness, contract §Error] <!-- Evaluator: Covered by contract §Error enum — each domain refusal has a distinct snake_case code; the shared HTTP-layer codes (forbidden/not_found/validation_error) are disambiguated by the per-code details discriminator, per platform convention (E008/E009/E013/E014) -->

- [X] CHK005 Is each domain refusal (no_concurrency_entitlement, license_not_active, seat_capacity_exhausted, lease_not_renewable, activation_required, signer_unavailable, rate_limited, CSRF/RBAC forbidden, cross-tenant not_found) mapped to a specific HTTP status? [Coverage, plan §Error Handling Strategy] <!-- Evaluator: Covered by plan §Error Handling Strategy table + contract §Error enum status annotations (403/409/503/429/403/404 respectively) -->

- [X] CHK006 Is the acquire `403` disambiguation between auth-scope `forbidden` (missing `lease` scope) and business `no_concurrency_entitlement` (absent `maxConcurrent`) specified so a reviewer can tell the two apart? [Clarity, FR-002/FR-005] <!-- Evaluator: Covered by contract §ForbiddenAcquire (two distinct codes) + §STATUS PRECEDENCE (auth 403 precedes 404; business no_concurrency_entitlement evaluated only after the license resolves) -->

- [X] CHK007 Is the `details` payload shape defined per error `code` (e.g. seat_capacity_exhausted → {maxConcurrent, concurrencyUsed, overageAllowance}; lease_not_renewable → {reason})? [Completeness, contract §Error] <!-- Evaluator: Covered by contract §Error.details description — enumerates the details shape per code -->

- [X] CHK008 Is soft-cap overage exhaustion given a specified refusal, and is the plan's "distinct overage reason" note reconciled with the contract reusing the same `seat_capacity_exhausted` code (distinguished only by `details`)? [Consistency, FR-012/plan §Error Handling Strategy] <!-- Evaluator: Resolved — reconciled to ONE truth: rewrote the plan §Error Handling Strategy overage row to a single `seat_capacity_exhausted` code distinguished by details {maxConcurrent, concurrencyUsed, overageAllowance} (removed the "+ distinct overage reason" wording); contract enum comment also clarified as one code for both cases -->

- [X] CHK009 Is the status-precedence order among authentication (401), authorization (403), resource resolution (404), and business rules (403/409) explicitly defined for ambiguous multi-failure cases? [Clarity, contract §STATUS PRECEDENCE] <!-- Evaluator: Covered by contract §STATUS PRECEDENCE — strict order 401 → 403(auth/RBAC/CSRF) → 404 → business 403/409 -->

- [X] CHK010 Does every non-2xx response across all five endpoints reference the shared `Error` schema rather than an ad-hoc shape? [Consistency, contract §responses] <!-- Evaluator: Covered by contract §components/responses — all reusable responses (BadRequest, Unauthorized, Forbidden*, *NotFound, AcquireConflict, LeaseNotRenewable, RateLimited, SignerUnavailable) schema: $ref Error -->


## Idempotency & Anti-Replay

- [X] CHK011 Is the acquire anti-replay token specified as a concrete named input (`acquireToken`), including whether it is carried in the request body or an HTTP header? [Clarity, FR-014] <!-- Evaluator: Covered by contract §AcquireLeaseRequest — `acquireToken` is a REQUIRED request-body field (schema §AcquireToken: high-entropy, single-use, never echoed) -->

- [X] CHK012 Is the token-replay path (same token → original lease at 200, no second seat) distinguished from the "holder already holds a live lease" idempotency path? [Clarity, FR-014/FR-023] <!-- Evaluator: Covered by contract §/v1/leases 200 response + §IDEMPOTENCY & ANTI-REPLAY — same acquireToken replay (FR-014) vs one-live-lease-per-(license,holderKey) re-use (FR-023) are stated as the two distinct 200 paths -->

- [X] CHK013 Is renew defined as idempotent — repeated heartbeats keep exactly one seat and only advance the expiry — with a defined 200 response? [Completeness, FR-007/SC-005] <!-- Evaluator: Covered by contract §/v1/leases/{leaseId}/renew 200 (LeaseGrant) + description "repeated heartbeats keep EXACTLY one seat and only advance expiresAt/lastRenewedAt" (FR-007, SC-005) -->

- [X] CHK014 Is release defined as an idempotent 200 no-op for live, already-ended, and unknown lease ids, returning a defined `ReleaseResult` that never drives the live count below zero? [Completeness, FR-008/SC-006] <!-- Evaluator: Covered by contract §/v1/leases/{leaseId}/release 200 (ReleaseResult) — idempotent for live/already-ended/unknown and never drives the count below zero (FR-008, SC-006) -->

- [X] CHK015 Is the release unknown/cross-tenant 200-no-op carve-out explicitly reconciled with SC-012's "cross-tenant reference resolves to not found", so the deviation from the 404 rule is unambiguous and justified as non-oracle? [Consistency, SC-012/FR-019] <!-- Evaluator: Covered by contract §TENANT SCOPING "SINGLE DELIBERATE EXCEPTION" + release description — unknown and cross-tenant produce the identical 200 no-op (frees nothing cross-tenant, not an enumeration oracle) -->

- [X] CHK016 Is the single-use replay-rejection window for `acquireToken` bounded and specified (duration or retention basis), not left merely "bounded"? [Measurability, FR-014] <!-- Evaluator: Covered by FR-014 — the token (nonce, UNIQUE (tenant_id, nonce)) is retained on the lease row for the row's RETENTION LIFETIME (mirroring E009's activation nonce), so a replay is rejected for the full retention window; a concrete retention basis, not merely "bounded" -->


## Authentication, Authorization & CSRF

- [X] CHK017 Is authentication documented per plane — runtime `X-API-Key` with the `lease` scope vs admin `admin_session` cookie — with each operation declaring exactly one scheme? [Completeness, FR-002/plan §API Surface Summary] <!-- Evaluator: Covered by contract §TWO AUTH PLANES + §securitySchemes (apiKey vs sessionCookie); each operation declares exactly one `security` scheme -->

- [X] CHK018 Is the fail-closed distinction between missing tenant context (401 unauthorized) and a resolvable key lacking the `lease` scope (403 forbidden) specified? [Clarity, FR-002] <!-- Evaluator: Covered by contract §securitySchemes apiKey + §STATUS PRECEDENCE + §ForbiddenScope; also SC-020 (missing/invalid key → 401, resolvable key without `lease` scope → 403) -->

- [X] CHK019 Is the admin RBAC requirement specified per admin operation (viewer or higher reads the registry; admin or higher force-releases)? [Completeness, FR-015/FR-016] <!-- Evaluator: Covered by contract §x-rbac — registry GET minRole viewer; force-release POST minRole admin (FR-015/016) -->

- [X] CHK020 Is the double-submit CSRF requirement on force-release specified as fail-closed 403 on missing/mismatch, recorded as a security event, and explicitly NOT required on the GET registry or the runtime plane? [Completeness, FR-016/SC-013] <!-- Evaluator: Covered by contract §parameters/CsrfToken + §Forbidden (csrf) + force-release op — required X-CSRF-Token, fail-closed 403 + security event, explicitly not on GET registry nor the /v1 runtime plane (FR-016, SC-013) -->

- [X] CHK021 Is the runtime `lease` capability scope defined as a NEW scope distinct from the existing E009 `activate` and E013 `validate` scopes? [Consistency, contract §securitySchemes] <!-- Evaluator: Covered by contract §securitySchemes/apiKey — "This is a NEW scope distinct from E009's `activate` and E013's `validate`" -->


## Rate Limiting & Retry

- [X] CHK022 Is rate limiting specified on all three runtime routes (acquire/renew/release), keyed per API key, refusing with `429 rate_limited` and auditing each limit-exceeded event? [Coverage, FR-017] <!-- Evaluator: Covered by contract §RateLimited "Covers the acquire, renew, and release runtime routes" (all three carry a 429 response) + info-block "rate-limited per API key" + audited limit-exceeded event (FR-017/018) -->

- [X] CHK023 Is the `Retry-After` header specified on 429 (and on 503 signer_unavailable) with its unit (seconds) defined? [Measurability, FR-017/contract §RateLimited] <!-- Evaluator: Covered by contract §RateLimited and §SignerUnavailable — both declare a `Retry-After` header, unit integer SECONDS (minimum 1) -->

- [X] CHK024 Is the relationship between the `Retry-After` header and the `details.retryAfterSeconds` value defined (must-match or independent)? [Clarity, contract §Error] <!-- Evaluator: Resolved — stated in the contract that `Retry-After` and `details.retryAfterSeconds` MUST AGREE (the same integer seconds); added to §Error.details, §RateLimited, and §SignerUnavailable descriptions + the Retry-After header schema notes -->

- [X] CHK025 Is the rate-limit threshold specified as a measurable/configurable value sized to legitimate heartbeat cadence, rather than left purely qualitative? [Measurability, FR-017] <!-- Evaluator: Covered by FR-017 — threshold "defined measurably and per-plan configurable as a burst multiple of the API key's expected aggregate (jittered) heartbeat request rate for the seats it serves (default >= 2x that rate)"; a concrete, measurable basis -->


## Request & Response Schemas

- [X] CHK026 Is the write-only `holderReference` specified as never stored, logged, or returned — appearing in no response or registry schema? [Coverage, FR-001/FR-020/SC-015] <!-- Evaluator: Covered by contract §HolderReference (writeOnly: true) + §SECRECY & PII INVARIANTS; absent from LeaseGrant, LeaseSummary, and the registry (FR-001/020, SC-015) -->

- [X] CHK027 Are the public signed `leaseHandle` and opaque `keyId` specified as returned only by acquire/renew, null in plain-authorization mode, absent from the registry, with the signing key never exposed? [Completeness, FR-022/SC-015] <!-- Evaluator: Covered by contract §LeaseGrant (leaseHandle + keyId nullable) + §SECRECY & PII INVARIANTS + §LeaseSummary (registry omits both); signing key never exposed (FR-022, SC-015) -->

- [X] CHK028 Is the acquire license reference constrained to exactly one of `licenseKey` or `licenseId` (mutually exclusive), with the 400 (malformed) vs 404 (unknown/cross-tenant) mapping defined? [Clarity, contract §AcquireLeaseRequest] <!-- Evaluator: Covered by contract §AcquireLeaseRequest (oneOf [licenseKey]/[licenseId]) + §LicenseKeyToken VALIDATION MAPPING — malformed → 400 validation_error, well-formed-but-unknown/cross-tenant → 404 license_not_found -->

- [X] CHK029 Is the `fingerprint` requirement conditioned on `machine` scope (400 if missing), and is the plan's concurrency scope discoverable by the client before a first acquire so it knows whether to supply one? [Completeness, FR-023/contract §Fingerprint] <!-- Evaluator: Resolved — added a SCOPE DISCOVERABILITY note to the contract §AcquireLeaseRequest.fingerprint: the per-plan `scope` is provisioned OUT-OF-BAND with the API key (client is told at onboarding) so a machine-scope client sends a fingerprint before its first acquire; as a fail-safe a missing fingerprint under machine scope returns the distinct 400 validation_error so the client can also learn+retry -->

- [X] CHK030 Is the renew request-body shape defined (optional, empty object accepted) and the release request specified as taking no body? [Completeness, contract §RenewLeaseRequest] <!-- Evaluator: Covered by contract §RenewLeaseRequest (empty object, additionalProperties false; requestBody required: false, `{}` accepted) + §release op (no requestBody) -->

- [X] CHK031 Are timestamp fields (`acquiredAt`/`lastRenewedAt`/`expiresAt`) specified with a concrete format and timezone (RFC3339/UTC) rather than left ambiguous? [Measurability, contract §LeaseGrant] <!-- Evaluator: Resolved — added a TIMESTAMPS note to the contract info block mandating every timestamp field (acquiredAt/lastRenewedAt/expiresAt) is a server-computed RFC 3339 / ISO 8601 date-time in UTC with a trailing `Z` offset (never local-offset/offset-naive); complements the existing `format: date-time` on LeaseGrant/LeaseSummary -->


## Registry Listing, Ordering & Truncation

- [X] CHK032 Is the registry list bounded (hard cap 1000) with a `truncated` signal and no offset/cursor pagination, and is the ordering deterministic (acquiredAt DESC, ties broken by id)? [Completeness, FR-015/contract §LeaseRegistry] <!-- Evaluator: Covered by contract §LeaseRegistry — maxItems 1000, `truncated` signal, "not paginated", ordered by acquiredAt DESCENDING with ties broken by id -->

- [X] CHK033 Is `concurrencyUsed` specified as computed independently of the (possibly truncated) list, so the used-vs-cap summary never understates true live usage? [Clarity, FR-003/FR-015] <!-- Evaluator: Covered by contract §LeaseRegistry.concurrencyUsed — "Computed independently of the (possibly truncated) list, so it never understates true usage" -->

- [X] CHK034 Is the optional `?status` filter enumerated (live|released|reclaimed) with its default (all statuses) specified? [Completeness, contract §LeaseStatusFilter] <!-- Evaluator: Covered by contract §parameters/LeaseStatusFilter — enum [live, released, reclaimed], "Omit to return all statuses" -->


## Cross-Artifact Consistency & Versioning

- [X] CHK035 Are all five endpoints' methods and paths consistent between the plan API Surface Summary and the OpenAPI `paths`? [Consistency, plan §API Surface Summary] <!-- Evaluator: Covered — plan §API Surface Summary and contract §paths agree exactly: POST /v1/leases, POST /v1/leases/{leaseId}/renew, POST /v1/leases/{leaseId}/release, GET /admin/licenses/{licenseId}/leases, POST /admin/leases/{leaseId}/force-release -->

- [X] CHK036 Is wire field naming uniformly camelCase with a documented mapping to the data-model's snake_case columns (max_concurrent↔maxConcurrent, holder_key↔holderKey, expires_at↔expiresAt)? [Consistency, contract §ERROR MODEL] <!-- Evaluator: Covered by contract §ERROR MODEL — "Field naming is camelCase throughout the bodies (the data-model's snake_case columns — e.g. max_concurrent, holder_key, expires_at — map to camelCase wire fields)" -->

- [X] CHK037 Is API versioning specified (runtime `/v1`, admin unversioned `/admin`, breaking change → `/v2`) and the media type fixed to application/json with non-JSON → 400 validation_error? [Completeness, contract §VERSIONING] <!-- Evaluator: Covered by contract §VERSIONING (runtime /v1, admin unversioned /admin, breaking → /v2) + §MEDIA TYPE (application/json only; non-JSON → 400 validation_error) -->

- [X] CHK038 Are the two distinct 404 codes (`license_not_found` on acquire vs `not_found` on renew/registry/force-release) intentional and reconciled with the plan's single "404 not found" row? [Consistency, plan §Error Handling Strategy] <!-- Evaluator: Resolved — rewrote the plan §Error Handling Strategy 404 row to enumerate BOTH codes (license_not_found on acquire; not_found on renew/registry/force-release), noting the cross-tenant-resolves-here rule and the release-route idempotent-200 carve-out; matches contract §Error enum + LicenseNotFound/LeaseNotFound/NotFound responses -->


## Requirement Traceability

- [X] CHK039 Does every FR with an API surface (FR-001..FR-008, FR-012..FR-017, FR-019, FR-022..FR-025) map to a specific endpoint, schema, or error code in the contract? [Traceability, plan §Requirement Coverage Map] <!-- Evaluator: Covered — plan §Requirement Coverage Map maps each FR to components/files, and the contract cites each listed FR against a concrete endpoint/schema/error code (e.g. FR-004/012→seat_capacity_exhausted, FR-014→acquireToken, FR-022→leaseHandle, FR-023→ConcurrencyScope/Fingerprint, FR-025→activation_required) -->

- [X] CHK040 Does each enumerated error `code` cite the FR/SC it enforces, so every refusal traces back to a requirement? [Traceability, contract §Error] <!-- Evaluator: Resolved — added FR/SC citations to the contract §Error enum comments that lacked them (validation_error→FR-023/§MEDIA TYPE, unauthorized→FR-002/SC-020, forbidden→FR-002/015/016 SC-010/013/020, license_not_found & not_found→FR-019/SC-012, signer_unavailable→FR-022/SC-021), so every code now traces to a requirement -->

