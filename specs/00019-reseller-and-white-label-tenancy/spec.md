---
feature_branch: "00019-reseller-and-white-label-tenancy"
created: "2026-08-12"
input: "Epic E018 — Reseller and white-label tenancy: reseller/partner multi-tenancy and white-label branding so partners can resell and brand licensing on top of the platform. Extends E005 tenant administration with a reseller hierarchy and per-tenant branding while preserving strict tenant isolation."
spec_type: "product"
spec_maturity: "clarified"
epic_id: "E018"
epic_sources: "{PRD:CAP-012}"
---

# Feature Specification: Reseller and White-label Tenancy

**Feature Branch**: `00019-reseller-and-white-label-tenancy`  
**Created**: 2026-08-12  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: clarified  
**Epic ID**: E018  
**Epic Sources**: {PRD:CAP-012}  
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Partners want to resell licensing to their own customers under their own brand, but today every tenant is a flat, isolated island administered only by the vendor: there is no way for a partner to manage a set of customer tenants, and every console surface shows the vendor's identity. Without a reseller hierarchy and white-label branding, the platform cannot support a partner/channel go-to-market — resellers must file tickets with the vendor for routine customer administration, and customers see the vendor's brand instead of their partner's. This feature lets a reseller manage its own customers and brand the experience, without ever weakening the strict tenant isolation the platform is built on.

## Scope *(mandatory)*

### Included

- Onboarding a **reseller** (created new or promoted from an existing tenant) and linking it to a set of **sub-tenants** (customers) in a shallow, one-level parent→child hierarchy.
- **Delegated, scoped administration**: a reseller-admin manages only its own sub-tenants (create, view, administer) and never any tenant outside its subtree.
- **White-label branding per tenant** — logo, colors, product name, support links, and email-sender identity — resolved by precedence (sub-tenant override → reseller default → platform default).
- **Isolation preservation**: downward-only visibility, no upward/lateral escalation, enforced at the data-access layer (not only the API).
- **Dual-identity auditing**: every reseller action on a sub-tenant is recorded with both the acting reseller-admin and the target sub-tenant, in the existing append-only audit trail.
- **Reseller lifecycle governance**: onboarding with a sub-tenant quota; reversible suspend distinct from offboard; offboarding that transfers or reassigns every sub-tenant (no orphans).
- **Verified custom domain and email sender** before white-label activation (anti-spoofing).

### Excluded

- **Nested / multi-level reseller hierarchies** (a sub-tenant that is itself a reseller) — deferred; the MVP is one reseller level to keep isolation reasoning tractable.
- **Reseller billing, commissions, or revenue-share** — a separate commercial concern; branding/administration here does not compute or settle money (relationship to E014 billing is out of scope).
- **Reselling the underlying signing/crypto or issuing licenses on the reseller's own keys** — licenses are always signed by the platform's single crypto core (Principle I); resellers brand the experience, not the trust root.
- **Customer self-service reseller signup / partner marketplace** — vendor-operator-initiated onboarding only for the MVP.
- **Per-reseller custom code, plugins, or theming beyond the defined branding fields** — out of scope.

### Edge Cases & Boundaries

- A reseller requests a tenant id **outside its subtree** → not-found, with no disclosure that the tenant exists.
- A reseller or sub-tenant attempts to reach a **parent, the platform, or a sibling** (upward/lateral) → denied and recorded as a security event.
- An **unset or empty tenant scope** (no `app.current_tenant`) at the data-access layer → **zero rows** returned; access is refused (fail-closed), never served unscoped — isolation defaults to closed at the data layer, not only at the API.
- A **sub-tenant override** conflicts with the reseller default → the sub-tenant's own setting wins **unless the reseller has locked that field** (a locked field is not overridable — the reseller value is authoritative); removing an unlocked override falls back to the reseller default, then platform default.
- An attempt to **white-label a trust signal** (revocation/tamper/security notice, signing identity, audit record, legal text) → refused; these remain authoritative.
- Two tenants claim the **same custom domain / email sender** → refused; a domain/sender may be bound to at most one tenant and only after ownership verification.
- Offboarding a reseller that **still has sub-tenants** → blocked until each is transferred or reassigned; no orphaned sub-tenant.
- Creating a sub-tenant **beyond the reseller's quota** → refused with a clear reason.
- The **last owner** of a reseller or sub-tenant cannot be removed/demoted into a lock-out (existing protection preserved).
- A **suspended reseller's** sub-tenants attempt new activity → blocked by the read-only cascade (sign-in and read still allowed); existing issued licenses continue to verify offline.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Manage my own customers as a reseller (Priority: P1)

