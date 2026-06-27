---
feature_branch: "00001-license-server"
created: "2026-06-26"
input: "A flexible, secure, fast license server that can be incorporated into any app or system, configurable no-code where realistic; must work offline including air-gapped/on-prem; all language stacks must integrate easily; Node/TypeScript server now (migrate to Rust later) with a Rust verifier core; multi-tenant SaaS from day one."
spec_type: "product"
spec_maturity: "draft"
epic_id: ""
epic_sources: ""
---

# Feature Specification: License Server

**Feature Branch**: `00001-license-server`  
**Created**: 2026-06-26  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft

## Problem Statement *(mandatory)*

Software vendors need to control who may run their applications and which features each customer may use, but rolling per-product licensing by hand is slow, insecure, and inconsistent across apps. Without a shared license server, every app reinvents key generation and validation — a frequent source of forgeable keys and licensing CVEs — and non-developers cannot change plans or entitlements without an engineering release. This feature delivers one flexible, secure, fast license server that any app can integrate, that verifies licenses offline (including air-gapped environments), and that lets non-developers configure products, plans, and entitlements with no code.

## Scope *(mandatory)*

### Included

- No-code admin console to define tenants' products, plans, and feature entitlements.
- Issuance of Ed25519-signed, offline-verifiable license keys.
- An embeddable verifier reusable across all language stacks (native via C ABI, web/Node via WASM, others via generated bindings) plus a universal REST API.
- Node-locked activation with seat-limit enforcement and machine fingerprinting.
- Air-gapped activation via offline file exchange.
- License lifecycle: issue, revoke, suspend, reinstate, transfer.
- Licensing models expressible in one token: node-locked, time-limited/subscription, perpetual, trial, and feature entitlements.
- Multi-tenant isolation, RBAC, append-only audit log, signing-key custody in KMS/HSM, and rate limiting.

### Excluded

- Online validation/heartbeat and short-token revocation propagation — P2 (deferred to keep the offline-first MVP shippable).
- Billing/Stripe integration and payment-failure grace periods — P2 (requires the online lifecycle layer first).
- Floating/concurrent seat leasing — P2 (needs an always-online lease service; breaks pure offline).
- Usage-metered billing and low-code policy rules engine — P3 (heaviest; not needed for MVP value).
- Payment processing and tax/merchant-of-record handling — out of scope (the server is the entitlement authority, not the biller).

### Edge Cases & Boundaries

- Tampered, expired, wrong-key, or wrong-machine license keys MUST be rejected.
- Clock rollback on an offline machine MUST NOT silently extend an expired license beyond an allowed skew.
- Hardware drift (e.g., RAM/disk swap) MUST NOT break an otherwise valid node-locked license.
- Activation beyond a plan's seat limit MUST be refused; deactivation MUST free a slot.
- An air-gapped machine MUST activate with zero inbound/outbound network from that machine.
- Concurrent activation attempts on the last seat MUST NOT exceed the limit (race-safe accounting).
- Transferring a license beyond its configured transfer limit MUST be refused.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Configure Licensing Catalog No-Code (Priority: P1)

As a product admin (non-developer), I open the admin console and define a product, one or more plans, and the feature entitlements each plan grants — boolean features and integer limits — without writing code or editing config files. Everything I create is scoped to my tenant only.

**Why this priority**: Core value proposition — the no-code configurability the user explicitly asked for; nothing else can be issued without a catalog.

**Independent Test**: In the console, create a product with one plan and two entitlements (one boolean, one integer limit); confirm they persist, are tenant-scoped, and are selectable when issuing a license.

**Acceptance Scenarios**:

1. **Given** an authenticated admin, **When** they create a product, a plan, and entitlements via the console, **Then** the catalog is saved and visible only within their tenant.
2. **Given** a plan with a boolean and an integer entitlement, **When** the admin edits an entitlement value, **Then** the change is persisted without any code change or redeploy.

### User Story 2 - Issue a Signed License (Priority: P1)

As a product admin, I issue a license for a customer under a chosen plan and immediately receive a usable license key that embeds the plan's entitlements and limits.

