# Security Checklist: Usage Metering & Aggregation

**Created**: 2026-08-02 | **Feature**: [spec.md](../spec.md)

## Authentication & Scope (usage.ingest)

- [X] CHK001 Are the requirements explicit that the `usage.ingest` scope is a NEW, ingest-only scope distinct from the E013 validate/heartbeat scopes, so a validating key gains no usage-write authority? [Completeness, FR-001] <!-- Evaluator: Covered by spec.md FR-001 + Clarifications 2026-07-24 (ingest-only scope; validating clients gain no write authority) and contract securitySchemes (usage.ingest distinct from activate/validate/lease) -->

- [X] CHK002 Is "tenant- and license-bound" for the `usage.ingest` scope defined precisely enough to test — i.e. is it specified whether a key is bound to a single license or a set, and how a report against an out-of-binding license is refused? [Clarity, FR-001] <!-- Evaluator: Covered by spec.md FR-001 + contract RUNTIME plane (key reports only for licenses in its own tenant; every event's licenseId/entitlementId re-resolved within that tenant; out-of-binding/cross-tenant → per-event not_found) -->
- [X] CHK003 Is the fail-closed behavior for a missing/insufficient `usage.ingest` scope stated as a single unambiguous outcome, given the plan lists both 401 and 403 for that case? [Consistency, FR-001/SC-016 vs plan Error Handling] <!-- Evaluator: Covered by contract RUNTIME plane + Unauthorized/ForbiddenScope responses — disambiguated: no resolvable tenant context → 401 unauthorized, resolvable key lacking scope → 403 forbidden (each a single unambiguous outcome) -->

- [X] CHK004 Do the requirements specify that a fail-closed refusal accrues NOTHING (no partial ingest, no side effect) when scope is absent? [Coverage, SC-016] <!-- Evaluator: Covered by spec.md SC-016 (refused fail-closed, nothing accrued) + contract ForbiddenScope (Nothing is accrued) -->

- [X] CHK005 Are requirements defined for ingest against an inactive, expired, suspended, or revoked license/API key — is the ingest path required to fail-closed on license lifecycle state, not just on scope presence? [Completeness, Gap - FR-001/FR-006] <!-- Evaluator: Resolved — added FR-021 + SC-018 (ingest fails closed per-event `license_inactive` on expired/suspended/revoked/inactive license, mirroring E013), plus contract PerEventRejectionCode `license_inactive` and plan Error-Handling row -->

- [X] CHK006 Is the authorization boundary for the operator/app aggregate query surface (console session + RBAC `viewer`) stated as a requirement, separate from the ingest key auth? [Completeness, FR-011/plan API Surface] <!-- Evaluator: Covered by spec.md Assumptions (operator query via console session + RBAC) + plan API Surface (admin_session + RBAC viewer) + contract sessionCookie/x-rbac.minRole viewer, distinct from the X-API-Key ingest plane -->


## Tenant Isolation & RLS

- [X] CHK007 Do the requirements mandate forced RLS on all three usage tables (`usage_event`, `usage_rollup`, `usage_unique_value`), or only the two named in FR-017's "usage tables"? [Coverage, FR-017 vs data-model INV-3] <!-- Evaluator: Covered by data-model.md migration DDL (ENABLE+FORCE ROW LEVEL SECURITY on all three tables) + INV-3; FR-017 "usage tables" covers all three -->

- [X] CHK008 Is the cross-tenant reference outcome specified consistently as "not found" (404) across ingest and query, rather than a leak-revealing distinct error? [Consistency, FR-006/FR-017/SC-012] <!-- Evaluator: Covered by FR-006/FR-017/SC-012 + contract (per-event not_found on ingest, 404 not_found on query, never 403) -->

- [X] CHK009 Is the unset-tenant-GUC → zero-rows behavior stated as a measurable requirement for every usage table? [Measurability, SC-012] <!-- Evaluator: Covered by SC-012 (unset tenant GUC yields zero rows on the usage tables) + data-model INV-3 + migration RLS policy (NULLIF current_setting) on all three tables -->

- [X] CHK010 Are the requirements clear that isolation is fail-closed for BOTH read and write (ingest for, read, and see) rather than read-only isolation? [Clarity, FR-017] <!-- Evaluator: Covered by FR-017 (neither ingest for, read, nor see another tenant's usage) + migration policy USING + WITH CHECK (write path) -->

- [X] CHK011 Is it specified that the retention/prune and rollup workers run tenant-scoped (or owner-role with an explicit tenant boundary) so a worker cannot cross tenants? [Completeness, Gap - FR-015/FR-018] <!-- Evaluator: Resolved — amended plan HINT-004: rollup worker iterates per-tenant setting app.current_tenant (FORCED RLS confines each pass to one tenant); owner-role prune/GDPR-erase use explicit tenant_id-scoped predicates; no aggregation/prune/erase spans more than one tenant -->


## Idempotency & Anti-Replay

- [X] CHK012 Is the dedupe uniqueness scope stated unambiguously as `(tenant, source, event_id)` everywhere, reconciling the FR-002 wording with the Key Entities/data-model wording? [Consistency, FR-002/Clarifications] <!-- Evaluator: Covered by FR-002 + Clarifications 2026-07-24 (reconciles FR-002 vs Key-Entities) + data-model usage_event_idem_uniq + contract — all state (tenant, source, event_id) -->

- [X] CHK013 Do the requirements define the exactly-once guarantee under concurrent parallel producers (race) as a testable outcome, not just single-threaded dedupe? [Measurability, SC-015] <!-- Evaluator: Covered by SC-015 (concurrent ingestion accrues exactly once, no double-count under a race) + Edge Cases + plan Testing Strategy (concurrent-dedupe race integration test) -->

- [X] CHK014 Is the security consequence of bounded dedupe — a re-report after key pruning accrues freshly and cannot resurrect a pruned event — stated as an intended, documented behavior rather than a defect? [Clarity, FR-002/FR-015] <!-- Evaluator: Covered by FR-002/FR-015 + Edge Cases ("documented consequence of bounded dedupe") + data-model INV-6 -->

- [X] CHK015 Are requirements defined for how independent producers minting keys avoid cross-source collision (the `source` half of the key) to prevent one producer suppressing another's events? [Completeness, FR-002] <!-- Evaluator: Covered by FR-002 (source is half the dedupe scope so independent producers mint keys without cross-source collision) + contract source field -->


## Rate Limiting & Abuse Bounds

- [X] CHK016 Is the per-API-key rate limit specified with a measurable threshold and the `429 rate_limited` + `Retry-After` response contract? [Measurability, FR-005/SC-011] <!-- Evaluator: Covered by FR-005 (per-API-key, configured threshold, 429 rate_limited + Retry-After) + SC-011 + contract RateLimited (Retry-After == details.retryAfterSeconds) -->

- [X] CHK017 Is the maximum batch-size cap (default 1,000) required to reject an over-cap batch BEFORE any accrual, with a distinct reason? [Clarity, FR-005] <!-- Evaluator: Covered by FR-005 (default 1,000; over-cap rejected before any accrual) + contract batch_too_large (rejected pre-accrual, details {max,size}) -->

- [X] CHK018 Are the two refusal vocabularies (top-level HTTP `Error.code` vs per-event `PerEventRejectionCode`) specified so a rate-limit/over-cap refusal cannot be confused with a per-event rejection? [Consistency, plan API Surface/Error Handling] <!-- Evaluator: Covered by contract Error.code enum (HTTP-level) explicitly separated from PerEventRejectionCode (non-HTTP, in-summary) + plan API Surface note -->

- [X] CHK019 Is there a requirement bounding reversal-event abuse — forging signed-negative events to zero out or drive usage negative — is such abuse audited and/or bounded rather than silently accepted? [Completeness, Gap - FR-013/FR-018] <!-- Evaluator: Covered by FR-003 (append-only, never mutate/delete), FR-018 (reversal is an audited action), and FR-020/SC-017 (true signed net preserved and visible to E014 true-up) — so forging negatives cannot silently reduce the billing-consumed net and every reversal is on the append-only audit trail -->

- [X] CHK020 Are the per-aggregation quantity constraints (e.g. reject non-1/non-integer COUNT quantity; whether a reversal may decrement COUNT vs is disallowed for UNIQUE_COUNT) specified so a malformed quantity cannot corrupt an aggregate? [Completeness, HINT-002] <!-- Evaluator: Resolved — pinned plan HINT-002: SUM any signed numeric; COUNT must be a non-zero integer (-1 decrements, non-integer/zero → validation_error); UNIQUE_COUNT must be a positive integer, reversal cannot retract (negative/zero/non-integer → validation_error); malformed quantity is a per-event validation_error (contract) -->


## Secret, Key & Credential Non-Exposure

- [X] CHK021 Do the requirements state that no secret, API key, or signing key appears in any usage RESPONSE, LOG, or AUDIT entry — covering all three sinks? [Coverage, FR-019] <!-- Evaluator: Covered by FR-019 (never expose a secret/API key/signing key in any usage response, log, or audit entry) + FR-018 (audit without secrets/credentials) -->

- [X] CHK022 Is it specified that query responses carry ONLY aggregate values and dimensions, with no credential or internal identifier leakage? [Clarity, FR-019] <!-- Evaluator: Covered by FR-019 (query responses carry only aggregate values and dimensions) + contract UsageQueryResult/additionalProperties:false schemas -->

- [X] CHK023 Is the audit-entry content requirement explicit that ingestion is attributed to the reporting API key/license WITHOUT storing the key's secret material? [Consistency, FR-018/FR-019] <!-- Evaluator: Covered by FR-018 (attributes ingestion to the reporting API key/license, without secrets or credentials) reinforced by FR-019 -->

- [X] CHK024 Is "no secret/API key/signing key exposed" defined as a measurable, testable outcome (e.g. a leakage test asserting absence across responses and logs)? [Measurability, SC-013/plan Testing Strategy] <!-- Evaluator: Covered by SC-013 (no record/response/log/audit exposes a raw credential) + plan Testing Strategy Security tier (secret/PII-leakage test) -->


## PII Minimization & Dimensions

- [X] CHK025 Is the server-side dimension allow-list schema specified as a REQUIREMENT (bounded keys, scalar values, size caps) so free-form `dimensions` cannot carry PII? [Completeness, FR-016/HINT-005] <!-- Evaluator: Covered by FR-016 (now requires server-side allow-list validation) + plan HINT-005 + contract Dimensions schema (maxProperties 16, scalar oneOf, maxLength 256) -->

- [X] CHK026 Is the behavior on a dimension-schema VIOLATION defined — is a disallowed key/oversized/PII-shaped value rejected per-event with a distinct reason, or silently dropped? [Coverage, Gap - FR-016/HINT-005] <!-- Evaluator: Resolved — amended FR-016 to state a dimensions-schema violation is REJECTED per-event with a distinct validation_error, never silently dropped/truncated/stored; reinforced in contract PerEventRejectionCode/Dimensions -->

- [X] CHK027 Are the minimized fields enumerated as a closed set (license/entitlement refs, quantities, event timestamps, allow-listed dimensions) so "no PII beyond references" is enforceable rather than advisory? [Clarity, FR-016] <!-- Evaluator: Covered by FR-016 (enumerated closed set: license/entitlement references, quantities, event timestamps, allow-listed dimensions; no PII beyond those references) + data-model INV-9 -->

- [X] CHK028 Is the `usage_unique_value.value_hash` requirement stated so the raw distinct value need not be stored (hash-only), preserving minimization for UNIQUE_COUNT? [Completeness, data-model §3/FR-016] <!-- Evaluator: Covered by data-model §3 (value_hash bytea; the raw value is not needed once hashed, aiding minimization) -->

- [X] CHK029 Is the PII-minimization guarantee expressed as a testable success criterion (no record/response/log/audit exposes PII beyond refs/dimensions)? [Measurability, SC-013] <!-- Evaluator: Covered by SC-013 (no usage record/response/log/audit exposes PII beyond license/entitlement/dimension references; tenant usage is GDPR-erasable) -->


## Append-Only Integrity & Audit

- [X] CHK030 Do the requirements mandate append-only `usage_event` (no app UPDATE/DELETE), with corrections only via signed reversal events? [Coverage, FR-003/data-model INV-2] <!-- Evaluator: Covered by FR-003 (append-only, no mutate/delete; corrections via reversal) + data-model INV-2 + grants SELECT,INSERT only -->

- [X] CHK031 Is the audit requirement complete across ALL security-relevant actions — ingest batch summary, entitlement definition/edit, over-quota signal, reversal, and prune? [Completeness, FR-018] <!-- Evaluator: Covered by FR-018 (audit for each ingestion batch summary, metered-entitlement definition/edit, over-quota signal, reversal, and retention prune) -->

- [X] CHK032 Is worker attribution to a synthetic system actor (rollup, prune) specified as an audit requirement distinct from API-key/license attribution for ingest? [Clarity, FR-018] <!-- Evaluator: Covered by FR-018 (worker actions rollup/prune attributed to a synthetic system actor, distinct from the reporting API key/license) -->

- [X] CHK033 Is the audit trail required to be append-only (non-mutable) consistent with the append-only usage-event guarantee? [Consistency, FR-018/FR-003] <!-- Evaluator: Covered by FR-018 (append-only audit entry) consistent with FR-003 append-only usage_event + contract (append-only E002 audit entry) -->


## Metering ↔ Billing Boundary

- [X] CHK034 Do the requirements state that metering computes NO price, rate, or money and introduces no card/PAN data? [Coverage, FR-020/SC-014] <!-- Evaluator: Covered by FR-020 (MUST NOT compute price/rate/money) + SC-014 + contract (no card/PAN/CVV data ever accepted, parsed, or stored) -->

- [X] CHK035 Is E014's access to the aggregate specified as READ-ONLY over the true signed net (not the floored display), and is that boundary a testable requirement? [Clarity, FR-020/SC-017] <!-- Evaluator: Covered by FR-020 (aggregate read-only to E014; true signed net, not the floored display) + SC-017 + plan Integration Points (E014 reads usage_rollup read-only) -->

- [X] CHK036 Is the operator-facing `raw=true` true-net exposure bounded and authorized — is it specified whether a `viewer` may see the true signed (possibly negative) net, or is raw-net access restricted to the E014/billing read path? [Completeness, Gap - FR-013/FR-020/plan API Surface] <!-- Evaluator: Resolved — amended FR-020 + added SC-019 + contract: raw=true bounded to E014/app internal read path or an elevated operator role (admin+); a plain viewer requesting raw=true is refused 403 and only sees the floored display (reconciles FR-013) -->


## GDPR Erasure & Retention

- [X] CHK037 Is GDPR erasure required to remove a tenant's rows across ALL usage tables (`usage_event`, `usage_rollup`, `usage_unique_value`), not just raw events? [Coverage, FR-016/data-model INV-9] <!-- Evaluator: Covered by data-model Retention & GDPR (owner-role erase removes tenant's usage_event, usage_rollup, AND usage_unique_value) + FR-016 + INV-9 -->

- [X] CHK038 Are erasure and retention-prune specified to run on the owner role (the app role lacking DELETE), keeping deletion authority off the ingest path? [Clarity, FR-015/FR-016/data-model Grants] <!-- Evaluator: Covered by data-model Grants + Retention & GDPR (prune/erase on owner role; app role has NO DELETE grant) + FR-015/FR-016 -->

- [X] CHK039 Is the distinction between retention pruning (raw + keys removed, aggregate survives) and GDPR erasure (aggregate also removed) stated unambiguously so the two are not conflated? [Consistency, FR-015/FR-016] <!-- Evaluator: Covered by data-model Retention & GDPR + INV-6 (prune removes raw+keys, aggregate survives) vs FR-016/erasure (removes aggregate too) — stated distinctly -->

- [X] CHK040 Is the fail-open prune/rollup behavior required to preserve audit completeness and reproducibility, so a fault does not silently drop the security audit trail? [Traceability, FR-015/FR-018/Compliance Check] <!-- Evaluator: Covered by FR-015 (fail-open worker leaves durable rollup intact) + FR-018 (append-only audit, synthetic actor) + spec Compliance Check note (fail-open MUST preserve reproducibility SC-004 and audit completeness) -->

