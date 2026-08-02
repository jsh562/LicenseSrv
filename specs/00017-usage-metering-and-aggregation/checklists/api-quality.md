# API Quality Checklist: Usage Metering & Aggregation (E016)
**Created**: 2026-08-02 | **Feature**: [spec.md](../spec.md)

## Ingest Contract Completeness

- [X] CHK001 Are the TWO distinct refusal vocabularies — top-level HTTP `Error.code` and the per-event `PerEventRejectionCode` — each enumerated in full, with the boundary between them stated so no code is left implicitly shared? [Completeness, openapi Error / PerEventRejectionCode; plan API Surface Summary] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §Error.code + §PerEventRejectionCode (each fully enumerated; boundary stated in both descriptions + ERROR MODEL note) -->

- [X] CHK002 Is every top-level `Error.code` value (validation_error, batch_too_large, unauthorized, unauthenticated, forbidden, not_found, rate_limited) bound to a specific HTTP status AND a specific plane (ingest vs query)? [Completeness, openapi Error.code] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §Error.code enum inline comments (each code annotated with HTTP status + plane; window_too_large added as 400/query) -->

- [X] CHK003 Is every `PerEventRejectionCode` (not_found, not_metered, archived, stale_event, future_event, validation_error) defined with a distinct triggering condition traceable to an FR? [Completeness, FR-004/FR-006/FR-016; openapi PerEventRejectionCode] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §PerEventRejectionCode (each code + license_inactive mapped to FR-004/006/016/017/021) -->

- [X] CHK004 Is the per-batch summary shape `{accepted, duplicate, rejected[{index,code,message}]}` fully specified, including the invariant that accepted + duplicate + rejected.length equals the request event count? [Completeness, FR-007; openapi IngestSummary] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §IngestSummary + §RejectedEvent (invariant "accepted + duplicate + rejected.length equals the number of events" stated) -->

- [X] CHK005 Is a duplicate's reporting path specified as counted in `duplicate` (NOT in `rejected[]`) and accruing nothing? [Clarity, FR-002; openapi IngestSummary/PerEventRejectionCode] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §IngestSummary.duplicate + §PerEventRejectionCode ("A DUPLICATE is NOT a rejection — counted in duplicate and accrues nothing") -->

- [X] CHK006 Is "a single bad event never fails the whole batch" stated unambiguously and identically across FR-007, AD-008, and the OpenAPI description? [Clarity, FR-007/AD-008] <!-- Evaluator: Covered by spec.md FR-007 + plan AD-008 + contracts/usage-api.openapi.yaml (PER-EVENT BATCH SEMANTICS: "a SINGLE BAD EVENT NEVER FAILS THE WHOLE BATCH") — consistent across all three -->

- [X] CHK007 Is the `UsageEvent` request schema complete — required licenseId, entitlementId, source, eventId, eventTime, signed quantity, optional dimensions — with `additionalProperties` disallowed? [Completeness, FR-002; openapi UsageEvent] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §UsageEvent (additionalProperties:false; required [licenseId,entitlementId,source,eventId,eventTime,quantity]; dimensions optional) -->

- [X] CHK008 Is the signed `quantity` semantics (negative = reference-free reversal that does not cite an original event id) fully specified on the wire? [Clarity, FR-013; openapi UsageEvent.quantity] <!-- Evaluator: Covered by contracts/usage-api.openapi.yaml §UsageEvent.quantity ("A NEGATIVE value is a reference-free REVERSAL/correction ... does not reference an original event") -->

- [X] CHK009 Is the per-aggregation quantity validation — rejecting a non-1 / non-integer quantity for COUNT / UNIQUE_COUNT — specified as a per-event `validation_error`, or is it left as an unspecified contract gap? [Completeness, FR-008; plan HINT-002] <!-- Evaluator: Covered by plan HINT-002 (PINNED per-aggregation quantity rules → per-event validation_error) + contracts §PerEventRejectionCode ("malformed per-aggregation quantity (e.g. non-integer COUNT or negative UNIQUE_COUNT)") -->

- [X] CHK010 Is the behavior of a negative/reversal quantity against a COUNT vs a UNIQUE_COUNT meter (decrement vs disallowed for a monotonic distinct set) defined at the contract level? [Completeness, FR-013; plan HINT-002] <!-- Evaluator: Covered by spec.md FR-013 + plan HINT-002 (COUNT -1 decrements the count; UNIQUE_COUNT distinct set MONOTONIC, reversal cannot retract → negative UNIQUE_COUNT rejected validation_error) -->


