---
adr_id: ADR-0009
status: accepted
date: 2026-07-17
tags: [observability, logging, metrics, tracing, telemetry, opentelemetry, prometheus, pino, cardinality, node, fastify]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00013-observability-and-slos/spec.md, specs/00007-containerized-runtime-and-config/spec.md]
---

# ADR-0009: In-Process Observability Instrumentation for the Node Runtime — Logging, Metrics, Tracing, and Label-Cardinality Policy

## Status

Accepted.

## Context

The E006 Fastify runtime currently runs `Fastify({ logger: false })`: it emits no structured logs, has no `request_id`, exposes no metrics surface, and produces no traces. Epic E012 (Observability and SLOs) establishes the platform's observability baseline against the documented SLIs.

The observability **backend** and the SLI/SLO targets are already fixed elsewhere and are **not re-decided here**:

- `specs/dod.md` fixes Prometheus + Grafana + Alertmanager as the metrics/alerting stack, OpenTelemetry on the online path, structured JSON logs tagged `tenant_id` / `request_id` / `product_id` / outcome, alert routing, and the SLI/SLO table (activation success ≥ 99.9%, validate p95 < 120 ms, issuance p95 < 300 ms, tenant-isolation as a hard 100% invariant).
- `specs/sad.md` restates the same observability posture and the reliability targets.

What is **not yet fixed**, and what this ADR resolves, is the **in-process instrumentation approach**: which libraries run inside the Node process, how each module wires logs/metrics/traces, how logs and traces correlate, and — critically — a binding policy on what may and may not become a Prometheus metric label. This is a **project-wide** decision: it dictates HOW every current and future Node/Fastify service in this codebase instruments itself, so all modules instrument uniformly and future epics inherit one standard rather than diverging per feature. That cross-epic reach makes it a project-level ADR rather than a feature-local `AD-###` entry.

A decision is needed now because E012 is the first epic to add instrumentation to the runtime, and every later online-path epic (E013 online enforcement, E014 billing) will emit telemetry through whatever seams E012 establishes. Getting the label-cardinality policy wrong early is expensive to unwind because it is baked into dashboards, alerts, and the TSDB.

## Decision Drivers

- **Idiomatic and uniform**: every module must instrument the same way; prefer the Node/Fastify-native, mature tools over bespoke code.
- **Backend already fixed**: the in-process choices must feed the DOD/SAD backend (Prometheus scrape, OTLP, structured JSON logs) without re-deciding it.
- **Bounded TSDB cardinality**: metric label sets must have a fixed ceiling; high-cardinality per-tenant identity must never explode the time-series database.
- **Tenant-safety of telemetry**: per-tenant identifiers (`tenant_id`, `license_key`, `request_id`) must not leak into an unbounded, widely-queried metrics surface (Principle II reach).
- **Fail-open telemetry**: instrumentation — especially trace export — must never affect request handling if a telemetry backend is degraded or down.
- **Logs ↔ traces ↔ metrics pivot**: an operator must be able to move between a log line, its trace, and the relevant metric.
- **Bounded overhead**: added latency and CPU cost must stay within a small, sampled budget on the hot path.
- **Config-driven and secret-safe**: endpoints, sampling, and ports flow through the validated config contract; any exporter secret uses the `<VAR>_FILE` convention; secrets/PII are redacted from logs.

## Considered Options

### Option A: Native idiomatic Node stack — pino + prom-client + OpenTelemetry Node SDK via a self-hosted Collector, with a binding label-cardinality policy

Enable Fastify's built-in **pino** logger for structured JSON logs; expose a Prometheus/OpenMetrics scrape endpoint via **prom-client** on a separate internal port; run the **OpenTelemetry Node SDK** with `@opentelemetry/auto-instrumentations-node` loaded via `--require` before app import and export OTLP to a self-hosted **Collector**; correlate logs and traces via injected `trace_id`/`span_id`; and enforce a binding policy that `tenant_id` / `request_id` / `license_key` are never Prometheus labels (high-cardinality identity lives in logs and trace attributes, bridged to metrics only via exemplars).

