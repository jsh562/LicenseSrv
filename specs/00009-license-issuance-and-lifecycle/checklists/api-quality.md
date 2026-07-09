# API Quality Checklist: License Issuance and Lifecycle
**Created**: 2026-07-08 | **Feature**: [spec.md](../spec.md)

## Status Code Coverage

- [X] CHK001 Is a success status code specified for each of the 13 operations (201 for issue and create-customer, 200 for reads/lifecycle/reissue, 204 for erase)? [Completeness, plan §API Surface Summary] <!-- Evaluator: Covered by contract paths — all 13 ops enumerate a success code: 201 createCustomer + issueLicense, 204 eraseCustomer, 200 for the two lists, get-customer/get-license/get-key, and revoke/suspend/reinstate/transfer/reissue -->

- [X] CHK002 Is it specified which operations may return `503 signer_unavailable`, and is that set limited to the two signing operations (issue, reissue)? [Completeness, FR-004 / contract §SignerUnavailable] <!-- Evaluator: Covered by contract §STATUS CODES ("returned ONLY by issue, reissue") — only issueLicense and reissueLicense list the 503 SignerUnavailable response -->

- [X] CHK003 Are the applicable 4xx codes enumerated per operation rather than left to a generic default (400 only where a body/query is validated, 409 only where a conflict is defined)? [Completeness, contract paths] <!-- Evaluator: Covered by contract paths — no generic 'default' responses; 400 only on ops with a body/query (createCustomer, issueLicense, listLicenses, transfer); 409 only where a conflict exists (duplicate_ref, plan_not_issuable, invalid_transition, transfer_limit_exceeded); revoke deliberately has no 409 -->

- [X] CHK004 Is a `401 unauthenticated` response defined for every operation given the global session requirement? [Completeness, contract §security] <!-- Evaluator: Covered — global security: sessionCookie plus a 401 Unauthorized response on all 13 operations -->

- [X] CHK005 Is a `403 forbidden` response defined for every operation to cover RBAC and CSRF denial? [Completeness, FR-016 / contract §Forbidden] <!-- Evaluator: Covered — 403 Forbidden on all 13 ops; §Forbidden documents both RBAC deny and CSRF failure share this shape -->

- [X] CHK006 Is `404 not_found` specified for every operation that resolves an id or references a target (including the transfer target customer)? [Completeness, contract §NotFound] <!-- Evaluator: Covered — 404 on get/erase customer, issue (unknown plan/customer), get/get-key license, revoke/suspend/reinstate/reissue, and transfer (with an explicit unknownCustomer target example) -->

- [X] CHK007 Is the `Location` header specified for both creation responses (issue 201, create-customer 201)? [Completeness, contract POST /admin/licenses] <!-- Evaluator: Covered — both the createCustomer 201 and issueLicense 201 responses declare a Location header -->


## Error Model and Codes

- [X] CHK008 Is the error envelope `{code, message, details?}` defined once, with `code` and `message` marked required and `details` optional? [Consistency, contract §Error] <!-- Evaluator: Covered by §components.schemas.Error — single schema, required: [code, message], details present but not required -->

- [X] CHK009 Are error codes defined as a closed enumerated set (validation_error, unauthenticated, forbidden, not_found, duplicate_ref, plan_not_issuable, invalid_transition, transfer_limit_exceeded, signer_unavailable), each mapped to an HTTP status? [Completeness, contract §Error.code] <!-- Evaluator: Covered by §Error.code — closed enum of exactly those 9 codes, each annotated with its HTTP status (400/401/403/404/409/409/409/409/503) -->

- [X] CHK010 Is the shape of `details` specified per code (e.g. validation_error to `{field,value}`; transfer_limit_exceeded to `{transferCount,transferLimit}`; signer_unavailable to `{productId,reason}`)? [Clarity, contract §Error.details] <!-- Evaluator: Covered by §Error.details description — per-code shapes enumerated for all 8 detail-bearing codes, matched by the per-response examples -->