## Idempotency & Ack Semantics

- [X] CHK011 Is the idempotency wire contract — dedupe key `(tenant, source, eventId)`, replay = no-op `duplicate` — fully specified including the independent-producer cross-source non-collision rule? [Completeness, FR-002; openapi UsageEvent] <!-- Evaluator: Covered by contracts §UsageEvent.source/eventId + IDEMPOTENT INGEST note (unique (tenant,source,eventId); independent producers under distinct source never collide; replay → duplicate no-op) -->

- [X] CHK012 Is the bounded-dedupe consequence (a re-report after the key is pruned is a FRESH accrual, not a duplicate) documented as an API-visible behavior? [Clarity, FR-015; openapi eventId] <!-- Evaluator: Covered by contracts §UsageEvent.eventId ("Dedupe guaranteed only within the retention window (~35d); a re-report after the key is pruned is a fresh accrual, FR-015") -->

- [X] CHK013 Is the 200-sync vs 202-decoupled ack specified as a DETERMINISTIC per-deployment mode (not per-request), returning an identical summary body either way? [Clarity, FR-005; openapi 200/202] <!-- Evaluator: Covered by contracts §ingestUsage 200/202 responses + description ("200 vs 202 is a DETERMINISTIC per-deployment mode (not per request) ... Same summary body either way") -->

- [X] CHK014 Is it specified that a client treats both 200 and 202 as success, and how "accrual committed inline" vs "durably appended, rollup deferred" is signaled? [Clarity, openapi 202] <!-- Evaluator: Covered by contracts §ingestUsage 200 ("accrual committed inline") + 202 ("durably appended + accepted, rollup deferred; client treats both 200 and 202 as success") -->

- [X] CHK015 Is the fast-ack (accept-then-aggregate) contract stated so a caller understands accrual may be asynchronous and the summary is not a rollup confirmation? [Completeness, FR-005] <!-- Evaluator: Covered by contracts §ingestUsage description ("FAST-ACKS (accept-then-aggregate) ... the rollup is asynchronous") + 202 (rollup deferred); spec FR-005 -->


## Auth, Rate Limiting & Tenant Scoping

- [X] CHK016 Is the ingest-plane auth requirement — `usage.ingest` scope, fail-closed 401 `unauthorized` (no tenant) vs 403 `forbidden` (resolvable key missing scope) — unambiguously distinguished? [Clarity, FR-001/SC-016; openapi apiKey] <!-- Evaluator: Covered by contracts §apiKey securityScheme + RUNTIME plane note ("no resolvable tenant → 401 unauthorized; resolvable key lacking usage.ingest → 403 forbidden") -->

- [X] CHK017 Is the console query-plane auth (admin_session cookie + RBAC viewer-or-higher) specified distinctly from the ingest plane, with `unauthenticated` vs `forbidden` codes? [Completeness, plan API Surface; openapi sessionCookie] <!-- Evaluator: Covered by contracts §sessionCookie + OPERATOR plane note (admin_session cookie + RBAC viewer-or-higher) + Error.code unauthenticated (401 query) vs forbidden (403 RBAC deny) -->

- [X] CHK018 Is the `usage.ingest` scope's tenant- and license-binding, and its distinctness from activate/validate/lease scopes, specified? [Completeness, FR-001; openapi apiKey] <!-- Evaluator: Covered by contracts §apiKey ("tenant- AND license-bound ... DISTINCT from E009 activate, E013 validate, and E015 lease ... independently revocable") -->

- [X] CHK019 Is the rate-limit contract complete (per-API-key, 429 `rate_limited`, `Retry-After` header) and does it REQUIRE the header to equal `details.retryAfterSeconds` (same integer, never disagreeing)? [Consistency, FR-005; openapi RateLimited] <!-- Evaluator: Covered by contracts §RateLimited response ("Retry-After ... MUST equal details.retryAfterSeconds (the SAME integer seconds — header and body never disagree)") + Error.details -->

- [X] CHK020 Is the maximum batch size (default 1,000, configurable) specified as an over-cap 400 `batch_too_large` refused BEFORE any accrual, with `{max, size}` details? [Completeness, FR-005; openapi IngestBadRequest] <!-- Evaluator: Covered by contracts §IngestBadRequest + §IngestUsageRequest (cap 1000, over-cap → 400 batch_too_large "rejected BEFORE any accrual", details {max,size}) -->

