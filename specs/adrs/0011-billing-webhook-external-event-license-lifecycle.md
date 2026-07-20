---
adr_id: ADR-0011
status: accepted
date: 2026-07-19
tags: [billing, webhooks, entitlement-automation, license-lifecycle, idempotency, reconciliation, dead-letter, grace-period, pci-boundary, provider-agnostic, secret-custody, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00015-billing-driven-entitlement-automation/spec.md, specs/00015-billing-driven-entitlement-automation/research.md, specs/00009-license-issuance-and-lifecycle/data-model.md, specs/00014-online-enforcement-and-revocation/spec.md]
---

# ADR-0011: Billing-Webhook Integration and the External-Event → License-Lifecycle Model

## Status

Accepted.

## Context

Until now a license's lifecycle is driven only by an admin acting in the console (E008): issuance, suspend/reinstate, revoke, transfer, and reissue are all manual operator actions. Epic E014 (Billing-driven entitlement automation, `{PRD:CAP-009}`, P2) connects an **OPTIONAL external billing provider** (Stripe/Paddle/…) whose **SIGNED webhooks** automatically provision, extend, grace, suspend, or revoke licenses so entitlements track what a customer has actually paid for — without an admin in the loop.

This is the first time the system ingests an **external event source** and lets it drive the license lifecycle, and the integration constraints are permanent and system-shaping rather than feature-local:

- **Payment processing is PERMANENTLY out of scope.** E014 only REACTS to provider events; it never initiates charges and never stores card/PAN data. This is a hard PRD product/security boundary (PCI-out-of-scope), not an MVP simplification, so it belongs in the project record.
- **Delivery is at-least-once, out-of-order, and lossy.** Provider webhooks can be redelivered, arrive in the wrong order, and be dropped entirely; signatures must be verified before any processing; handling must be idempotent; lockout must be grace-first (customer-friendly dunning); and the integration must be provider-agnostic.
- **The pattern is reusable.** How the system verifies, normalizes, dedupes, applies, and self-heals external events is the same shape a future usage-metering / consumption epic (E015+/CAP-011) would reuse, so the *pattern* — not just this epic's endpoint — is a project-wide freeze point.

The decision must also stay consistent with what is already committed elsewhere and NOT re-decide it:

- **E008 owns the license lifecycle.** `license.status ∈ {active, suspended, revoked}` (revoked terminal); the suspend/reinstate/revoke/issue transitions and the offline-verifiable LIC1 token semantics are E008's (`specs/00009-license-issuance-and-lifecycle/data-model.md`). E008 has NO grace state, and the offline token deliberately excludes `status` (the disclosed offline-revocation gap). E014 must DRIVE these transitions, not re-implement or mutate them.
- **E013 owns client propagation.** Suspension/revocation reaches connected clients via the online validate/heartbeat non-reissue + signed-CRL model (ADR-0010). E014 sets `license.status`; E013 propagates it. E014 introduces no new client enforcement path.
- **E004 owns license signing.** The Ed25519 per-product signer/keyring in KMS/HSM (ADR-0003) is the single crypto core (Principle III). The provider webhook signing secret is an inbound-verification secret of a *different class*, and must not be conflated with or co-mingled into license-key custody.

What this ADR decides: the external-event → license-lifecycle **model** — how billing events are ingested, normalized, mapped onto the E008 lifecycle, made resilient to faulty delivery, and kept inside the PCI boundary — as one project-level contract that E014 implements and future external-event sources can reuse.

## Decision Drivers

- **Permanent payment/card boundary (PRD hard boundary)**: never initiate a charge, never store card/PAN data; record only billing-lifecycle metadata. PCI scope must be structurally avoided, not merely "not done yet".
- **Correctness under at-least-once / out-of-order / lossy delivery**: exactly-once application, no stale-event regression, and recovery from dropped deliveries are mandatory, not best-effort.
- **Provider-agnostic**: adding Stripe, then Paddle, then another provider must not touch core lifecycle logic; provider quirks stay at the edge.
- **Additive to E008 — do not mutate the enforcement truth**: the `license.status` enum and the offline LIC1 token semantics must stay unchanged; billing state is an overlay, not a new license status.
- **Reuse the single security core (Principle III)**: lifecycle transitions call E008 services, client propagation is E013's, license signing stays E004's — no second crypto core, no re-implemented lifecycle.
- **Grace-before-lockout**: standard dunning behaviour — a bounded, configurable, recoverable grace window, not instant lockout, and not one-way.
- **Multi-tenant isolation (Principle II)**: a provider connection's events only ever affect that tenant's licenses/subscriptions.
- **Secret custody discipline (Principle I posture)**: the inbound-HMAC webhook secret is a distinct secret class from the E004 license signing key, `<VAR>_FILE`/encrypted-at-rest, never API-returned, rotatable with a transition window.
- **Reusable ingestion pattern**: the adapter + idempotency + reconciliation shape should generalize to future external-event sources (metering).

