---
feature_branch: "00009-license-issuance-and-lifecycle"
created: "2026-07-08"
input: "E008"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E008"
epic_sources: "{PRD:CAP-002}"
---

# Feature Specification: License Issuance and Lifecycle

**Feature Branch**: `00009-license-issuance-and-lifecycle`
**Created**: 2026-07-08
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E008
**Epic Sources**: {PRD:CAP-002}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

A catalog of products, plans, and entitlements has no value until an admin can turn a plan into a real,
signed license a customer can use. Today there is no way to issue a cryptographically signed,
offline-verifiable license under a plan, nor to manage its life after issue — revoke it when misused or
refunded, suspend and reinstate it, or transfer it to another customer. Without issuance and lifecycle,
the MVP cannot deliver a usable license, and downstream activation (E009) and enforcement (E013) have
nothing to act on. Issuance is a tier-0 path: it must be fast (p95 < 1s) and never expose the signing key.

## Scope *(mandatory)*

### Included

- **Issuing** a signed, offline-verifiable license under a chosen product + plan, for a customer, with a
  term (perpetual or time-limited).
- Embedding a **point-in-time snapshot** of the plan's effective definition (entitlements + seat limit) and
  the customer/product/plan identity into the signed license.
- **Lifecycle** management: revoke (terminal), suspend and reinstate, and transfer to another customer
  (within a transfer limit), each audited.
- Registering and listing **customers** (pseudonymous, minimal PII); a license references one customer.
- Browsing the **license registry** (status, customer, plan, expiry) and retrieving a license's signed key.

### Excluded

- Machine activation and seat enforcement — owned by E009 (this epic sets the seat limit in the license and
  exposes license status; E009 enforces activation against it).
- Online validation, heartbeat, short-token renewal, and revocation-list propagation — owned by E013.
- Billing-driven issuance/suspension (subscription events, grace periods) — owned by E014.
- Air-gapped activation file exchange — owned by E010.
- Signing-key creation, custody, and rotation mechanics — owned by E004 (this epic consumes the signer).
- The token byte format and offline verification — owned by E001 (this epic produces tokens in that format).

### Edge Cases & Boundaries

- Issuing under an **archived** plan or with an archived entitlement is refused (only active catalog entries
  can be issued).
- Issuing when the product has **no active signing key** or the signer is **locked** fails clearly, with no
  partial license created.
- Suspend/reinstate/revoke/transfer on an unknown license, or an invalid transition (reinstate a license
  that is not suspended; transfer or reinstate a revoked license), is refused with a clear reason.
- Transferring beyond the per-license **transfer limit** is refused.
- Revoking an already-revoked license is a no-op (idempotent), not an error.
- A **perpetual** license (no expiry) and a **time-limited** license are both supported.
- **Offline revocation gap**: a revoked/suspended license's already-distributed token still verifies offline
  until it expires; revocation takes effect at activation/online time (E009/E013). This is a disclosed MVP
  limitation, not a defect — mitigated later by short-TTL tokens + online renewal (E013).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Issue a signed license (Priority: P1)

A licensing admin selects a product and one of its plans, chooses (or registers) a customer, sets a term
(perpetual or an expiry date), and issues a license. In under a minute they receive a signed, offline-
verifiable license key that embeds the plan's entitlements, seat limit, and expiry.

**Why this priority**: This is the core value — turning a catalog plan into a usable signed license; everything downstream depends on it.

**Independent Test**: An admin issues a license under a plan for a customer and receives a signed key that verifies offline and carries the plan's entitlements, seat limit, and expiry.

**Acceptance Scenarios**:

1. **Given** a product with an active signing key and a plan with entitlements, **When** the admin issues a license for a customer with a 1-year term, **Then** a signed key is returned that verifies offline and embeds the entitlements, seat limit, expiry, and a unique license id.
2. **Given** a plan, **When** the admin issues without an expiry, **Then** a perpetual license is created (no expiry).
3. **Given** a product with no active signing key (or a locked signer), **When** the admin attempts to issue, **Then** issuance is refused with a clear reason and no license is created.

### User Story 2 - Revoke a license (Priority: P1)

An admin revokes a license (e.g. after a refund or misuse). The license moves to a terminal revoked state
and can no longer be reinstated, transferred, reissued, or activated.

**Why this priority**: Revocation is how revenue leakage and misuse are contained — a core commercial control.

**Independent Test**: An admin revokes an active license; the license shows revoked, and reinstate/transfer/activation are all refused.