- [X] CHK021 Is cross-tenant resolution specified as not-found on BOTH planes — per-event `not_found` on ingest and `404 not_found` (never 403) on query — so an out-of-tenant id is indistinguishable from a missing one? [Consistency, FR-017/SC-012; openapi Error/LicenseNotFound] <!-- Evaluator: Covered by contracts §TENANT SCOPING ("per-event not_found on ingest, and 404 not_found on the query route (never 403)") + §LicenseNotFound + §PerEventRejectionCode.not_found -->


## Request Body, Secrecy & PII

- [X] CHK022 Is the `dimensions` map constrained by an explicit server-side allow-list (bounded key set, scalar-only values, size/count caps) with a violation surfaced as a per-event `validation_error`? [Completeness, FR-016/SC-013; openapi Dimensions] <!-- Evaluator: Covered by contracts §Dimensions (additionalProperties scalar-only oneOf, maxLength 256, maxProperties 16; server allow-list; violation → per-event validation_error) + FR-016 -->

- [X] CHK023 Is the no-secret rule stated for every request/response body, log, and audit entry (no secret, API key, or signing key ever carried)? [Completeness, FR-019; openapi Error/IngestSummary] <!-- Evaluator: Covered by contracts §SECRECY & PII INVARIANTS + §AUDIT + Error.message/details ("never a secret, API key, signing key, or card/PAN data") + FR-019 -->

- [X] CHK024 Is it specified that no card/PAN/CVV or PII beyond license/entitlement/dimension references appears in any usage field? [Completeness, FR-016/FR-020; openapi UsageEvent] <!-- Evaluator: Covered by contracts §SECRECY & PII INVARIANTS ("NO card/PAN/CVV/expiry ... no PII beyond those references") + §UsageEvent + FR-016/FR-020 -->

- [X] CHK025 Are all timestamps (event `eventTime`, query `from`/`to`) required to be RFC3339 / ISO 8601 UTC with a trailing `Z` (offset-aware, never local, never offset-naive)? [Clarity, FR-004; openapi Timestamps note] <!-- Evaluator: Covered by contracts §TIMESTAMPS note ("RFC 3339 / ISO 8601 in UTC with a trailing Z ... never a local offset and never offset-naive") + §UsageEvent.eventTime + §FromQuery/§ToQuery -->


## Query Surface

- [X] CHK026 Is the query window contract complete — required `from` (inclusive) / `to` (exclusive), with an inverted or malformed window → 400 `validation_error`? [Completeness, FR-011; openapi FromQuery/ToQuery] <!-- Evaluator: Covered by contracts §FromQuery (required, inclusive) + §ToQuery (required, exclusive, "MUST be after from; inverted or malformed → 400 validation_error") + §QueryBadRequest -->

- [X] CHK027 Is a maximum query window size (or a bucket-count bound) specified, or is the window left unbounded — a missing constraint on an expensive aggregate query? [Completeness, openapi FromQuery/ToQuery] <!-- Evaluator: Resolved — added a bounded max window/bucket-count to contracts/usage-api.openapi.yaml: new Error.code `window_too_large` (400, query, details {maxHours,hours}), §ToQuery span bound, getLicenseUsage refusal list, §QueryBadRequest windowTooLarge example; mirrored in plan Error Handling Strategy row -->

- [X] CHK028 Is the optional `entitlementId` narrowing specified, including that a cross-tenant/unknown id yields an EMPTY result (never leaks existence)? [Clarity, FR-017; openapi EntitlementIdQuery] <!-- Evaluator: Covered by contracts §EntitlementIdQuery ("A cross-tenant/unknown id yields an empty result (never leaks existence)") -->

- [X] CHK029 Is the `bucket` grouping (hour/day/period) fully specified, including the omitted-bucket single-window-total case and `period` alignment being applied at read (E014), not stored? [Completeness, FR-010; openapi BucketQuery] <!-- Evaluator: Covered by contracts §BucketQuery (hour/day/period; "Omit for a single window total per entitlement (no buckets[])"; period billing-alignment "applied at read, not stored") -->