- [X] CHK011 Are the `details.reason` enumerations constrained (plan_not_issuable: archived_plan|archived_entitlement; signer_unavailable: no_active_key|signer_locked)? [Completeness, contract §PlanNotIssuable/§SignerUnavailable] <!-- Evaluator: Covered — §Error.details constrains plan_not_issuable reason to archived_plan|archived_entitlement and signer_unavailable reason to no_active_key|signer_locked; §PlanNotIssuable/§SignerUnavailable examples match -->

- [X] CHK012 Is a stability/versioning rule stated for error codes (a new code requires a contract change)? [Clarity, contract §Error.code] <!-- Evaluator: Covered by §Error.code description: "Enumerated; new codes require a contract change." -->


## Secrecy Invariant

- [X] CHK013 Is it stated unambiguously that the signed license key appears ONLY in the issue (201), reissue (200), and GET `/key` responses, and modelled so list/metadata reads omit it (`licenseKey` conditional via `IssuedLicense`)? [Consistency, FR-003 / SC-010 / contract §SECRECY INVARIANT] <!-- Evaluator: Covered by §SECRECY INVARIANT ("returned in exactly three places") plus the model: License.licenseKey optional/omitted from reads, IssuedLicense requires it (issue/reissue), LicenseKey for /key -->

- [X] CHK014 Is the distinction between the returned signed license key (public token) and the product signing key (never returned) defined clearly enough to prevent conflation? [Clarity, FR-003 / contract §SignedLicenseKey] <!-- Evaluator: Covered by §SignedLicenseKey ("safe to distribute... NOT the signing key") and §SECRECY INVARIANT contrasting the returned public LIC1 token vs the never-returned private signing key -->

- [X] CHK015 Is it stated that no schema, example, error field, header, log, or audit entry ever contains signing-key material? [Completeness, SC-010 / contract §Error] <!-- Evaluator: Covered by §SECRECY INVARIANT ("not in any response body, header, example, log, or audit entry") and §Error ("NEVER any signing-key material or signed token appears in any field") -->

- [X] CHK016 Is `keyId` defined as an opaque identifier (which key signed the token), not key material, everywhere it appears (License, LicenseKey, IssuedLicense)? [Clarity, contract §License.keyId] <!-- Evaluator: Covered — License.keyId "Opaque identifier only — never key material"; LicenseKey.keyId "opaque identifier, not key material"; IssuedLicense inherits License; §SECRECY INVARIANT reiterates it -->


## RBAC and CSRF

- [X] CHK017 Is a minimum role specified for every operation (viewer for reads, admin for mutations) via one consistent mechanism (`x-rbac.minRole`)? [Consistency, FR-016 / contract §RBAC] <!-- Evaluator: Covered — every op declares x-rbac.minRole; all GETs = viewer, all POST/DELETE = admin, per §RBAC -->

- [X] CHK018 Is the CSRF token requirement stated for every state-changing operation (all POST/DELETE) and explicitly NOT required for reads? [Consistency, contract §CSRF / §CsrfToken] <!-- Evaluator: Covered — the required CsrfToken header parameter is referenced by all 8 mutations (createCustomer, eraseCustomer, issue, revoke, suspend, reinstate, transfer, reissue); §CSRF/§CsrfToken state GETs do not require it -->

- [X] CHK019 Is the role hierarchy (owner > admin > viewer) defined so that "admin or higher" and "viewer or higher" are unambiguous? [Clarity, contract §RBAC] <!-- Evaluator: Covered by §RBAC: "Roles are owner > admin > viewer (mirrors src/server/auth/rbac.ts)" -->

- [X] CHK020 Is it specified that an RBAC or CSRF denial is recorded as an auditable security event? [Completeness, FR-016 / contract §Forbidden] <!-- Evaluator: Covered by §RBAC ("A denied privileged action is recorded as an auditable security event") and §Forbidden ("Both are recorded as an auditable security event (FR-016)") -->


## Lifecycle Semantics

- [X] CHK021 Is the license state machine fully specified — states plus allowed transitions (active↔suspended, active|suspended to revoked, revoked terminal)? [Completeness, FR-010 / contract §LIFECYCLE STATE MACHINE] <!-- Evaluator: Covered by §LIFECYCLE STATE MACHINE — states {active,suspended,revoked} and transitions active→suspended, suspended→active, active|suspended→revoked (terminal), plus the LicenseStatus enum -->