**Acceptance Scenarios**:

1. **Given** an active license, **When** the admin revokes it, **Then** its status becomes revoked and the action is audited.
2. **Given** a revoked license, **When** the admin tries to reinstate or transfer it, **Then** the action is refused with a clear reason.
3. **Given** an already-revoked license, **When** the admin revokes it again, **Then** it remains revoked (no error).

### User Story 3 - Suspend and reinstate a license (Priority: P1)

An admin temporarily suspends a license (e.g. a payment issue) and later reinstates it. A suspended license
cannot be activated; reinstating returns it to active.

**Why this priority**: Temporary holds are a routine commercial need distinct from permanent revocation.

**Independent Test**: An admin suspends an active license (activation refused), then reinstates it (active again).

**Acceptance Scenarios**:

1. **Given** an active license, **When** the admin suspends it, **Then** its status becomes suspended and the action is audited.
2. **Given** a suspended license, **When** the admin reinstates it, **Then** its status returns to active.
3. **Given** a license that is not suspended, **When** the admin tries to reinstate it, **Then** the action is refused.

### User Story 4 - Transfer a license to another customer (Priority: P1)

An admin transfers a license from one customer to another (e.g. a reseller reassignment), subject to a
per-license transfer limit that prevents abuse.

**Why this priority**: License reassignment is a common commercial and support workflow; the limit deters sharing abuse.

**Independent Test**: An admin transfers an active license to a new customer within the limit; a transfer beyond the limit is refused.

**Acceptance Scenarios**:

1. **Given** an active license within its transfer limit, **When** the admin transfers it to another customer, **Then** the license's customer changes, the transfer count increments, and the action is audited.
2. **Given** a license at its transfer limit, **When** the admin attempts another transfer, **Then** it is refused with a clear reason.
3. **Given** a revoked license, **When** the admin attempts a transfer, **Then** it is refused.

### User Story 5 - Browse the license registry and retrieve keys (Priority: P1)

An admin (or a read-only reviewer) browses the tenant's licenses — status, customer, plan, expiry — and
retrieves a license's signed key on demand. All data is tenant-scoped and role-gated.

**Why this priority**: Operators must see and manage what they've issued and re-fetch a key for a customer; security-critical isolation.

**Independent Test**: An admin lists licenses and retrieves one license's signed key; a viewer can read but not issue; a second tenant sees none of the first tenant's licenses.

**Acceptance Scenarios**:

1. **Given** issued licenses, **When** an admin opens the registry, **Then** they see each license's status, customer, plan, and expiry.
2. **Given** a license, **When** the admin requests its key, **Then** the signed license key is returned.
3. **Given** a viewer, **When** they attempt to issue or change a license, **Then** the action is denied and recorded as a security event; and a second tenant's admin never sees this tenant's licenses.

### User Story 6 - Reissue a license after signing-key rotation (Priority: P2)

After a product's signing key rotates (E004), an admin reissues a license's signed key — re-signing the
same license terms with the current key — without changing the license's identity, entitlements, or expiry.

**Why this priority**: Useful for key hygiene, but the MVP works via the overlapping keyring (old tokens still verify); non-blocking.

**Independent Test**: After a key rotation, an admin reissues a license and receives a new signed key over the same terms; the license id and terms are unchanged.

**Acceptance Scenarios**:

1. **Given** a license and a rotated product signing key, **When** the admin reissues, **Then** a new signed key over the same terms is returned and the license identity/terms are unchanged.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: The system MUST let an admin issue a license under a chosen active product + active plan, for a customer, with a term that is either perpetual or a specific expiry.
- **FR-002**: An issued license MUST embed a point-in-time snapshot of the plan's effective definition — the entitlement keys and values and the seat limit — plus the product, plan, and customer identity, an issue timestamp, the expiry, and a unique license id.
- **FR-003**: The issued license MUST be returned as a signed, offline-verifiable key in the platform token format, signed by the product's signing key; the signing key MUST never be exposed in any response, log, or audit entry.
- **FR-004**: Issuance MUST require an active signing key for the product and an available (unlocked) signer; when either is missing, issuance MUST fail with a clear reason and create no license.
- **FR-005**: The system MUST NOT issue a license under an archived plan or with an archived entitlement.
- **FR-006**: Catalog edits made after issuance MUST NOT change an already-issued license (it holds the snapshot from issue time).
- **FR-007**: The system MUST support revoking a license — from `active` or `suspended` — into a terminal `revoked` state; a revoked license MUST NOT be reinstated, transferred, or reissued. Revoking an already-revoked license MUST be a no-op.
- **FR-008**: The system MUST support suspending an active license (`suspended`) and reinstating a suspended license to `active`; reinstate MUST be refused for a license that is not suspended.
- **FR-009**: The system MUST support transferring an `active` or `suspended` license to a different customer, subject to a per-license transfer limit (a configurable default, e.g. 3); a transfer that would exceed the limit MUST be refused. (Transfer of a `revoked` license is refused by FR-007.)
- **FR-010**: The license lifecycle MUST be a well-defined state machine; any invalid transition MUST be refused with a clear, specific reason.
- **FR-011**: The system MUST let an admin register and list customers that are pseudonymous — identified within the tenant by an admin-supplied reference label (not a natural-person identifier) — holding at most minimal personal data limited to an optional display name and an optional contact email (these two fields are the only ones treated as PII and the only fields cleared on anonymization); every license MUST reference exactly one customer.
- **FR-012**: The system MUST let an admin browse the tenant's license registry (status, customer, plan, expiry) and retrieve any license's signed key on demand.
- **FR-013**: The system MUST expose each license's current status so downstream activation (E009) and enforcement (E013/E014) can act on it.
- **FR-014**: Every issuance and lifecycle action (issue, revoke, suspend, reinstate, transfer, reissue) and every customer-record action (register, erase — whether the erasure anonymizes or hard-deletes) MUST be written to the append-only audit log with actor, action, and target; an erasure audit entry MUST NOT contain the erased personal data. A refused action due to authorization is additionally recorded as a security event (FR-016); a refused lifecycle transition (FR-010) leaves the license unchanged and is not itself a recorded mutation.
- **FR-015**: All licenses and customers MUST be strictly tenant-scoped — no cross-tenant read or write; access MUST fail closed when tenant context is absent or unresolved — an unscoped request returns no rows and performs no write rather than defaulting to broad access.
- **FR-016**: The system MUST allow a role of admin or higher to issue and manage license lifecycle and allow viewers to read the registry; an unauthorized action MUST be denied and recorded as a security event.
- **FR-017**: License issuance latency MUST meet p95 < 1 second including signing.
- **FR-018**: The system SHOULD let an admin reissue a license's signed key after the product's signing key rotates, re-signing the same terms with the current key without changing the license's identity or terms. *(P2)*
- **FR-019**: The system MUST support erasing a customer's personal data (deletion or anonymization) to honor data-subject deletion requests, subject to referential integrity with issued licenses (a customer that holds licenses is anonymized rather than hard-deleted, so the licenses remain interpretable).

### Key Entities *(include for product or technical specs if feature involves data)*

- **License**: a tenant-scoped issued license. Attributes: id, product, plan, customer, status (active / suspended / revoked), issued-at, expiry (null = perpetual), seat limit (snapshot), entitlements snapshot, the signing key id used, transfer count, and the signed license key (token). References exactly one customer, product, and plan.
- **Customer**: a tenant-scoped, pseudonymous recipient of licenses. Attributes: id; a `ref` (a stable, non-PII pseudonymous reference label, unique per tenant, that survives anonymization); an optional display name (PII, cleared on anonymization); an optional contact email (PII, cleared on anonymization); status (active / anonymized); created-at. Has many licenses.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E007 catalog exposes an effective-plan read model (entitlement keys/values + seat limit) that issuance snapshots at issue time.
- The E004 signing service provides a per-product signer and keyring; a product must have an active signing key before licenses can be issued under its plans.
- The E001 token format and offline verifier are the target for issued license keys; the platform signs Ed25519 tokens.
- Customers are pseudonymous with minimal PII, consistent with the product's GDPR-minimizing posture.
- The console shell, session authentication, RBAC, and append-only audit (E005/E002) gate and record all issuance/lifecycle actions.

### Risks