- **Pros**: Every pillar is the mature, idiomatic choice for the runtime — pino is Fastify's native logger (child loggers, redaction, serializers for free), prom-client is the standard Prometheus client, and the OTel Node SDK is the vendor-neutral tracing standard. Feeds the already-fixed backend directly (Prometheus scrape, OTLP to Collector, structured JSON). The Collector decouples the app from any specific backend and adds buffering, tail-sampling, and vendor-agnostic routing. The cardinality policy gives a fixed label ceiling and keeps tenant identity out of the TSDB while still allowing a log/trace pivot via exemplars. Auto-instrumentation plus `BatchSpanProcessor` and configurable sampling keep hot-path overhead small and export fail-open. Uniform seams that every future Node service reuses.
- **Cons**: Three libraries plus a Collector to operate and configure; a small always-on overhead budget (~0.5–2 ms/req, 2–5% CPU) on instrumented paths; the cardinality policy is a standing constraint every metric author must respect; config surface grows (OTLP endpoint, sampling, metrics port).

### Option B: Hand-rolled JSON logger (replacing pino), with the same metrics/tracing pillars

Write a bespoke structured-logging layer instead of enabling Fastify's built-in pino.

- **Pros**: No dependency on pino's API; full control over log shape.
- **Cons**: Reinvents what pino already provides — child loggers, redaction paths, fast serializers, level handling — with more code and more risk; diverges from the Fastify-native path; ongoing maintenance for zero differentiated value.

### Option C: OpenTelemetry Metrics SDK instead of prom-client for the metrics pillar

Emit metrics through the OTel Metrics SDK and export them (via the Collector) rather than exposing a prom-client scrape endpoint.

- **Pros**: One telemetry SDK for both traces and metrics; export-based rather than scrape-based; could unify pipelines later.
- **Cons**: More moving parts for the baseline than a simple Prometheus scrape endpoint; prom-client is simpler and more mature for a direct OpenMetrics `/metrics` surface, which is exactly the DOD-fixed scrape contract. OTel metrics can be layered later via the Collector without changing that scrape contract, so adopting it now buys complexity with no baseline payoff.

### Option D: Direct OTLP export from the app to the backend (no Collector)

Point the OTel exporter straight at the observability backend, skipping a self-hosted Collector.

- **Pros**: One fewer component to run; simplest possible trace path.
- **Cons**: Couples the application to a specific backend endpoint and format; loses in-flight buffering, tail-sampling, and vendor-agnostic routing; makes backend swaps an app change; weaker fail-open story if the backend is the direct dependency.

### Option E: Full auto-instrumentation with 100% sampling and synchronous export

Enable all auto-instrumentations, sample every request, and export spans without batching.

- **Pros**: Complete trace coverage; no sampling decisions to reason about.
- **Cons**: Unbounded latency and CPU cost on the hot path; synchronous export makes request handling depend on exporter health (violates fail-open); no cost control. Unacceptable for the online validate/issue paths with tight latency SLOs.

## Decision Outcome

Chosen option: **Option A — the native idiomatic Node stack (pino + prom-client + OpenTelemetry Node SDK via a self-hosted Collector) with a binding metric label-cardinality policy** — because it is the only option that instruments every module the idiomatic way, feeds the already-fixed Prometheus/OTLP/structured-log backend without re-deciding it, keeps the TSDB cardinality bounded and tenant-safe, and stays fail-open within a small overhead budget. The rejected options each trade away one of those properties (idiomaticity, baseline simplicity, backend decoupling, or hot-path safety) for no baseline gain.

The resolved in-process instrumentation approach is:

1. **Logging (pino)** — Replace `Fastify({ logger: false })` with Fastify's built-in pino logger. Emit one request-scoped log line via a **child logger** bound with `tenant_id`, `request_id`, `product_id`, and the request outcome. Generate `request_id` via Fastify `genReqId`; an inbound correlation header is accepted only as a **non-authoritative** tag, never as the authoritative ID. Drive the log level from the existing `LOG_LEVEL` config. Redact secrets/PII — API keys and license keys — via pino `redact` paths, and hash machine fingerprints rather than logging them raw.

2. **Metrics (prom-client)** — Expose an OpenMetrics endpoint via prom-client on a **separate/internal port** (never the public API port). Publish RED histograms/counters keyed by `route` + `outcome`, plus process, pg-pool, and signer-availability gauges. Attach trace **exemplars** to histograms so a latency bucket links to a representative trace.

