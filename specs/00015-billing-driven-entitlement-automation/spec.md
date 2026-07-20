---
feature_branch: "00015-billing-driven-entitlement-automation"
created: "2026-07-19"
input: "E014 — Automate license lifecycle from billing webhooks with grace periods"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E014"
epic_sources: "{PRD:CAP-009}"
---

# Feature Specification: Billing-driven Entitlement Automation

**Feature Branch**: `00015-billing-driven-entitlement-automation`
**Created**: 2026-07-19
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E014
**Epic Sources**: {PRD:CAP-009}

## Problem Statement *(mandatory)*

Today a license's lifecycle is driven only by an admin acting in the console — so keeping entitlements in sync with what a customer has actually paid for is manual: a cancellation, a failed payment, or a refund does not automatically change the customer's access, and a new subscription does not automatically provision a license. This drives revenue leakage (refunded/lapsed customers keep working) and operational toil (every packaging or payment change is a manual admin action). E014 connects an external billing provider so its subscription and payment webhooks automatically provision, extend, grace, suspend, or revoke licenses — with configurable grace periods, verified signatures, and idempotent handling — affecting vendors/operators who sell subscription licenses and the end-customers whose access should track their billing status.

## Scope *(mandatory)*

### Included

- **Webhook ingestion** — a signed billing-webhook endpoint that verifies the provider signature and dedups deliveries before processing.
- **Subscription→license mapping** — provider subscription/payment events drive the E008 license lifecycle: provision/activate on create, extend on renewal/payment, grace→suspend on cancel/payment-failure, revoke on refund/chargeback.
- **Grace periods** — a configurable window after cancel/payment-failure during which the license stays usable, then auto-suspends; a successful payment during grace restores it.
- **Subscription↔license linkage** — each managed license is linked to its external subscription so events resolve to exactly one license.
- **Operator configuration** — connect a billing provider (type + signing secret) and configure the subscription-plan→catalog-plan mapping + grace policy.
- **Out-of-order / missed-event handling** — a recency guard so stale events don't override newer state, plus a reconciliation job that self-heals drift against the provider.
- **Audit + dead-letter** — every billing-driven mutation is audited with its triggering event id; unmapped/failed events are recorded for operator attention.

### Excluded

- **Payment processing / charging / card data** — PERMANENTLY out of scope; E014 only REACTS to events, never initiates charges or stores card/PAN data (PCI-out-of-scope). Rationale: a hard product/security boundary (PRD).
- **The lifecycle transitions themselves** (suspend/reinstate/revoke/issue) — owned by E008; E014 drives them, it does not re-implement them. Rationale: reuse.
- **Online propagation of suspension/revocation to clients** — owned by E013 (validate/heartbeat non-reissue + CRL); E014 sets `license.status`, E013 propagates. Rationale: separate epic.
- **Usage-metered / consumption billing** — E015+/CAP-011 (P3). Rationale: separate epic.
- **A full billing/invoicing UI** — the operator config is the minimal connection + mapping + grace policy; rich billing dashboards are deferred. Rationale: keep the MVP focused on automation.

### Edge Cases & Boundaries