As a reseller-admin, I sign in and see only the customer tenants that belong to me, so I can provision and administer them (administrative/provisioning/branding metadata only — never their license/usage/activation operational data, FR-017) without the vendor's help and without ever touching another partner's customers.

**Why this priority**: This is the core value proposition and the central security boundary — without scoped, downward-only reseller administration there is no reseller capability at all.

**Independent Test**: Seed a reseller with two sub-tenants and an unrelated sibling reseller; the reseller-admin lists and administers only its own two sub-tenants, and any reference to the sibling or the platform resolves to not-found.

**Acceptance Scenarios**:

1. **Given** a reseller with sub-tenants A and B, **When** the reseller-admin lists customers, **Then** only A and B appear and no other tenant is visible.
2. **Given** a reseller-admin session, **When** it requests a tenant outside its subtree (a sibling's customer or the platform), **Then** the result is not-found and does not disclose the tenant's existence.
3. **Given** a reseller within its sub-tenant quota, **When** the reseller-admin provisions a new customer, **Then** the sub-tenant is created under that reseller and is immediately administrable by it.
4. **Given** a reseller-admin, **When** it attempts an action reserved for the vendor/platform operator (e.g., moving a tenant to another reseller), **Then** the action is denied and recorded as a security event.
5. **Given** a reseller-admin viewing one of its sub-tenants, **When** it requests that sub-tenant's data, **Then** only administrative/provisioning/branding metadata is returned and any license/usage/activation operational data is denied.

### User Story 2 - Brand the experience for my customers (Priority: P1)

As a reseller-admin, I set my branding — logo, colors, product name, support links, email sender — so my customers experience the licensing product as mine, and each customer can further tailor its own look.

**Why this priority**: "Resell and brand" is the epic's headline capability; without white-labeling, partners cannot present the product as their own.

**Independent Test**: Configure reseller branding and one sub-tenant override; sign into each surface and confirm the reseller brand appears by default and the override appears where set, with no vendor identity on partner-facing surfaces.

**Acceptance Scenarios**:

1. **Given** a reseller with configured branding, **When** a customer under it signs into the console, **Then** the reseller's logo, colors, and product name are shown by default.
2. **Given** a sub-tenant that sets its own branding, **When** its users view any branded surface, **Then** the sub-tenant's override is applied instead of the reseller default — except for fields the reseller has locked, which are not overridable.
3. **Given** any branding configuration, **When** a security/revocation/tamper notice, signing identity, audit record, or legal text is displayed, **Then** it is shown authoritatively and is never replaced by partner branding.
4. **Given** a customer with no override and a reseller with none, **When** its users view a branded surface, **Then** the platform default branding is applied.

### User Story 3 - Keep every partner action isolated and audited (Priority: P1)

As a vendor/platform operator (and a compliance reviewer), I need every reseller action on a customer to be strictly isolated and recorded, so introducing partners never opens a cross-tenant path and every delegated action is accountable.

**Why this priority**: Security-critical — the whole feature is only acceptable if it provably cannot weaken tenant isolation (Principle II).

**Independent Test**: Drive reseller actions across two resellers and confirm no cross-subtree read/write is possible at the data layer, and that each action produces a dual-identity, tamper-evident audit entry.

**Acceptance Scenarios**:

1. **Given** a reseller-admin acting on its sub-tenant, **When** the action completes, **Then** the append-only audit records both the acting reseller-admin identity and the target sub-tenant.
2. **Given** any role including reseller-admin and owner, **When** it attempts to edit or delete an audit entry, **Then** the attempt is refused (append-only, tamper-evident).
3. **Given** a request carrying a tenant id from outside the caller's subtree, **When** the data layer resolves scope, **Then** zero rows are returned — isolation is enforced below the API, not only in it.
4. **Given** a sub-tenant or reseller attempting to reach a parent, the platform, or a sibling, **When** the request is processed, **Then** it is denied and recorded as a security event.

### User Story 4 - Onboard, suspend, and offboard a reseller safely (Priority: P2)

As a vendor/platform operator, I onboard a reseller with a customer quota, can suspend it reversibly, and can offboard it only after its customers are safely transferred, so the partner lifecycle never orphans a customer or loses accountability.

**Why this priority**: Governance makes the feature operable at scale, but the P1 stories already deliver a usable, isolated reseller; lifecycle can follow.

**Independent Test**: Onboard a reseller with a quota, exceed it (refused), suspend and reverse it, then attempt offboarding with and without resolving its sub-tenants.

**Acceptance Scenarios**:

1. **Given** onboarding, **When** the operator creates a new reseller tenant or promotes an existing tenant, **Then** the reseller, its first reseller-admin, and a sub-tenant quota (platform default) are established.
2. **Given** a reseller at its hard quota, **When** it tries to create another sub-tenant, **Then** the attempt is refused with a clear reason; only the operator can raise the quota.
3. **Given** an active reseller, **When** the operator suspends it, **Then** new reseller activity is blocked, data is retained, a read-only state cascades to its sub-tenants (sign-in and read allowed; no new provisioning/activation/branding change), and reversing the suspension restores access.
4. **Given** a reseller with sub-tenants, **When** the operator offboards it, **Then** offboarding is blocked until every sub-tenant is transferred to another reseller or reassigned to direct-platform ownership, and each transfer is audited.

### User Story 5 - Use my own domain and email identity (Priority: P2)

As a reseller-admin, I bind my own custom domain and email sender so customers reach a fully branded, trustworthy partner experience — after proving I own them.

**Why this priority**: Elevates branding from in-app to a full partner presence, but is not required for the MVP branding experience (US2).

**Independent Test**: Attempt to activate a custom domain/email sender before and after ownership verification, and confirm activation only succeeds post-verification.

**Acceptance Scenarios**:

1. **Given** an unverified custom domain or email sender, **When** the reseller-admin tries to use it for white-label, **Then** activation is refused until ownership is verified.
2. **Given** a verified custom domain, **When** a customer reaches the product through it, **Then** the correct tenant is resolved and its branding is applied.
3. **Given** a domain/sender already bound to another tenant, **When** a second tenant claims it, **Then** the claim is refused.

## Clarifications

### Session 2026-08-12

- Q: What may a reseller-admin see of a sub-tenant's OPERATIONAL data (licenses/usage/activations) vs. only admin/provisioning/branding metadata? -> A: Metadata only (privacy-minimizing) — no license/usage/activation operational data for the MVP.
- Q: Is a reseller-admin scoped to a subset of sub-tenants or always the whole subtree? -> A: Whole subtree only for the MVP; per-sub-tenant scoping deferred.
- Q: What "defined state" does suspending a reseller cascade to its sub-tenants? -> A: Read-only cascade — login allowed, no new provisioning/activation/branding changes; already-issued licenses keep verifying offline.
- Q: FR-001 (designate existing) vs FR-010 (provision new) — which onboarding path? -> A: Both, via one create-or-select flow (create a new reseller tenant OR promote an existing tenant).
- Q: Branding precedence — per-field vs whole-profile, and may a reseller lock fields? -> A: Per-field resolution AND a reseller may mark individual fields as locked (non-overridable by sub-tenants).
- Q: Sub-tenant quota — default, authority, hard vs soft? -> A: Hard cap; a platform-configured numeric default; only the vendor/platform operator may change a reseller's quota.
- Q: What happens to a sub-tenant's branding when the operator moves it between resellers? -> A: Keep the sub-tenant's own overrides; the reseller-default layer re-resolves to the new reseller; the branding-context change is audited on source + destination.
- Q: What proof does white-label activation require for a custom domain and an email sender? -> A: Domain via DNS TXT/CNAME challenge; email sender via DNS-based SPF + DKIM/DMARC alignment (provable send-authorization).

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a vendor/platform operator **onboard a reseller via one create-or-select flow** — either creating a new reseller tenant or promoting an existing tenant to reseller — and link **sub-tenants** to it as a shallow, one-level parent→child hierarchy.
- **FR-002**: System MUST provide a **reseller-admin** role authorized over its reseller's **entire subtree** (list, provision, and manage all of its sub-tenants — per-sub-tenant subset scoping is out of scope for the MVP) that MUST integrate with the existing owner>admin>viewer RBAC model, failing closed (an unpermitted action is denied and recorded as a security event).
- **FR-003**: System MUST let a reseller-admin **provision a new sub-tenant** under its own reseller, subject to a **hard** sub-tenant quota (a platform-configured numeric default; only the vendor/platform operator may change a reseller's quota — a reseller can never raise its own).
- **FR-004**: System MUST scope a reseller session to **downward-only visibility**: a reference to any tenant outside the caller's subtree resolves to not-found without disclosing the tenant's existence.
- **FR-005**: System MUST prevent **upward and lateral escalation** — a sub-tenant or reseller cannot read or act on a parent, the platform, or a sibling — and MUST enforce this at the data-access layer, not only at the API.
- **FR-006**: System MUST support a **per-tenant branding profile** covering at least logo, colors, product name, support/help links, and email-sender identity, and MUST let a reseller mark **individual fields as locked** (non-overridable by its sub-tenants) to enforce brand consistency; a locked field MUST be presented to the sub-tenant as simply not editable (e.g., "set by your provider") WITHOUT revealing the reseller hierarchy (consistent with FR-014).
- **FR-007**: System MUST resolve applied branding **per field** by precedence **sub-tenant override → reseller default → platform default** (each field falls back independently), except that a reseller-**locked** field cannot be overridden by a sub-tenant.
- **FR-008**: System MUST NOT white-label **trust signals** — license revocation/tamper/security notices, the license-signing identity, audit records, and legal/compliance text remain authoritative and unspoofable regardless of branding.
- **FR-009**: System MUST record every reseller action on a sub-tenant in the existing **append-only, tamper-evident audit** with both the acting reseller-admin identity and the target sub-tenant (dual-identity); no role may edit or delete an audit entry.
- **FR-010**: As part of reseller onboarding (FR-001) and quota assignment (FR-003), the System MUST establish the reseller's **first reseller-admin** so the reseller is immediately operable by a named administrator.
- **FR-011**: System MUST support **suspending a reseller** reversibly — blocking new reseller activity while retaining data — as an action distinct from offboarding, and MUST cascade a **read-only state** to its sub-tenants (users may still sign in and read, but no new provisioning/activation/branding change is allowed); already-issued licenses MUST continue to verify offline, and reinstating the reseller MUST restore normal access.
- **FR-012**: System MUST require **offboarding a reseller to first resolve every sub-tenant** (transfer to another reseller or reassign to direct-platform ownership) so no sub-tenant is orphaned, applying a notice/grace window, with the resolution audited.
- **FR-013**: System MUST **verify ownership before white-label activation** through a `pending → verified → active` lifecycle — a custom domain via a DNS TXT/CNAME challenge, and an email sender via DNS-based SPF + DKIM/DMARC alignment (proving authorized sending, not merely address control) — where a binding is created `pending`, becomes `verified` once the DNS proof is met, and is `active` only after an explicit activation step; and MUST bind a given verified/active domain/sender to at most one tenant.
- **FR-014**: System MUST keep an **end-tenant admin's existing experience unchanged except for applied branding**; a sub-tenant cannot see the reseller hierarchy or any tenant other than itself.
- **FR-015**: System MUST allow only a **vendor/platform operator to move a sub-tenant between resellers** (or to/from direct-platform ownership); the move MUST **preserve the sub-tenant's own branding overrides** while the reseller-default branding layer and per-field **locks re-resolve to the destination reseller** (a field the source reseller locked may become overridable, or vice-versa, per the destination's locks), and MUST audit both the move and the branding-context change on the source and destination.
- **FR-016**: System MUST preserve **last-owner protection** for both reseller and sub-tenant tenants (no action leaves a tenant with no administrator).
- **FR-017**: System MUST restrict a reseller-admin to a sub-tenant's **administrative/provisioning/branding metadata only** — it MUST NOT expose the sub-tenant's license, usage, or activation operational data to the reseller (privacy-minimizing default for the MVP; any future broader access would be an explicit, audited, consented grant).

### Key Entities *(include for product or technical specs if feature involves data)*

- **Reseller (partner)**: a tenant that is a reseller — created new or promoted from an existing tenant at onboarding (FR-001); owns a subtree of sub-tenants; has a hard sub-tenant quota (operator-controlled) and a lifecycle status (active | suspended | offboarding). Extends the existing tenant, not a new isolation mechanism.
- **Reseller relationship**: the parent→child link binding a reseller tenant to a sub-tenant ("managed-by"); the basis for subtree scoping and for transfer/reassignment.
- **Branding profile**: per-tenant white-label settings (logo, colors, product name, support links, email-sender identity, optional custom domain) plus per-field **locked** flags (reseller-set, non-overridable) and verification status for domain/sender; applied per field via the sub-tenant→reseller→platform precedence.
- **Tenant / User & Role / Audit entry** *(existing, from E002/E005 — extended, not redefined)*: tenants gain a reseller link and branding; RBAC gains the reseller-admin role; the audit trail gains dual-identity reseller-action entries.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The feature is built on the existing E002 tenant substrate (forced row-level security + tenant-scoped access) and E005 administration (tenant-scoped sessions, RBAC, append-only audit, console shell) — reused and extended, never weakened or reimplemented.
- The hierarchy is **one reseller level** (reseller → customer); nested resellers are deferred.
- Branding is presentation-layer only: it never alters a license's contents or the signed token, and offline verification is unaffected (Principle I).
- A **vendor/platform operator** actor already exists and is the only actor above all resellers.
- Reseller onboarding is vendor-operator-initiated (no public partner self-signup in the MVP).

### Risks

- **Isolation regression / privilege escalation via the new hierarchy** *(likelihood: medium, impact: high)*: adding a parent→child relationship risks an upward/lateral cross-tenant path or IDOR; mitigate with data-layer subtree scoping and explicit escalation/isolation security tests.
- **Branding trust abuse** *(likelihood: medium, impact: medium)*: an unverified custom domain/email sender enables spoofing, or branding hides the authoritative signer; mitigate with ownership verification and a non-white-labelable trust-signal set.
- **Orphaned sub-tenants on reseller offboarding** *(likelihood: low, impact: high)*: deleting a reseller could strand customers; mitigate with a mandatory transfer-or-reassign gate and grace window.

## Implementation Signals *(mandatory)*

- **NEW-ENTITY** — reseller designation, the reseller→sub-tenant relationship link, and the per-tenant branding profile (with domain/sender verification status).
- **MIGRATION** — additive, expand-only changes over the existing tenant substrate (reseller link + branding) that preserve forced row-level security; no existing tenant/RBAC/audit semantics changed.
- **NEW-API** — reseller/console operations: onboard reseller, provision/list/manage sub-tenants, set branding, verify domain/sender, suspend/offboard, and operator-only transfer between resellers.
- **NEW-UI** — a reseller console surface (sub-tenant management + branding editor) and branding applied across all tenant-facing surfaces.
- **NEW-CONFIG** — platform-default (hard) sub-tenant quota (operator-adjustable per reseller), offboarding notice/grace window, the non-white-labelable trust-signal set, and platform-default branding.
- **EXTERNAL-SERVICE** — custom-domain ownership verification (DNS TXT/CNAME challenge) and email-sender authorization (SPF + DKIM/DMARC alignment) for the P2 branding surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A reseller-admin can provision and administer its own sub-tenants and, in the same session, cannot view or act on any tenant outside its subtree.
- **SC-002** [US1]: A reseller reference to a tenant outside its subtree returns not-found without disclosing the tenant's existence, in 100% of attempts.
- **SC-003** [US2]: A customer under a reseller sees the reseller's branding by default and its own override where set, with no platform-vendor **branding** identity on partner-facing surfaces — except the authoritative trust signals of FR-008 (signing identity, security/revocation notices, audit, legal text), which remain shown.
- **SC-004** [US2]: Applied branding resolves per field by the sub-tenant → reseller → platform precedence (each field falls back independently), and a reseller-locked field cannot be overridden by a sub-tenant — confirmed by changing each level and a locked field and observing the result.
- **SC-005** [US3]: Every reseller action on a sub-tenant is recorded with both the acting reseller-admin and the target sub-tenant, and no role can edit or delete any audit entry.
- **SC-006** [US3]: A revocation/tamper/security notice and the license-signing identity are always shown authoritatively regardless of branding (never white-labeled or spoofable).
- **SC-007** [US3]: Any upward/lateral escalation attempt (reaching a parent, platform, or sibling) is denied and recorded as a security event, with zero cross-subtree rows returned at the data layer; likewise an unset/empty tenant scope (no `app.current_tenant`) returns zero rows (fail-closed), never unscoped data.
- **SC-008** [US4]: A reseller cannot exceed its configured sub-tenant quota; the over-quota attempt is refused with a clear reason.
- **SC-009** [US4]: Suspending a reseller blocks new reseller activity, retains data, and cascades a read-only state to its sub-tenants (sign-in and read allowed; no new provisioning/activation/branding change); it is fully reversible and already-issued licenses still verify offline.
- **SC-010** [US4]: A reseller cannot be offboarded while any sub-tenant is unresolved; every sub-tenant is transferred or reassigned (no orphans) and each move is audited.
- **SC-011** [US5]: A custom domain or email sender cannot be used for white-label until ownership is verified, and a domain/sender is bound to at most one tenant.
- **SC-012** [US1]: An end-tenant admin's experience is unchanged except for applied branding and never reveals the reseller hierarchy.
- **SC-013** [US1]: A reseller-admin can access only a sub-tenant's administrative/provisioning/branding metadata and is denied its license, usage, and activation operational data, in 100% of attempts.
- **SC-014** [US4]: Moving a sub-tenant between resellers preserves the sub-tenant's own branding overrides, re-resolves per-field locks against the destination reseller, and records the move plus the branding-context change on both the source and destination.
- **SC-015** [US4]: No action can leave a reseller or sub-tenant with no administrator — the last owner cannot be removed or demoted (refused), preserving the inherited E005 last-owner protection.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Reseller (partner) | A tenant designated to resell and brand licensing for a set of customer tenants it manages. |
| Sub-tenant (customer) | A tenant managed by a reseller, within that reseller's subtree. |
| End-tenant admin | The administrator of a sub-tenant (customer); an alias of "sub-tenant admin" used where the customer-side operator is contrasted with the reseller-admin. |
| Subtree | The set of tenants a reseller may see and act on (itself and its sub-tenants); the boundary of downward-only visibility. |
| White-label / branding | Presentation-layer customization (logo, colors, product name, support links, email/domain identity) applied per tenant. |
| Branding profile | The stored per-tenant white-label settings and their verification status. |
| Trust signal | A security-authoritative element (revocation/tamper/security notice, signing identity, audit record, legal text) that is never white-labeled. |
| Delegated administration | Scoped authority granted to a reseller-admin to manage only its own subtree — a grant, never ambient cross-tenant access. |
| Vendor/platform operator | The actor above all resellers, able to manage resellers and move sub-tenants between them. |

## Stress-Test Findings

### Session 2026-08-12

All findings from the post-clarification adversarial pass were RESOLVED INLINE (stale wording the new clarifications contradicted).

- **STF-001** (severity: HIGH, category: consistency) [RESOLVED inline] — The Edge Case "sub-tenant override always wins" contradicted the new reseller-**locked**-field rule (FR-006/FR-007). **Given** a reseller locks a branding field, **When** a sub-tenant tries to override it, **Then** the reseller value must remain authoritative. **Resolution**: amended the edge case to carve out locked fields. Affected: Edge Cases, FR-006, FR-007, SC-004.
- **STF-002** (severity: HIGH, category: consistency) [RESOLVED inline] — US2-AS2 asserted a sub-tenant override applies on "any branded surface" with no locked-field exception. **Given** a reseller-locked field, **When** the sub-tenant sets its own value, **Then** the override must not apply. **Resolution**: added the locked-field exception to US2-AS2. Affected: US2, FR-007, SC-004.
- **STF-003** (severity: HIGH, category: consistency) [RESOLVED inline] — SC-003 "no platform-vendor identity on partner-facing surfaces" collided with the mandatory, always-shown signing identity/trust signals (FR-008/SC-006). **Given** a license/verification surface, **When** it renders, **Then** the authoritative signer identity must remain visible even under full branding. **Resolution**: scoped SC-003 to platform-vendor *branding* identity, excepting FR-008 trust signals. Affected: SC-003, FR-008, SC-006.
- **STF-004** (severity: MEDIUM, category: consistency) [RESOLVED inline] — A locked-field indicator in the sub-tenant editor could disclose that a managing reseller exists, conflicting with hierarchy concealment (FR-014/SC-012). **Resolution**: FR-006 now requires locked fields be shown as simply not editable without revealing the hierarchy. Affected: FR-006, FR-014, SC-012.
- **STF-005** (severity: MEDIUM, category: ambiguity) [RESOLVED inline] — US1 "administer" was undefined against the FR-017 metadata-only restriction. **Resolution**: US1 now defines administration as metadata/provisioning/branding only, excluding license/usage/activation operational data. Affected: US1, FR-017.
- **STF-006** (severity: LOW, category: coverage) [RESOLVED inline] — Locked-flag behavior across an operator sub-tenant move was undefined (FR-015). **Resolution**: FR-015 now states per-field locks re-resolve to the destination reseller while sub-tenant overrides are retained. Affected: FR-015, FR-006, FR-007.
- **STF-007** (severity: LOW, category: terminology) [RESOLVED inline] — "end-tenant admin" (FR-014/SC-012) had no glossary term. **Resolution**: added an "End-tenant admin" glossary alias of sub-tenant admin. Affected: FR-014, SC-012, Glossary.

## Compliance Check

**Status**: PASS (Spec Validator 10/10; Policy Auditor PASS — Principles I–III + PII minimization). Read-only validation; no blocking violations.

| Principle | Verdict | Evidence |
|-----------|---------|----------|
| I. Offline-first / single crypto core / no token change | PASS | Excluded bars reselling on reseller keys; branding is presentation-only and never alters license contents or the signed token; FR-008/SC-006 keep the signing identity authoritative; already-issued licenses verify offline under suspension (FR-011). |
| II. Multi-tenant isolation (forced-RLS + RBAC + audit) | PASS | Downward-only visibility (FR-004), no upward/lateral escalation enforced at the data layer (FR-005/SC-007), RBAC extended not weakened + fail-closed (FR-002), last-owner protection (FR-016), operator-only audited sub-tenant moves (FR-015); reuses/extends E002/E005 substrate. |
| III. Single security core, append-only audit | PASS | Dual-identity, append-only, tamper-evident audit (FR-009/SC-005); trust signals never white-labeled (FR-008/SC-006). |
| PII / privacy minimization | PASS | FR-017 resolved (Clarify 2026-08-12) to metadata-only — a reseller-admin never sees a sub-tenant's license/usage/activation operational data, the privacy-minimizing default. |

**Carry-forward to Plan** (non-blocking): (1) resolve FR-017 with a privacy-minimizing default during `/sddp-clarify`; (2) plan.md must extend the existing CSRF posture to the new console NEW-API/NEW-UI surfaces (spec-level omission is acceptable, but do not drop the control).