## Considered Options

### Option A: Verify→dedupe→apply ingestion, provider-agnostic adapters, a billing overlay on E008, a recency guard + reconciliation, and a permanent PCI boundary (composite model)

Adopt one integration model with six parts:

1. **Ingestion = verify → dedupe → apply.** Verify the provider HMAC signature over the RAW request body plus a timestamp recency check (default ~5 min) BEFORE any processing; an invalid/missing/stale signature is rejected inline (4xx) and NEVER enqueued or dead-lettered. Dedupe by the provider event id, recorded TRANSACTIONALLY in the same commit as the side effect, giving exactly-once application under at-least-once delivery. Acknowledge fast; decouple durable processing from acknowledgement.
2. **Provider-agnostic adapters.** A thin per-provider adapter normalizes each provider into ONE internal canonical event model (type, subscription id, tenant, occurred-at, provider event id). Provider-specific parsing/signature schemes live only in the adapter; provider quirks never leak into core lifecycle logic.
3. **Grace as an overlay on E008 (NOT a new license status).** A subscription↔license link plus a billing overlay (`billing_state`, `grace_expires`, `last_applied_event_at`) drives the E008 `active↔suspended` lifecycle: created/activated → provision/activate (via E008); renewal/payment → extend + keep active; canceled/payment-failed → grace (license stays usable) → auto-suspend via a SCHEDULED job when grace elapses; refund/chargeback → revoke (terminal); recovery-on-payment → reinstate. The E008 `status` enum and the offline LIC1 token semantics are UNCHANGED (purely additive tables/columns).
4. **Ordering + resilience.** A stale-event recency guard ignores any event older than `last_applied_event_at`, so out-of-order delivery cannot regress state; a periodic provider RECONCILIATION job syncs authoritative subscription state from the provider API to self-heal missed/dropped deliveries; unmapped or failed-after-ack events are DEAD-LETTERED for operator attention; signature/schema failures are rejected inline and never dead-lettered.
5. **Permanent PCI boundary.** E014 NEVER initiates charges and stores NO card/PAN data — only billing-lifecycle metadata (subscription id, billing state, event ids). The webhook signing secret is a PROVIDER INBOUND-HMAC secret, a distinct secret class from the E004 Ed25519 license signing key, delivered via `<VAR>_FILE`/encrypted-at-rest, never returned by any API, rotatable with a transition window (old + new accepted concurrently).
6. **Reuse, don't re-implement.** Lifecycle transitions call the E008 services; client propagation is E013's; there is no new crypto core and no new client verifier.

- **Pros**: External billing drives entitlements automatically (closes the revenue-leakage + operational-toil gap); PCI scope is structurally avoided; provider-agnostic and resilient to at-least-once/out-of-order/lossy delivery; additive to E008 so the enforcement truth (`status`) and the offline token are untouched; reuses E008/E013/E004 with no second crypto core (Principle III); tenant-scoped (Principle II); the adapter + idempotency + reconciliation shape is directly reusable by future external-event sources (metering).
- **Cons**: Adds a webhook-ingestion surface plus two scheduled workers (grace-expiry auto-suspend, provider reconciliation) to build and operate; introduces a second inbound secret class to provision/rotate; billing state and license `status` are two coordinated stores that must be kept consistent (the recency guard + reconciliation are exactly the mechanisms that keep them so).

### Option B: Grant entitlements on checkout-success instead of on webhook-confirmed state

Provision/activate the license from the client-side checkout-success redirect rather than from the provider's confirmed subscription webhook.

- **Pros**: Simplest happy path; entitlement appears instantly at checkout with no webhook plumbing.
- **Cons**: Unreliable and insecure — the checkout redirect is client-controlled and races the provider's asynchronous billing confirmation; a payment can later fail, be reversed, or never settle while the license is already granted; it observes only the create moment, not the ongoing renew/cancel/refund lifecycle E014 exists to track. Rejected.

### Option C: Add a `grace` value to the E008 `license.status` enum

Represent the grace window as a new first-class license status alongside `active/suspended/revoked`.