**Why this priority**: Issuance is the primary action that turns catalog configuration into something a customer can run; blocks all downstream verification.

**Independent Test**: Issue a license under a plan; receive a signed key; confirm the key carries the plan's entitlements, expiry, and seat limit and appears in the console.

**Acceptance Scenarios**:

1. **Given** a configured plan, **When** the admin issues a license for a customer, **Then** a signed license key is returned and recorded against that customer and plan.
2. **Given** an issued license, **When** the admin views it, **Then** its entitlements, expiry, seat limit, and status are shown, but the signing private key is never exposed.

### User Story 3 - Verify a License Offline and Gate Features (Priority: P1)

As an integrating developer, I embed the verifier in my application (native, web/Node, or another stack) and validate a license key entirely offline against a pinned public keyring, then unlock the features the license entitles. No network call is required on the verification path.

**Why this priority**: The headline promise — fast, secure, embed-anywhere, offline verification — and the single security-critical path.

**Independent Test**: Embed the verifier in a sample app, verify a valid key offline (no network) and unlock an entitled feature; confirm a tampered or expired key is rejected and clock rollback does not extend an expired license.

**Acceptance Scenarios**:

1. **Given** a valid license key and the matching public keyring, **When** the app verifies offline, **Then** verification succeeds and entitled features are enabled.
2. **Given** a tampered, expired, or wrong-key license, **When** the app verifies, **Then** verification fails and entitled features stay locked.
3. **Given** an expired license, **When** the local clock is set backward, **Then** verification still fails (monotonic anchor rejects the rollback).

### User Story 4 - Node-Locked Activation with Seat Limits (Priority: P1)

As an application (on behalf of a customer), I activate a license on a machine; the server binds it to that machine's fingerprint and enforces the plan's maximum activations, refusing activations beyond the limit. The customer can deactivate a machine to free a seat.

**Why this priority**: Node-locking and seat enforcement are the core anti-sharing controls of the MVP licensing model.

**Independent Test**: Activate up to a plan's seat limit; confirm the next activation is refused; deactivate one machine and confirm a new activation succeeds; confirm a RAM/disk change does not invalidate an existing activation.

**Acceptance Scenarios**:

1. **Given** a plan with N seats, **When** an (N+1)th machine activates, **Then** the activation is refused with a clear seat-limit reason.
2. **Given** an activated machine, **When** it is deactivated, **Then** a slot is freed and a new machine may activate.
3. **Given** an activated machine with minor hardware drift, **When** it re-validates, **Then** the activation still matches.

### User Story 5 - Activate an Air-Gapped Machine via File Exchange (Priority: P1)

As an operator of a fully offline (air-gapped) machine, I generate a signed activation request file, carry it to an internet-connected portal that returns a signed activation response file, and import that file to activate the machine — with no network access on the air-gapped machine.

**Why this priority**: Explicitly required (air-gapped/on-prem); enterprise and regulated environments cannot use online activation.

**Independent Test**: Produce a request file on an offline machine, process it on the online portal, import the response file, and confirm the license verifies offline afterward — with no network from the air-gapped machine.

**Acceptance Scenarios**:

1. **Given** an offline machine, **When** the operator generates a request file and the portal issues a response file, **Then** importing it activates the machine and consumes a seat.
2. **Given** an imported activation, **When** the app verifies offline, **Then** verification succeeds without any network call.

### User Story 6 - Online Validation, Heartbeat & Revocation Propagation (Priority: P2)

As an application with intermittent connectivity, I periodically validate online and send heartbeats; the server renews a short-lived offline token and, if a license has been revoked or suspended, the revocation takes effect within the renewal window.

**Why this priority**: Makes revocation real for connected clients and enables remote enforcement; MVP ships offline-first without it.

**Independent Test**: Revoke a license; confirm a connected client's offline token stops validating after the next renewal cycle, while a never-connected client is unaffected until reconnect.

**Acceptance Scenarios**:

1. **Given** a connected client, **When** its short-lived token expires and it renews, **Then** it receives a fresh token only if the license remains valid.
2. **Given** a revoked license, **When** the client next renews, **Then** renewal is refused and features lock after the grace window.

