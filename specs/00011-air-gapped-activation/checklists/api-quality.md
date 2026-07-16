# API Quality Checklist: Air-Gapped Activation (E010)
**Created**: 2026-07-15 | **Feature**: [spec.md](../spec.md)

## Endpoint & Message Schema Completeness

- [X] CHK001 Is the single portal endpoint (POST `/v1/air-gap/activations`, its operationId, and that it is the ONLY in-scope wire surface) specified unambiguously? [Completeness, contract §paths /v1/air-gap/activations] <!-- Evaluator: Covered by contract §paths /v1/air-gap/activations (operationId processAirGapActivation) + info TWO-TRANSPORT MODEL / OUT OF SCOPE -->

- [X] CHK002 Are the request-body schema `AirGapActivateRequest` and its required field (`requestFile`) fully enumerated with type and constraints? [Completeness, contract §AirGapActivateRequest] <!-- Evaluator: Covered by contract §AirGapActivateRequest (additionalProperties:false, required requestFile → RequestFile string with min/maxLength+pattern) -->

- [X] CHK003 Are the success-body schema `AirGapActivateResult` and its required fields (`responseFile`, `created`) fully specified, including that `responseFile` is present on BOTH new and replay outcomes? [Completeness, contract §AirGapActivateResult] <!-- Evaluator: Covered by contract §AirGapActivateResult (required [responseFile, created]; BOTH outcomes include responseFile) -->

- [X] CHK004 Is the strictness of the request and result bodies (`additionalProperties: false` — no undocumented fields) stated intentionally so a reviewer can confirm no field is silently accepted? [Clarity, contract §AirGapActivateRequest/AirGapActivateResult] <!-- Evaluator: Covered by contract §AirGapActivateRequest + §AirGapActivateResult (both additionalProperties:false) -->


## Envelope Fields & Wire Encoding

- [X] CHK005 Are ALL logical fields of the request-file envelope (`formatVersion`, `licenseKey`|`licenseId`, `fingerprint.signals`, `nonce`, `producedAt`, optional `label`) each documented with type, required/optional status, and constraints? [Completeness, contract §RequestFileEnvelope] <!-- Evaluator: Covered by contract §RequestFileEnvelope (all logical fields typed with required/optional + constraints) -->

- [X] CHK006 Are ALL logical fields of the response-file envelope (`formatVersion`, `activationId`, `machineBoundKey`, `keyId`, `expiresAt`, `machineId`) each documented with type and required/optional status? [Completeness, contract §ResponseFileEnvelope] <!-- Evaluator: Covered by contract §ResponseFileEnvelope (all six fields required + typed) -->

- [X] CHK007 Is the mutually-exclusive license reference (exactly one of `licenseKey` or `licenseId`) specified unambiguously (oneOf), so a both-present or neither-present file has a defined outcome? [Clarity, contract §RequestFileEnvelope oneOf] <!-- Evaluator: Covered by contract §RequestFileEnvelope oneOf (required licenseKey / required licenseId) -->

- [X] CHK008 Is the on-wire representation of both files stated explicitly as an opaque base64url STRING inside a JSON body (with the decoded envelopes documentation-only, NOT the wire schema)? [Clarity, contract §RequestFile / §ResponseFile] <!-- Evaluator: Covered by contract §RequestFile/§ResponseFile (opaque base64url string) + info MEDIA TYPE + envelopes flagged documentation-only -->

- [X] CHK009 Is the base64url character/format constraint (the string `pattern`) defined so a reviewer can distinguish a non-decodable file (`validation_error`) from a decodable-but-unsupported one? [Measurability, contract §RequestFile pattern] <!-- Evaluator: Covered by contract §RequestFile pattern '^[A-Za-z0-9_-]+$' + info FILE FORMAT VERSIONING (validation_error vs unknown_format_version) -->

- [X] CHK010 Is the salted per-signal hash format (`SignalHash`, no raw hardware identifiers) specified concretely enough that the PII invariant is verifiable from the schema? [Traceability, FR-010 / contract §SignalHash] <!-- Evaluator: Covered by contract §SignalHash (base64url 32-byte digest, pattern; no raw identifiers) + FR-010 -->


