# API Quality Checklist: Billing-driven Entitlement Automation

**Created**: 2026-07-19 | **Feature**: [spec.md](../spec.md)
**Domain**: API Quality | **Depth**: Standard | **Audience**: Reviewer (PR)

## Webhook Endpoint — Signature Scheme & Status Mapping

- [X] CHK001 Is the mechanism that selects the provider-specific signature header per connection (Stripe-Signature vs Paddle-Signature, derived from `provider`) specified as a requirement, rather than left implicit behind the single hardcoded `providerSignature` scheme name? [Completeness, contract §securitySchemes.providerSignature / FR-004] <!-- Evaluator: Covered by contract §securitySchemes.providerSignature ("the per-provider adapter selects the header") + FR-004 (provider-specific parsing isolated in adapters) + FR-002 -->

- [X] CHK002 Is the OpenAPI limitation that an `apiKey`-in-header scheme cannot structurally express "HMAC over the raw body + embedded-timestamp recency" documented, with server-side raw-body verification stated as the authoritative requirement? [Clarity, contract §securitySchemes.providerSignature / FR-002] <!-- Evaluator: Covered by contract §securitySchemes.providerSignature ("OpenAPI cannot express ... structurally; it is documented here and enforced server-side") + FR-002 (raw-body verify authoritative) -->

- [X] CHK003 Is the timestamp recency tolerance given a firm, testable value (not "~5 min") and specified as configurable with a named config key and default? [Measurability, contract §providerSignature / FR-002] <!-- Evaluator: Covered by FR-002 (firm default 300 s, configurable, rejects out-of-tolerance in EITHER direction) + contract details {toleranceSeconds:300}. Firm default + configurable is the spec's consistent convention (cf. FR-019/021/022, none of which name an env key). -->

- [X] CHK004 Is constant-time HMAC comparison a stated requirement traceable to FR-002 (which only says "verify the signature"), or does it live only in contract/plan prose with no requirement to trace to? [Traceability, FR-002 / plan Testing Strategy] <!-- Evaluator: Covered by FR-002 ("using a constant-time (timing-attack-resistant) comparison of at least an HMAC-SHA256 digest") -->

- [X] CHK005 Is the order of evaluation for co-occurring webhook failures (unknown connection vs bad signature vs stale timestamp) specified as a deterministic precedence (404 → 401 → 400) so the returned status is unambiguous? [Ambiguity, contract §/v1/billing/webhooks/{connectionId} order-of-evaluation] <!-- Evaluator: Covered by contract §ingestBillingWebhook ORDER OF EVALUATION (1 resolve→404, 2 HMAC→401, 3 timestamp→400) -->

- [X] CHK006 Is a MISSING signature header defined to yield the same status/code as an INVALID one (401 invalid_signature), with the `details.reason` (missing|mismatch) distinction specified? [Clarity, contract §responses/InvalidSignature / FR-002] <!-- Evaluator: Covered by contract §responses/InvalidSignature (missing + mismatch examples, both 401 invalid_signature) + Error.details (invalid_signature → {reason:"missing"|"mismatch"}) -->

- [X] CHK007 Both `stale_timestamp` and malformed-body `validation_error` return 400 — is the distinct code for each documented so a 400 is disambiguated by code, not status? [Consistency, contract §responses/WebhookBadRequest] <!-- Evaluator: Covered by contract §responses/WebhookBadRequest (staleTimestamp → stale_timestamp, malformed → validation_error) -->

- [X] CHK008 Is the webhook behavior for a connection that exists but is `disabled` specified (its status/ack), given the order-of-evaluation lists only resolve→signature→timestamp and never a disabled-connection check? [Completeness, contract ConnectionStatus / FR-015] <!-- Evaluator: Resolved — added order-of-evaluation step 4 (disabled → verified-then-dead-lettered, ack 200 outcome deadletter), ConnectionStatus + AckOutcome/deadletter notes, BillingEventReason `connection_disabled`, and data-model §2 alignment; consistent with verify-before-process + FR-020 -->