- **Pros**: A single explicit status field encodes billing state; no separate overlay table.
- **Cons**: Mutates the E008 `status` enum and, by extension, the offline LIC1 token semantics — every verifier, every downstream consumer (E009 activation, E013 enforcement), and the token schema would have to learn a new status, breaking the "additive, `status` is the enforcement truth" invariant. Grace is a billing concept, not an enforcement state: during grace the license IS `active` (usable). The additive overlay keeps `status` clean and lets grace expiry resolve to a normal E008 `active→suspended` transition. Rejected.

### Option D: Instant suspend on the first payment failure

Move the license out of usable state as soon as a single payment-failed/cancel event arrives.

- **Pros**: Strictest possible enforcement; zero post-nonpayment usage.
- **Cons**: Customer-hostile and out of step with how billing actually works — providers run dunning/smart-retries for days-to-weeks after a failed charge, and a transient card decline is common and recoverable. Instant lockout punishes paying customers for provider-side retry latency. Grace/dunning is the standard, expected behaviour. Rejected.

### Option E: Map `canceled` straight to terminal revoke

Treat a subscription-cancelled (or payment-failed) event as a terminal revocation.

- **Pros**: Simple, one mapping; no grace/suspend intermediate state.
- **Cons**: Kills recovery — `revoked` is terminal in E008, so a re-subscribe, a late successful payment, or a reactivation could not reinstate the license, forcing manual re-issuance. Cancel/non-payment is a recoverable condition and maps to SUSPEND (reversible); only true value-reversal (refund/chargeback) maps to terminal revoke. Rejected.

### Option F: Webhooks-only, with no reconciliation

Rely solely on incoming webhooks to keep license state correct; add no polling/reconciliation safety net.

- **Pros**: Less infrastructure — no reconciliation worker, no provider-API polling.
- **Cons**: Delivery is lossy, so a single dropped cancel/refund webhook leaves a license in the wrong state indefinitely (e.g. active after cancellation) with no self-healing path — precisely the revenue-leakage failure E014 exists to close. A periodic authoritative reconciliation against the provider API is required to bound drift from missed deliveries. Rejected.

## Decision Outcome

Chosen option: **Option A — the composite verify→dedupe→apply / provider-agnostic-adapter / E008-billing-overlay / recency-guard-plus-reconciliation / permanent-PCI-boundary model** — because it is the only option that automates entitlements from confirmed billing state while staying correct under at-least-once/out-of-order/lossy delivery, provider-agnostic, additive to the E008 enforcement truth, inside the PCI boundary, and reusing the single security core (E008 lifecycle, E013 propagation, E004 signer). Concretely, the model is fixed as:

1. **Ingestion = verify → dedupe → apply.** Raw-body HMAC signature verification + a ~5 min timestamp recency check happen BEFORE any processing; failures are rejected inline (4xx), never enqueued or dead-lettered. Deduplication is keyed on the provider event id and recorded transactionally with the side effect, so at-least-once redelivery is applied exactly once; the endpoint acknowledges fast with durable processing decoupled from ack.
2. **Provider-agnostic adapters.** Thin per-provider adapters normalize each provider (Stripe/Paddle/…) into ONE internal canonical event model (type, subscription id, tenant, occurred-at, provider event id). Core lifecycle logic sees only the canonical model; provider quirks never leak past the adapter.
3. **Grace = an additive overlay on E008, NOT a new license status.** A subscription↔license link plus a billing overlay (`billing_state`, `grace_expires`, `last_applied_event_at`) drives the E008 `active↔suspended` lifecycle: created/activated → provision/activate; renewal/payment → extend + clear grace; canceled/payment-failed → grace (still usable) → auto-suspend via a SCHEDULED job when grace elapses; refund/chargeback → revoke (terminal); recovery-on-payment → reinstate. The E008 `status` enum and offline LIC1 token semantics are UNCHANGED.
4. **Ordering + resilience.** A stale-event recency guard (ignore events older than `last_applied_event_at`) plus a periodic provider RECONCILIATION job (authoritative provider-API sync) self-heal out-of-order and missed deliveries; unmapped / failed-after-ack events are DEAD-LETTERED for operator attention; signature/schema failures are rejected inline and never dead-lettered.
5. **Permanent PCI boundary.** E014 NEVER initiates charges and stores NO card/PAN data — only billing-lifecycle metadata (subscription id, billing state, event ids). The webhook signing secret is a PROVIDER INBOUND-HMAC secret — a distinct secret class from the E004 Ed25519 license signing key — delivered via `<VAR>_FILE`/encrypted-at-rest, never returned by any API, rotatable with a transition window.
6. **Reuse, don't re-implement.** Lifecycle transitions call the E008 services; client propagation is E013's (ADR-0010); no new crypto core and no new client verifier.