## Status Semantics: Always-200 + `created`

- [X] CHK011 Is the always-`200`-on-success (never `201`) decision stated WITH its rationale for departing from E009's `201`/`200`, so the deviation is deliberate and reviewable? [Clarity, plan §AD-007 / contract info "ONE STATUS FOR BOTH"] <!-- Evaluator: Covered by plan §AD-007 + contract info ONE STATUS FOR BOTH (file-exchange transaction rationale) -->

- [X] CHK012 Is the meaning of `created: true` (new seat consumed) versus `created: false` (idempotent replay) defined unambiguously? [Clarity, FR-005 / contract §AirGapActivateResult.created] <!-- Evaluator: Covered by contract §AirGapActivateResult.created + FR-005 -->

- [X] CHK013 Is an idempotent replay explicitly defined as a SUCCESS outcome (not an error), consistent with FR-005? [Consistency, FR-005 / contract info "ONE STATUS FOR BOTH"] <!-- Evaluator: Covered by contract info ONE STATUS FOR BOTH ("A replay is a successful, expected outcome — never an error") + FR-005 -->

- [X] CHK014 Is the absence of a `Location` header / caller-addressable resource URL explicitly justified for this file-exchange transaction? [Clarity, plan §AD-007 / contract info] <!-- Evaluator: Covered by plan §AD-007 + contract info ONE STATUS FOR BOTH (no server-side resource URL to follow → no Location/201) -->

- [X] CHK015 Is the FR-003 "indistinguishable from an online activation" requirement reconciled with the deliberately DIFFERENT `200`+`created` response shape (vs online `201`/`200`), so the two are not read as contradictory? [Consistency, FR-003 / plan §AD-007] <!-- Evaluator: Covered by FR-003 (scopes "indistinguishable" to seat count + registry) + contract info SHARED E009 SEAT ACCOUNTING vs ONE STATUS FOR BOTH + plan AD-007 (wire shape differs because it is a file-exchange transaction) -->


## Error Model Completeness & Distinctness

- [X] CHK016 Is every refusal reason mapped to a distinct, enumerated snake_case `code` (validation_error, unknown_format_version, stale_request, insufficient_signals, unauthorized, forbidden, license_not_found, seat_limit_reached, nonce_replayed, license_not_active, rate_limited, signer_unavailable)? [Completeness, contract §Error.code enum] <!-- Evaluator: Covered by contract §Error.code enum (all 12 codes enumerated with per-code status comments) -->

- [X] CHK017 Is each error `code` bound to exactly one HTTP status (400/401/403/404/409/429/503) with no code spanning statuses? [Consistency, contract §Error / §responses] <!-- Evaluator: Covered by contract §Error.code enum comments (one status per code) + §responses mapping -->

- [X] CHK018 Are `validation_error` (undecodable/malformed file) and `unknown_format_version` (decodable but unsupported version) differentiated distinctly and testably? [Clarity, FR-007 / contract §400] <!-- Evaluator: Covered by contract info FILE FORMAT VERSIONING + §400 examples (malformedFile vs unknownFormatVersion) -->

- [X] CHK019 Is the `details` object shape defined for EACH code that carries one (e.g. `unknown_format_version → {formatVersion}`, `stale_request → {producedAt, maxAgeSeconds}`, `seat_limit_reached → {seatLimit, seatsUsed}`, `insufficient_signals → {signalsProvided, signalsRequired}`)? [Completeness, contract §Error.details] <!-- Evaluator: Resolved — the four listed shapes were present; added the validation_error oversize variant `{ reason: "oversize" }` (FR-019) to contract §Error.details so every code's details shape is centrally documented -->

- [X] CHK020 Are the three `409` conditions (seat_limit_reached, nonce_replayed, license_not_active) each given a distinct code and details shape rather than a shared generic conflict code? [Clarity, FR-004/005/009 / contract §409] <!-- Evaluator: Covered by contract §409 (three distinct codes, each with a details example) + §Error.details shapes -->