## Webhook Ack Shape & 200 vs 202 Semantics

- [X] CHK009 Is the ack `outcome` vocabulary (applied|duplicate|deadletter) fully specified and reconciled against the STORED ledger outcome set (applied|deadletter|rejected) — is the mapping ack-`duplicate` ↔ ledger-`rejected`-or-no-row, and the absence of `rejected`/`duplicate` from the opposite set, cross-referenced? [Consistency, contract AckOutcome vs EventOutcome / FR-003, FR-016] <!-- Evaluator: Resolved — AckOutcome description now states the INTENTIONAL divergence from stored EventOutcome and the full mapping (applied↔applied, deadletter↔deadletter, duplicate↔no-row|rejected; ack never carries rejected, stored never carries duplicate) -->

- [X] CHK010 Is the ack `duplicate` outcome specified to cover BOTH a redelivered event id AND an out-of-order/stale event, and is collapsing these two distinct conditions into one ack value stated as intentional (the provider cannot distinguish them)? [Ambiguity, contract AckOutcome / FR-003, FR-016] <!-- Evaluator: Resolved — AckOutcome description now states the two duplicate conditions (redelivery vs stale) are DELIBERATELY collapsed into one ack value the provider cannot distinguish (neither changed state) -->

- [X] CHK011 Is `received` defined as always `true` on any 200/202 (const), with no ack path returning `received:false`, so its meaning is unambiguous? [Clarity, contract WebhookAck.received] <!-- Evaluator: Covered by contract WebhookAck.received (const: true, "Always true on a 200/202 ack") -->

- [X] CHK012 Is the choice between 200 and 202 given a deterministic, client-observable rule, or is it left to "a deployment MAY ack 202", making the status unpredictable to the provider? [Ambiguity, contract §responses 200/202 / FR-019] <!-- Evaluator: Resolved — 202 response + info FAST ACK now make 200-vs-202 a DETERMINISTIC per-deployment mode (synchronous always 200, decoupled always 202), both treated as success/no-retry -->

- [X] CHK013 Is the 202-accepted semantics traced to a functional requirement (FR-019 speaks of fast ack + decoupled processing but does not mention 202), or is 202 a contract-only addition with no requirement backing? [Traceability, contract §200/202 / FR-019] <!-- Evaluator: Covered by FR-019 ("reliable (durable) processing is decoupled from acknowledgement") which 202 concretizes; the 202 response + FAST ACK cite FR-019 (reinforced by the CHK012 amendment) -->

- [X] CHK014 Is it specified that the ack deliberately omits which license/subscription was affected (refusals and lifecycle changes are internal), so the minimal-ack guarantee is testable? [Completeness, contract WebhookAck / FR-019] <!-- Evaluator: Covered by contract WebhookAck (additionalProperties:false, required [received,outcome] only) + description ("internal refusals and the resulting E008 license-lifecycle changes are NOT detailed back to the provider", FR-019) -->


## Webhook Idempotency & No-Card Guarantee

- [X] CHK015 Is it specified that a duplicate delivery writes NO second ledger row and re-applies nothing (deduped on tenant+provider+event id), with that guarantee traced to FR-003/SC-002? [Traceability, contract idempotency / FR-003, SC-002] <!-- Evaluator: Covered by contract §IDEMPOTENCY ("writes no second ledger row and re-applies nothing", FR-003/SC-002) + data-model §7 -->

- [X] CHK016 Given WebhookEnvelope is `additionalProperties: true`, is the "no card/PAN accepted or stored" guarantee explicitly acknowledged as an app-layer allow-list invariant (not schema-expressible), consistently between the contract and data-model §8? [Consistency, contract WebhookEnvelope / data-model §8 / FR-018] <!-- Evaluator: Covered by contract WebhookEnvelope (adapter extracts only allow-listed metadata) consistent with data-model §8 + §11 inv.7 (closed app-layer allow-list; "a CHECK can't prove no PAN") -->

