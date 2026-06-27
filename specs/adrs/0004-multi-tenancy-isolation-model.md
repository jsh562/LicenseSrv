---
adr_id: ADR-0004
status: accepted
date: 2026-06-26
tags: [multi-tenancy, postgres, isolation, security]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0004: Multi-Tenancy Isolation Model

## Status

Accepted.

## Context

The product is multi-tenant SaaS from day one, and a single cross-tenant data leak is catastrophic and unrecoverable. We must choose an isolation model that prevents leaks defensively (defense in depth), keeps operational cost low enough to ship on time, and still allows large tenants to be migrated to stronger isolation later if needed.

## Decision Drivers

- Multi-tenant SaaS from day one with catastrophic, unrecoverable cost of a cross-tenant leak.
- Time-to-market: avoid heavy per-tenant provisioning at launch.
- Defense in depth: isolation should not depend solely on application correctness.
- A migration path to stronger isolation for large tenants later.

## Considered Options

### Option A: Database-per-tenant

- **Pros**: Strongest physical isolation; per-tenant backup/restore and scaling.
- **Cons**: Heavy provisioning and migration overhead; expensive at scale for many small tenants; slows time-to-market.

### Option B: Schema-per-tenant

- **Pros**: Logical isolation per tenant within one database; moderate separation.
- **Cons**: Schema sprawl and migration fan-out across thousands of schemas; connection/search-path management complexity; still operationally heavy at scale.

### Option C: Shared-schema with row scoping + RLS

- **Pros**: Lowest operational overhead; fastest to launch; a mandatory `tenant_id` plus a data-access layer that injects tenant scope, hardened by PostgreSQL Row-Level Security, gives defense in depth without per-tenant provisioning.
- **Cons**: Every query must be tenant-scoped; a single missed scope is a leak unless RLS catches it; isolation correctness must be continuously tested.

## Decision Outcome

Chosen option: **Shared schema + row scoping + RLS** — a shared PostgreSQL schema with a mandatory `tenant_id` on every tenant-owned row, enforced by a repository/data-access layer that injects tenant scope on every query, hardened with PostgreSQL Row-Level Security policies as a second line of defense. Cross-tenant access is permitted only via an explicit, audited platform-admin path. Database-per-tenant migration remains available later for large tenants.

## Consequences

### Positive

- Fastest time-to-market with no per-tenant provisioning at launch.
- Defense in depth: even an application-layer scoping miss is contained by RLS.
- A clear, audited platform-admin path is the only sanctioned cross-tenant route.

### Negative

- Every query must be tenant-scoped; the data-access layer becomes a critical correctness boundary.
- Tenant-isolation tests are mandatory and must cover both the access layer and RLS policies.

### Neutral

- Large tenants can later be migrated to database-per-tenant without changing the public API contract.

## Links

- ADR-0003 (per-product key scoping complements tenant scoping)
- project-instructions.md — Principle II (Multi-Tenant Isolation); Technology Stack; Testing & Quality Policy
- specs/00001-license-server/plan.md
