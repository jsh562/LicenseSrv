---
feature_branch: "00007-containerized-runtime-and-config"
created: "2026-07-05"
input: "E006"
spec_type: "operational"
spec_maturity: "draft"
epic_id: "E006"
epic_sources: "{SAD:ADR-0006}{DOD:DDR-004,DDR-005}"
---

# Feature Specification: Containerized Runtime and Config

**Feature Branch**: `00007-containerized-runtime-and-config`
**Created**: 2026-07-05
**Status**: Draft
**Spec Type**: operational
**Spec Maturity**: draft
**Epic ID**: E006
**Epic Sources**: {SAD:ADR-0006}{DOD:DDR-004,DDR-005}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The License API is buildable and tested but not yet deployable: there is no server entrypoint that boots the HTTP listener, no container image, no compose stack, and configuration is read ad-hoc from `process.env` scattered across module loaders with no validation. Platform and self-host operators cannot stand the service up, and downstream epics (E011 supply chain, E012 observability) have no image to build on. Without a single, config-driven image with gated migrations and health probes, every deployment would be bespoke, secrets would leak through image layers, and upgrades/rollbacks would be unsafe.

## Scope *(mandatory)*

### Included

- A server entrypoint that loads and validates configuration, opens the database pool, mounts the E002 application, and listens for HTTP traffic.
- A multi-stage container image producing one minimal, non-root runtime artifact that serves every deployment shape (managed SaaS and self-host).
- A 12-factor configuration contract: all runtime settings from environment; required settings validated at startup with fail-fast behavior; a documented configuration reference.
- File-mounted secret injection (an `<VAR>_FILE` convention) so secrets are never baked into image layers or exposed via `docker inspect`.
- The gated database migration job packaged in the same image, run as a discrete, advisory-locked, idempotent step separate from application boot (never migrate-on-boot).
- Startup, liveness, and readiness health endpoints, where readiness (not liveness) reports not-ready on dependency degradation.
- A docker-compose stack bringing up API + PostgreSQL + the gated migration step, driven solely by env/secret files, reaching a healthy state.

### Excluded

- CI image build, multi-arch publishing, SBOM, image signing, and air-gap bundles — owned by E011 (this epic produces the image the pipeline consumes).
- Metrics, tracing, dashboards, and alerting — owned by E012 (this epic exposes health endpoints and structured startup logging, not full observability).
- Kubernetes/Helm manifests and cloud-specific deployment — compose is the reference topology; orchestrator manifests are a later concern (probes/config are designed to be orchestrator-portable).
- The Rust verifier core and its bindings — distributed separately (E003), not packaged in this server image.
- Application feature behavior (auth, catalog, issuance) — unchanged; this epic only packages and configures what exists.

### Edge Cases & Boundaries

- Database unreachable at boot: the API process starts but readiness reports not-ready (no crash-loop); the migration job fails fast with a clear error and non-zero exit.
- A required configuration value or secret file is missing/empty: startup fails fast with a specific message and non-zero exit — the process does not serve in a degraded state.
- Two migration jobs run concurrently (e.g. two orchestrator replicas): the advisory lock serializes them; the second is a no-op.
- An already-migrated database: re-running the migration job applies nothing (idempotent).
- Unsupported PostgreSQL version: the migration job refuses to proceed (existing ≥16.4 gate).
- Invalid or already-bound listen port: startup fails fast rather than serving on an unexpected interface.
- SIGTERM during in-flight requests: the runtime drains and exits within a bounded window (P2).

## Operational Objectives *(mandatory for operational specs only)*

### Objective 1 - Single production runtime image + entrypoint (Priority: P1)

Produce one minimal container image, built via a multi-stage Dockerfile, that runs the License API through a real server entrypoint (load config → open pool → mount app → listen). The same image, with a different command, runs the migration job.

**Why this priority**: Nothing is deployable without a bootable image; it blocks the compose demo and every downstream operational epic.

**Rationale**: `createApp()` exists but nothing calls `.listen()`; there is no packaging. ADR-0006 mandates a single image for SaaS and self-host.

**Deliverables**:
- A server entrypoint module that boots the HTTP listener from validated config.
- A multi-stage `Dockerfile` (build stage compiles TypeScript; final stage carries only production artifacts, no build toolchain or dev dependencies) running as a non-root user.
- A `.dockerignore` and an image run command for both "serve" and "migrate" modes.