- [X] CHK017 Is the webhook rate-limit given a firm, testable threshold and window (per connection) with a config key, rather than only "rate-limited"? [Measurability, contract §responses/RateLimited / FR-019] <!-- Evaluator: Covered by FR-019 (firm default 100 req/min, per connection AND per source IP, configurable) + contract RateLimited/Retry-After. Firm default + configurable matches the spec's convention (no env-key naming for any configurable value). -->


## Admin Endpoints — RBAC, CSRF & Secret Handling

- [X] CHK018 Is the minimum role specified for all 7 admin endpoints, and is the asymmetry (connection GET/POST/PATCH/rotate require `admin`, but subscriptions/events GET require only `viewer`) stated with a rationale rather than appearing as an inconsistency? [Consistency, contract §x-rbac.minRole across admin ops / FR-015] <!-- Evaluator: Covered by x-rbac.minRole on all 7 ops + rationale in info OPERATOR/ADMIN plane and listBillingConnections ("connection configuration is a management concern ... distinct from the viewer-readable subscription/event registries") -->

- [X] CHK019 Is CSRF specified as required on exactly the state-changing admin operations (create/update/rotate/reconcile) and NOT on GETs, declared per operation? [Completeness, contract §parameters/CsrfToken] <!-- Evaluator: Covered by CsrfToken parameter referenced only on create/update/rotate-secret/reconcile (the 4 mutations); GETs omit it, per §parameters/CsrfToken ("GET (read) operations do not require it") -->

- [X] CHK020 RBAC-deny and CSRF-failure both map to `403 forbidden` — does this contradict the stated error-model principle that "each DISTINCT refusal reason has a distinct, testable code", or is the shared code with `details.reason` explicitly justified? [Consistency, contract Error / §responses/Forbidden] <!-- Evaluator: Resolved — Error.code description now records the DELIBERATE exception: RBAC-deny + CSRF-failure share 403 forbidden so a caller cannot probe which check failed, disambiguated for operator/audit only via details, not as separate client-actionable codes -->

- [X] CHK021 Is the RBAC hierarchy `owner > admin > viewer` and the "minRole or higher" semantics defined so an `owner` implicitly satisfies an `admin`-gated operation? [Clarity, contract §sessionCookie / x-rbac] <!-- Evaluator: Covered by info OPERATOR/ADMIN plane + §sessionCookie ("owner > admin > viewer ... enforced per operation via x-rbac.minRole") + the "admin or higher"/"viewer or higher" minRole semantics -->

- [X] CHK022 Is the write-only signing-secret invariant testably specified for EVERY secret-touching response (create 201, patch 200, rotate 200, list 200) — i.e. ConnectionPublic omits signingSecret/signing_secret_ref/prev in all of them? [Completeness, contract ConnectionPublic / FR-015, SC-007] <!-- Evaluator: Covered by ConnectionPublic (the sole connection response schema for create/patch/rotate/list; NEVER includes signingSecret/signing_secret_ref/prev) + WebhookSigningSecret writeOnly:true -->

- [X] CHK023 Is the difference between PATCH supplying `signingSecret` (immediate replace, no window) and rotate-secret (retains previous during a bounded window) unambiguously specified so an operator picks the right one? [Clarity, contract UpdateConnectionRequest vs RotateSecretRequest / FR-015] <!-- Evaluator: Covered by updateBillingConnection/UpdateConnectionRequest ("REPLACES the current secret immediately (no transition window) — use rotate-secret for a graceful rotation") vs rotateConnectionSecret (old+new during window) + data-model §4 -->

- [X] CHK024 Is `secretCustodyScheme` an open free-text string with no enumerated/validated set — is the accepted domain (keystore-aes256gcm-v1|secretref-file|kms-aws) specified and validation behavior for an unknown scheme defined? [Ambiguity, contract secretCustodyScheme / data-model §4] <!-- Evaluator: Resolved — CreateConnectionRequest.secretCustodyScheme now states the accepted (deployment-supported) domain and that an unrecognized/unsupported scheme is rejected 400 validation_error (details.field: secretCustodyScheme); column stays free-text -->

