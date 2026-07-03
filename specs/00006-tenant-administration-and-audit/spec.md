---
feature_branch: "00006-tenant-administration-and-audit"
created: "2026-07-02"
input: "Epic E005 — Tenant administration and audit: the admin console shell with interactive login and tenant-scoped sessions, role-based access control, tenant/user management, runtime API-key management, and audit-log viewing. Built on the E002 tenant repository, RBAC tables, and append-only audit log."
spec_type: "product"
spec_maturity: "draft"
epic_id: "E005"
epic_sources: "{PRD:CAP-007}"
---

# Feature Specification: Tenant Administration and Audit

**Feature Branch**: `00006-tenant-administration-and-audit`  
**Created**: 2026-07-02  
**Status**: Draft  
**Spec Type**: product  
**Spec Maturity**: draft  
**Epic ID**: E005  
**Epic Sources**: {PRD:CAP-007}

## Problem Statement *(mandatory)*

A non-developer licensing admin needs a web console to run their tenant — sign in, manage the people and machine credentials that can act, and review what happened — without touching code or the database. Today there is a tenant-scoped data layer and machine (API-key) authentication (E002), but no human sign-in, no interface to manage users/roles/keys, and no way to read the audit trail. Without this, tenants cannot be operated safely: humans have no least-privilege access, a security/compliance reviewer cannot inspect a tamper-evident record of who did what, and every later admin surface (catalog, issuance, activation) has no console shell to live in. This feature delivers the tenant administration console and audit views that make the platform operable and auditable.

## Scope *(mandatory)*

### Included

- **Interactive human sign-in** producing a tenant-scoped session (distinct from machine API-key auth).
- The **admin console shell** — a navigable authenticated surface later admin slices plug into.
- **Role-based access control (RBAC)** enforced on every privileged action.
- **User & role management** — invite/create users, assign and change roles, deactivate.
- **Runtime API-key management** — create, rotate, and revoke machine keys with scopes.
- **Audit-log viewing** — a filterable, read-only view of the append-only audit trail for a compliance reviewer.
- Every administrative action is **tenant-scoped and audited**.

### Excluded

- Catalog, issuance, activation, and billing surfaces — owned by E007/E008/E009/E014; they plug into this console shell but are out of scope here.
- Reseller / white-label hierarchy and branding — owned by E018.
- Signing-key custody operations — owned by E004; the console may link to key status but does not manage custody here.
- Single sign-on / external identity federation — a later enhancement (see US6, P2); the MVP uses direct interactive credentials.
- Customer-side audit export to external SIEM — a later enhancement (PRD assumption), not part of the MVP viewer.

### Edge Cases & Boundaries

- A session established for tenant A MUST NOT read or mutate any other tenant's data, ever.
- RBAC MUST fail closed: an action not explicitly permitted for the user's role is denied and recorded as a security event.
- The **last owner** of a tenant MUST NOT be removable or demotable such that the tenant is left with no administrator (no lock-out).
- A newly created API key's secret is shown **exactly once** at creation and is never retrievable afterward; only its metadata and status are visible later.
- The audit log is **append-only and tamper-evident**: no console action (by any role, including owner) can edit or delete an audit entry.
- Sessions MUST expire and be explicitly revocable (sign-out); an expired/revoked session grants no access.
- A deactivated user MUST be unable to sign in or act, effective immediately for new requests.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Sign in to a tenant-scoped admin console (Priority: P1)

As a licensing admin, I sign in with my credentials and land in a console scoped to my tenant, so that I can administer only my organization's licensing.

**Why this priority**: Without human sign-in and a tenant-scoped session there is no console at all — it gates every other administrative capability.

**Independent Test**: A seeded admin signs in, receives an authenticated session, sees only their tenant's data, signs out, and can no longer access the console with the ended session.

**Acceptance Scenarios**:

1. **Given** a valid admin credential for tenant A, **When** the admin signs in, **Then** they get an authenticated, tenant-A-scoped session and reach the console.
2. **Given** an authenticated session for tenant A, **When** the admin views any console data, **Then** only tenant A's data is shown and no tenant B data is reachable.
3. **Given** an authenticated session, **When** the admin signs out (or the session expires), **Then** further console requests are rejected as unauthenticated.

### User Story 2 - Role-based access control gates privileged actions (Priority: P1)

As a tenant owner, I rely on roles so that each user can do only what their role allows, and denied attempts are recorded.

**Why this priority**: Least-privilege access is security-critical and a compliance prerequisite (CAP-007); without it, any signed-in user could do anything.

**Independent Test**: A viewer-role user is blocked from a privileged action (e.g. creating an API key) with a clear denial, while an admin-role user succeeds; the denial appears in the audit log as a security event.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose role lacks permission for an action, **When** they attempt it, **Then** it is denied (fail-closed) and an auditable security event is recorded.
2. **Given** a signed-in user whose role permits an action, **When** they perform it, **Then** it succeeds and is audited.

