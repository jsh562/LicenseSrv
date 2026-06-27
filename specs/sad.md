# Software Architecture Document: LicenseSrv

> Date: 2026-06-26 | Status: Draft

## Purpose and Scope

LicenseSrv is a multi-tenant, offline-first software license server. It issues cryptographically signed licenses, verifies them on customer machines with no network call, enforces machine activation and seat limits, supports air-gapped activation, and lets non-developers configure products, plans, and entitlements. It runs as a managed multi-tenant SaaS or fully self-hosted (including air-gapped) from a single container image. This document is the canonical project-level technical context: architecture style, technology baseline, runtime and deployment views, cross-cutting concerns, quality targets, and the ADR index. Feature-level implementation detail lives under `specs/00001-*/`.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 22 (server, admin UI); Rust (stable) for the embeddable verifier core. Server migrates to Rust in a later phase; verifier core is Rust from day one.  
**Primary Dependencies**: Fastify, Drizzle ORM, Zod (server); React + Vite (admin SPA); ed25519-dalek, ciborium (verifier core); cbindgen / wasm-pack / UniFFI (bindings); cloud KMS SDK.<br>
**Storage**: PostgreSQL 16 — shared schema, `tenant_id` on every tenant-owned row, Row-Level Security. Redis reserved for later phases (rate-limit counters, floating-seat leases).  
**Testing**: Vitest + Testcontainers (server), Playwright (admin E2E), cargo test + criterion + cargo-fuzz (verifier core).<br>
**Target Platform**: Linux containers (one Docker image) for the control plane; WASM, native (C ABI), and managed runtimes for verifier embedding.  
**Project Type**: platform (multi-tenant SaaS API + embeddable verification library + admin web).<br>
**Performance Goals**: offline verify p99 < 5 ms (in-process); online validate p95 < 120 ms; issuance p95 < 300 ms (KMS-bound).  
**Constraints**: zero-network verify path; air-gapped activation; strict tenant isolation; signing keys never exposed by any interface; one image serves SaaS and self-host.  
**Scale/Scope**: multi-tenant; stateless API horizontally scalable behind a load balancer; the only stateful hot spot is per-license seat counting.

## System Scope and Context

LicenseSrv serves three human actors — an Integrating Developer who embeds the verifier, a Licensing Admin who configures the catalog and issues licenses, and an End-Customer Operator who activates machines (including air-gapped). It depends on a KMS/HSM for signing-key custody, a CDN for distributing signed keyrings/revocation lists, an optional billing provider (P2), and can export audit events to a customer SIEM.

### C4 System Context

```mermaid
C4Context
    title System Context
    Person(dev, "Integrating Dev", "Embeds verifier")
    Person(admin, "Licensing Admin", "Configures, issues")
    Person(op, "Customer Operator", "Activates machines")
    System(ls, "LicenseSrv", "License server")
    System_Ext(kms, "KMS / HSM", "Signing-key custody")
    System_Ext(cdn, "CDN", "Keyring / revocation list")
    System_Ext(siem, "Customer SIEM", "Audit export")
    Rel(admin, ls, "Configures, issues")
    Rel(op, ls, "Activates")
    Rel(dev, ls, "Integrates SDK")
    Rel(ls, kms, "Signs via")
    Rel(ls, cdn, "Publishes keyring/CRL")
    Rel(ls, siem, "Exports audit")
```

### C4 Container View

```mermaid
C4Container
    title Container View
    Person(admin, "Licensing Admin")
    Person(dev, "Integrating Dev")
    System_Boundary(ls, "LicenseSrv") {
        Container(spa, "Admin SPA", "React + Vite", "No-code console")
        Container(api, "License API", "Node/TS Fastify", "Modular monolith")
        ContainerDb(db, "PostgreSQL", "Postgres 16", "Tenant-scoped store + audit")
    }
    Container_Ext(verifier, "Verifier Core", "Rust + bindings", "Offline verify")
    System_Ext(app, "Licensed App", "Customer app", "Embeds verifier")
    System_Ext(kms, "KMS / HSM", "Signing keys")
    System_Ext(cdn, "CDN", "Keyring / CRL")
    Rel(admin, spa, "Uses")
    Rel(spa, api, "REST/JSON")
    Rel(dev, verifier, "Embeds")
    Rel(app, verifier, "Verify offline")
    Rel(app, api, "Activate / validate")
    Rel(api, db, "Tenant-scoped SQL")
    Rel(api, kms, "Sign")
    Rel(api, cdn, "Publish keyring/CRL")
```