**Verification Criteria**:
1. **Given** the built image, **When** it is run with valid config, **Then** the API listens and serves requests on the configured port.
2. **Given** the final image, **When** its contents and user are inspected, **Then** no build toolchain/dev dependencies are present and the process runs as non-root.

### Objective 2 - 12-factor configuration contract (Priority: P1)

Centralize all runtime configuration into a single validated contract sourced from the environment, failing fast on missing or invalid required values, with a documented reference for every setting.

**Why this priority**: A misconfigured image must fail closed, not run degraded; correct, discoverable config is a prerequisite for safe operation.

**Rationale**: Config is currently read ad-hoc (`DATABASE_URL`, `SIGNING_*`, `ADMIN_*`, API-key secret) with no validation; operators have no single source of truth.

**Deliverables**:
- A configuration loader that reads, validates, and types all runtime settings at startup, consolidating the existing per-module env reads.
- A configuration reference document enumerating each variable (name, purpose, required/optional, default, secret-or-not).

**Verification Criteria**:
1. **Given** a required variable is unset, **When** the runtime starts, **Then** it exits non-zero with a message naming the missing setting and does not serve.
2. **Given** two different env configurations, **When** the same image is run against each, **Then** behavior differs accordingly with no image rebuild.

### Objective 3 - File-mounted secret injection (Priority: P1)

Inject secrets (database credentials, the API-key/HMAC secret, signing custodian shares) via mounted files, never through baked-in image content, keeping them out of image layers and `docker inspect` output.

**Why this priority**: Secret custody is security-critical; leakage through image layers or env inspection is a high-impact failure (DDR-005).

**Rationale**: DDR-005 mandates cloud-agnostic, file-mounted secrets as the default; the image must be agnostic to the specific secret mechanism (Docker/compose secrets, SOPS+age, Sealed Secrets, Vault).

**Deliverables**:
- An `<VAR>_FILE` resolution convention in the config loader (read the secret from the referenced file path).
- Guidance in the configuration reference on mounting secrets and secret hygiene.

**Verification Criteria**:
1. **Given** secrets provided via mounted files, **When** the container runs, **Then** secret values appear in no image layer/history and in no `docker inspect` output.
2. **Given** a referenced secret file is missing or empty, **When** the runtime starts, **Then** it fails fast rather than serving without the secret.

### Objective 4 - Gated migration job (Priority: P1)

Run schema migrations as a discrete, explicitly-invoked, advisory-locked, idempotent job — from the same image and config contract — that is never triggered by application boot.

**Why this priority**: Separating migration from boot is what makes digest-pinned rollback safe (DDR-004); it is a hard prerequisite for correct rollout ordering.

**Rationale**: The advisory-locked, version-gated, idempotent migration harness already exists; this epic packages it as a first-class job and guarantees the app never auto-migrates.

**Deliverables**:
- A "migrate" run mode of the image invoking the existing migration harness.
- A guarantee (and test) that starting the app performs no schema changes.

**Verification Criteria**:
1. **Given** an unmigrated database, **When** the application is started (not the migrate job), **Then** the schema is unchanged and the app reports not-ready.
2. **Given** the migrate job is run twice, or concurrently, **Then** migrations apply exactly once (idempotent + advisory-locked).

### Objective 5 - Health probes with readiness-gated dependencies (Priority: P1)

Expose startup, liveness, and readiness endpoints on an unauthenticated internal path, where readiness — not liveness — reports not-ready when a required dependency (the database) is degraded, so orchestrators withhold traffic without killing a healthy process.

**Why this priority**: Correct probe semantics are what make rolling deploys and self-host operation safe; wrong semantics kill healthy containers or route traffic to broken ones.

**Rationale**: ADR-0006 specifies readiness (not liveness) fails on DB/KMS degradation; an internal `/internal/ready/*` convention already exists and must be generalized.

**Deliverables**:
- Liveness, readiness, and startup endpoints under the internal (no-auth) path.
- Readiness logic that checks database reachability (and composes existing subsystem readiness such as the signer).