### User Story 3 - Manage users and their roles (Priority: P1)

As a tenant admin, I invite/create users, assign and change their roles, and deactivate users who should no longer have access.

**Why this priority**: Administering who can act — and at what privilege — is the core of tenant administration; the platform is unusable by an organization without it.

**Independent Test**: An admin creates a user, assigns a role, changes the role, then deactivates the user; the deactivated user can no longer sign in, and each change is audited.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they create a user and assign a role, **Then** the user exists in the tenant with that role and the action is audited.
2. **Given** an existing user, **When** the admin changes their role or deactivates them, **Then** the change takes effect for the user's subsequent access and is audited.
3. **Given** the tenant's last owner, **When** an admin attempts to remove or demote them, **Then** the action is refused to prevent lock-out.

### User Story 4 - Manage runtime API keys (Priority: P1)

As a tenant admin, I create, rotate, and revoke machine API keys with specific scopes, so that integrations authenticate with least privilege and compromised keys can be retired.

**Why this priority**: Machine credentials (E002 API keys) drive the runtime; managing their lifecycle and scopes is essential to operate and secure a tenant.

**Independent Test**: An admin creates a scoped API key (secret shown once), uses its metadata listing, rotates it, and revokes it; a revoked key no longer authenticates and every step is audited.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they create an API key with scopes, **Then** the secret is displayed once, the key's metadata is stored, and creation is audited.
2. **Given** an existing API key, **When** the admin rotates or revokes it, **Then** the old secret stops authenticating and the change is audited.
3. **Given** a previously created API key, **When** the admin views it later, **Then** only its metadata/status are shown — never the secret.

### User Story 5 - Review the audit log (Priority: P1)

As a security/compliance reviewer, I view a read-only, filterable audit log of who did what and when, so that I can verify a tamper-evident record of tenant activity.

**Why this priority**: A tamper-evident, reviewable audit trail is a foundational trust and compliance capability (CAP-007) and a procurement gate for security reviewers.

**Independent Test**: A reviewer opens the audit view, sees entries with actor, action, target, and timestamp, filters by date and by security events, and confirms no console action can modify or delete an entry.

**Acceptance Scenarios**:

1. **Given** administrative activity has occurred, **When** the reviewer opens the audit view, **Then** each entry shows actor, action, target, and timestamp, scoped to their tenant.
2. **Given** the audit view, **When** the reviewer filters (e.g. by date range or security-event flag), **Then** only matching entries are shown.
3. **Given** any role (including owner), **When** they attempt to edit or delete an audit entry, **Then** it is impossible — the log is append-only.

### User Story 6 - Sign in via single sign-on (Priority: P2)

As an enterprise admin, I sign in through my organization's identity provider (SSO/OIDC) instead of a separate credential, so that access follows our central identity and offboarding.

**Why this priority**: Valuable for enterprise adoption, but the MVP is fully operable with direct interactive credentials; SSO layers on later.

**Independent Test**: An admin completes an SSO sign-in flow and receives a tenant-scoped session equivalent to a direct sign-in.

**Acceptance Scenarios**:

1. **Given** a tenant configured for SSO, **When** an admin authenticates via the identity provider, **Then** they receive a tenant-scoped session and the sign-in is audited.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a human authenticate with interactive credentials and, on success, establish a session bound to exactly one tenant.
- **FR-002**: System MUST scope every console read and write to the session's tenant; a session MUST NOT access another tenant's data under any circumstance.
- **FR-003**: Sessions MUST be securely managed: the opaque session token MUST be delivered to the browser only via a cookie set `HttpOnly`, `Secure`, and `SameSite` (Strict), and MUST be stored server-side only as a one-way hash — the raw token is never persisted, logged, or returned in any response body or header other than the `Set-Cookie` issued at sign-in. Sessions MUST expire after a bounded, operator-configurable window (default 8 hours, configurable up to a 24-hour maximum), be explicitly revocable via sign-out (server-side), and be rejected on the next request once expired or revoked.
- **FR-004**: System MUST enforce role-based access control on every privileged action server-side, failing closed (deny by default) when the user's role lacks permission.
- **FR-005**: A denied (unauthorized) action MUST be recorded as an auditable security event.
- **FR-006**: System MUST allow an authorized admin to create users, assign and change their roles, and deactivate users within the tenant.
- **FR-007**: A deactivated user MUST be unable to sign in or perform actions on subsequent requests.
- **FR-008**: System MUST prevent removing or demoting the tenant's last owner so the tenant is never left without an administrator.
- **FR-009**: System MUST allow an authorized admin to create runtime API keys with explicit scopes; the secret MUST be shown only once at creation and never be retrievable thereafter, and the stored key secret MUST be kept only as a one-way hash (never plaintext) — the machine-credential analogue of FR-017.
- **FR-010**: System MUST allow rotating and revoking API keys; a rotated/revoked key MUST stop authenticating.
- **FR-011**: System MUST expose a read-only audit view showing, per entry, the actor, action, target, and timestamp, scoped to the tenant.
- **FR-012**: The audit view MUST support filtering (at minimum by date range and by the security-event flag).
- **FR-013**: The audit log MUST be append-only and tamper-evident: no console action, by any role including owner, may edit or delete an audit entry. Here "tamper-evident" means append-only immutability enforced at the privilege/grant layer — no role holds update or delete permission on audit entries — rather than cryptographic hash-chaining.
- **FR-014**: Every administrative mutation (sign-in, user/role change, API-key lifecycle) MUST write an audit entry attributing the acting principal, in the same transaction as the mutation (atomic — if the audit write fails, the mutation is rolled back) so no mutation escapes the trail; unauthorized denials are additionally audited as the security events required by FR-005.
- **FR-015**: System MUST provide a navigable authenticated console shell that later admin surfaces (catalog, issuance, activation) plug into without weakening tenant scoping or RBAC.
- **FR-016**: System SHOULD support single sign-on (SSO/OIDC) as an alternative interactive authentication method yielding an equivalent tenant-scoped session. *(P2)*
- **FR-017**: Interactive human credentials MUST be stored only as salted, one-way-hashed values (never plaintext) and MUST never be logged or returned by any API — the human-credential analogue of the API-key secrecy rule (FR-009).
- **FR-018**: The interactive sign-in path MUST resist credential guessing by throttling or locking out repeated failed attempts (rate-limit and/or account lockout): after a bounded, operator-configurable number of consecutive failed attempts (default 5) the account MUST be locked out for a bounded, operator-configurable window (default 15 minutes) before further attempts are accepted, and lockout/throttle events MUST be auditable.
- **FR-019**: Cookie-authenticated state-changing requests MUST be protected against cross-site request forgery (CSRF): beyond the same-site cookie already required by FR-003 (necessary but not sufficient on its own), every state-changing request MUST additionally present a per-session anti-CSRF token that the server validates and rejects when it is absent or does not match (e.g. a double-submit token echoed in a request header — the concrete mechanism is a Plan/contract decision).

### Key Entities *(include for product or technical specs if feature involves data)*

