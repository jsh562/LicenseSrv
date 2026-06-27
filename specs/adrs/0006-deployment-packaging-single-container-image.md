---
adr_id: ADR-0006
status: accepted
date: 2026-06-26
tags: [deployment, packaging, docker, 12-factor, operations]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0006: Deployment & Packaging — Single Container Image for SaaS and Self-Host

## Status

Accepted.

## Context

The PRD requires the same product to run both as managed SaaS and as a customer-operated self-host/air-gapped install, driven by data-residency needs. We must choose a packaging and deployment model that produces one consistent artifact across both shapes, configures cleanly per environment, handles schema migrations safely, and exposes health signals suitable for orchestration. Baking environment specifics or secrets into images would fragment the build and leak credentials; running migrations implicitly on every boot risks concurrent or partial schema changes across scaled instances.

## Decision Drivers

- The PRD's self-host-or-managed duality from a single artifact.
- Data residency and air-gapped operation.
- Operational consistency across deployment shapes (one build to reason about).
- Safe, controlled schema migrations under horizontal scaling.
- Secret and KMS/BYOK handling that never embeds credentials in the image.

## Considered Options

### Option A: Single image + 12-factor env config + gated migrations + health probes

- **Pros**: One artifact for every deployment shape; configuration via environment keeps the image generic and reproducible; migrations run as a discrete, advisory-locked admin step so they are deliberate and serialized; startup/liveness/readiness probes give orchestrators accurate signals; readiness (not liveness) fails on DB/KMS degradation to avoid restart loops.
- **Cons**: Self-host operators need documented backup and secret-provisioning runbooks; a separate migration step adds a deployment stage rather than "just boot."

### Option B: Managed PaaS / serverless-only

- **Pros**: Minimal infrastructure management for the managed offering.
- **Cons**: Does not satisfy self-host or air-gapped requirements; vendor coupling; no single artifact spanning both shapes.

### Option C: Kubernetes-first

- **Pros**: Strong orchestration, scaling, and rollout primitives for SaaS.
- **Cons**: Imposes Kubernetes on self-host/air-gapped operators who often want a simple compose stack; raises the operational bar for small customers; ties packaging to one orchestrator.

## Decision Outcome

Chosen option: **Single image + env config + gated migrations + health probes** — ship one Docker image configured entirely through 12-factor environment variables. Self-host and air-gapped installs run it via a docker-compose stack; managed SaaS runs it under an orchestrator (Kubernetes/ECS). Database migrations execute as a discrete, gated, advisory-locked admin job/step rather than implicitly on boot. The image exposes startup, liveness, and readiness probes; readiness fails (liveness does not) when the database or KMS is degraded. Secrets and KMS/BYOK configuration are injected via environment or a secret store, never baked into the image.

## Consequences

### Positive

- One build to produce and maintain across all deployment shapes.
- Migrations are deliberate and serialized via advisory locks, safe under horizontal scaling.
- Accurate orchestration signals; degraded dependencies remove an instance from rotation instead of killing it.
- Generic, reproducible images with no embedded secrets.

### Negative

- Self-host operators require a documented backup and secret-provisioning runbook.
- The gated migration step adds a deployment stage that must be run before serving traffic.

### Neutral

- Compose for self-host and an orchestrator for SaaS share the identical image, differing only in configuration and orchestration.

## Links

- ADR-0005 (single deployable service this image packages)
- ADR-0003 (KMS/BYOK key custody injected via env/secret store)
- ADR-0004 (multi-tenant datastore migrated by the gated admin step)
- project-instructions.md — Technology Stack; deployment and operational principles
- specs/00001-license-server/plan.md