**Verification Criteria**:
1. **Given** a running container with the database stopped, **When** the probes are polled, **Then** readiness reports not-ready while liveness stays healthy (the container is not killed).
2. **Given** the database is restored, **When** readiness is polled again, **Then** it returns to ready and traffic resumes.

### Objective 6 - Reference docker-compose stack (Priority: P1)

Provide a docker-compose stack that brings up the API, PostgreSQL, and the gated migration step — configured solely through env/secret files — and reaches a healthy state with no manual intervention.

**Why this priority**: It is the epic's acceptance demo ("`docker compose up`") and the reference self-host topology operators start from.

**Rationale**: Operators need a one-command, reproducible local/self-host deployment that demonstrates correct ordering (migrate before serve) and env-only configuration.

**Deliverables**:
- A `docker-compose.yml` defining API + PostgreSQL + a one-shot migration service, wired with health checks and startup ordering.
- An example env file and secret-file layout (no real secrets committed).

**Verification Criteria**:
1. **Given** an example env/secret set, **When** `docker compose up` is run, **Then** migrations complete, the API becomes ready, and health checks pass without manual steps.
2. **Given** the stack is running, **When** the app container starts, **Then** it serves only after migrations complete and the database is reachable.

### Objective 7 - Graceful lifecycle (Priority: P2)

Shut down cleanly on SIGTERM — stop accepting new connections, drain in-flight requests, and close the database pool within a bounded window — with structured startup/shutdown logging.

**Why this priority**: Improves zero-downtime rolling restarts and clean operations, but the MVP deploys and passes health checks without it.

**Rationale**: Readiness-gated rolling restarts are cleaner when the process drains rather than dropping connections; structured lifecycle logs aid operators (and seed E012).

**Deliverables**:
- SIGTERM/SIGINT handling that drains and closes resources within a bounded, configurable window.
- Structured startup and shutdown log lines (config summary without secrets, listen address, shutdown reason).

**Verification Criteria**:
1. **Given** in-flight requests, **When** the process receives SIGTERM, **Then** it stops accepting new connections, completes in-flight work, and exits cleanly within the window.

### Operational Constraints

- **One image for all deployments**: no per-environment image variants; all environment differences come from env/secret files (ADR-0006).
- **Secrets never in the image**: no secret value in any image layer, image history, or `docker inspect` output (DDR-005).
- **Migrations gated, not on-boot**: expand/contract, advisory-locked, idempotent, run before app rollout; destructive changes are out of scope here (DDR-004).
- **Readiness gates traffic, liveness gates the process**: a degraded dependency must fail readiness only, never liveness.
- **Cloud-agnostic**: no dependency on a specific cloud secret manager or managed service in the default deployment; PostgreSQL 16.4+ is the datastore in all shapes.
- **Non-root runtime**: the container process runs as an unprivileged user with a minimal writable surface.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: This epic packages the E002 application (`createApp`) and invokes its advisory-locked migration harness (`runMigrations`) as the gated migration job.
- **IP-002**: The configuration contract consolidates the existing per-module environment reads (`DATABASE_URL`, the API-key/HMAC secret, `SIGNING_*` custodian shares and signer selection, `ADMIN_*` session/lockout settings) into one validated surface.
- **IP-003**: Health probes extend the existing internal, unauthenticated `/internal/` convention (e.g. the E004 signer readiness probe) with liveness, readiness, and startup endpoints and a database-reachability check.
- **IP-004**: The runtime depends on an external PostgreSQL 16.4+ instance (provided by the compose stack for local/self-host; externally provisioned for managed deployments).
- **IP-005**: Secrets are consumed from mounted files, agnostic to the operator's mechanism (Docker/compose file secrets by default; SOPS+age, Sealed Secrets, or Vault supported per DDR-005).
- **IP-006**: E011 (supply chain) builds, scans, signs, and publishes this image and its compose/air-gap bundles; E012 (observability) instruments this runtime and consumes its structured logs and health signals.

## Requirements *(mandatory)*

### Operational Requirements *(operational specs only)*