- [X] CHK021 Is the status-precedence order (401 → 403 → 429 → 400/404/409) specified so an outcome is deterministic when more than one failure could apply? [Measurability, contract info "STATUS PRECEDENCE"] <!-- Evaluator: Covered by contract info STATUS PRECEDENCE (strict order 401→403→429→400/404/409) -->

- [X] CHK022 Is it specified that no error body ever echoes the nonce, fingerprint values, a raw hardware identifier, or key material? [Coverage, FR-010 / contract §Error] <!-- Evaluator: Covered by contract §Error/§Error.message/§Error.details ("never a raw identifier, key material, token, or nonce") + info AUDIT ("never the nonce or fingerprint values") -->

- [X] CHK023 Is the cross-tenant reference outcome fixed to `404 license_not_found` (never `403`), so tenant existence is not disclosed and the code is consistent with FR-011? [Consistency, FR-011 / contract §LicenseNotFound] <!-- Evaluator: Covered by contract §LicenseNotFound + info TENANT SCOPING ("resolves to 404 ... never 403") + FR-011 -->


## File-Format Versioning & Negotiation

- [X] CHK024 Is it required that BOTH the request file AND the response file carry an explicit `formatVersion`? [Completeness, FR-014 / contract §RequestFileEnvelope / §ResponseFileEnvelope] <!-- Evaluator: Covered by contract §RequestFileEnvelope.formatVersion (required) + §ResponseFileEnvelope.formatVersion (required) + FR-014 -->

- [X] CHK025 Is the rejection contract for an unknown/future request format version fully defined (`400 unknown_format_version` with `{formatVersion}` details), covering FR-001/007/014? [Coverage, FR-001/007/014 / contract §400] <!-- Evaluator: Covered by contract §400 unknownFormatVersion example (details {formatVersion}) + §Error.details -->

- [X] CHK026 Is "cross-version mismatch" (FR-014) defined precisely enough to test, and is it distinguishable from a merely unknown/future version? [Clarity, FR-014] <!-- Evaluator: Resolved — added a FILE FORMAT VERSIONING clause to the contract stating a cross-version mismatch (any unsupported/future/retired/incompatible request formatVersion) is uniformly refused unknown_format_version (no separate code; testably distinct only from validation_error), and a supported version always yields the current response formatVersion (FR-014) -->

- [X] CHK027 Is the file `formatVersion` axis explicitly distinguished from the HTTP `/v1` API-version axis so the two are not conflated? [Clarity, contract info "VERSIONING"] <!-- Evaluator: Covered by contract info VERSIONING ("independent of the request/response FILE formatVersion") -->


## Auth, Rate-Limit & Transport

- [X] CHK028 Are the credential and required scope (the `X-API-Key` header + `activate` scope) specified, including the fail-closed `401` (no tenant) vs `403` (missing scope) distinction? [Completeness, FR-002 / contract §securitySchemes] <!-- Evaluator: Covered by contract §securitySchemes apiKey + x-rbac.requiredScope activate + info SINGLE AUTH PLANE (401 no tenant / 403 missing scope) + FR-002 -->

- [X] CHK029 Is the no-CSRF posture for this header-credential runtime plane stated explicitly (vs the console cookie plane that this contract does not touch)? [Clarity, contract info "SINGLE AUTH PLANE"] <!-- Evaluator: Covered by contract info SINGLE AUTH PLANE ("There is NO CSRF on this plane ... CSRF applies only to the /admin console plane") -->

- [X] CHK030 Is the rate-limit response fully specified (`429 rate_limited`, `Retry-After` header, `retryAfterSeconds` detail, throttled attempt audited)? [Completeness, FR-013 / SC-012 / contract §RateLimited] <!-- Evaluator: Covered by contract §RateLimited (Retry-After header + details.retryAfterSeconds + audited) + FR-013/SC-012 -->

- [X] CHK031 Is the media/content type of every request and response body stated (`application/json`, UTF-8, no content negotiation)? [Clarity, contract info "MEDIA TYPE"] <!-- Evaluator: Covered by contract info MEDIA TYPE (application/json UTF-8, no content negotiation; file envelopes travel as base64url strings inside the JSON — no multipart) -->

