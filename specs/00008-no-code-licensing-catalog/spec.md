---
feature_branch: "00008-no-code-licensing-catalog"
created: "2026-07-07"
input: "E007"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E007"
epic_sources: "{PRD:CAP-001}"
---

# Feature Specification: No-Code Licensing Catalog

**Feature Branch**: `00008-no-code-licensing-catalog`
**Created**: 2026-07-07
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E007
**Epic Sources**: {PRD:CAP-001}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Today, changing how a product is packaged — its plans and the features each plan unlocks — means an
engineering release: entitlements are hard-coded. That makes commercial teams wait on developers for
routine packaging changes and couples pricing/packaging decisions to the deploy cycle. Licensing admins
(non-developers) need to define products, plans, and feature entitlements, and set per-plan values,
entirely through forms — no code, no config files — so packaging changes ship the moment they are saved.
Without this catalog there is nothing for license issuance (E008) to reference, so it blocks the MVP.

## Scope *(mandatory)*

### Included

- No-code definition and management of **products** (the catalog root), **plans** (a package under a
  product), and **feature entitlements** (boolean on/off, or an integer limit).
- Setting **per-plan entitlement values** (which features a plan grants, and the value for each).
- A per-plan **seat limit** (maximum activations), defaulting to 1.
- Read-only **browsing** of the catalog, tenant-scoped and role-gated, within the E005 admin console shell.
- **Archiving** (soft-retire) of catalog entries so already-issued licenses remain interpretable.
- A retrievable **effective plan definition** (entitlement keys, values, seat limit) for downstream issuance.

### Excluded

- License issuance, lifecycle, and signing — owned by E008 (this epic provides the catalog it reads).
- Activation and seat enforcement — owned by E009 (this epic only stores the seat-limit default).
- Dynamic/guarded policy rules and computed entitlements — owned by E017 (this epic stores static values only).
- Pricing, currency, and billing — owned by the billing epic (E014); plans define entitlements, not prices.
- Retroactive changes to already-issued licenses — issued licenses snapshot their values at issue time and
  are never mutated by later catalog edits.

### Edge Cases & Boundaries

- A duplicate key (product key within a tenant, plan key within a product, entitlement key within a tenant)
  is rejected.
- An integer-limit value that is negative or non-integer, or a boolean value on an integer entitlement (and
  vice-versa), is rejected with a field-level message.
- Attempting to change an entitlement's **type** after any plan references it is refused.
- Hard-deleting an entitlement, plan, or product that is referenced (by a plan or by issued licenses) is
  refused; archiving is the supported path.
- Archiving a product archives its plans; archived entries are excluded from active selection but retained.
- A plan with zero entitlements is valid (it simply grants no gated features).
- Editing a plan's entitlement value changes only **future** issuance; previously issued licenses are unaffected.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Define and manage products (Priority: P1)

A licensing admin opens the catalog in the admin console and creates a product — the top-level container
for everything they license (e.g. "Acme CAD"). They give it a human name and a stable key, and can later
edit its details or archive it when it is retired.

**Why this priority**: The product is the catalog root; nothing else (plans, entitlements) can exist without it.

**Independent Test**: An admin creates a product via the console, sees it listed, edits its name, and archives it.

**Acceptance Scenarios**:

1. **Given** an authenticated admin, **When** they submit a product with a name and a unique key, **Then** the product is created and appears in the catalog.
2. **Given** an existing product, **When** the admin submits another product with the same key, **Then** it is rejected as a duplicate.
3. **Given** a product no longer sold, **When** the admin archives it, **Then** it is retained but excluded from active selection.

### User Story 2 - Define and manage plans within a product (Priority: P1)

The admin creates one or more plans under a product (e.g. "Standard", "Pro"). Each plan is a package that
will grant a set of entitlements and carries a seat limit (how many machines a license may activate),
which defaults to 1.

**Why this priority**: Plans are what licenses are issued against; they carry the seat limit issuance/activation depend on.