### User Story 7 - Billing-Driven Lifecycle with Grace Periods (Priority: P2)

As a vendor, I connect a billing provider so that subscription create/renew/cancel and payment-failure events automatically provision, extend, or suspend licenses, with a configurable grace period before lockout.

**Why this priority**: Automates the paid-to-entitled mapping and avoids churning customers on transient payment failures; depends on the online lifecycle layer.

**Independent Test**: Simulate a subscription-cancelled webhook; confirm the license enters a grace period, then suspends after it elapses; confirm duplicate webhooks are idempotent.

**Acceptance Scenarios**:

1. **Given** a connected billing provider, **When** a subscription is cancelled, **Then** the license enters a grace period and suspends when it elapses.
2. **Given** a repeated webhook delivery, **When** it is processed, **Then** license state is unchanged (idempotent).

### User Story 8 - Floating/Concurrent Seats and Usage Metering (Priority: P3)

As a vendor with concurrent-use or consumption-based products, I configure floating seats (leased and reclaimed) and usage-metered entitlements with idempotent usage reporting.

**Why this priority**: Advanced monetization models; valuable but not required for a viable MVP and dependent on always-online infrastructure.

**Independent Test**: Lease all floating seats, confirm the next request waits or is refused, let a lease expire and confirm the seat is reclaimed; report the same usage event twice and confirm it is counted once.

**Acceptance Scenarios**:

1. **Given** a floating plan at capacity, **When** a new session requests a seat, **Then** it is refused until a lease frees or expires.
2. **Given** a metered entitlement, **When** the same usage event is reported twice, **Then** it is counted once.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST allow an admin to create, edit, and delete products, plans, and feature entitlements through the admin console with no code and no manual config-file edits.
- **FR-002**: System MUST support entitlement types of boolean (feature on/off) and integer limit (e.g., max projects), attachable to a plan and overridable per license.
- **FR-003**: System MUST allow a plan to express, in a single license token, the licensing-model parameters: node-locked max activations, time-limited expiry, perpetual (no expiry), trial duration, max version, and maintenance-until.
- **FR-004**: System MUST issue a license under a plan for a customer and return a signed, offline-verifiable license key.
- **FR-005**: License keys MUST be Ed25519-signed and MUST carry license/product/plan/customer identifiers, issued-at and expiry, max activations, entitlements, key_id, token version, and a nonce.
- **FR-006**: System MUST allow an admin to revoke, suspend, and reinstate a license; revoked or suspended licenses MUST NOT permit new activations and MUST NOT be renewable.
- **FR-007**: System MUST support transferring/reassigning a license between machines subject to a configurable transfer limit.
- **FR-008**: System MUST provide an embeddable verifier that validates a license key fully offline by checking the Ed25519 signature against a pinned public keyring and evaluating expiry, machine binding, and entitlements, with no network call.
- **FR-009**: The verifier MUST reject tampered, expired, wrong-key, and wrong-machine license keys.
- **FR-010**: The verifier MUST be consumable from native code (C ABI), web/Node (WASM), and generated bindings for other languages, with no per-language reimplementation of cryptography.
- **FR-011**: The verifier MUST trust a keyring of multiple public keys selected by key_id to enable signing-key rotation without breaking existing licenses.
- **FR-012**: The verifier MUST resist clock rollback by persisting a monotonic last-seen timestamp anchor and rejecting validation when local time precedes the anchor beyond an allowed skew.
- **FR-013**: System MUST bind an activation to a machine via a salted-hash fingerprint and MUST enforce the plan's max-activation limit, refusing activations beyond it (race-safe).
- **FR-014**: System MUST allow deactivation of a machine to free an activation slot.
- **FR-015**: Machine fingerprints MUST tolerate partial hardware drift, matching when a configurable subset of stable signals agree.
- **FR-016**: System MUST support air-gapped activation via offline file exchange: a client-generated signed activation request file, an online-portal-issued signed activation response file, and client-side import to activate — with no network on the air-gapped machine.
- **FR-017**: System MUST scope every product, plan, license, activation, signing key, and audit record to a tenant; no cross-tenant read or write is permitted except via an audited platform-admin action.
- **FR-018**: Runtime and machine-facing APIs MUST authenticate via tenant-scoped API keys governed by role-based access control.
- **FR-019**: Private signing keys MUST be stored in KMS/HSM or an encrypted keystore and MUST never be returned by any API or written to logs.
- **FR-020**: System MUST record every license and administrative mutation in an append-only audit log capturing actor, action, target, and timestamp.
- **FR-021**: Activation, validation, and heartbeat endpoints MUST be rate-limited, and activation requests MUST include a nonce to prevent replay.
- **FR-022**: Machine and customer identifiers MUST be stored as salted hashes or minimized, and the system MUST support export and deletion of a customer's personal data.
- **FR-023**: System SHOULD provide online validation and periodic heartbeat that renews short-lived offline tokens and propagates revocation/suspension within the renewal window. *(P2)*
- **FR-024**: System SHOULD integrate billing webhooks to drive license lifecycle and apply configurable payment-failure grace periods, processing webhooks idempotently. *(P2)*
- **FR-025**: System SHOULD support floating/concurrent seat leasing with automatic seat reclamation for dead machines. *(P2)*
- **FR-026**: System MAY support usage-metered entitlements with idempotent usage ingestion and aggregation. *(P3)*
- **FR-027**: System MAY provide a sandboxed low-code rules layer (guarded expressions, not free-form code) for dynamic entitlement decisions. *(P3)*
- **FR-028**: The admin console MUST authenticate human users via interactive login (email + password) with tenant-scoped sessions and role-based access control; SSO/OIDC is deferred to a later phase.
- **FR-029**: Each product MUST own its own Ed25519 signing key pair by default (per-product key scope), so that a key compromise is isolated to a single product.
- **FR-030**: The integrator-facing license key MUST be encoded as a version-prefixed, URL/file-safe string of the form `LIC1.<base64url(token)>`.
- **FR-031**: A plan MUST default to a seat limit of 1 when unspecified, and the system MUST permit at most one active trial per machine fingerprint to limit trial abuse.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Tenant**: An isolated account that owns products, plans, licenses, keys, and users; the root of all access scoping.
- **Product**: A licensed application belonging to a tenant; carries its signing key reference and settings.
- **Plan (Policy)**: A reusable rule template under a product — licensing model, limits, expiry behavior, default entitlements.
- **Entitlement**: A named capability (boolean or integer limit) attached to a plan and optionally overridden per license.
- **License**: An issued instance bound to a plan and customer; has status, expiry, seat limit, and entitlements.
- **Activation (Machine)**: A license bound to a machine fingerprint (salted hash); consumes a seat.
- **Customer**: The pseudonymous holder of one or more licenses; minimal PII.
- **Signing Key**: A versioned (key_id) Ed25519 key pair; private part in KMS/HSM, public part published in the keyring.
- **Revocation**: A record marking a license revoked/suspended; feeds revocation propagation.
- **Audit Log**: Append-only record of every license/admin mutation.
- **API Key / User / Role**: Tenant-scoped credentials and RBAC assignments.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Licensed applications can either embed a small native/WASM verifier library or call an HTTPS endpoint.
- Admins configuring licensing are non-developers comfortable with a web console.
- The hosting environment provides a KMS/HSM or secure secret store for signing-key custody.
- All clients except explicitly air-gapped ones can reach the server periodically for activation/renewal; air-gapped clients use file exchange.
- PostgreSQL is available as the primary tenant-scoped datastore.

### Risks

