---
feature_branch: "00003-tenancy-and-data-foundation"
created: "2026-06-27"
input: "Epic E002 — Tenancy and data foundation: the modular-monolith application skeleton and the tenant-scoped data layer (PostgreSQL schema, a repository that injects tenant scope on every query, Row-Level Security as the safety net, the append-only audit write path) that every server epic builds on."
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E002"
epic_sources: "{SAD:ADR-0004,ADR-0005}"
---

# Feature Specification: Tenancy and Data Foundation

**Feature Branch**: `00003-tenancy-and-data-foundation`  
**Created**: 2026-06-27  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E002  
**Epic Sources**: {SAD:ADR-0004,ADR-0005}

## Problem Statement *(mandatory)*

The license server is multi-tenant SaaS from day one, where a single cross-tenant data leak is catastrophic and unrecoverable. Every later server capability — catalog, issuance, activation, signing, admin — must read and write tenant-scoped data and record an audit trail, so the isolation, schema, migration, and audit foundations cannot be reinvented per feature. This foundation delivers the modular-monolith application skeleton and the tenant-scoped data layer (repository + Row-Level Security + append-only audit + gated migrations) that all subsequent epics depend on.

## Scope *(mandatory)*

### Included

- A tenant-scoped data-access (repository) layer that injects the authenticated tenant on every tenant-owned query.
- PostgreSQL Row-Level Security as a defense-in-depth safety net under the repository layer.
- The initial database schema for the foundational entities (tenant, user, role, api_key, audit_log).
- Backward-compatible (expand/contract) migrations run as a discrete, advisory-locked job.
- An append-only audit write path recording every tenant/administrative mutation.
- The modular-monolith application skeleton with enforced internal module boundaries and a tenant-resolution auth context.

### Excluded

- Feature-domain tables and logic (products, plans, licenses, activations, signing keys) — owned by their respective epics; this foundation only provides the tenancy/audit substrate they extend.
- Container packaging, 12-factor config, secrets, and health probes — owned by the runtime/packaging epic (E006); this epic provides the migration harness it runs.
- Interactive human login / sessions / SSO — owned by the admin epic (E005); this epic provides machine/runtime tenant authentication only.
- Public REST endpoints for business capabilities — owned by their feature epics; this epic provides the module/auth skeleton they plug into.

### Edge Cases & Boundaries

- A tenant-owned query executed without a resolved tenant scope MUST be refused, not run unscoped.
- A pooled database connection MUST NOT carry a prior request's tenant context into the next request.
- A privileged/owner database role or `SECURITY DEFINER` path MUST NOT silently bypass RLS for application queries.
- Two migration runners starting concurrently MUST NOT both apply migrations.
- A destructive schema change MUST NOT ship in the same release as code depending on it.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Tenant-scoped data access and isolation (Priority: P1)

Provide a repository layer that injects the authenticated tenant scope on every tenant-owned read and write, hardened by PostgreSQL Row-Level Security as the safety net, so no operation can cross a tenant boundary.

**Why this priority**: Cross-tenant isolation is a non-negotiable principle; a leak is catastrophic, and every other epic depends on this guarantee.

**Rationale**: Application-layer scoping plus database-enforced RLS is defense in depth (ADR-0004); neither alone is sufficient.

**Deliverables**:
- A repository/data-access layer that requires and injects a tenant scope on every tenant-owned query.
- RLS policies with `FORCE ROW LEVEL SECURITY` on every tenant-owned table; the application connects as a non-owner, non-superuser role.
- Connection-pool tenant-context isolation (scoped per transaction, reset on connection return).
- A `tenant_id`-leading composite index on every tenant-owned table.

**Validation Criteria**:
1. **Given** a request authenticated to tenant A, **When** it reads or writes, **Then** it can access only tenant A's rows and never tenant B's (repository and RLS).
2. **Given** a tenant-owned query with no resolved tenant scope, **When** it is issued, **Then** it is refused rather than executed unscoped.
3. **Given** a pooled connection reused across requests, **When** a new request runs, **Then** it carries no prior tenant context.

### Objective 2 - Schema and gated migrations (Priority: P1)