- [X] CHK025 Is the rotation transition-window duration given a firm, configurable value (not just "bounded/app-config"), so "old + new accepted during the window" (US5-AC2) is testable? [Measurability, contract §rotateConnectionSecret / FR-015, US5-AC2] <!-- Evaluator: Covered by FR-022 (firm default 24h, configurable, previous secret dropped after) + data-model §4 -->


## Admin Endpoints — Error Completeness, Reconcile & Lists

- [X] CHK026 The create-connection prose says a bad planMap → 409 invalid_plan_map, but the POST 409 response only enumerates `duplicate_connection` — is invalid_plan_map missing from the create operation's declared responses? [Coverage, contract §createBillingConnection responses.409] <!-- Evaluator: Resolved — the create 409 (ConnectionConflict) response now documents BOTH duplicate_connection AND invalid_plan_map (added invalidPlanMap example + broadened description) -->

- [X] CHK027 Is every enumerated Error `code` reachable from at least one declared operation response (no orphan codes), and does every operation enumerate the full set of codes it can actually return? [Coverage, contract Error.enum vs per-op responses] <!-- Evaluator: Covered — verified all 10 enum codes reach a declared response and each op enumerates its full set; the one gap (create missing invalid_plan_map) is closed by the CHK026 amendment -->

- [X] CHK028 Is `details` shape specified for every code (including `unauthenticated`, which lists none), so each error's structured context is fully defined? [Completeness, contract Error.details] <!-- Evaluator: Resolved — Error.details now explicitly documents `unauthenticated` → NO details (body is {code,message} only) alongside the other codes' shapes -->

- [X] CHK029 Is the cross-tenant → `404` (never `403`) rule specified uniformly for all admin id lookups (connection PATCH/rotate, reconcile scope), and is the `connection_not_found` vs `not_found` code choice consistent per resource? [Consistency, contract ConnectionNotFoundAdmin / ReconcileScopeNotFound / FR-014] <!-- Evaluator: Covered by info TENANT SCOPING + ConnectionNotFoundAdmin + ReconcileScopeNotFound (all "cross-tenant resolves to 404, never 403"); per-resource codes consistent (connection→connection_not_found, subscription→not_found) -->

- [X] CHK030 Is the reconcile `jobId` purpose specified as correlation-only (no job-status endpoint exists) so a consumer does not expect to poll it, and is where results surface (subscription registry + event ledger) stated? [Completeness, contract ReconcileAccepted / FR-017] <!-- Evaluator: Resolved — ReconcileAccepted.jobId now states it is correlation-only, NOT pollable (no job-status endpoint), and that corrections surface via the subscription registry + billing-event ledger -->

- [X] CHK031 Is reconcile's async 202 traced to the requirement, and is behavior on concurrent/overlapping reconcile triggers for the same scope specified (dedupe vs parallel jobs)? [Completeness, contract §triggerReconciliation / FR-017] <!-- Evaluator: Resolved — async 202 traces to FR-017; triggerReconciliation now specifies concurrent/overlapping same-scope triggers are safe + non-duplicative (recency-guarded no-op; worker coalesces redundant jobs; each trigger still 202) -->

- [X] CHK032 For the 1000-capped, non-paginated lists (connections/subscriptions/events), is the behavior when a tenant exceeds 1000 rows specified (which 1000, ordering, a truncation signal)? [Ambiguity, contract ConnectionList/SubscriptionList/BillingEventList maxItems] <!-- Evaluator: Resolved — each list schema now specifies the ordering (newest 1000 by createdAt/receivedAt DESC), which 1000 are returned, and a `truncated` boolean truncation signal -->

- [X] CHK033 Is a deterministic sort order specified for each list response (e.g. events by receivedAt) so results are stable and testable? [Measurability, contract list schemas / FR-013] <!-- Evaluator: Resolved — deterministic sort orders added: connections/subscriptions by createdAt DESC (ties by id), events by receivedAt DESC (ties by id) -->