- **Signing-key unavailability** *(likelihood: medium, impact: high)*: the signer is a tier-0 dependency; if it is locked or a product has no key, issuance is blocked — mitigated by a clear fail-closed error and signer readiness, and by surfacing the prerequisite in the flow.
- **Offline revocation gap** *(likelihood: high, impact: medium)*: a revoked license's already-distributed token verifies offline until expiry — a disclosed MVP limitation mitigated later by short-TTL tokens + online renewal (E013); communicated to buyers, not hidden.
- **Snapshot-semantics confusion** *(likelihood: medium, impact: low)*: admins may expect catalog edits to propagate to issued licenses — mitigated by documenting that a license is a point-in-time snapshot and offering reissue for key rotation.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — license and customer, tenant-scoped.
- `MIGRATION` — an expand-only schema migration adding the license and customer tables with forced RLS and audit grants (E002 pattern).
- `NEW-API` — tenant-scoped `/admin` issuance + lifecycle REST (issue, revoke, suspend, reinstate, transfer, list, retrieve-key) and customer register/list.
- `NEW-UI` — issuance and license-registry views in the admin console shell, behind RBAC.
- `EXTERNAL-SERVICE` — consumes the E004 in-process signer to sign license tokens (no private-key exposure).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An admin issues a license and receives a usable signed key in under a minute (issuance p95 < 1 second including signing).
- **SC-002** [US1]: The issued key embeds the plan's entitlements, seat limit, and expiry, and verifies offline against the product's key.
- **SC-003** [US1]: A catalog edit made after issuance does not change an already-issued license.
- **SC-004** [US2]: A revoked license cannot be reinstated, transferred, or reissued, and every lifecycle action is audited.
- **SC-005** [US3]: A suspended license is not active (activation would be refused), and reinstating returns it to active.
- **SC-006** [US4]: A license transfers to a new customer while within its transfer limit; a transfer beyond the limit is refused.
- **SC-007** [US5]: An admin browses the registry, sees each license's status, customer, plan, and expiry, and retrieves a license's signed key.
- **SC-008** [US2]: Every invalid lifecycle transition is refused with a clear reason and leaves the license unchanged.
- **SC-009** [US5]: Licenses and customers are tenant-isolated — one tenant never sees another's — and a viewer cannot issue or change a license (the attempt is a recorded security event).
- **SC-010** [US1]: The product's signing key never appears in any issuance response, log, or audit entry — only the signed license key (public token) is returned.
- **SC-011** [US5]: Erasing a customer with no licenses hard-deletes it; erasing a customer that holds licenses anonymizes it — the display name and contact email are cleared and status becomes `anonymized`, while the non-PII `ref` is retained so its licenses remain interpretable — and the erasure is audited without recording any erased PII.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| License | An issued, signed grant of a plan's entitlements to a customer, verifiable offline; has a lifecycle (active / suspended / revoked). |
| Signed license key | The offline-verifiable token (platform format, Ed25519-signed by the product's key) the customer embeds in their software. |
| Snapshot | The point-in-time copy of the plan's effective definition (entitlements, seat limit) baked into a license at issue time; later catalog edits do not change it. |
| Term | A license's validity: perpetual (no expiry) or time-limited (a specific expiry). |
| Transfer limit | The maximum number of times a single license may be reassigned to a different customer. |
| Revoke / Suspend / Reinstate / Transfer | Lifecycle actions: permanently terminate, temporarily hold, return a held license to active, and reassign to another customer. |
| Customer | A pseudonymous recipient of licenses within a tenant. |

## Compliance Check

**Status**: PASS (Policy Auditor, 2026-07-08)

Validated against `project-instructions.md` (v1.2.0). No violations.

- **Offline-first crypto (Principle I)**: PASS — the license is an Ed25519-signed, offline-verifiable token in the E001 format (FR-003), snapshotting what the verifier needs (FR-002); no crypto reimplemented (issuance consumes the E004 signer; verification is the E001 core). The signing key is never exposed (FR-003, SC-010). The offline-revocation-gap is explicitly disclosed (Edge Cases + Risks).
- **Multi-tenant isolation (Principle II)**: PASS — licenses + customers tenant-scoped with forced RLS (FR-015); fail-closed RBAC (FR-016); isolation + viewer-denial verified (SC-009).
- **Single audited security core (Principle III)**: PASS — every issuance/lifecycle action append-only audited (FR-014); unauthorized attempts recorded (FR-016).
- **Tech stack (Node 22 + Fastify; node-postgres + raw SQL migrations, no Drizzle; PostgreSQL 16.4+; React SPA)**: PASS — MIGRATION signal follows the E002 raw-SQL forced-RLS pattern; no ORM implied.
- **PII / GDPR posture**: PASS — customers pseudonymous with minimal PII (FR-011); customer erasure/anonymization for data-subject deletion, referential-safe (FR-019, added to satisfy the deletability obligation).
- **Source layout (`/src`)**: PASS — logical `/admin` API + console UI references only; no paths outside `/src`.