Define the initial tenant-scoped schema for the foundational entities and run backward-compatible migrations as a discrete, advisory-locked step rather than implicitly on boot.

**Why this priority**: All later epics extend this schema; unsafe or racing migrations would block their delivery and safe rollbacks.

**Rationale**: Expand/contract migrations keep upgrades and digest-pinned rollbacks safe (DDR-004); a gated runner prevents replica races.

**Deliverables**:
- An initial schema for `tenant`, `user`, `role`, `api_key`, and `audit_log`.
- A migration harness enforcing backward-compatible (expand/contract) changes.
- A discrete migration step guarded by a database advisory lock (single runner).

**Validation Criteria**:
1. **Given** the migration harness, **When** migrations run, **Then** they apply as a discrete step gated by an advisory lock, with at most one runner applying them.
2. **Given** two concurrent migration attempts, **When** they start, **Then** only one applies the migrations and the other waits or no-ops.
3. **Given** a prior application version, **When** the new schema is applied, **Then** the prior version still runs against it (expand/contract).

### Objective 3 - Append-only audit and modular skeleton (Priority: P1)

Record every tenant and administrative mutation in an append-only audit log, and establish the modular-monolith application skeleton with enforced internal module boundaries and a tenant-resolution auth context.

**Why this priority**: Auditability is required for forensics/compliance, and the module seams must exist before feature epics plug into them.

**Rationale**: The append-only log is the forensic backbone (Principle III); enforced module seams keep future extraction cheap (ADR-0005).

**Deliverables**:
- An append-only `audit_log` write path capturing actor, action, target, and timestamp for every mutation; no UPDATE/DELETE grant to the application role.
- The modular-monolith application skeleton with reserved, boundary-enforced module seams.
- A tenant-resolution auth context (machine/runtime API key) that makes the resolved tenant available to the repository layer.

**Validation Criteria**:
1. **Given** any tenant or administrative mutation, **When** it commits, **Then** a corresponding append-only audit entry exists (actor, action, target, timestamp).
2. **Given** the application role, **When** it attempts to UPDATE or DELETE an audit row, **Then** the operation is denied.
3. **Given** a request with a valid tenant-scoped API key, **When** it is processed, **Then** the resolved tenant is available to the repository and enforced.

### Technical Constraints