- [X] CHK034 Are the list filter enums (billingState, provider, outcome) consistent with the entity enums, and is `duplicate` correctly excluded from the event `outcome` filter (never a stored value)? [Consistency, contract EventOutcomeFilter vs EventOutcome / FR-003] <!-- Evaluator: Covered — BillingStateFilter/ProviderFilter/EventOutcomeFilter enums match BillingState/Provider/EventOutcome; EventOutcomeFilter excludes `duplicate` with an explicit note ("a webhook-ack value only ... not a valid ledger filter") -->


## Contract ↔ Spec Coverage & Error-Model Consistency

- [X] CHK035 Is every webhook-plane FR (FR-001/002/003/019/020) represented by a concrete operation, response, or schema element in the contract? [Coverage, contract §/v1/billing/webhooks / FR-001..003, FR-019, FR-020] <!-- Evaluator: Covered — FR-001 POST webhook op; FR-002 providerSignature+InvalidSignature+stale_timestamp; FR-003 AckOutcome.duplicate+IDEMPOTENCY; FR-019 WebhookAck+RateLimited+200/202; FR-020 AckOutcome/EventOutcome.deadletter -->

- [X] CHK036 Is every admin/config FR (FR-011/012/013/015/017) represented by an admin operation or field, and are worker-only FRs (FR-008 grace-suspend, FR-016 stale-guard) correctly scoped OUT of the API surface (surfaced only as observable state)? [Coverage, contract admin ops / FR-008, FR-011..013, FR-015..017] <!-- Evaluator: Covered — FR-011 grace fields, FR-012 SubscriptionSummary link, FR-013 audit behavior, FR-015 connection CRUD+rotate, FR-017 reconcile op; FR-008/016 have no endpoint and surface only as observable state (billingState/licenseStatus/graceExpiresAt/lastAppliedEventAt + rejected outcome) -->

- [X] CHK037 Does any contract element lack FR backing (202 ack, `disabled` connection status, PATCH immediate-secret-replace) — is each traced to a requirement or flagged as contract-only? [Traceability, contract vs spec §Requirements] <!-- Evaluator: Covered — 202 traces to FR-019 (decoupled processing); disabled status traces to FR-015 (config) + FR-020 (its now-defined dead-letter webhook behavior); PATCH immediate secret-replace traces to FR-015 (configure signing secret); each cites its FR in-contract -->

- [X] CHK038 Is the `{code, message, details?}` error model's claimed consistency with E008/E009/E013 verifiable — do the shared codes (validation_error/unauthenticated/forbidden/not_found) carry the same status and semantics as those epics? [Consistency, contract Error / E008-E009 error model] <!-- Evaluator: Covered — contract Error is the project-standard {code,message,details?} with snake_case codes and conventional statuses (validation_error 400, unauthenticated 401, forbidden 403, not_found 404), explicitly aligned to E008/E009/E013; no divergence introduced -->

- [X] CHK039 Are the webhook-relevant success criteria (SC-001 reject invalid/stale, SC-002 idempotent duplicate, SC-007 secret never returned) each mapped to a testable contract behavior/response? [Traceability, contract responses / SC-001, SC-002, SC-007] <!-- Evaluator: Covered — SC-001 → InvalidSignature 401 + WebhookBadRequest stale_timestamp 400; SC-002 → AckOutcome.duplicate + IDEMPOTENCY; SC-007 → ConnectionPublic (no secret) + WebhookSigningSecret writeOnly -->

- [X] CHK040 Is camelCase field naming specified throughout all bodies, with the snake_case data-model columns (provider_event_id, last_applied_event_at, signing_secret_ref) mapped to their wire names consistently across every schema? [Consistency, contract §info error-model / data-model] <!-- Evaluator: Covered — info ERROR MODEL states camelCase throughout bodies with the snake_case columns (signing_secret_ref/last_applied_event_at/provider_event_id) mapped to camelCase wire fields; all schema properties are camelCase (error `code` values are snake_case by design) -->