- **OR-001**: The system MUST provide a server entrypoint that loads validated configuration, opens the database pool, mounts the application, and listens on a configurable port.
- **OR-002**: The system MUST be packaged as a single container image built with a multi-stage build whose final stage contains only production runtime artifacts (no build toolchain, no development dependencies).
- **OR-003**: The container process MUST run as a non-root user with only the minimal writable filesystem surface it requires.
- **OR-004**: The same image MUST support both an application "serve" mode and a "migrate" mode selected at run time, sharing one configuration/secret contract.
- **OR-005**: All runtime configuration MUST be provided via environment variables; no environment-specific value may be baked into the image.
- **OR-006**: The runtime MUST validate required configuration at startup and fail fast (non-zero exit, refuse to serve) on any missing or invalid required setting, naming the offending setting.
- **OR-007**: A configuration reference MUST document every variable — name, purpose, required/optional, default, and whether it is a secret.
- **OR-008**: Secrets MUST be injectable from mounted files via an `<VAR>_FILE` convention, and secret values MUST NOT appear in image layers, image history, or `docker inspect` output.
- **OR-009**: A missing or empty referenced secret file for a required secret MUST cause fail-fast startup, naming the missing secret (consistent with OR-006).
- **OR-010**: Database migrations MUST run as a discrete, explicitly-invoked, advisory-locked, idempotent job; the application MUST NOT apply migrations on boot.
- **OR-011**: The gated migration job MUST run as the same image artifact invoked in migrate mode, resolving configuration and secrets through the identical `<VAR>_FILE` contract as the application — no separate migration image, tool, or configuration path.
- **OR-012**: The runtime MUST expose liveness, readiness, and startup endpoints on the unauthenticated internal path.
- **OR-013**: Readiness MUST report not-ready when a required dependency fails its health check — the database (its readiness probe query fails or times out) and, where a signer is configured, the signer custody (custody unavailable or locked), composing the existing subsystem readiness — while liveness MUST remain healthy so the container is not killed for a dependency outage.
- **OR-014**: A docker-compose stack MUST bring up the API, PostgreSQL, and the gated migration step using only env/secret files and reach a healthy state without manual steps.
- **OR-015**: The compose stack MUST order startup so the application serves only after the migration job completes and the database is reachable.
- **OR-016**: The runtime SHOULD shut down gracefully on SIGTERM — stop accepting new connections, drain in-flight requests, and close the pool within a bounded window (default 10 seconds, configurable). *(P2)*
- **OR-017**: The runtime MUST emit structured startup logging (a structured key/value line) that summarizes effective configuration without disclosing any secret value.

### Runbook Requirements *(include for operational specs if applicable)*

- **RR-001**: A runbook MUST exist for a stuck or contended migration job (diagnosing and clearing a held advisory lock, resuming after a failed migration).
- **RR-002**: A runbook MUST exist for diagnosing failed readiness due to database unreachability, and for fail-fast startup caused by missing configuration/secret files.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Operators have an OCI-compatible container runtime and docker-compose available.
- PostgreSQL 16.4+ is provisioned externally, or via the reference compose stack for local/self-host.
- The E002 application and its migration harness are stable and are not modified by this epic beyond adding the entrypoint and config surface.
- Operators supply secrets through mounted files; the image remains agnostic to the specific secret-management mechanism.
- A Node 22 runtime base image is acceptable for the server; the Rust verifier core is distributed separately and is not in this image.

### Risks

- **Secret leakage** *(likelihood: medium, impact: high)*: secrets could leak via env, logs, or `docker inspect` if the file convention is bypassed — mitigated by file-only secret loading, secret-free startup logging, and a secret-not-in-image test.
- **Migrate-on-boot creep** *(likelihood: low, impact: high)*: a module auto-running migrations would reintroduce unsafe rollback — mitigated by the gated-job-only requirement and a test that app boot performs no schema change.
- **Probe misconfiguration** *(likelihood: medium, impact: medium)*: coupling liveness to the database would kill healthy containers on transient DB blips — mitigated by readiness-only dependency gating with liveness independent of the database.

## Implementation Signals *(mandatory)*