**Independent Test**: An admin creates a plan under a product, sets its seat limit, edits it, and archives it.

**Acceptance Scenarios**:

1. **Given** an existing product, **When** the admin creates a plan with a name and unique key, **Then** the plan is created under that product with a default seat limit of 1.
2. **Given** a plan, **When** the admin sets its seat limit to a positive integer, **Then** the new limit is saved.
3. **Given** a plan belonging to product A, **When** it is viewed, **Then** it is never associated with another product.

### User Story 3 - Define feature entitlements (Priority: P1)

The admin defines the features that plans can grant: a **boolean** entitlement (a feature is on or off,
e.g. "export_pdf") or an **integer-limit** entitlement (a numeric cap, e.g. "max_projects"). Each has a
stable key that becomes the feature key embedded in issued licenses.

**Why this priority**: Entitlements are the units plans grant; without them a plan unlocks nothing.

**Independent Test**: An admin defines one boolean and one integer-limit entitlement and sees both listed.

**Acceptance Scenarios**:

1. **Given** an authenticated admin, **When** they define a boolean entitlement with a unique key, **Then** it is created with type boolean.
2. **Given** an authenticated admin, **When** they define an integer-limit entitlement, **Then** it is created with type integer-limit.
3. **Given** an entitlement already referenced by a plan, **When** the admin tries to change its type, **Then** the change is refused.

### User Story 4 - Configure per-plan entitlement values (Priority: P1)

The admin attaches entitlements to a plan and sets each value — on/off for a boolean, a non-negative
number for an integer limit — and can edit any value later. Saving takes effect immediately with no code
change or deploy.

**Why this priority**: This is the core no-code value: changing what a plan grants without an engineering release.

**Independent Test**: An admin sets two entitlement values on a plan, edits one, and confirms the change persists with no code change.

**Acceptance Scenarios**:

1. **Given** a plan and defined entitlements, **When** the admin sets a boolean value on and an integer limit to 50, **Then** both values are saved on the plan.
2. **Given** a saved plan entitlement, **When** the admin changes the integer limit to 100 and saves, **Then** the new value persists immediately without any code or config change.
3. **Given** an integer-limit entitlement, **When** the admin enters a negative or non-numeric value, **Then** it is rejected with a field-level message.

### User Story 5 - Browse the catalog, role-gated and tenant-isolated (Priority: P1)

A viewer can browse the catalog read-only; only admins can create or edit. Every catalog entity is scoped
to the owning tenant and is never visible or editable from another tenant.

**Why this priority**: Security-critical — the catalog must enforce the same RBAC and tenant isolation as the rest of the console.

**Independent Test**: A viewer lists the catalog but is blocked from creating a product; a second tenant cannot see the first tenant's catalog.

**Acceptance Scenarios**:

1. **Given** a viewer, **When** they open the catalog, **Then** they can browse products, plans, and entitlements but see no create/edit actions.
2. **Given** a viewer, **When** they attempt a catalog mutation, **Then** it is denied and recorded as a security event.
3. **Given** a catalog created in tenant A, **When** an admin of tenant B queries the catalog, **Then** none of tenant A's entities are visible.

### User Story 6 - Export the catalog declaratively (Priority: P2)

The admin exports the tenant's catalog in a declarative format (YAML/JSON) for review, backup, or GitOps.

**Why this priority**: Useful for review and version control, but the MVP is fully usable through the console without it.

**Independent Test**: An admin exports the catalog and the file contains the products, plans, entitlements, and values as configured.

**Acceptance Scenarios**:

1. **Given** a configured catalog, **When** the admin requests an export, **Then** a declarative document containing all products, plans, entitlements, and per-plan values is returned.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: The system MUST let an admin create, list, view, edit, and archive **products**, tenant-scoped.
- **FR-002**: A product MUST have a human name and a stable key that is unique within the tenant.
- **FR-003**: The system MUST let an admin create, list, view, edit, and archive **plans** under a parent product; a plan MUST belong to exactly one product and have a key unique within that product.
- **FR-004**: A plan MUST carry a seat limit (maximum activations) that defaults to 1 and accepts any positive integer.
- **FR-005**: The system MUST let an admin define **entitlements** with a type of `boolean` or `integer-limit` and a stable key unique within the tenant.
- **FR-006**: An entitlement's type MUST be fixed once the entitlement is referenced by any plan (type changes refused thereafter).
- **FR-007**: The system MUST let an admin attach entitlements to a plan and set a per-plan **value**: on/off for a boolean entitlement, a non-negative integer for an integer-limit entitlement.
- **FR-008**: The system MUST reject an entitlement value that does not match its type, with a clear field-level message.
- **FR-009**: Editing a plan's entitlement value or any catalog attribute MUST take effect immediately, with no code change, redeploy, or config-file edit.
- **FR-010**: Every catalog entity MUST be strictly tenant-scoped — no cross-tenant read or write.
- **FR-011**: The system MUST allow a role of admin or higher to create/edit/archive catalog entities and allow viewers to read; an unauthorized mutation MUST be denied and recorded as a security event.
- **FR-012**: Every catalog mutation MUST be written to the append-only audit log with actor, action, and target.
- **FR-013**: Archiving MUST retain the entity (so already-issued licenses remain interpretable) while excluding it from active selection; the catalog offers no hard-delete operation — archive is the only retirement path (a referenced entity can never be hard-deleted).
- **FR-014**: The system MUST expose the **effective plan definition** — the plan's entitlement keys, their values, and the seat limit — through the admin API for downstream license issuance.
- **FR-015**: The no-code catalog MUST be presented as forms within the admin console shell, behind the console's authentication and RBAC.
- **FR-016**: Catalog edits MUST affect only future issuance; licenses already issued MUST be unaffected.
- **FR-017**: The system SHOULD let an admin export the tenant's catalog in a declarative format (YAML/JSON). *(P2)*
- **FR-018**: A product, plan, and entitlement **key** MUST be immutable after creation — the key is never accepted in an edit and cannot be changed (the human name and description remain editable). An entitlement's type is governed separately by FR-006; FR-018 concerns only the key. (The entitlement key is the feature key embedded in issued licenses, so changing it would break field gating.)
- **FR-019**: A denial security event required by FR-011 MUST capture the actor (the attempting principal/session), the attempted action, the target entity, and the denial reason (e.g. insufficient role, or a cross-tenant attempt), so denials are independently auditable from authorized-mutation audit entries.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Product**: the tenant-scoped catalog root. Attributes: name, stable key (unique per tenant), description, status (active/archived). Has many plans.
- **Plan**: a package under one product. Attributes: name, stable key (unique per product), description, seat limit (max activations, default 1), status. Has many plan-entitlement values.
- **Entitlement**: a tenant-scoped feature definition. Attributes: stable key (unique per tenant; the feature key embedded in issued licenses), name, type (boolean | integer-limit), description, status.
- **Plan Entitlement**: the per-plan value binding a plan to an entitlement. Attributes: plan, entitlement, value (a boolean flag or a non-negative integer, per the entitlement's type).

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E002 tenant repository, Row-Level Security, append-only audit log, and migration harness are available and are what the catalog persists through.
- The E005 admin console shell, session authentication, and RBAC (owner/admin/viewer) are available; the catalog UI plugs into the console's navigation behind RBAC.
- License issuance (E008) consumes the effective plan definition this epic exposes; entitlement keys are the canonical feature keys embedded in E001 signed tokens.
- Non-developer admins configure the catalog entirely through forms; no config files or code are involved.

### Risks

- **Key churn after issuance** *(likelihood: medium, impact: high)*: renaming an entitlement key after licenses embed it breaks feature gating in the field — mitigated by immutable keys once referenced and archive-not-delete.
- **Scope creep into dynamic rules** *(likelihood: medium, impact: medium)*: admins may expect computed/conditional entitlements — mitigated by keeping E007 to static values and deferring guarded rules to E017.
- **Referential breakage** *(likelihood: low, impact: high)*: deleting a referenced plan/entitlement would orphan issued licenses — mitigated by forbidding hard deletion of referenced entities (archive only).

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — product, plan, entitlement, and plan_entitlement catalog entities.
- `MIGRATION` — an expand-only schema migration adding the catalog tables with tenant-scoped forced RLS and audit grants, following the E002 pattern.
- `NEW-API` — tenant-scoped `/admin` catalog REST endpoints for products, plans, entitlements, and per-plan values, plus the effective-plan-definition read model.
- `NEW-UI` — catalog views (products / plans / entitlements / plan values) added to the E005 admin console shell, behind RBAC.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An admin creates a product through the console in under a minute with no code or config change.
- **SC-002** [US2]: An admin creates a plan under a product; a new plan defaults to a seat limit of 1.
- **SC-003** [US3]: An admin defines one boolean entitlement and one integer-limit entitlement, both listed in the catalog.
- **SC-004** [US4]: An admin sets a plan's entitlement values and then edits one; the change persists immediately with no code change.
- **SC-005** [US4]: An entitlement value that does not match its type (e.g. a non-numeric integer limit) is rejected with a clear message and nothing is saved.
- **SC-006** [US5]: A viewer can browse the catalog but cannot create or edit; an unauthorized mutation is denied and recorded as a security event.
- **SC-007** [US5]: A catalog created in one tenant is never visible or editable from another tenant.
- **SC-008** [US1]: Archiving a catalog entry retains it for already-issued licenses while removing it from active selection.
- **SC-009** [US4]: The effective plan definition — entitlement keys, values, and seat limit (default 1) — is retrievable for issuance and reflects the latest saved values.
- **SC-010** [US1]: Every authorized catalog change (create, edit, archive) is recorded in the audit log with actor, action, and target.
- **SC-011** [US4]: Setting or removing a plan's entitlement value is recorded in the audit log with actor, action, and target (extending SC-010's coverage to the per-plan value changes).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Product | The top-level catalog entity a vendor licenses; contains plans. |
| Plan | A package under a product that a license is issued against; grants a set of entitlement values and carries a seat limit. |
| Entitlement | A definition of a gated feature — either boolean (on/off) or integer-limit (a numeric cap) — identified by a stable key. |
| Entitlement value | The per-plan setting for an entitlement (a boolean flag, or a non-negative integer for a limit). |
| Seat limit | The maximum number of machine activations a license issued under a plan may hold; defaults to 1. |
| Effective plan definition | The resolved set of a plan's entitlement keys, their values, and its seat limit — the read model license issuance consumes. |
| No-code | Configurable through admin-console forms only, with no code change, redeploy, or config-file edit. |
| Archive | Soft-retire an entity: retained for interpretation of already-issued licenses but excluded from active selection. |

## Compliance Check

**Status**: PASS (Policy Auditor, 2026-07-07)

Validated against `project-instructions.md` (v1.2.0). No violations.

- **Multi-tenant isolation (Principle II)**: PASS — FR-010 strict tenant scope; MIGRATION signal specifies tenant-scoped forced RLS (E002 pattern); US5 + SC-007 verify isolation.
- **Fully-audited + fail-closed RBAC (Principle III)**: PASS — FR-012 audits every mutation (append-only); FR-011 denies + records unauthorized mutations as security events; viewer read-only.
- **Offline-first / single security core (Principle I)**: PASS — the catalog performs no cryptography; issuance/signing excluded (E008). Entitlement keys only feed E001 signed tokens downstream.
- **Tech stack (Node 22 + Fastify; node-postgres + raw SQL migrations, no Drizzle; PostgreSQL 16.4+; React SPA)**: PASS — persists via the E002 repository + raw-SQL migration harness; NEW-API is tenant-scoped `/admin` REST; NEW-UI plugs into the E005 console shell. No ORM implied.
- **Source layout (`/src`)**: PASS — reuses `/src`-resident E002 persistence + E005 console; no paths outside `/src`.