- Every tenant-owned persistence and API operation MUST be tenant-scoped; cross-tenant access is permitted only via an explicit, audited platform-admin path.
- The application MUST connect to PostgreSQL as a non-owner, non-superuser role; the supported Postgres patch level MUST meet TR-014 (16.4+, patched within 30 days).
- Migrations MUST be backward-compatible (expand/contract); destructive changes deferred ≥ 2 releases.
- The core MUST meet the project quality gates: ≥ 80% **line AND branch** coverage, security scanning (`npm audit`, Semgrep) with the build failing on any high/critical advisory or high-severity SAST finding, and integration tests against a real PostgreSQL (Testcontainers).

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: The signing (E004), admin (E005), catalog (E007), issuance (E008), and activation (E009) epics depend on this tenant repository, RLS policies, and audit log.
- **IP-002**: The runtime/packaging epic (E006) consumes this migration harness as its gated, advisory-locked migration job.
- **IP-003**: The foundational entities extend the project data model in `specs/00001-license-server/data-model.md` (tenant, user/role, api_key, audit_log).

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST provide a data-access repository that injects the authenticated tenant scope on every tenant-owned read and write; no tenant-owned query may execute without a resolved tenant scope.
- **TR-002**: System MUST enforce PostgreSQL Row-Level Security with `FORCE ROW LEVEL SECURITY` on every tenant-owned table, with the application connecting as a non-owner, non-superuser role.
- **TR-003**: System MUST prevent connection-pool tenant-context bleed (scope set per transaction and reset on connection return) so a pooled connection never carries a prior request's tenant scope.
- **TR-004**: Every tenant-owned table MUST have a composite index leading with `tenant_id`.
- **TR-005**: System MUST define an initial schema for the foundational entities `tenant`, `user`, `role`, `api_key`, and `audit_log`.
- **TR-006**: Database migrations MUST be backward-compatible (expand/contract); destructive changes MUST be deferred at least two releases.
- **TR-007**: Migrations MUST run as a discrete, advisory-locked step (a single runner at a time), not implicitly on every application boot.
- **TR-008**: System MUST record every tenant and administrative mutation in an append-only audit log capturing actor, action, target, and timestamp; the audit table MUST NOT grant UPDATE or DELETE to the application role.
- **TR-009**: System MUST authenticate runtime/machine requests to a tenant context via a tenant-scoped API key carrying capability scopes (e.g. `activate`, `validate`, `admin`), and make the resolved tenant and scopes available to the repository/authorization layer.
- **TR-010**: The application MUST be structured as a modular monolith with internal module boundaries enforced by a build-failing dependency-boundary lint rule (e.g. ESLint `no-restricted-imports` or dependency-cruiser) so a high-throughput path can be extracted later without a rewrite.
- **TR-011**: A cross-tenant access attempt MUST be blocked and MUST be recorded as an auditable `security_event` in the audit log; the audit stream is exportable for downstream alerting.
- **TR-012**: User/customer identifiers used only for lookup MUST be stored as a hash only (no plaintext lookup identifier retained), and the schema MUST support export and deletion of a tenant's personal data (GDPR).
- **TR-013**: Operations MUST be gated by role-based access control; a principal's role within its tenant MUST be a necessary gate for which operations it may perform (combined with API-key scope per TR-016).
- **TR-014**: The application MUST run against PostgreSQL 16 at or above the latest security-patched minor release (minimum 16.4), and the deployment MUST adopt new Postgres security patches within 30 days of release (RLS CVE exposure).
- **TR-015**: Each migration MUST apply within a transaction so a failure leaves no half-applied schema, and the advisory lock MUST auto-release on runner crash / session end so a failed runner does not deadlock the next.
- **TR-016**: When both an API-key scope and an RBAC role apply to an operation, authorization MUST be fail-closed — the operation is permitted only if the scope AND the role each allow it; denial by either gate is surfaced via the auditable security-event path (SC-007).

### Key Entities *(include for product or technical specs if feature involves data)*

- **Tenant**: The isolation root; every tenant-owned row carries `tenant_id`.
- **User**: A human principal within a tenant (credentials owned by the admin epic); minimal PII.
- **Role**: An RBAC role assignment scoping a user's permissions within a tenant.
- **API Key**: A tenant-scoped machine credential (stored hashed) used for runtime authentication.
- **Audit Log**: An append-only record of every mutation (actor, action, target, timestamp, with an optional before/after snapshot).

## Assumptions & Risks *(mandatory)*

### Assumptions

- PostgreSQL 16.4+ is available and the application connects as a dedicated non-owner role.
- At most one migration runner executes at a time (enforced by the advisory lock).
- Feature epics extend this schema additively via the same migration harness.

### Risks

