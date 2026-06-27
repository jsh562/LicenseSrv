---
adr_id: ADR-0005
status: accepted
date: 2026-06-26
tags: [architecture, monolith, modularity, scaling]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0005: Architecture Style — Modular Monolith

## Status

Accepted.

## Context

We must ship a multi-tenant, offline-first license server quickly with a small team. The server owns several cohesive concerns — catalog, issuance, activation, air-gap, auth/RBAC, audit, and signing — that share one transactional datastore and need race-safe seat counting under concurrent activation. We must choose an architecture style that minimizes operational and integration overhead now while leaving room to extract a high-throughput path (e.g., validate/metering) later without a rewrite. The embeddable verifier core and the React admin SPA are distributed separately and are out of scope for this decision.

## Decision Drivers

- Time-to-market with a small team.
- Operational simplicity: as few moving parts to deploy and run as possible.
- A single transactional datastore for race-safe seat counting and consistency.
- Future extractability of a high-throughput service without a rewrite.
- Stated path to migrate the server to Rust later without re-architecting boundaries.

## Considered Options

### Option A: Modular monolith

- **Pros**: Single deploy unit and one datastore; transactional seat counting is trivial; lowest operational burden; strong in-code module seams enable later extraction; fastest to build for a small team.
- **Cons**: Module boundaries must be enforced in-code (no network boundary to force discipline); a single process scales vertically first; one codebase can erode into a big ball of mud without governance.

### Option B: Microservices from day one

- **Pros**: Independent scaling and deployment per concern; hard network boundaries enforce isolation.
- **Cons**: Distributed transactions for seat counting are hard and error-prone; heavy operational and observability overhead; slows time-to-market dramatically for a small team; premature for current load.

### Option C: Serverless functions

- **Pros**: Elastic scale-to-zero; minimal infrastructure management for managed deployment.
- **Cons**: Poor fit for offline-first/self-host and air-gapped installs; cold-start and connection-pool friction against PostgreSQL; vendor coupling; awkward for stateful, transactional seat counting.

## Decision Outcome

Chosen option: **Modular monolith** — build the license server as a single deployable API service with strong internal module boundaries (catalog, issuance, activation, air-gap, auth/RBAC, audit, signing) over one transactional PostgreSQL datastore. Module seams are designed so a high-throughput validate/metering service can be extracted later without a rewrite. Scale vertically first, then horizontally as stateless instances behind a load balancer.

## Consequences

### Positive

- Simplest operations and a single deploy unit at launch.
- One transactional datastore makes race-safe seat counting straightforward.
- Clean in-code seams preserve a cheap future extraction path.
- Fits offline-first, self-host, and air-gapped deployment shapes.

### Negative

- Module boundaries must be enforced in-code and in review, since no network boundary forces the discipline.
- A single process scales vertically first; very high throughput on one concern may eventually force extraction.

### Neutral

- Horizontal scaling is available by running stateless instances behind a load balancer.
- The later server-to-Rust migration reuses the same module boundaries rather than re-architecting them.

## Links

- ADR-0002 (embeddable verifier core is distributed separately, outside this service)
- ADR-0004 (multi-tenancy isolation within the shared datastore)
- ADR-0006 (single-container packaging for this service)
- ADR-0007 (REST/JSON API surface of this service)
- project-instructions.md — Technology Stack; operational simplicity and time-to-market principles
- specs/00001-license-server/plan.md