- `NEW-CONFIG` — A validated 12-factor configuration contract consolidating all runtime settings, with `<VAR>_FILE` secret resolution and fail-fast validation.
- `NEW-API` — Internal liveness, readiness (DB-aware), and startup health endpoints on the unauthenticated `/internal/` path.
- `NEW-WORKER` — A gated "migrate" run mode of the image that invokes the existing advisory-locked migration harness as a discrete job.
- `EXTERNAL-SERVICE` — PostgreSQL as an orchestrated dependency in the reference compose stack (health-checked, startup-ordered).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ6]: Running `docker compose up` with an example env/secret set brings the API to ready and passes health checks with no manual steps beyond providing configuration.
- **SC-002** [OBJ4]: Migrations apply only via the discrete gated job; starting the application against an unmigrated database changes no schema.
- **SC-003** [OBJ2]: The same image runs in two distinct configurations, differing only by env/secret files, with no rebuild.
- **SC-004** [OBJ3]: No secret value is discoverable in image layers, image history, or `docker inspect` output.
- **SC-005** [OBJ4]: Two concurrent migration runs never double-apply, and a completed migration re-run is a no-op.
- **SC-006** [OBJ5]: With the database stopped, readiness reports not-ready while liveness stays healthy and the container keeps running; readiness recovers when the database returns.
- **SC-007** [OBJ2]: Starting with a required variable or secret file missing exits non-zero with a clear message and does not serve.
- **SC-008** [OBJ1]: The final image contains no build toolchain or development dependencies and runs as a non-root user.
- **SC-009** [OBJ7]: On SIGTERM the runtime drains in-flight requests and exits cleanly within the bounded window (default 10s) with no dropped request. *(P2)*
- **SC-010** [OBJ2]: The configuration reference enumerates every runtime variable an operator must or may set (name, purpose, required/optional, default, secret-or-not), with none missing versus what the runtime reads.
- **SC-011** [OBJ2]: Startup logging summarizes effective configuration while disclosing no secret value (no credential, HMAC secret, or custodian share appears in any log line).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| 12-factor config | Configuration supplied entirely through environment variables (and file-referenced secrets), never baked into the build artifact. |
| Gated migration | A schema migration run as a discrete, explicitly-invoked step before application rollout — never triggered by application boot. |
| Liveness | A health signal indicating the process itself is alive; failing it causes an orchestrator to restart the container. |
| Readiness | A health signal indicating the process can currently serve traffic; failing it causes an orchestrator to withhold traffic without restarting the container. |
| Startup probe | A health signal indicating initial boot has completed, used to defer liveness/readiness checks until the process has started. |
| `<VAR>_FILE` convention | A pattern where a secret is provided by pointing an environment variable at a mounted file whose contents are the secret value. |
| Expand/contract migration | A backward-compatible migration style (add before remove) that keeps the prior app version runnable against the new schema, making digest-pinned rollback safe. |

## Compliance Check

**Status**: PASS (Policy Auditor, 2026-07-05)

Validated against `project-instructions.md` (v1.2.0) and the authoritative project decisions. No violations.

- **ADR-0006 (single image, SaaS + self-host)**: PASS — one multi-stage image with serve/migrate modes; no per-environment variants (OR-002/OR-004, Constraints).
- **DDR-004 (gated advisory-locked expand/contract migrations, never migrate-on-boot)**: PASS — OR-010 requires a discrete advisory-locked idempotent job and forbids on-boot migration; SC-002/SC-005; migrate-on-boot risk mitigated.
- **DDR-005 (cloud-agnostic file-mounted secrets)**: PASS — OR-008/OR-009 `<VAR>_FILE` secrets absent from image layers/history/`docker inspect`; no mandatory cloud secret manager (IP-005).
- **Readiness-not-liveness on dependency degradation**: PASS — OR-013 (DB + signer custody) fails readiness only; SC-006.
- **Tech stack (Node 22 + Fastify; node-postgres + raw SQL migrations, no Drizzle; PostgreSQL 16.4+)**: PASS — boots existing `createApp()`, invokes existing `runMigrations` harness; no ORM reintroduced.
- **Offline verifier core / single audited security core**: PASS — verifier core distributed separately, out of this image; no crypto reimplemented.
- **Source layout (`/src`)**: PASS (advisory) — Dockerfile/`.dockerignore`/`docker-compose.yml` are root-level manifests; the entrypoint + config loader are TS source to be placed under `/src/server` at Plan.

Non-blocking notes carried to Plan: confirm the internal readiness payload stays a boolean/dependency-status shape leaking no secret or tenant detail (constrained by OR-017).