- **RLS bypass** *(likelihood: medium, impact: high)*: a privileged role, owner-owned view, or `SECURITY DEFINER` path could bypass RLS — mitigate with a non-owner app role, forced RLS, and mandated current Postgres patch level.
- **Connection-pool context bleed** *(likelihood: medium, impact: high)*: a pooled connection carrying a prior tenant scope leaks data — mitigate with per-transaction scope and reset-on-return.
- **Migration race** *(likelihood: low, impact: high)*: concurrent runners corrupt schema state — mitigate with an advisory-locked single-runner migration step.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — Foundational schema: tenant, user, role, api_key, audit_log.
- `MIGRATION` — Initial tenant-scoped schema plus the expand/contract, advisory-locked migration harness.
- `NEW-CONFIG` — Non-owner DB role and RLS policies (`FORCE ROW LEVEL SECURITY`).
- `NEW-API` — Tenant-resolution auth-context middleware and the modular-monolith module skeleton.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A request authenticated to one tenant can never read or modify another tenant's data — verified across the repository and RLS layers for every tenant-owned table and a representative set of read and write operations across at least two distinct tenants (100% blocked).
- **SC-002** [OBJ1]: A tenant-owned query issued without a resolved tenant scope is refused, and a reused pooled connection carries no prior tenant context (verified by a pool-reuse test).
- **SC-003** [OBJ2]: Migrations apply as a discrete advisory-locked step with at most one runner; concurrent attempts do not both apply.
- **SC-004** [OBJ2]: A prior application version (the immediately preceding released schema, N-1) runs unchanged against the migrated schema (expand/contract verified).
- **SC-005** [OBJ3]: Every tenant/administrative mutation produces an append-only audit entry, and the application role cannot UPDATE or DELETE audit rows.
- **SC-006** [OBJ3]: A request with a valid tenant-scoped API key resolves to exactly one tenant, which the repository enforces on every query.
- **SC-007** [OBJ1]: A cross-tenant access attempt is blocked and recorded as an auditable security event (TR-011); an operation denied by an unauthorized role OR an insufficient API-key scope is blocked and recorded (TR-013, TR-016).
- **SC-008** [OBJ2]: Lookup identifiers are stored as a hash only (no plaintext retained), and a tenant's personal data can be exported and deleted on request (TR-012).
- **SC-009** [OBJ1]: Every tenant-owned table has a verified `tenant_id`-leading composite index (TR-004).
- **SC-010** [OBJ2]: The foundational schema (tenant, user, role, api_key, audit_log) is present and applied via the migration harness (TR-005).
- **SC-011** [OBJ3]: Module-boundary enforcement blocks a cross-module import that violates the reserved seams (TR-010).
- **SC-012** [OBJ2]: A failed or crashed migration leaves the schema unchanged and the advisory lock free (TR-015).

## Clarifications

### Session 2026-06-27 (checklist hardening)

- Q: How do an API-key scope and an RBAC role combine for an operation? -> A: Fail-closed AND — permitted only if both the scope and the role allow it; denial by either is the auditable security event (TR-016, SC-007).
- Q: What coverage dimensions does the ≥80% gate apply to? -> A: Lines AND branches both ≥ 80% over `src/server/`.
- Q: What is the minimum supported PostgreSQL version/patch policy? -> A: 16.4+ with security patches adopted within 30 days (TR-014).
- Q: What are the migration failure/atomicity semantics? -> A: Per-migration transaction (no half-apply) and advisory-lock auto-release on crash (TR-015, SC-012).
- Q: What anchors the isolation and expand/contract tests? -> A: Isolation verified across ≥2 tenants and every tenant-owned table (SC-001); expand/contract uses the N-1 schema as the prior version (SC-004).

## Compliance Check

**Overall**: PASS (no violations) vs project-instructions v1.1.0; the non-blocking gaps raised in audit are closed below.

- Principle II (Multi-Tenant Isolation + RBAC): PASS — tenant-scope (TR-001/002/003), audited cross-tenant admin path (TR-011), RBAC gating (TR-013).
- Principle III (Fully Audited): PASS — append-only audit of every mutation, no UPDATE/DELETE to the app role (TR-008, SC-005).
- Security (PII/GDPR/isolation): PASS — hashed/minimized identifiers + export/delete (TR-012, SC-008); non-owner role + current patch level (TR-002).
- Testing & Quality: PASS — coverage ≥ 80%, security scanning, real-Postgres integration (Technical Constraints). Image/supply-chain scanning (Trivy/Grype) is owned by the runtime epic E006.
- Source layout (`ENFORCE_SRC_ROOT`, `/src/server`): enforced at the Plan phase.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Tenant | An isolated account that owns its data; the root of all access scoping. |
| Row-Level Security (RLS) | A PostgreSQL feature restricting which rows a role may access, used here as the isolation safety net. |
| Repository layer | The data-access layer that injects tenant scope on every query. |
| Expand/contract migration | A backward-compatible schema change pattern (add now, remove later) that keeps rollbacks safe. |
| Advisory lock | A PostgreSQL lock used to ensure a single migration runner. |
| Append-only audit log | A mutation log with no UPDATE/DELETE, providing tamper-evident forensics. |
| Modular monolith | One deployable with enforced internal module boundaries that permit later extraction. |