### C4 Component View

The License API is one deployable with enforced internal module seams (ADR-0005) so a high-throughput path can be extracted later without a rewrite.

```mermaid
C4Component
    title Component View
    Container_Boundary(api, "License API") {
        Component(auth, "Auth / RBAC", "module", "Sessions + API keys")
        Component(catalog, "Catalog", "module", "Products/plans/entitlements")
        Component(issue, "Issuance + Signer", "module", "Sign via KMS")
        Component(activ, "Activation + Seats", "module", "Node-lock, race-safe seats")
        Component(airgap, "Air-Gap", "module", "Signed file exchange")
        Component(audit, "Audit", "module", "Append-only log")
        Component(repo, "Tenant Repository", "module", "RLS-scoped data access")
    }
    ComponentDb(db, "PostgreSQL", "Postgres 16", "Tenant-scoped")
    System_Ext(kms, "KMS / HSM", "Signing keys")
    Rel(auth, repo, "Scopes tenant")
    Rel(catalog, repo, "CRUD")
    Rel(issue, kms, "Sign")
    Rel(issue, repo, "Persist license")
    Rel(activ, repo, "Atomic seat count")
    Rel(airgap, issue, "Issue token")
    Rel(catalog, audit, "Record")
    Rel(repo, db, "SQL")
```

## Solution Strategy and Architecture Style

- **Architecture Style**: Modular monolith (ADR-0005) — one deployable License API with strong internal module boundaries, alongside a separately-distributed embeddable verifier core and a decoupled admin SPA.
- **Source Code Location**: All project source code must reside in the `/src` directory.
- **Why this style fits**: Time-to-market and a small team favor one deploy unit; a single transactional datastore makes race-safe seat counting straightforward; the offline verifier is the moat and is isolated as a reusable library (ADR-0002). Module seams permit later extraction of a high-throughput validate/metering service.
- **Alternatives considered**: Microservices from day one (rejected — ops overhead, slower MVP) and serverless functions (rejected — cold-start latency, awkward stateful seat flows, weaker self-host/air-gap story). REST/JSON is the public API style (ADR-0007); the system ships as a single container image for both SaaS and self-host (ADR-0006).

## Key Runtime Flows and Failure Paths

### Offline Verification (default path, no network)

```mermaid
sequenceDiagram
    participant App as Licensed App
    participant Core as Verifier Core (in-process)
    App->>Core: verify(token, keyring, now, fingerprint)
    Core->>Core: decode, Ed25519 verify, anchor, expiry, fingerprint
    Core-->>App: VerifiedLicense or first failing check
    note over App,Core: Zero network. ~microseconds. Entitlements gate features.
```

### Online Activation (seat enforcement + signing)

```mermaid
sequenceDiagram
    participant App as Licensed App
    participant API as License API
    participant DB as PostgreSQL
    participant KMS as KMS
    App->>API: POST /v1/activations (key, fingerprint, nonce)
    API->>DB: atomic UPDATE seats WHERE used < max (tenant-scoped)
    alt seat available
        API->>KMS: sign machine-bound token
        KMS-->>API: signature
        API->>DB: persist activation + audit
        API-->>App: signed token
    else at limit / revoked
        API-->>App: 409 + reason code
    end
```

### Failure Paths

- **KMS unavailable/throttled** → retry with backoff + circuit breaker; queue/defer issuance so availability is preserved (latency degrades, not correctness). Verify path is unaffected (never calls KMS).
- **Concurrent activation on last seat** → atomic conditional `UPDATE` (READ COMMITTED) prevents over-allocation; zero rows updated → seat denied.
- **DB primary failure** → streaming-replica failover (near-zero RPO); readiness probe fails so degraded instances stop taking traffic.
- **Clock rollback on client** → monotonic anchor rejects validation beyond the 48 h skew.
- **Revocation staleness** → revoked license may be honored until the signed CRL/keyring CDN TTL (`next_update`) expires; bounded and disclosed.
- **Tenant-scope assertion failure** → request aborted, paged as a security incident (must never occur).

## Deployment and Infrastructure View

One image (ADR-0006), driven by 12-factor env config; migrations run as a gated, advisory-locked admin job; startup/liveness/readiness probes (readiness fails — not liveness — when DB/KMS degraded).