- Invalid/missing webhook signature → rejected with no state change (never enqueued/processed).
- Duplicate delivery (same provider event id) → idempotent no-op returning success; applied at most once.
- Out-of-order/stale event (older than the license's last-applied event time) → ignored; never overrides newer state.
- A webhook for an unknown/unmapped subscription or unhandled event type → dead-lettered for operator attention, not silently dropped.
- Grace elapses while the app is down → the scheduled grace job suspends on next run (grace expiry is time-driven, not solely webhook-driven).
- A successful payment arrives after auto-suspend but the subscription is active again → the license is reinstated (recovery still possible from `suspended`).
- Refund/chargeback → revoke (terminal); a later event MUST NOT resurrect a revoked license.
- Signing-secret rotation → both old and new secrets accepted during a transition window.
- A provider retry storm → the endpoint is rate-limited and acks fast; processing stays idempotent.
- Multi-tenant: a provider connection's events only affect that tenant's licenses (tenant-scoped).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Verified, idempotent webhook ingestion (Priority: P1)

The billing provider POSTs subscription/payment events to a webhook endpoint; the server verifies the signature over the raw body before processing and dedups duplicate deliveries, so events reliably drive license lifecycle without forgery or double-application.

**Why this priority**: The security + reliability substrate every other billing behaviour depends on — it delivers two of the epic's three acceptance criteria (idempotent, signature-verified) and blocks everything else.

**Independent Test**: Send a validly-signed event → accepted + processed once; send the same event id again → idempotent no-op; send an event with a bad/missing signature → rejected with no state change.

**Acceptance Scenarios**:

1. **Given** a webhook with a valid provider signature (and in-tolerance timestamp), **When** it is received, **Then** it is accepted and processed.
2. **Given** a webhook with a missing or invalid signature, **When** it is received, **Then** it is rejected (4xx) and no license state changes.
3. **Given** a webhook already processed (same provider event id), **When** it is delivered again, **Then** it is an idempotent no-op — the license state is applied exactly once.

### User Story 2 - Subscription lifecycle drives license lifecycle (Priority: P1)

Provider subscription/payment events automatically provision, activate, and extend licenses: a subscription created/activated provisions or activates a license per the configured plan mapping, and a renewal or successful payment extends it — so entitlements track billing without an admin acting.

**Why this priority**: The core value of the epic (CAP-009 — "subscription events provision licenses"); automation of the happy path.

**Independent Test**: A subscription-created event provisions/activates a linked license per the plan mapping; a renewal/payment event extends the license's term and keeps it active.

**Acceptance Scenarios**:

1. **Given** a configured subscription-plan→catalog-plan mapping, **When** a subscription-created/activated event arrives, **Then** a license is provisioned (issued/activated) and linked to that subscription.
2. **Given** an active linked license, **When** a renewal / invoice-paid event arrives, **Then** the license term is extended and it remains active (any grace/past-due state cleared).
3. **Given** a billing-driven change, **When** it is applied, **Then** it is audited with the triggering provider event id.

### User Story 3 - Grace period on cancel/payment-failure, then auto-suspend (Priority: P1)

A cancelled or payment-failed subscription puts its license into a bounded, configurable grace window during which it stays usable; if the window elapses with no recovery the license is automatically suspended, and a successful payment during grace restores it.

**Why this priority**: The epic's first acceptance criterion and the customer-friendly core — grace avoids instant lockout while still enforcing non-payment.

**Independent Test**: A subscription-cancelled (or payment-failed) event moves the license into grace (still usable); after the grace window elapses with no payment, the license is auto-suspended; a payment during grace restores it to active.

**Acceptance Scenarios**:

1. **Given** an active linked license, **When** a subscription-cancelled or payment-failed event arrives, **Then** the license enters a grace window (still usable) with a recorded grace-expiry, and is not immediately suspended.
2. **Given** a license in grace, **When** the grace window elapses with no recovering payment, **Then** the license is automatically suspended (time-driven, even if no further webhook arrives).
3. **Given** a license in grace, **When** a successful payment / reactivation event arrives, **Then** the license is restored to active and grace is cleared.

### User Story 4 - Refund / chargeback → revocation (Priority: P2)

A refund or chargeback event revokes the license (terminal), so a refunded or disputed customer loses access — closing the revenue-leakage gap — with the revocation propagated to clients by the online-enforcement layer.

**Why this priority**: Directly addresses the "misused/refunded → revoke access" pain, but it is a lower-frequency event than the renew/cancel happy path, so it follows the P1 core.

**Independent Test**: A refund/chargeback event on a linked subscription revokes the license; a subsequent event does not resurrect it (revoked is terminal).

**Acceptance Scenarios**:

1. **Given** a linked active or grace/suspended license, **When** a refund/chargeback event arrives, **Then** the license is revoked (terminal).
2. **Given** a revoked license, **When** any later billing event for that subscription arrives, **Then** it does not resurrect the license (revoked is terminal, idempotent).

### User Story 5 - Operator connects a provider & configures policy (Priority: P2)

An operator connects a billing provider (type + webhook signing secret) and configures the subscription-plan→catalog-plan mapping and grace-period policy, so packaging and billing changes are made without an engineering release.

**Why this priority**: Enables the no-code promise (PRD) and is required to run the automation for real, but the automation logic (US1–US3) can be tested with a seeded connection, so it follows the core flows.

**Independent Test**: An operator creates a billing connection (provider + secret) and a plan mapping + grace policy through the operator surface, and a subsequent webhook is verified and mapped using that configuration.

**Acceptance Scenarios**:

1. **Given** the operator surface, **When** the operator adds a provider connection with its signing secret and a plan mapping + grace duration, **Then** the configuration is stored (the secret never returned) and used to verify/map incoming webhooks.
2. **Given** a stored connection, **When** the operator rotates the signing secret, **Then** both the old and new secret are accepted during a transition window.

### User Story 6 - Reconciliation & missed-event recovery (Priority: P3)

A periodic (or on-demand) reconciliation reconciles license state against the billing provider to recover from missed, dropped, or out-of-order webhooks, so a lost delivery does not leave a license in the wrong state.

**Why this priority**: A resilience safety net; the webhook path (US1–US4) delivers correct state in the common case, and reconciliation hardens against delivery gaps — valuable but not required for the MVP.

**Independent Test**: Simulate a missed cancel webhook (license left active while the provider shows cancelled) → run reconciliation → the license is corrected (moved to grace/suspended per policy).

**Acceptance Scenarios**:

1. **Given** a license whose state has drifted from the provider (a missed webhook), **When** reconciliation runs, **Then** the license is corrected to match the provider's authoritative subscription state.
2. **Given** an out-of-order event older than the license's last-applied event, **When** it is processed, **Then** it is ignored and does not override the newer state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose a billing-webhook endpoint that receives an external provider's subscription and payment events.
- **FR-002**: System MUST verify the webhook signature over the RAW, unparsed request bytes — using a constant-time (timing-attack-resistant) comparison of at least an HMAC-SHA256 digest (the provider signature-header scheme, e.g. `t=<ts>,v1=<hmac>`, parsed by the per-provider adapter) — BEFORE any JSON parse, body mutation, or other processing, together with a timestamp recency check whose tolerance is a configurable value (default 300 seconds / 5 minutes) that rejects any signed timestamp outside the window in EITHER direction (stale OR future-dated / negative-skew). A missing, malformed/unparseable, or mismatched signature and an out-of-tolerance timestamp are EACH rejected inline with no state change (never enqueued, never dead-lettered).
- **FR-003**: System MUST process each event idempotently — deduped by the provider event id via a UNIQUE constraint whose insert is committed transactionally with its side effect — so an at-least-once redelivery is applied at most once EVEN under concurrent/simultaneous in-flight redeliveries of the same event id (a racing delivery conflicts on the UNIQUE and is a no-op); a duplicate returns success without re-applying.
- **FR-004**: System MUST normalize provider events into an internal canonical model and map them to license actions via a configurable event→action mapping (provider-specific parsing isolated in adapters).
- **FR-005**: On a subscription created/activated event, System MUST provision a license linked to that subscription per the configured plan mapping — issuing a NEW license via E008 when the subscription has no existing link, and activating/reusing the already-linked license when one exists (idempotent re-creation resolves to the existing link).
- **FR-006**: On a renewal / successful-payment event, System MUST extend the linked license (update term, keep active) and clear any grace/past-due state.
- **FR-007**: On a cancellation or payment-failure event, System MUST move the linked license into a bounded grace window (remaining usable) and record its grace-expiry, without immediate suspension.
- **FR-008**: When a grace window elapses with no recovering payment, System MUST automatically suspend the license — driven by a scheduled job, not solely by webhook arrival.
- **FR-009**: On a successful payment / reactivation during grace, or from a billing-suspended license, System MUST restore the license to active and clear grace. Recovery is always permitted from `suspended` (only `revoked` is terminal — a revoked license is never resurrected, FR-010).
- **FR-010**: On a refund or chargeback event, System MUST revoke the linked license (terminal); a revoked license MUST NOT be resurrected by any later event.
- **FR-011**: Grace-period durations MUST be configurable (per plan/policy), each a positive duration, with a sane default on the order of the provider dunning window (default ~14 days).
- **FR-012**: System MUST link each managed license to its external subscription (subscription id ↔ license) and persist the billing/subscription state so every event resolves to exactly one license.
- **FR-013**: All billing-driven lifecycle mutations MUST be audited (append-only) with the triggering provider event id; when a mutation has no provider event id — a time-driven grace auto-suspend (FR-008) or a reconciliation-driven correction (FR-017) — the audit MUST record a synthetic system triggering source (a system/worker actor plus the affected subscription id, and the reconciliation job/snapshot reference where applicable) so every mutation remains attributable.
- **FR-014**: All billing operations MUST be tenant-scoped — a provider connection's events only affect that tenant's licenses/subscriptions.
- **FR-015**: System MUST let an operator configure a provider connection — provider type, the subscription-plan→catalog-plan mapping, and the grace policy — and set/rotate the webhook signing secret. The secret's at-rest custody, non-return, non-logging, and rotation-window semantics are governed by FR-022.
- **FR-016**: System MUST guard against out-of-order/stale events — an event older than the license's last-applied event MUST NOT override newer state.
- **FR-017**: System MUST provide reconciliation (periodic and/or on-demand) that reconciles license state against the provider's authoritative subscription state to recover from missed/dropped webhooks.
- **FR-018**: System MUST NOT initiate payments/charges and MUST NOT accept, parse, log, or store card/PAN data — defined as PAN, CVV, expiry, cardholder name, full billing address, or any raw customer PII beyond the pseudonymous E008 `customer` reference. This is a VERIFIABLE structural negative: no outbound charge / payment-initiation code path exists (provider interaction is limited to INBOUND webhook ingestion and READ-ONLY reconciliation reads), and the no-card-data boundary applies equally to the webhook ingest path AND the reconciliation ingest path (provider-API-pulled state is subject to the same minimized, allow-listed persistence). E014 only reacts to events (PCI-out-of-scope).
- **FR-019**: The webhook endpoint MUST acknowledge quickly (target p95 < 200 ms) and be rate-limited at two granularities — per resolved connection AND per source IP — where the per-IP (pre-resolution) limit bounds a flood of unknown/invalid `{connectionId}` values BEFORE signature verification, so pre-authentication traffic that cannot be keyed on a resolved connection is still bounded. The threshold is a bounded, configurable value (documented sane default, e.g. 100 requests/minute) and an over-limit delivery is refused `429` with a `Retry-After` header; reliable (durable) processing is decoupled from acknowledgement, and a shed (429) delivery relies on the provider's at-least-once retry (never silently lost).
- **FR-020**: An unmapped/unhandled or failed-after-ack event MUST be recorded (dead-letter / needs-attention) for operator visibility, never silently dropped; a signature/schema failure is rejected inline (not dead-lettered).
- **FR-021**: Billing/subscription metadata and the billing-event ledger MUST inherit the existing GDPR posture — customer identifiers minimized/salted per E008, retention-bounded, and deletable — so the new billing tables are covered by the project's data-minimization and erasure guarantees (the no-card/PAN-data boundary is governed by FR-018). The billing-event ledger retention horizon MUST be a measurable, configurable upper bound (default 365 days on `received_at`) that MUST remain above the idempotency/anti-replay floor (it MUST exceed the provider retry window and be ≥ 48h), reconciling the retention FLOOR (idempotency, FR-003) with the GDPR minimization CEILING.
- **FR-022**: The provider inbound-HMAC webhook signing secret MUST be envelope-encrypted (or held as an opaque `<VAR>_FILE`/KMS reference) at rest — NEVER stored in plaintext — MUST never be logged, and MUST never be returned by ANY API surface (success responses, error bodies, logs, diagnostics, or the `billing_connection_public` connection read projection). Rotation MUST keep the previous secret valid only for a bounded, configurable transition window (default 24 hours), after which the previous secret is dropped/nulled so a superseded secret is not accepted indefinitely.

### Key Entities

- **License** *(E008, reused — `specs/00009-license-issuance-and-lifecycle/`)*: `status` (active/suspended/revoked; revoked terminal); E014 drives its lifecycle from billing and links it to a subscription; suspension/revocation propagate to clients via E013.
- **Subscription** *(new)*: the external subscription ↔ license linkage — provider, external subscription id, tenant, billing state (active/past_due/grace/canceled/refunded), grace-expiry, and the last-applied event time (for the recency guard).
- **Billing event** *(new)*: the received, signature-verified, deduped webhook — provider, event id (idempotency key), type, occurred-at, processing outcome; an append-only ledger; unmapped/failed entries flagged for dead-letter.
- **Billing connection / policy** *(new)*: per-tenant provider connection — type, webhook signing secret(s) (rotation), the subscription-plan→catalog-plan mapping, and grace-period durations.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The billing provider sends SIGNED webhooks (HMAC + timestamp, Stripe-style) for subscription and payment lifecycle events.
- E008 issuance + lifecycle (suspend/reinstate/revoke/issue) are the mechanisms E014 drives; E013 propagates suspension/revocation to connected clients.
- The operator maps each billing plan to a catalog plan and a customer record exists or is created at provisioning.
- Payment processing, retries/dunning, and card handling are performed entirely by the external provider — never by LicenseSrv.
- Grace defaults (on the order of the provider's dunning window, e.g. ~2 weeks) are acceptable and per-plan tunable.

### Risks

- **At-least-once, out-of-order, and dropped webhook delivery** *(likelihood: high, impact: medium)*: mitigate via idempotency (event-id dedup), a stale-event recency guard, and periodic reconciliation.
- **A missed webhook leaves a license in the wrong billing state** *(likelihood: medium, impact: medium)*: mitigate via the reconciliation job (authoritative provider sync).
- **Provider signature/event-schema differences** *(likelihood: medium, impact: low)*: mitigate via a thin per-provider adapter normalizing to one internal model.

## Implementation Signals *(mandatory)*

- `NEW-API` — a billing-webhook ingestion endpoint plus operator config endpoints (connection, plan mapping, grace policy).
- `MIGRATION` — new subscription + billing-event tables and a billing/grace overlay linking licenses to subscriptions; additive (no change to E008 license columns/enum).
- `EXTERNAL-SERVICE` — the billing provider (Stripe/Paddle/…) sending signed webhooks; the reconciliation job calls its API.
- `NEW-WORKER` — a scheduled grace-expiry/auto-suspend job and a reconciliation job (both fail-open).
- `NEW-CONFIG` — provider connection secret (`<VAR>_FILE`), grace-period durations, the plan mapping.
- `NEW-UI` — a minimal operator surface (billing connection + mapping + grace policy) in the admin console.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A webhook with an invalid/missing/stale/future-skewed signature (timestamp outside tolerance in either direction) is rejected with no license state change; a validly-signed, in-tolerance one is accepted and processed.
- **SC-002** [US1]: A duplicate webhook delivery (same provider event id), whether sequential OR concurrent/simultaneous in-flight, is idempotent — the license state is applied exactly once (a UNIQUE conflict yields a no-op).
- **SC-003** [US2]: A subscription-created event provisions/activates a license linked to the subscription per the plan mapping; a renewal/payment event extends it and keeps it active.
- **SC-004** [US3]: A subscription-cancelled (or payment-failed) event moves the license into grace (still usable), and after the grace window elapses with no recovery the license is automatically suspended.
- **SC-005** [US3]: A successful payment during grace restores the license to active and clears grace.
- **SC-006** [US4]: A refund/chargeback event revokes the license, and a later event does not resurrect it.
- **SC-007** [US5]: An operator can connect a provider and configure the plan mapping + grace policy without a code change, and the signing secret is never returned by any API.
- **SC-008** [US2]: Every billing-driven lifecycle mutation is auditable to its triggering source — a provider event id for webhook-driven changes, or a synthetic system source (grace/reconciliation worker) + the affected subscription for time-driven changes (FR-013).
- **SC-009** [US6]: Reconciliation corrects a license whose state drifted from the provider due to a missed webhook.
- **SC-010** [US6]: An out-of-order/stale event does not override a newer license state.
- **SC-011** [US1]: All billing operations are tenant-scoped — tenant A's connection/webhook cannot read or mutate tenant B's subscription/license/events (a cross-tenant reference resolves to not-found under RLS) (FR-014).
- **SC-012** [US1]: No card/PAN data is present in any stored billing metadata (the ledger `payload_summary`), and the system initiates no outbound charge (no payment-initiation path exists) (FR-018).
- **SC-013** [US1]: An over-limit webhook flood is throttled (429 + Retry-After) at both per-connection AND per-source-IP granularity (the per-IP limit bounds unknown/invalid `{connectionId}` floods before signature verification), while valid in-tolerance events are still accepted (FR-019).
- **SC-014** [US5]: The webhook signing secret is never returned by any API and never logged; once a rotation transition window closes, the superseded previous secret is dropped (FR-022).
- **SC-015** [US1]: Billing-event ledger metadata is retention-bounded (default 365 days, floored above the provider retry window / ≥ 48h) and deletable per GDPR (FR-021).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Billing provider | The external system (Stripe/Paddle/…) that charges customers and emits subscription/payment webhooks; LicenseSrv reacts to it and never charges. |
| Webhook | A signed HTTP event the provider POSTs on a subscription/payment lifecycle change. |
| Idempotency (event id) | Applying each provider event at most once, deduped by its unique event id, despite at-least-once redelivery. |
| Subscription | The external recurring-billing record, linked 1:1 to a managed license. |
| Grace period | A bounded, configurable window after cancel/payment-failure during which the license stays usable before auto-suspend. |
| Dunning | The provider's payment-retry process after a failed charge; grace tracks it on the entitlement side. |
| Reconciliation | A periodic/on-demand sync of license state against the provider's authoritative subscription state to recover from missed webhooks. |
| Dead-letter | A record of an unmapped/unhandled or failed-after-ack event kept for operator attention rather than dropped. |
| Provisioning | Issuing/activating a license (via E008) in response to a subscription-created event. |
| Stale-event guard | Ignoring an event older than the license's last-applied event so out-of-order delivery can't regress state. |

## Compliance Check

**Verdict: PASS** — no CRITICAL violations. The payment/card boundary, no-new-key-custody, tenant isolation, audit, and the four webhook security controls are explicit and internally consistent; the billing provider remains an optional P2 add-on, not a hard core dependency.

**Satisfied principles**:
- **Payment/card boundary** (PRD hard boundary) — FR-018 + Scope→Excluded §1 + Assumptions: payment processing/charging/card-PAN data PERMANENTLY out of scope (PCI-out-of-scope), consistent across the spec.
- **I. Offline-First / signing keys never exposed** — provisioning issuance is delegated to E008 (FR-005), so the E004 Ed25519 signer + key custody are untouched (no new crypto/key); the webhook signing secret is a distinct provider inbound-HMAC secret handled via `<VAR>_FILE` and never returned by any API (FR-015/SC-007).
- **II. Multi-tenant isolation** — FR-014: webhook/subscription/license ops tenant-scoped; a connection's events only affect that tenant's licenses.
- **III. Single security core, audited** — reuses the E008 lifecycle (no re-implemented crypto; FR-002 HMAC is provider-auth, not license Ed25519 verification); FR-013 audits every billing-driven mutation append-only, attributed to the triggering provider event id OR a synthetic system source (grace/reconciliation worker) + subscription (SC-008).
- **Webhook security controls** — signature-verify-before-processing + timestamp recency + constant-time (FR-002/SC-001), idempotency/anti-replay by event id incl. concurrent races (FR-003/SC-002), rate-limiting per-connection + per-source-IP (FR-019/SC-013), secret custody envelope-encrypted + never-returned/never-logged + rotatable with a drop-after-window (FR-022/SC-014), no card/PAN + retention-bounded ledger (FR-018/FR-021/SC-012/SC-015), tenant isolation (FR-014/SC-011).
- **Cloud-agnostic / self-host** — the billing provider is `EXTERNAL-SERVICE` behind provider-agnostic adapters (FR-004); CAP-009 is a P2 add-on (PRD/SAD "optional billing provider"), not a hard P1 dependency.
- **PII/GDPR** — no card data (FR-018); billing/subscription metadata retention-bounded + deletable, inheriting the E008 GDPR posture (FR-021).

**Advisories resolved**: GDPR retention/deletion of the new billing metadata (FR-021); webhook-secret custody + rotation elevated to FR-022 (FR-015 delegates to it); verification coverage added for the security FRs (SC-011 tenant isolation, SC-012 no-card-data, SC-013 rate-limit, SC-014 secret custody, SC-015 retention). **Violations**: none.