- **Client-side bypass on attacker-controlled machines** *(likelihood: high, impact: medium)*: a determined cracker can patch out local checks — mitigate by gating highest-value features behind periodic online validation and accepting that licensing deters casual piracy, not determined attackers.
- **Signing-key compromise** *(likelihood: low, impact: high)*: leaks the ability to forge all licenses — mitigate via KMS/HSM custody, per-tenant/per-product keys, rotation, and revocation.
- **Multi-tenant isolation defect** *(likelihood: medium, impact: high)*: a query crossing tenant boundaries leaks data — mitigate via a mandatory tenant-scoped repository layer, isolation tests, and row-level checks.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — Tenant/Product/Plan/Entitlement/License/Activation/Customer/SigningKey/AuditLog data model.
- `NEW-API` — Public runtime REST (activate, validate, deactivate, entitlements), admin CRUD, and air-gap file endpoints.
- `NEW-UI` — Admin console for no-code catalog, issuance, revocation, and activation views.
- `NEW-CONFIG` — Versioned Ed25519 license token format and public-key keyring.
- `EXTERNAL-SERVICE` — KMS/HSM for signing-key custody (P1); billing provider webhooks (P2).
- `MIGRATION` — Initial tenant-scoped PostgreSQL schema.
- `NEW-WORKER` — Token-renewal/heartbeat handler and seat reaper (P2).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An admin can define a product with at least one plan and one feature entitlement entirely through the console, with no code or config-file edits.
- **SC-002** [US1]: No tenant can read or modify another tenant's products, plans, licenses, or keys.
- **SC-003** [US2]: An admin can issue a usable, signed license key in under one minute, with the signing private key never exposed.
- **SC-004** [US3]: A licensed application verifies a valid license offline (no network) and unlocks exactly the entitled features; a tampered, expired, or wrong-machine key is rejected 100% of the time.
- **SC-005** [US3]: Offline license verification adds no perceptible startup delay (under 5 ms on commodity hardware), and an expired license cannot be revived by setting the clock backward.
- **SC-006** [US4]: Activations are capped at the plan's seat limit; the (limit+1)th activation is refused and deactivating a seat allows a new activation, with no over-allocation under concurrent attempts.
- **SC-007** [US5]: An operator can activate a fully air-gapped machine using only file exchange, with no inbound or outbound network from that machine.
- **SC-008** [US2]: Every license and administrative mutation appears in the append-only audit log with actor, action, target, and timestamp, and no entry can be altered or deleted.
- **SC-009** [US4]: Replayed activation requests (reused nonce) are rejected, and abusive request rates on activation/validation endpoints are throttled.

## Clarifications

### 2026-06-26

- **Signing-key scope**: Per-product Ed25519 key pairs by default (FR-029), isolating key-compromise blast radius to one product.
- **Admin authentication**: Interactive email+password login with tenant-scoped sessions for the no-code console (FR-028); tenant-scoped API keys remain for runtime/machine APIs (FR-018). SSO/OIDC deferred to a later phase. (Resolves the FR-018 ↔ US1 conflict.)
- **Machine fingerprint**: Composed of five stable signals — machine/board UUID, primary MAC, CPU identifier, OS install ID, disk serial — matched when at least 3 of 5 agree (configurable per plan), so RAM/disk swaps do not break activation (FR-015).
- **Clock-rollback skew**: Validation is rejected when local time precedes the monotonic anchor by more than 48 hours (configurable per product) (FR-012).
- **License-key encoding**: `LIC1.<base64url(token)>` — version-prefixed, URL/file-safe (FR-030).
- **Default seat & trial abuse**: New plans default to a seat limit of 1; at most one active trial per machine fingerprint (FR-031).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Entitlement | A named capability a license grants, expressed as a boolean flag or an integer limit. |
| Node-locked | A license bound to a specific machine via its fingerprint. |
| Floating license | A license whose seats are leased concurrently and reclaimed, rather than bound to fixed machines. |
| Machine fingerprint | A salted hash of stable hardware/OS signals identifying a machine without storing raw hardware IDs. |
| Keyring | The set of trusted public keys a client embeds; selected by key_id to allow rotation. |
| Key rotation | Issuing new tokens under a new signing key while clients still trust prior public keys. |
| Air-gapped activation | Activating a machine with no network, via signed request/response file exchange. |
| Monotonic anchor | The highest timestamp a client has ever observed, used to detect and reject clock rollback. |
| Revocation propagation | The mechanism by which a revoked license stops validating on clients (via short-token renewal or a revocation list). |