```mermaid
flowchart TB
    Image["Single Docker Image<br>License API + migrations entrypoint"]
    subgraph SaaS["Managed SaaS (orchestrated)"]
        LB["Load Balancer"] --> R1["API replica"]
        LB --> R2["API replica"]
        R1 --> PG["PostgreSQL<br>primary + replica (PITR)"]
        R2 --> PG
        R1 --> KMS["Cloud KMS / HSM"]
        R1 --> CDN["CDN<br>keyring / CRL"]
    end
    subgraph Self["Self-host / Air-gapped (compose)"]
        SApi["API container"] --> SPG["PostgreSQL"]
        SApi --> SHSM["BYOK / soft-HSM"]
    end
    Image --> LB
    Image --> SApi
```

## Cross-Cutting Concerns

### Security

Tenant isolation is enforced at two layers: the Tenant Repository injects tenant scope on every query, and PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`, non-owner app role, `tenant_id`-leading composite indexes) is the safety net (ADR-0004). Pooled connections use `SET LOCAL`/`DISCARD ALL` to prevent tenant-context bleed. Humans authenticate to the console via interactive sessions; machine/runtime APIs use tenant-scoped API keys with RBAC. Private signing keys live in KMS/HSM, per product (ADR-0003), never returned by an API or logged. Activation/validation endpoints are rate-limited per tenant; activations carry nonces (anti-replay). Machine/customer identifiers are salted-hashed and erasable (GDPR). Postgres patch currency is mandated (RLS CVE exposure).

### Reliability

Managed control-plane availability target 99.9% (99.95% enterprise tier); offline verify is network-independent (effectively 100%, a stated selling point). Issuance tolerates temporary KMS unavailability via queue + backoff + circuit breaker. Control-plane RPO ≤ 5 min (near-zero with streaming standby), RTO ≤ 1 h validated by monthly restore drills. Error budget = 100% − SLO on a rolling 28–30 day window, gating releases.

### Observability

Structured JSON logging tagged with `tenant_id`/`request_id`/`product_id`, queryable per tenant; distributed tracing on the online path (app vs DB vs KMS attribution). First-class SLIs: activation success rate (≥99.9%), validate latency (p95<120ms), issuance latency (p95<300ms), failed-validation/tamper rate (anomaly alerts), and a continuous tenant-isolation assertion (any cross-tenant access = page). Append-only audit events are exportable to a customer SIEM.

### Data Management

PostgreSQL owns all control-plane state; the client holds only a signed token plus a small local state file (monotonic anchor, cached CRL). Continuous archiving + PITR (`archive_timeout=60`) plus a streaming standby. Machine/customer PII is minimized, retention-bounded, and erasable. Token format is versioned (`token_version`, `key_id`) for forward compatibility; the parser is fuzzed.

### Integration Strategy

Public REST/JSON over HTTPS described by OpenAPI (ADR-0007); the embeddable verifier covers stacks that want offline/fast verification, while the REST API gives any language zero-SDK reach. KMS integration is pluggable (cloud KMS, PKCS#11, or soft-HSM for self-host/BYOK). Signed keyring/CRL artifacts are published to a CDN. Billing-provider webhooks and outbound event webhooks are P2.

### Operations

One image across all environments; config and secrets via env/secret store, never baked in. Migrations are a discrete gated step. Self-host operators get a documented backup and secret-provisioning runbook and the air-gapped file-exchange flow. Stateless app tier enables rolling/blue-green deploys gated on readiness.

## Quality Attributes

| Attribute | Target | Measurement | Notes |
|-----------|--------|-------------|-------|
| Performance | offline verify p99 < 5 ms; online validate p95 < 120 ms; issuance p95 < 300 ms | criterion bench; server latency histograms | verify is in-process; issuance KMS-bound |
| Reliability | 99.9% SaaS control plane; offline verify network-independent; RPO ≤ 5 min, RTO ≤ 1 h | synthetic + real SLIs; monthly restore drills | error-budget gated releases |
| Security | 100% cross-tenant access blocked; keys never exposed; append-only audit | isolation assertions; key-access audits; pen test | tenant leak = pageable incident |
| Maintainability | ≥ 80% coverage; one crypto core; enforced module seams | coverage reports; lint `-D warnings`; arch tests | single verifier core across stacks |
| Scalability | stateless horizontal scale; seat-count sharded per license | load tests; contention metrics | only stateful hot spot is per-license seats |

## Architecture Decision Records

Project-level architectural decisions are maintained as standalone MADR files under `specs/adrs/`. This table is a navigational index — full decision records live in the linked files.

| ADR ID | Title | Status | Date | Supersedes | File |
|--------|-------|--------|------|------------|------|
| ADR-0001 | License Token Format & Encoding | accepted | 2026-06-26 | — | [0001-license-token-format.md](adrs/0001-license-token-format.md) |
| ADR-0002 | Embeddable Verifier Architecture (Single Rust Core + Bindings) | accepted | 2026-06-26 | — | [0002-embeddable-verifier-architecture.md](adrs/0002-embeddable-verifier-architecture.md) |
| ADR-0003 | Signing-Key Custody & Scope (Per-Product Keys in KMS/HSM) | accepted | 2026-06-26 | — | [0003-signing-key-custody-and-scope.md](adrs/0003-signing-key-custody-and-scope.md) |
| ADR-0004 | Multi-Tenancy Isolation Model | accepted | 2026-06-26 | — | [0004-multi-tenancy-isolation-model.md](adrs/0004-multi-tenancy-isolation-model.md) |
| ADR-0005 | Architecture Style — Modular Monolith | accepted | 2026-06-26 | — | [0005-architecture-style-modular-monolith.md](adrs/0005-architecture-style-modular-monolith.md) |
| ADR-0006 | Deployment & Packaging — Single Container Image for SaaS and Self-Host | accepted | 2026-06-26 | — | [0006-deployment-packaging-single-container-image.md](adrs/0006-deployment-packaging-single-container-image.md) |
| ADR-0007 | Public API Style — REST/JSON First | accepted | 2026-06-26 | — | [0007-public-api-style-rest-json-first.md](adrs/0007-public-api-style-rest-json-first.md) |

## Risks, Assumptions, Constraints, and Open Questions

### Risks

- Client-side checks on attacker-controlled machines are bypassable — position as casual-piracy deterrence + overuse recovery, never piracy elimination.
- Signing-key compromise forges a product's licenses — mitigated by per-product KMS custody, rotation, and revocation; remains top risk.
- Multi-tenant isolation defect (connection-context bleed, RLS bypass via privileged role/CVE) — both a security and compliance failure; defense-in-depth + Postgres patch currency.
- KMS as a tier-0 issuance dependency — quota saturation or outage degrades issuance; mitigated by queue/backoff/circuit-breaker and multi-region keys.
- Revocation staleness for offline/never-connected clients — an accepted, disclosed MVP limitation (online propagation is P2).

### Assumptions

- Licensed apps can embed a small native/WASM library or call an HTTPS endpoint.
- The environment provides a KMS/HSM or secure keystore for signing keys.
- Most clients can reach the service periodically; air-gapped clients use file exchange.
- PostgreSQL is the primary datastore in all deployment shapes.

### Constraints

- Verification must require no network on the default path and add no perceptible delay.
- One container image must serve managed SaaS and self-hosted/air-gapped installs.
- Strict tenant isolation; signing keys never exposed; machine/customer data minimized and erasable.

### Open Questions

- First-priority SDK stacks for a first-class verifier path at launch.
- Whether an on-prem LAN relay is needed beyond file-exchange air-gap.
- Required compliance attestations (SOC 2, data-residency commitments) for earliest buyers.
- Whether Redis is needed in P1 for per-tenant rate limiting, or in-process limiting suffices until P2.

## Project Context Baseline Updates

- The offline verifier core exposes the single canonical verification API and license token format (`LIC1.` envelope); its byte layout is a project-wide freeze point consumed by the bindings, signing, issuance, and activation work. Token-format changes are breaking and must be versioned (`token_version`, `key_id`).
- The verifier core targets `no_std` + `alloc` (`wasm32` + 64-bit desktop/server) so one crate serves all bindings; its public API follows SemVer, its failure reasons are a closed append-only `VerifyError` enum (a stable cross-binding contract), and the keyring carries per-key validity (`valid_from`/`valid_until`, revoked) enforced offline.
- The tenancy & data foundation provides the shared server substrate every feature epic builds on: a tenant-scoped repository (injects `tenant_id` on every query) hardened by forced Postgres RLS under a non-owner role, an advisory-locked expand/contract migration harness, and an append-only `audit_log` (no UPDATE/DELETE to the app role) written on every mutation. Every tenant-owned query is tenant-scoped; cross-tenant access only via an explicit, audited platform-admin path.