- **User**: A human principal within a tenant, with an interactive credential, a role, and an active/deactivated status.
- **Role**: The privilege level that governs which actions a user may perform. The roles form a fixed, ordered, closed set — owner > admin > viewer (each higher role includes the lower roles' privileges) — enforced fail-closed server-side; no other roles exist.
- **Session**: An authenticated, time-bounded, tenant-scoped context established at sign-in and endable by sign-out/expiry.
- **API key**: A machine credential with scopes and a status; its secret exists only at creation time.
- **Audit entry**: An append-only record of an action — actor, action, target, timestamp, and a security-event flag.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The people administering licensing are non-developers comfortable with a web admin surface (PRD).
- E002 provides the tenant repository, the user/role/api-key tables, forced tenant isolation (RLS), and the append-only audit log this feature builds on.
- The MVP uses direct interactive credentials (email + password); external identity federation (SSO) is a P2 layer.
- Human sessions and machine API keys are distinct authentication paths that both resolve to a tenant scope.
- The new human-credential and session data are PII/tenant data covered by E002's existing GDPR export/erasure path (E002 TR-012); this feature does not introduce a separate data-handling regime.

### Risks

- **Session/auth handling weakness** *(likelihood: medium, impact: high)*: insecure sessions could enable account takeover or cross-tenant access — mitigate with bounded expiry, revocation, tenant-bound sessions, and server-side RBAC on every action.
- **Privilege-escalation / lock-out via role management** *(likelihood: medium, impact: high)*: bad role edits could escalate privilege or strand a tenant — mitigate with fail-closed RBAC and a last-owner safeguard.
- **Audit tampering perception** *(likelihood: low, impact: high)*: if the audit trail is (or appears) editable, compliance trust collapses — mitigate with append-only enforcement at the privilege layer (E002) and a read-only viewer.

## Implementation Signals *(mandatory)*

- `NEW-UI` — The admin console shell (authenticated navigable surface) with the users, API-keys, and audit views.
- `NEW-API` — Interactive auth/session endpoints plus tenant-scoped admin REST for users, roles, API keys, and audit queries.
- `NEW-ENTITY` — Session and a human interactive credential (extending the E002 user), distinct from the machine API key.
- `MIGRATION` — Add the human-credential and session storage to the E002 schema (expand-only, tenant-scoped, RLS).
- `NEW-CONFIG` — Session/cookie security settings and the session/credential secrets (injected via the runtime secrets contract).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An admin signs in and sees only their own tenant's data; a signed-out or expired session grants no console access.
- **SC-002** [US1]: No authenticated session can read or mutate another tenant's data in any console view or action.
- **SC-003** [US2]: A user whose role lacks permission is denied a privileged action (fail-closed), and the denial is recorded as a security event; an authorized user succeeds.
- **SC-004** [US3]: An admin can create a user, assign/change their role, and deactivate them; the deactivated user cannot subsequently sign in, and each change is audited.
- **SC-005** [US3]: An attempt to remove or demote the tenant's last owner is refused.
- **SC-006** [US4]: An API-key secret is obtainable only at creation; a revoked or rotated key no longer authenticates; all key lifecycle actions are audited.
- **SC-007** [US5]: The audit view shows actor, action, target, and timestamp per entry (tenant-scoped), supports date-range and security-event filtering, and no action can edit or delete an entry.
- **SC-008** [US6]: An admin can obtain a tenant-scoped session via SSO equivalent to a direct sign-in. *(P2)*
- **SC-009** [US1]: A human credential is never exposed — it is stored only hashed and appears in no API response or log — and repeated failed sign-ins are throttled/locked out.
- **SC-010** [US1]: An admin surface plugged into the console shell inherits the session's tenant scope and RBAC — it cannot read or act outside the tenant or above the user's role.
- **SC-011** [US1]: A cookie-authenticated state-changing request that lacks a valid anti-CSRF token is rejected, and the session token never appears in any API response body or log — it is delivered only in the sign-in cookie.

## Compliance Check

**Overall**: PASS vs project-instructions v1.1.0 (+ ADR-0004, ADR-0007, E002). No blocking violations; the hardening items raised in audit are resolved below.

- Principle II (Multi-Tenant Isolation + RBAC): PASS — session bound to one tenant (FR-001), every console read/write tenant-scoped with no cross-tenant path (FR-002, SC-002), server-side fail-closed RBAC with audited denial (FR-004/005, SC-003), and plugged-in surfaces inherit scope + RBAC (FR-015, SC-010).
- Principle III (Single Security Core, Fully Audited): PASS — every admin mutation and every denial audited with actor/action/target/timestamp (FR-014/005, SC-007); append-only and tamper-evident, no edit/delete by any role (FR-013). Reuses the E002 append-only audit path, not a new mechanism (Assumptions; MIGRATION expand-only on the E002 schema).
- Security Requirements: PASS — bounded/revocable/tenant-bound sessions with `HttpOnly`+`Secure`+`SameSite` cookies and a measurable, operator-configurable expiry (default ≤ 24h) (FR-003); CSRF protection (SameSite + double-submit token) on cookie-authenticated state-changing requests (FR-019); human credentials stored only salted-hashed, never logged/returned (FR-017, SC-009); brute-force throttling/lockout on sign-in after a bounded number of consecutive failures (default 5), auditable (FR-018); API-key secret shown once and never retrievable (FR-009); immediate loss of access on deactivation (FR-007); last-owner safeguard (FR-008).
- Technology Stack: PASS — TS SPA console shell (NEW-UI) + tenant-scoped admin REST (NEW-API, ADR-0007) on the E002 data layer; distinct human-session vs machine API-key auth (NEW-ENTITY).
- E002 / ADR consistency: PASS — reuses the tenant repository, RBAC, RLS, and append-only `audit_log`; Session + human credential are the net-new entities E002 explicitly defers to E005. Aligns with ADR-0004 (shared-schema + RLS) and ADR-0007 (REST/JSON). New credential/session PII is covered by E002's GDPR export/erase path (Assumptions).

Note: the SPA framework and the session-store/library implementation are Plan-phase decisions; the security **properties** stated above (cookie hardening, anti-CSRF, credential/token secrecy at rest, lockout, expiry) are required by this spec, while the concrete header/cookie mechanics live in the Plan and contract. Source layout (`/src/server`, `/src/admin-ui`) enforced at Plan.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Interactive login | A human sign-in with credentials (vs. a machine API key), establishing a session. |
| Session | A time-bounded, tenant-scoped authenticated context created at sign-in and endable by sign-out/expiry. |
| RBAC | Role-based access control — permitting actions by the user's assigned role, fail-closed. |
| API key | A machine credential (scoped) used by integrations/runtime; its secret is shown only at creation. |
| Tamper-evident audit | An append-only activity log that no action can edit or delete, preserving a trustworthy record. |
| Last-owner safeguard | A rule preventing removal/demotion of the final owner so a tenant is never left without an admin. |