3. **Tracing (OpenTelemetry Node SDK)** — Load `@opentelemetry/auto-instrumentations-node` (Fastify + pg + http) via `--require` **before app import**, plus a **manual span** around the signer call. Export OTLP to a **self-hosted Collector** using `BatchSpanProcessor` with configurable sampling. Export is **fail-open**: a down or slow Collector never affects request handling.

4. **Correlation** — Inject `trace_id`/`span_id` into pino log lines (OTel log correlation) so operators can pivot logs ↔ traces. `request_id` remains the **business** correlation ID; trace IDs are the telemetry correlation.

5. **Label-cardinality policy (binding)** — `tenant_id`, `request_id`, and `license_key` **MUST NEVER** be Prometheus metric labels. All high-cardinality / per-tenant identity lives in logs and trace attributes, bridged to metrics only via exemplars. Every metric's label set must have a **fixed ceiling** (bounded, enumerable values such as `route` and `outcome`). This policy is binding on all current and future metric authors.

Configuration keys (OTLP endpoint, sampling ratio, metrics port) are added to the validated Zod config contract from E006, and any exporter secret uses the `<VAR>_FILE` convention already established for secrets.

## Consequences

### Positive

- **Uniform, idiomatic instrumentation** across every module, with one standard that future Node services (E013, E014, and beyond) adopt unchanged.
- **Bounded TSDB cardinality** — the fixed label ceiling and the never-label rule keep the metrics backend from exploding as tenants and licenses grow.
- **Tenant-safe telemetry** — per-tenant identity (`tenant_id`, `license_key`, `request_id`) stays in logs and trace attributes and out of the widely-queried metrics surface, reinforcing Principle II at the telemetry layer.
- **Fail-open telemetry** — a degraded Collector or backend never affects request handling; the overhead budget is small and sampled (~0.5–2 ms/req, 2–5% CPU on instrumented paths).
- **Full pivot** — logs, traces, and metrics interlink (child-logger tags, injected trace IDs, and histogram exemplars), so incident triage moves cleanly from a metric to a trace to the underlying log line.
- **Backend decoupling** — the Collector lets the backend evolve (buffering, tail-sampling, vendor routing) without app changes, and prom-client's scrape contract stays stable even if OTel metrics are layered in later.

### Negative

- **More components to operate** — three in-process libraries plus a self-hosted Collector, each with its own configuration.
- **Standing constraint** — the label-cardinality policy is a permanent rule every metric author must respect; violations must be caught in review.
- **Config surface grows** — OTLP endpoint, sampling ratio, and metrics port are added to the config contract (validated via Zod, secrets via `<VAR>_FILE`).
- **Always-on overhead** — a small latency/CPU budget on instrumented hot paths, mitigated by batching and sampling.

### Neutral

- OTel Metrics can be introduced later via the Collector without changing the prom-client scrape contract, so the metrics pillar has a forward path if pipelines are unified.
- The internal metrics port must be reachable by the scraper (in-cluster / sidecar) but must not be exposed on the public API surface — a deployment/network concern, not an app-code change.

## Links

- ADR-0004 (Multi-Tenancy Isolation Model) — the label-cardinality policy extends tenant isolation into telemetry: tenant identity never becomes an unbounded metric label.
- ADR-0006 (Deployment & Packaging — Single Container Image) — the separate internal metrics port and the Collector are wired within the single-image / config-driven deployment model.
- ADR-0007 (Public API Style — REST/JSON First) — the metrics scrape endpoint runs on a separate internal port, distinct from the public REST/JSON API surface.
- specs/dod.md — Observability and Monitoring (Logging / Metrics / Tracing / Alerting) and the SLI/SLO table: the fixed backend (Prometheus, Grafana, Alertmanager, OpenTelemetry, structured JSON logs) that this ADR instruments toward but does not re-decide.
- specs/sad.md — Observability & reliability posture and targets.
- specs/project-plan.md — Epic E012 (Observability and SLOs), the epic that motivates this decision.
- specs/00013-observability-and-slos/spec.md — the E012 feature workspace consuming this decision.
- specs/00007-containerized-runtime-and-config/spec.md — the E006 runtime/config contract (Fastify `logger:false` baseline, `LOG_LEVEL`, validated Zod config, `<VAR>_FILE` secret convention) extended by this ADR.