- [X] CHK022 Is revoke specified as idempotent (returns 200, not an error, on an already-revoked license) with the deliberate absence of a 409 documented so it does not read as a gap? [Consistency, FR-007 / contract POST /admin/licenses/{licenseId}/revoke] <!-- Evaluator: Covered — revokeLicense description states it is idempotent, returns 200 on an already-revoked license, and "so revoke has no 409"; the 200 response note repeats the idempotent case -->

- [X] CHK023 Are the invalid-transition conditions stated per operation (suspend requires active; reinstate requires suspended; transfer/reissue refused when revoked), each mapped to `409 invalid_transition`? [Clarity, FR-008 / FR-010 / contract §InvalidTransition] <!-- Evaluator: Covered — suspend/reinstate/reissue ops and §InvalidTransition state the precondition per action; transfer-of-revoked mapped to invalid_transition; all map to 409 invalid_transition -->

- [X] CHK024 Is `transfer_limit_exceeded` defined against a specified limit (per-license, configurable default) and distinguished from `invalid_transition`? [Clarity, FR-009 / contract POST /admin/licenses/{licenseId}/transfer] <!-- Evaluator: Covered — transfer op cites a "per-license transfer LIMIT (configurable default)"; exceeding it → transfer_limit_exceeded, distinct from the invalid_transition returned for a revoked license -->

- [X] CHK025 Is it stated that a refused lifecycle action leaves the license unchanged? [Completeness, SC-008 / contract §InvalidTransition] <!-- Evaluator: Covered — §LIFECYCLE STATE MACHINE ("leaves the license unchanged"), §InvalidTransition ("The license is left unchanged"), suspend/reinstate ("leaving it unchanged"), and the transfer 409 ("The license is left unchanged") -->

- [X] CHK026 For transfer, are the two distinct 409 outcomes (transfer_limit_exceeded vs invalid_transition on a revoked license) each specified with their own code? [Clarity, contract POST /admin/licenses/{licenseId}/transfer] <!-- Evaluator: Covered — the transfer 409 defines two examples: limitExceeded (transfer_limit_exceeded, {transferCount,transferLimit}) and revoked (invalid_transition, {from:revoked,action:transfer}) -->

- [X] CHK027 Is the offline-revocation-gap disclosed as an intended limitation so the meaning of the exposed lifecycle `status` field is unambiguous downstream? [Clarity, spec §Edge Cases / contract §OFFLINE REVOCATION GAP] <!-- Evaluator: Covered by §OFFLINE REVOCATION GAP ("disclosed MVP limitation, not a defect... status exposed here is the source of truth downstream enforcement acts on") and spec §Edge Cases -->


## Schemas and Request/Response Shape

- [X] CHK028 Are all response schemas (Customer, License, IssuedLicense, LicenseKey, and the list wrappers) fully specified with their required fields enumerated? [Completeness, contract §components.schemas] <!-- Evaluator: Covered — Customer required[id,ref,status,createdAt]; License required[id,productId,planId,customerId,status,issuedAt,expiresAt,maxActivations,entitlements,keyId,transferCount]; IssuedLicense = License + required[licenseKey]; LicenseKey required[licenseId,keyId,licenseKey]; CustomerList/LicenseList required their arrays -->

- [X] CHK029 Is camelCase field naming stated as a convention across all request and response bodies? [Consistency, contract §STATUS CODES] <!-- Evaluator: Covered by §STATUS CODES: "Field naming is camelCase throughout, matching the E005/E007 console surfaces." -->

- [X] CHK030 Are all id fields specified as UUIDs (`format: uuid`), and is a customer `ref` clearly distinguished from its id? [Clarity, AD-002 / contract §IDENTIFIERS] <!-- Evaluator: Covered by §IDENTIFIERS (AD-002) — all id/reference fields are format:uuid; Customer.ref documented as "a separate, human-supplied stable label... NOT the id" -->