This ADR fixes the external-event → license-lifecycle MODEL and the permanent PCI/secret boundary. It does not re-decide the E008 lifecycle/token semantics, the E013 propagation model, or the E004 signing-key custody, all of which are reused unchanged.

## Consequences

### Positive

- External billing drives entitlements automatically — provisioning, renewal-extension, grace, auto-suspend, revoke, and recovery track confirmed provider state with no admin action, closing the revenue-leakage and operational-toil gaps (CAP-009).
- PCI scope is structurally avoided: no charges are ever initiated and no card/PAN data is ever stored, so the billing tables and event ledger stay outside PCI and inherit the existing GDPR/data-minimization posture.
- The integration is provider-agnostic and resilient to faulty delivery: adapters isolate provider quirks, idempotency handles at-least-once redelivery, the recency guard handles out-of-order, and reconciliation heals lossy/missed deliveries.
- E008 stays the single enforcement truth: `license.status` and the offline LIC1 token are untouched; billing state is a clean additive overlay, so verifiers and E009/E013 consumers need no changes.
- The single security core is preserved (Principle III): lifecycle transitions reuse E008 services, client propagation reuses E013 (ADR-0010), and license signing stays with the E004 Ed25519 signer — no second crypto core, no second client verifier.
- The adapter + transactional-idempotency + reconciliation pattern is directly reusable by future external-event sources such as usage-metering/consumption billing (E015+/CAP-011).

### Negative

- Adds operational surface: a webhook-ingestion endpoint plus two scheduled workers — grace-expiry auto-suspend and provider reconciliation — that must be run, monitored, and kept fail-open.
- Introduces a second inbound secret class (the provider HMAC webhook secret) to provision, store `<VAR>_FILE`/encrypted-at-rest, and rotate with a transition window, distinct from the E004 license key.
- Billing state and license `status` are two coordinated stores; keeping them consistent depends on the recency guard, transactional dedup, and reconciliation working correctly (a dead-letter path captures the residual unmapped/failed cases for operator attention).

### Neutral

- Revocation staleness for connected clients remains bounded by the E013 propagation window (ADR-0010): E014 sets `license.status` promptly, but the moment a client sees it is governed by E013, not by this decision.
- Grace default durations are configurable per plan/policy (on the order of the provider's dunning window, e.g. ~2 weeks); tuning them is an operator policy choice, not an architectural one.
- Reconciliation cadence and webhook retry/rate-limit tuning are operational parameters within this model, not separate architectural decisions.

## Links

- specs/00015-billing-driven-entitlement-automation/spec.md — E014 (FR-001..FR-021, US1..US6, SC-001..SC-010); the billing-webhook ingestion, grace/suspend, revoke, reconciliation, and PCI-boundary requirements this ADR fixes the model for.
- specs/00015-billing-driven-entitlement-automation/research.md — verify-then-dedupe-then-apply, grace-before-lockout, out-of-order/reconciliation, and provider-agnostic/PCI posture research grounding this decision.
- specs/00009-license-issuance-and-lifecycle/data-model.md — E008 `license.status ∈ {active,suspended,revoked}` (revoked terminal), the suspend/reinstate/revoke transitions, and the offline-token semantics this ADR drives without mutating (the billing overlay is additive).
- specs/00014-online-enforcement-and-revocation/spec.md — E013 online enforcement; suspension/revocation set by E014 propagate to connected clients here.
- ADR-0010 (Online-Enforcement Token and Revocation Model) — the client-propagation model E014 relies on to reach connected clients (E014 sets status, E013 propagates).
- ADR-0003 (Signing-Key Custody & Scope) — the E004 per-product Ed25519 signing key, a distinct secret class from the provider inbound-HMAC webhook secret introduced here.
- ADR-0004 (Multi-Tenancy Isolation Model) — the tenant-scoping this decision inherits (a connection's events only affect that tenant's licenses).
- ADR-0005 (Architecture Style — Modular Monolith) — the module seams the billing-ingestion + scheduled workers slot into.
- specs/sad.md — Integration Strategy (billing-provider webhooks are P2) and the optional-billing-provider external dependency.
- PRD CAP-009 (billing-driven entitlement automation) and the PRD payment/card hard boundary (PCI-out-of-scope); project-instructions.md Principle II (multi-tenant isolation) and Principle III (single security core, fully audited).