- [X] CHK030 Is the floor-at-zero display vs `raw=true` true-signed-net distinction fully specified, including that `raw` is exactly what E014 true-up consumes and never mutates storage? [Clarity, FR-013/FR-020/SC-017; openapi RawQuery] <!-- Evaluator: Covered by contracts §RawQuery + §REVERSALS + FLOOR-AT-ZERO ("max(0,net) display vs TRUE SIGNED NET that E014 true-up consumes ... Never changes the underlying stored aggregate") -->

- [X] CHK031 Is authorization for `raw=true` (true-net) access specified — who may read the un-floored value — or is raw access left ambiguous relative to the `viewer` role? [Completeness, FR-020; openapi RawQuery] <!-- Evaluator: Covered by contracts §RawQuery ("raw=true BOUNDED to an ELEVATED role: requires admin or higher; a plain viewer requesting raw=true is refused 403 forbidden") + FR-020/SC-019 -->

- [X] CHK032 Is the app self-read path (a licensed app reading its OWN license aggregate via the runtime plane) defined as a contract, or left as an undocumented internal read? [Completeness, FR-011; openapi App self-read note] <!-- Evaluator: Resolved — disambiguated the APP SELF-READ + E014 note in contracts/usage-api.openapi.yaml as an INTERNAL-ONLY read path (own license, true-net direct from usage_rollup), explicitly NOT a wire operation, NOT on the /admin session plane, and NOT using the console raw=true parameter; the /admin route is the sole externally-specified query surface -->

- [X] CHK033 Is deterministic ordering (entitlements by `entitlementId`, buckets by ascending `bucketStart`) and the non-paginated hard cap of 1000 with a `truncated` signal fully specified? [Completeness, FR-011; openapi UsageQueryResult] <!-- Evaluator: Covered by contracts §UsageQueryResult (ordered by entitlementId, maxItems 1000, truncated) + §UsageBucket (ascending bucketStart) + §UsageEntitlementAggregate.buckets -->

- [X] CHK034 Is the reproducibility requirement (an identical query over an unchanged window returns identical totals) stated as a binding API contract obligation? [Testability, FR-011/SC-004] <!-- Evaluator: Covered by contracts §REPRODUCIBLE AGGREGATE + getLicenseUsage description ("REPRODUCIBLE — an identical query over an unchanged window returns IDENTICAL totals") + §UsageEntitlementAggregate; spec SC-004 -->

- [X] CHK035 Is the over-quota signal contract (`overQuota` flag, echoed `allowance`, never blocks ingestion, always `false` when allowance is null) specified in the query response? [Completeness, FR-014; openapi UsageEntitlementAggregate] <!-- Evaluator: Covered by contracts §UsageEntitlementAggregate.overQuota/allowance ("SIGNAL ... never blocks ingestion; Always false when allowance is null") + §OPTIONAL QUOTA SIGNAL -->


## Cross-Artifact Consistency & Testability

- [X] CHK036 Are wire field names consistent (camelCase bodies mapping to snake_case columns) across the spec FRs, the plan API Surface Summary, and the OpenAPI file? [Consistency, plan API Surface; openapi error-model note] <!-- Evaluator: Covered by contracts §ERROR MODEL ("Field naming is camelCase throughout the bodies ... snake_case columns map to camelCase wire fields") + plan Data Model / API Surface (camelCase↔snake_case) — consistent -->

- [X] CHK037 Do the codes/statuses in the plan Error Handling Strategy (e.g. `409 not_metered`, `409 archived`, `409 aggregation_frozen`) reconcile with the OpenAPI treatment of not_metered/archived as PER-EVENT codes inside a 200/202 summary rather than HTTP 409? [Consistency, plan Error Handling Strategy; openapi PerEventRejectionCode] <!-- Evaluator: Resolved — rewrote plan.md Error Handling Strategy to ONE truth: added a Vocabulary column splitting WHOLE-REQUEST HTTP errors from PER-EVENT rejection codes; not_metered/archived/not_found/license_inactive/stale_event/future_event now correctly shown as per-event codes in the 200/202 rejected[] (NOT HTTP statuses); 409 aggregation_frozen scoped to the E007 catalog plane -->

- [X] CHK038 Is each refusal reason (HTTP-level and per-event) a distinct, testable code so an acceptance criterion can assert one exact reason rather than a class? [Testability, FR-006; openapi Error/PerEventRejectionCode] <!-- Evaluator: Covered by contracts §Error.code + §PerEventRejectionCode (two disjoint enums, each a distinct snake_case testable code) reinforced by the reconciled plan Error Handling Strategy (CHK037) -->