- [X] CHK031 Is `expiresAt` specified as nullable with null meaning perpetual, consistently in both the issue request and the license response schemas? [Clarity, FR-001 / contract §IssueLicenseRequest / §License] <!-- Evaluator: Covered — IssueLicenseRequest.expiresAt type [string,null] ("null/omitted for a PERPETUAL license") and License.expiresAt type [string,null] ("null for a PERPETUAL license") -->

- [X] CHK032 Is the entitlements snapshot specified as a key-to-value map with constrained value types (boolean or non-negative integer), a key-naming pattern, and an empty map declared valid? [Completeness, FR-002 / contract §EntitlementSnapshot] <!-- Evaluator: Covered — EntitlementSnapshot is a map (additionalProperties EntitlementValue = boolean | integer minimum:0), propertyNames pattern '^[a-z][a-z0-9_]*$', and "An empty object is valid" -->

- [X] CHK033 Is `maxActivations` specified as the snapshot seat limit with a defined domain (integer >= 1) and its downstream (E009) meaning noted? [Clarity, FR-002 / contract §License.maxActivations] <!-- Evaluator: Covered — License.maxActivations integer minimum:1, "The SNAPSHOT seat limit... E009 enforces it." -->

- [X] CHK034 Are request bodies constrained (additionalProperties false, required fields, length limits for ref/name/email)? [Completeness, contract §CreateCustomerRequest / §IssueLicenseRequest] <!-- Evaluator: Covered — all three request schemas set additionalProperties:false with required fields; CreateCustomerRequest caps ref/name at 200, email at 320 with minLength -->

- [X] CHK035 Is `transferCount` defined (integer >= 0) with its relationship to the transfer limit specified? [Clarity, FR-009 / contract §License.transferCount] <!-- Evaluator: Covered — License.transferCount integer minimum:0; the transfer op increments it and refuses once it would exceed the limit (transfer_limit_exceeded details {transferCount,transferLimit}) -->

- [X] CHK036 Is the customer erasure outcome specified (204 for both hard-delete and anonymize) with the anonymized field state defined (ref pseudonym, name/email null, status anonymized)? [Completeness, FR-019 / contract DELETE /admin/customers/{customerId}] <!-- Evaluator: Covered — eraseCustomer: both outcomes return 204; anonymize replaces ref with an opaque pseudonym, nulls name/email, sets status=anonymized (irreversible) -->


## Filtering, Bounding, Scope, and Priority

- [X] CHK037 Are the registry list filters (`?status`, `?customerId`, `?planId`) specified, including that they combine with AND and each parameter's type/enum? [Completeness, contract §listLicenses / §parameters] <!-- Evaluator: Covered — listLicenses references LicenseStatusFilter (enum active|suspended|revoked), CustomerIdQuery (uuid), PlanIdQuery (uuid); description states filters "combine (AND)" -->

- [X] CHK038 Are list ordering and the result bound (hard cap 1000, no offset/cursor pagination) specified for both the customers and licenses lists? [Completeness, AD-009 / contract §CustomerList / §LicenseList] <!-- Evaluator: Covered — CustomerList ordered by createdAt, LicenseList ordered by issuedAt, both maxItems:1000; §LIST BOUNDING (AD-009) states "no offset/cursor pagination in E008" -->

- [X] CHK039 Is it specified that a cross-tenant id resolves to `404 not_found` (never `403`), so an out-of-tenant id is indistinguishable from a non-existent one? [Consistency, FR-015 / contract §TENANT SCOPING] <!-- Evaluator: Covered by §TENANT SCOPING: "a cross-tenant id resolves to 404 not_found, never 403, so an out-of-tenant id is indistinguishable from a non-existent one"; §Error reiterates it -->

- [X] CHK040 Is the reissue operation marked P2 consistently in the spec and the contract so its priority relative to the P1 operations is unambiguous? [Consistency, FR-018 / contract §reissue x-priority] <!-- Evaluator: Covered — contract reissueLicense sets x-priority: P2; spec US6 is Priority P2 and FR-018 is marked (P2) -->