- [X] CHK032 Is the rate-limit evaluation point (before the body is parsed, keyed per API key) specified clearly enough to be verified against the status-precedence rules? [Measurability, FR-013 / contract info "SINGLE AUTH PLANE"] <!-- Evaluator: Covered by contract info SINGLE AUTH PLANE ("keyed per API key, the limiter runs before the body is parsed") + STATUS PRECEDENCE (429 before 400/404/409) -->


## Payload Limits & Field Boundaries

- [X] CHK033 Is a maximum payload / file-string size specified for BOTH `requestFile` and `responseFile` (e.g. an explicit `maxLength`), so an oversize submission has a defined outcome? [Completeness, contract §RequestFile / §ResponseFile maxLength] <!-- Evaluator: Covered by contract §RequestFile/§ResponseFile maxLength (16384) + oversize outcome (validation_error, details.reason=oversize) per FR-019 / §RequestFile description -->

- [X] CHK034 Are the envelope field boundaries quantified and testable (nonce entropy/min-max length, `signals` min/max item count and uniqueness, `label` max length)? [Measurability, contract §RequestFileEnvelope] <!-- Evaluator: Covered by contract §RequestFileEnvelope (nonce minLength 16/maxLength 200/>=128-bit; signals minItems 1/maxItems 32/uniqueItems; label maxLength 200) + FR-020 -->


## Idempotency, Replay & Freshness

- [X] CHK035 Is it explicit that an idempotent replay returns the ORIGINAL response file (byte-identical) and consumes no additional seat? [Clarity, FR-005 / SC-005 / contract §AirGapActivateResult] <!-- Evaluator: Resolved — amended contract §AirGapActivateResult (description + created field) to state a replay returns the BYTE-IDENTICAL original response file (deterministic re-packaging of the original machine-bound credential) with no additional seat (FR-005, SC-005) -->

- [X] CHK036 Is the idempotency key (the single-use `nonce`) and the distinction between a benign replay (`created:false`) and a nonce reused to forge a different activation (`nonce_replayed`) defined unambiguously? [Clarity, FR-005 / contract §RequestFileEnvelope.nonce] <!-- Evaluator: Covered by contract §RequestFileEnvelope.nonce (idempotent replay vs nonce_replayed for a different activation) + info ONE STATUS FOR BOTH + FR-005 -->

- [X] CHK037 Is the freshness window (`producedAt` vs `maxAgeSeconds` → `stale_request`) quantified, and is its relationship to the nonce lifetime / idempotency window specified so a stale-but-replayable case is not ambiguous? [Measurability, FR-008 / plan §AD-005] <!-- Evaluator: Resolved — amended contract §400 stale_request to quantify the window (default 604800s/7d, FR-020) and state that freshness gates only the FIRST processing; an already-processed request (nonce on record via the activation) replays regardless of age (FR-021), so freshness and idempotent-replay cannot contradict -->


## Spec-Plan-Contract Traceability & Scope

- [X] CHK038 Does every FR-001..014 map to a documented request/response/error behavior in the contract, matching the plan's Requirement Coverage Map? [Traceability, plan §Requirement Coverage Map] <!-- Evaluator: Covered by plan §Requirement Coverage Map (FR-001..014) + contract per-behavior FR references -->

- [X] CHK039 Does the contract match plan.md's API Surface Summary exactly (path, auth+scope, req/res types, and the full enumerated error set)? [Consistency, plan §API Surface Summary] <!-- Evaluator: Covered by plan §API Surface Summary — path, API key + activate scope, AirGapActivateRequest→200 AirGapActivateResult, and the full 400/401/403/404/409/429/503 error set all match the contract -->

- [X] CHK040 Is FR-015 (console upload/download) explicitly confirmed as P2/DEFERRED and OUT of this contract, with no `/admin` route modeled? [Coverage, FR-015 / contract info "OUT OF SCOPE"] <!-- Evaluator: Covered by contract info OUT OF SCOPE (P2 console variant not modeled; no /admin route) + plan §Requirement Coverage Map FR-015 [DEFERRED] P2 -->

