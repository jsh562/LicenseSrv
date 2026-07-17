---
feature_branch: "00013-observability-and-slos"
created: "2026-07-17"
input: "e012 — Build the observability and SLO baseline"
spec_type: "operational"
spec_maturity: "draft"
epic_id: "E012"
epic_sources: "{DOD:DDR-2}"
---

# Feature Specification: Observability and SLOs

**Feature Branch**: `00013-observability-and-slos`
**Created**: 2026-07-17
**Status**: Draft
**Spec Type**: operational
**Spec Maturity**: draft
**Epic ID**: E012
**Epic Sources**: {DOD:DDR-2}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

The E006 control-plane runtime ships health probes but has no structured request logging, no metrics, no tracing, and no SLO visibility — its Fastify logger is disabled, there is no request correlation ID, and there is no `/metrics` surface. Operators and on-call therefore cannot see activation success, issuance latency, or availability, cannot query one tenant's requests, and cannot detect a cross-tenant access breach — which for a multi-tenant license server is a security-critical blind spot. Without this baseline the documented SLIs/SLOs are unmeasurable and every incident is diagnosed blind, lengthening MTTR and leaving the tenant-isolation invariant unpoliced.

## Scope *(mandatory)*

### Included

- Structured per-tenant JSON logging with request correlation — one line per request tagged `tenant_id`, `request_id`, `product_id`, and outcome, queryable per tenant, driven by the existing `LOG_LEVEL`.
- Application metrics (RED per online endpoint) and infrastructure metrics (app process, Postgres pool, signer), exposed on an OpenMetrics/Prometheus endpoint.
- SLO dashboards for the documented SLIs (activation success, issuance latency, control-plane availability) with panels rendered against their SLO targets.
- Tenant-isolation continuous assertion that raises an **immediate page** on any cross-tenant access.
- Distributed tracing (OpenTelemetry) on the online path with app/DB/signer attribution, correlated to logs by trace id.
- Multi-window burn-rate SLO alerting and Alertmanager routing to on-call (SEV1/SEV2), with alert rules and dashboards as versioned artifacts.
- A cloud-agnostic, self-hostable observability stack (Prometheus + Grafana + OpenTelemetry Collector) shipped as a compose overlay / config for self-host operators, and the config keys to drive it.

### Excluded

- The online **validate/heartbeat** request handler itself — it does not exist yet and is delivered by E013 (Online enforcement and revocation). E012 provisions the instrumentation harness and a validate-latency SLO panel that shows "pending data" until E013 lands. Rationale: a non-existent path cannot be instrumented; building the harness now avoids rework.
- Log-aggregation backend choice (Loki / ELK / cloud) — operator's choice; E012 emits queryable structured logs, not the store. Rationale: cloud-agnostic, per DOD.
- DORA metrics automation (deployment frequency, lead time, change-failure, MTTR) — derived externally from Git/CI/incident timestamps, not runtime instrumentation. Rationale: a reporting concern outside this runtime baseline.
- Reliability-engineering concerns beyond observability — backups/PITR, DR drills, capacity/autoscaling. Rationale: separate DOD Reliability scope, not instrumentation.
- Managed-offering specifics (PagerDuty/Opsgenie, a hosted aggregator) — the cloud-agnostic self-hostable default is provided; managed substitution is an operator choice.

### Edge Cases & Boundaries

- The `/metrics` surface must expose no tenant data or secrets and must be bound to a dedicated non-public port (per OR-005 / AD-001).
- High-cardinality guard: `tenant_id`, `request_id`, and `license_key` must never appear as Prometheus labels; per-tenant detail lives in logs/traces (linked via exemplars).
- Telemetry must fail-open — a down Collector/Prometheus/Grafana must not increase request error rate or crash the API.
- Observability overhead must stay within the budget defined by SC-010 (≤ 2 ms p95 added latency, ≤ 5% CPU over baseline); tracing is sampled.
- An inbound client-supplied correlation header is recorded as a non-authoritative tag only; the authoritative `request_id` is generated server-side and is never trusted for security decisions.
- The tenant-isolation assertion must not itself perform a cross-tenant read; it hooks the single `withTenant()` DB choke point / auth seam.
- Logs, metrics, and traces must redact secrets and raw PII (API keys, license keys; machine fingerprints hashed).
- Until E013 ships the validate path, the validate-latency SLI has no data — the dashboard must render this as "pending", not as a breach.

## Operational Objectives *(mandatory for operational specs only)*

### Objective 1 - Structured per-tenant logging with request correlation (Priority: P1)

Establish request-scoped structured JSON logging over the E006 runtime: generate a `request_id` per request, propagate it, and emit exactly one log line per request tagged with `tenant_id`, `request_id`, `product_id`, and outcome — queryable per tenant and correlated to traces, with secrets/PII redacted and verbosity driven by `LOG_LEVEL`.

**Why this priority**: Per-tenant queryable, correlated logs are the foundational SLI data source and the primary incident-diagnosis tool — the epic's first acceptance criterion ("structured logs queryable per tenant with request correlation").

**Rationale**: The runtime today runs `Fastify({ logger: false })` with no `request_id` and only ad-hoc startup logs; there is no way to reconstruct one tenant's activity or link a log to a trace.

**Deliverables**:
- A request-scoped structured logger (enable/replace the Fastify logger) wired to `LOG_LEVEL`.
- `request_id` generation + propagation (request context carrier) and a trace-id bridge into log lines.
- A documented log-field contract (required fields, redaction rules).

**Verification Criteria**:
1. **Given** an authenticated `/v1` request, **When** it completes, **Then** exactly one JSON log line is emitted carrying `tenant_id`, `request_id`, `product_id`, and outcome, and contains no secrets or raw PII.
2. **Given** a set of requests for two tenants, **When** an operator filters logs by `tenant_id`, **Then** only that tenant's request lines are returned.
3. **Given** a traced request, **When** its log line and its trace are compared, **Then** they share a correlatable id (trace_id present in the log).
4. **Given** a request carrying an inbound client-supplied correlation header, **When** it is processed, **Then** the sanitized value is recorded under a distinct `client_request_id` field (never overwriting the server-generated `request_id`), drives no security/routing/tenant-resolution decision, and never appears as a metric label.

### Objective 2 - Metrics and SLO dashboards for the documented SLIs (Priority: P1)

Expose an OpenMetrics/Prometheus endpoint with RED metrics per online endpoint plus infrastructure metrics, and provide SLO dashboards that report activation success rate, issuance latency, and control-plane availability against their DOD SLO targets.

**Why this priority**: Dashboards reporting the SLIs against their SLOs are the epic's second acceptance criterion; without metrics the SLOs are unmeasurable.

**Rationale**: There is no metrics surface today (no `prom-client`, no `/metrics`); the DOD fixes the SLI/SLO targets but nothing produces or visualizes the numbers.

**Deliverables**:
- A `/metrics` (OpenMetrics) endpoint plus request/latency/error instrumentation for the activation and issuance paths.
- Infrastructure metrics (process CPU/memory, DB pool/connections, signer availability).
- SLI recording rules and Grafana dashboard definitions (as versioned config) rendering the SLIs against SLO targets, including a validate-latency panel provisioned for E013.

**Verification Criteria**:
1. **Given** live traffic, **When** Prometheus scrapes `/metrics`, **Then** RED metrics for activation and issuance and infra metrics for app/DB/signer are present in OpenMetrics format.
2. **Given** the recording rules and dashboards, **When** an operator opens the SLO dashboard, **Then** activation success rate (≥99.9%), issuance p95 latency (<300ms), and availability (99.9%) render against their targets.
3. **Given** the validate path is not yet deployed, **When** the dashboard loads, **Then** the validate-latency panel shows "pending data" rather than a breach.
4. **Given** the scraped `/metrics` exposition, **When** the label set of every exposed series is inspected, **Then** no series carries `tenant_id`, `request_id`, or `license_key` as a label (the SC-006 cardinality invariant holds under inspection).
5. **Given** the dedicated metrics listener fails to bind its port at startup, **When** the API boots, **Then** request handling continues unaffected (non-fatal) and a metrics-unavailability operational alert (Prometheus target `up==0` / dead-man's switch) is raised.

### Objective 3 - Tenant-isolation paged invariant (Priority: P1)

Continuously assert that cross-tenant access is blocked at the single DB tenant choke point / auth seam, emit a dedicated security signal on any violation, and route that signal to an immediate page; validate the path with a synthetic canary.

**Why this priority**: Tenant isolation is a hard invariant (100%, zero error budget) and security-critical per the DOD; the epic's third acceptance criterion is "a cross-tenant access attempt raises a page-level alert."

**Rationale**: RLS enforces isolation at `withTenant()`, but a breach today would be invisible — there is no signal and no page. A security invariant must page on first occurrence, never be smoothed by burn-rate math.

**Deliverables**:
- An isolation-assertion hook at the `withTenant()` choke point / auth seam emitting a distinct security event/counter on any authenticated-tenant ≠ resource-tenant mismatch.
- A dedicated Alertmanager rule that pages immediately (not budget-based) on any occurrence, plus the minimal routing to on-call needed for that page.
- A synthetic canary probe that periodically attempts a known cross-tenant access and pages if it ever succeeds.

**Verification Criteria**:
1. **Given** a request whose authenticated tenant differs from the target resource's tenant, **When** it is attempted, **Then** it is blocked AND a page-level alert fires.
2. **Given** the synthetic canary, **When** it runs against a healthy system, **Then** the cross-tenant attempt is blocked and the alert path is exercised end-to-end.
3. **Given** normal same-tenant traffic, **When** it runs, **Then** no isolation page fires (no false positives).
4. **Given** the synthetic canary cannot complete its probe (an infra/transport error rather than a cross-tenant success), **When** the failure occurs, **Then** no isolation page fires and a distinct lower-severity canary dead-man's-switch alert is raised.

### Objective 4 - Distributed tracing on the online path (Priority: P2)

Add OpenTelemetry tracing to the online path with app/DB/signer span attribution, exported via OTLP to a self-hostable Collector and correlated to logs by trace id, sampled to bound overhead.

**Why this priority**: Tracing deepens latency/error diagnosis (attribution across app, DB, signer) but the MVP SLOs are already measurable from metrics and logs — it enhances rather than blocks the baseline.

**Rationale**: Latency SLO breaches need attribution to a layer (app vs Postgres vs signer); without spans, on-call cannot localize the cause.

**Deliverables**:
- OTel SDK bootstrap with auto-instrumentation (Fastify + pg + http) plus a manual span around the signer call.
- OTLP export to a self-hosted Collector; configurable sampling; trace_id ↔ log correlation.

**Verification Criteria**:
1. **Given** an activation request, **When** it is traced, **Then** the trace attributes elapsed time across app, DB (pg), and signer spans.
2. **Given** a traced request, **When** its trace_id is used, **Then** the correlated log lines for that request are retrievable.
3. **Given** the Collector is unavailable, **When** requests are served, **Then** request handling is unaffected (fail-open export).

### Objective 5 - Multi-window burn-rate SLO alerting and routing (Priority: P2)

Add multi-window, multi-burn-rate alert rules for the availability, activation-success, and latency SLOs, routed through Alertmanager to on-call with SEV1/SEV2 severity and an escalation policy, all as versioned artifacts.

**Why this priority**: Burn-rate alerting operationalizes the SLOs and cuts alert noise, but the dashboards (OBJ2) already give visibility and the isolation page (OBJ3) already covers the security invariant — this is the automation layer on top.

**Rationale**: Raw-threshold alerts are noisy or slow; error-budget burn-rate alerting (fast + slow windows) pages only on genuine, sustained budget consumption.

**Deliverables**:
- Burn-rate alert rules (paired fast/slow windows) for availability, activation-success, and issuance-latency SLOs.
- Alertmanager routing to on-call channels (Grafana OnCall / Slack / email) with SEV1/SEV2 severity and escalation policy; rules and routing versioned in-repo.

**Verification Criteria**:
1. **Given** a sustained error-budget burn exceeding the fast+slow threshold, **When** it persists, **Then** a page fires to on-call.
2. **Given** a brief sub-threshold blip, **When** it clears, **Then** no page fires (short window suppresses it).
3. **Given** a SEV1 page unacknowledged past the policy window, **When** the timer elapses, **Then** it escalates per the documented policy.

### Operational Constraints

- Cloud-agnostic and self-hostable only: Prometheus, Grafana, Alertmanager, OpenTelemetry Collector — no proprietary SaaS dependency in the baseline.
- `tenant_id`, `request_id`, and `license_key` must not be Prometheus metric labels; per-tenant/per-request identity lives in logs and trace attributes, bridged by exemplars.
- Telemetry must fail-open: unavailability of any observability backend must not degrade, error, or crash the API.
- Observability overhead must stay within a bounded latency and CPU budget — added request latency ≤ 2 ms p95 and ≤ 5% CPU over an uninstrumented baseline, measured at the default trace sample rate (SC-010 is the canonical numeric definition); tracing is sampled.
- No secrets or raw PII in logs, metrics, traces, or the `/metrics` surface; the metrics endpoint is access-controlled or bound to a non-public port.
- Tenant isolation is a hard invariant (zero error budget) — it pages immediately and is never smoothed by burn-rate alerting.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: E012 instruments the E006 runtime at fixed seams — global hooks in `src/server/app.ts` (`createApp`, tenant-auth preHandler), bootstrap in `src/server/main.ts`, the validated config contract in `src/server/config/`, and the single DB tenant choke point `withTenant()` in `src/server/db/client.ts` — where the logging, metrics, tracing, and isolation-assertion hooks attach.
- **IP-002**: The `/metrics` endpoint and OTLP exporter depend on an operator-provided or compose-overlay-provided Prometheus + Grafana + OpenTelemetry Collector (self-hostable, cloud-agnostic).
- **IP-003**: The validate-latency SLI depends on E013 (Online enforcement and revocation) creating the `/v1` validate/heartbeat handler; E012 provides the instrumentation harness and a "pending" panel so the SLI activates when E013 lands.
- **IP-004**: SLO targets and alert severities are sourced from the DOD SLI/SLO table and Alerting policy ({DOD:DDR-2}); routing integrates with the operator's on-call (Grafana OnCall / Slack / email; managed may substitute PagerDuty/Opsgenie).
- **IP-005**: The self-host observability stack overlay and observability config surface ship alongside the E011 signed release/compose bundle so self-host operators get instrumentation with the image.

## Requirements *(mandatory)*

### Operational Requirements *(operational specs only)*

- **OR-001**: System MUST emit exactly one structured JSON log line per request — via the response hook, for every HTTP request including error paths, early auth rejections, and non-`/v1` requests — tagged with `tenant_id`, `request_id`, `product_id`, and request outcome; when the tenant is not yet resolved (e.g., a pre-auth rejection) the `tenant_id` field is recorded as null rather than omitting or duplicating the line.
- **OR-002**: System MUST generate a server-side authoritative `request_id` per request (via Fastify `genReqId`) and propagate it through logs and trace context. An inbound client-supplied correlation header is recorded ONLY as a non-authoritative diagnostic tag under a distinct field name (`client_request_id`) that never overwrites or is conflated with the authoritative `request_id`. Before it is recorded, the client-supplied tag MUST be validated/sanitized — bounded length (≤128 chars) and a restricted charset (printable ASCII, no control or newline characters), truncating or rejecting anything else — so it cannot inject content into logs or smuggle secrets/PII. The client-supplied tag MUST NEVER be used for any security or routing decision (authorization, tenant selection/resolution, audit identity, rate-limit keys) and MUST NEVER be used as a metric label (unbounded cardinality / injection risk; OR-008).
- **OR-003**: System MUST make logs filterable/queryable per tenant.
- **OR-004**: System MUST NOT include secrets or raw PII in logs, metrics, traces, or the `/metrics` surface, applying the same per-field redaction rule set across all signal types. The redaction set MUST cover, at minimum: API keys and `Authorization`/`x-api-key` request headers, bearer/session tokens, license keys and signed license-token payloads, database connection strings/DSNs, and OTLP/exporter secrets (signing-key material is handled by the stricter total-exclusion rule in OR-020); raw PII — machine fingerprints — MUST be hashed with a deterministic, one-way keyed hash (HMAC-SHA-256 with a server-held salt/pepper) so the same machine stays correlatable across signals (queryability) while the raw fingerprint cannot be recovered (irreversibility) or brute-force enumerated. The same rule set MUST also apply to error messages, stack traces, and exception payloads captured in logs and span/`exception` events. Redaction MUST fail closed — if a field cannot be confidently redacted it MUST be dropped (omit the field, line, or span attribute) rather than emitted in the clear. Log verbosity MUST be driven by `LOG_LEVEL` (permitted pino levels `trace`|`debug`|`info`|`warn`|`error`|`fatal`, default `info`).
- **OR-005**: System MUST expose an OpenMetrics/Prometheus metrics endpoint that carries no tenant data or secrets and is bound to a dedicated internal (non-public) port — a separate prom-client listener off the public API surface — per {SAD:ADR-0009}/AD-001. Conformance is measurable: the listener MUST bind to a configurable dedicated port (OR-018) that is NOT published on the public ingress/load-balancer and is reachable only from the metrics scraper's network (enforced by an internal/private bind address and/or network policy/firewall), and MUST never share the public `/v1` listener or route. The endpoint performs NO application-level authentication — network isolation (dedicated non-public port + scraper-only reachability) is its sole access-control mechanism (the non-public port is the chosen control, not an either/or with it); because there is no endpoint auth, the surface MUST expose no tenant data or secrets so that network-layer control is sufficient.
- **OR-006**: System MUST expose application RED metrics (request rate, error rate, latency histograms) for the activation and issuance paths, plus a seat-contention counter (incremented once per activation denied due to seat-limit contention) and a failed-validation/tamper counter (incremented once per request whose license token fails signature/tamper validation). Latency histogram bucket boundaries MUST include the SLO thresholds (notably 120 ms and 300 ms) so p95/p99 are computable from the metric.
- **OR-007**: System MUST expose infrastructure metrics — process CPU/memory, DB pool/connection stats, and signer availability.
- **OR-008**: System MUST keep metric label sets bounded — `tenant_id`, `request_id`, and `license_key` MUST NOT be metric labels; histograms SHOULD carry trace exemplars for high-cardinality drill-down.
- **OR-009**: System MUST provide SLO dashboards reporting activation success rate, issuance latency (p95), and control-plane availability against the DOD SLO targets, with a validate-latency panel provisioned as "pending" until E013.
- **OR-010**: System MUST provide SLI recording rules computing good/total ratios and latency percentiles that back the dashboards and alerts.
- **OR-011**: System MUST continuously assert — at a single assertion point, the `withTenant()` DB tenant choke point (`src/server/db/client.ts`) — that the authenticated principal's tenant (resolved at the auth-seam preHandler as `req.tenant`) equals the tenant GUC (`app.current_tenant`) being set for the transaction. A cross-tenant access violation is defined as any mismatch between those two identities. RLS remains the authoritative enforcement that blocks the access; the assertion is the detection/signal path only and MUST NOT itself perform any cross-tenant read (it compares the two in-memory tenant identities without querying another tenant's rows). On any violation the System MUST emit a dedicated security signal comprising (a) a Prometheus counter `tenant_isolation_violation_total` (no `tenant_id`/`request_id`/`license_key` labels; OR-008) that drives the immediate page independently of trace sampling and OTLP export (OR-014), and (b) a structured security log event carrying `request_id`, the authenticated tenant, the attempted (GUC) tenant, the assertion location, and outcome (`blocked`).
- **OR-012**: System MUST raise an immediate page-level alert (SEV1 per OR-016; not burn-rate smoothed) on any cross-tenant access violation, routed to on-call. "Immediate" is measurable: the isolation alert rule carries no burn-rate/`for:` window and fires on the first evaluation cycle that observes a violation, bounding detection-to-page latency to ≤ ~1 minute (one scrape + evaluation interval) — distinct from the multi-window burn-rate windows of OR-015. The page MUST NOT fire on same-tenant access (matching identities) — no false positives — for either live traffic or the canary. This no-false-positive property MUST be asserted over a bounded verification window — at least 100 same-tenant requests plus at least one full canary cadence cycle — so that "no page fires" is a concrete pass/fail assertion rather than an open-ended claim. System MUST also provide a synthetic canary that exercises this path at a configurable cadence (default ~60 s): it MUST use dedicated reserved synthetic tenant fixtures (never real customer tenants/data), run against the live control plane, and treat a cross-tenant attempt that is NOT blocked as the pageable outcome. A canary execution failure (the probe cannot complete — infra/transport error) MUST be classified distinctly from a detected breach, MUST NOT trigger the isolation page, and SHOULD raise a separate lower-severity operational alert (canary dead-man's switch) so a broken canary is not misread as isolation and a silently dead canary is still noticed.
- **OR-013**: System MUST provide distributed tracing on the online path with app/DB/signer span attribution, exported via OTLP to a self-hostable Collector and correlated to logs by trace id. Span attributes are subject to the same OR-004 redaction rule set: trace instrumentation MUST NOT capture raw SQL statement text or bound query parameters that can carry license keys or PII — `db.statement`/parameter capture in the pg auto-instrumentation MUST be disabled or redacted. The `trace_id` MUST be present in every request's log line regardless of the sampling decision — sampling governs span export, not trace-context/`trace_id` generation — so log↔trace correlation (SC-002) is assertable for both sampled and unsampled requests.
- **OR-014**: System MUST sample traces at a configurable rate (parent-based ratio, default 10%), and telemetry export failures MUST NOT affect request handling (fail-open); fail-open coverage extends to a metrics-port bind failure (a failed metrics listener is non-fatal to the API). Fail-open is scoped strictly to telemetry export and observability backends (Collector/Prometheus/Grafana/metrics listener) — it NEVER relaxes request-path enforcement (authentication, RLS, tenant-isolation), which remains fail-closed. Fail-open MUST NOT suppress, mask, delay, or drop the tenant-isolation security signal — that signal reaches Alertmanager via a path independent of trace sampling and batched OTLP export, so the isolation page fires even when the Collector/OTLP export is unavailable. A metrics-port bind or scrape failure, while non-fatal to request handling, MUST NOT be silent: metrics unavailability MUST itself raise an operational alert (Prometheus target `up==0` / dead-man's switch) so that loss of breach visibility is detected and fail-open never becomes a silent blind spot.
- **OR-015**: System MUST provide multi-window burn-rate alert rules for the availability, activation-success, and latency SLOs (page on fast+slow burn; ticket on slow burn).
- **OR-016**: System MUST route alerts via Alertmanager to on-call with per-alert SEV1/SEV2 severity — tenant-isolation page and service-down (fast-burn availability/issuance) alerts as SEV1, sustained degradation (slow-burn) alerts as SEV2 — and an escalation policy quantified per {DOD:DDR-2} (SEV1 auto-escalates if unacknowledged within 10 min; SEV2 escalates to lead at ~30 min), with alert rules and routing kept as versioned artifacts.
- **OR-017**: System MUST provide the observability stack (Prometheus, Grafana, Alertmanager, OpenTelemetry Collector) as a cloud-agnostic, self-hostable compose overlay / config for self-host operators.
- **OR-018**: System MUST add observability configuration (metrics port, OTLP endpoint, trace sampling rate, log format) to the validated config contract following the `LOG_LEVEL` precedent, with any exporter secret resolved via the `<VAR>_FILE` convention. The exporter secrets covered MUST include, at minimum, the OTLP exporter authentication token/header value and any Collector transport credentials (basic-auth password or mTLS client key). Precedence follows the established `readSecret` convention — `<VAR>_FILE` takes precedence over the inline `<VAR>` when both are set (a readable, non-empty file wins; an empty/unreadable file for a required secret fails fast, naming the setting). Exporter secrets (and all `<VAR>_FILE`-sourced secrets) MUST NOT appear in the logged startup/config summary — `configSummary` remains secret-free (OR-004).
- **OR-019**: System MUST evaluate each SLO over a rolling 30-day window, with the good/total (or percentile) computation and per-SLO error budget sourced from the DOD SLI/SLO table ({DOD:DDR-2}): control-plane availability — good (non-error) responses over total, measured from real traffic plus synthetic probes, target 99.9%, budget 0.1% (~43.8 min/month); activation success — successful activations over total activation attempts excluding policy denials, target ≥99.9%, budget 0.1% of requests; issuance latency — p95 of the issuance duration histogram, target <300 ms; validate latency — p95/p99 of the validate duration histogram, targets <120 ms/<300 ms (pending E013); tenant isolation — cross-tenant access blocked, 100% hard invariant, zero error budget (pages immediately, never budget-smoothed).
- **OR-020**: System MUST exclude all signing-key material from every telemetry signal (logs, metrics, traces, and the `/metrics` surface). Signer instrumentation MUST be limited to availability, latency, and outcome attributes and MUST NOT record signing-key identifiers, key bytes, or the signing payload/input. Signer error, exception, and stack-trace telemetry is subject to the same exclusion — no key material or signing input may appear in any captured error/exception payload. This makes normative the Principle I guarantee ({SAD:ADR-0009}; project-instructions Principle I) previously asserted only in the Compliance Check narrative. OR-020 specializes OR-004: where OR-004 redacts secrets generally, OR-020 mandates total exclusion of signing-key material from every signal.

### Runbook Requirements *(include for operational specs if applicable)*

- **RR-001**: A runbook MUST exist for responding to a tenant-isolation page — confirm the breach, contain, assess blast radius, and notify (security incident path). It MUST act on exactly the signal OR-011 emits: the `tenant_isolation_violation_total`-driven SEV1 page (OR-012/OR-016), using the security log-event fields (`request_id`, authenticated tenant, attempted/GUC tenant, assertion location, timestamp) to confirm the breach and scope blast radius, so responders and the emitting system share one signal definition (OBJ3).
- **RR-002**: A runbook MUST exist for SLO breach / error-budget burn response — identify the affected SLI, correlate dashboards→exemplar traces→tenant logs, and mitigate.
- **RR-003**: A runbook MUST exist for observability-stack failure (Prometheus / Collector / Grafana / Alertmanager down) — confirm the API is unaffected (fail-open) and restore telemetry.
- **RR-004**: A runbook MUST exist for the on-call latency/error diagnosis flow using logs + traces (dashboard → burn alert → exemplar trace → per-tenant logs).

## Assumptions & Risks *(mandatory)*

### Assumptions

- The E006 runtime seams (`app.ts` global hooks, `main.ts` bootstrap, `config/`, and the `withTenant()` DB choke point) are stable instrumentation points and remain available.
- Operators run, or the compose overlay provides, a Prometheus + Grafana + Alertmanager + OpenTelemetry Collector stack; the managed offering may substitute hosted equivalents.
- The DOD SLI/SLO table and alerting/escalation policy are the authoritative targets and will not materially change during delivery.
- The online validate/heartbeat path is delivered by E013; until then the validate-latency SLI has no data.
- Grafana dashboards and Prometheus/Alertmanager rules are acceptable as versioned config artifacts in-repo.

### Risks

- **Metric cardinality blow-up** *(likelihood: medium, impact: high)*: tenant/request identifiers leaking into metric labels would exhaust Prometheus memory — mitigate via the OR-008 label constraint and a label-allowlist review.
- **Observability overhead degrades the latency SLOs it measures** *(likelihood: low, impact: medium)*: mitigate via trace sampling, asynchronous/batched export, and a measured overhead budget with fail-open behavior.
- **Isolation alert false-positives (fatigue) or false-negatives (missed breach)** *(likelihood: medium, impact: high)*: mitigate by placing the single assertion at the `withTenant()` choke point and validating the alert path end-to-end with a synthetic canary.

## Implementation Signals *(mandatory)*

- `NEW-CONFIG` — metrics port, OTLP exporter endpoint, trace sampling rate, and log-format/level wiring added to the validated config contract (following the `LOG_LEVEL` precedent).
- `NEW-API` — an internal OpenMetrics `/metrics` endpoint (dedicated non-public metrics port, per OR-005 / AD-001).
- `NEW-WORKER` — an OpenTelemetry SDK/Collector export path (out-of-band, sampled, fail-open) and a synthetic tenant-isolation canary probe.
- `EXTERNAL-SERVICE` — Prometheus, Grafana, Alertmanager, and OpenTelemetry Collector as self-hostable, cloud-agnostic observability backends (compose overlay).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: Every control-plane request emits exactly one structured log line tagged with `tenant_id`, `request_id`, `product_id`, and outcome, filterable per tenant, with no secrets or raw PII present.
- **SC-002** [OBJ1]: Every request's log line carries a trace_id (universal guarantee); for a sampled/exported trace, that trace_id resolves to the trace, enabling a one-click log↔trace pivot.
- **SC-003** [OBJ2]: The metrics endpoint exposes RED metrics for the activation and issuance paths and infra metrics for app/DB/signer in OpenMetrics format, scrapeable by Prometheus.
- **SC-004** [OBJ2]: The SLO dashboard renders activation success rate (target ≥99.9%), issuance latency p95 (target <300ms), and control-plane availability (target 99.9%) against their targets.
- **SC-005** [OBJ3]: A simulated cross-tenant access attempt is blocked AND raises a page-level alert, verified end-to-end by the synthetic canary.
- **SC-006** [OBJ2, OBJ3]: No `tenant_id`, `request_id`, or `license_key` appears as a Prometheus metric label (the cardinality invariant holds under inspection).
- **SC-007** [OBJ4]: An online-path request produces a trace attributing elapsed time across app, DB (pg), and signer spans, correlated to the request's logs by trace_id.
- **SC-008** [OBJ5]: A sustained error-budget burn on an SLO raises a page via burn-rate alerting, while a brief sub-threshold blip does not.
- **SC-009** [OBJ1, OBJ4]: With the telemetry backend unavailable (Prometheus/Collector down), request error rate does not increase and the API does not crash (fail-open verified).
- **SC-010** [OBJ2, OBJ4]: With instrumentation enabled at the default trace sample rate, added request latency stays ≤ 2 ms p95 and CPU overhead ≤ 5% versus an uninstrumented baseline, measured by comparing baseline vs. instrumented runs of the same workload (p95 latency delta and CPU delta).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| SLI | Service Level Indicator — a measured signal of service behavior (e.g., activation success rate, validate latency). |
| SLO | Service Level Objective — the target value/range for an SLI (e.g., availability 99.9%). |
| Error budget | The allowed amount of SLO non-compliance over a window (e.g., 0.1% of requests for a 99.9% target). |
| Burn rate | How fast the error budget is being consumed; multi-window burn-rate alerting pages on sustained high burn. |
| RED method | Instrumenting each request path by Rate, Errors, and Duration. |
| Exemplar | A trace_id attached to a metric sample, linking an aggregate metric to a representative trace without a high-cardinality label. |
| Cardinality | The number of distinct time series a metric produces; unbounded label values (e.g., tenant_id) cause cardinality blow-up. |
| OTLP | OpenTelemetry Protocol — the transport used to export traces/metrics/logs to a Collector. |
| Paged invariant | A hard, zero-error-budget property (here, tenant isolation) whose violation triggers an immediate page rather than budget-based alerting. |
| request_id | A server-generated per-request correlation ID propagated across logs and trace context. |

## Compliance Check

**Verdict: PASS** — no CRITICAL violations (per `project-instructions.md` Governance, any real violation would be CRITICAL; none found). All core principles, security requirements, the cloud-agnostic constraint, and the DOD SLI/SLO targets are satisfied.

**Satisfied principles**:
- **I. Offline-First / signing keys never exposed** — OR-004 (no secrets/raw PII in logs; keys redacted, fingerprints hashed), OR-005 (`/metrics` carries no secrets; access-controlled/non-public port), OR-018 (exporter secrets via `<VAR>_FILE`), OR-020 (signing-key material excluded from all telemetry as a normative requirement). The signer is instrumented for availability/latency only (OR-007; OBJ4 span) — no key material in any telemetry.
- **II. Multi-Tenant Isolation** (strengthened) — OBJ3 + OR-011/OR-012: cross-tenant access blocked at the single `withTenant()` choke point, dedicated security signal, immediate page (never burn-rate smoothed), synthetic canary; the assertion performs no cross-tenant read; `tenant_id` never a metric label (OR-008/SC-006). Matches the DOD tenant-isolation SLI row (100%, 0 budget → page).
- **III. Single Security Core, Fully Audited** — adds no crypto; request logging is additive to (does not bypass) the append-only audit log.
- **Cloud-agnostic / self-host-first** — OR-017 + IP-002/IP-005 + `EXTERNAL-SERVICE`: Prometheus + Grafana + Alertmanager + OTel Collector as a self-hostable compose overlay; no proprietary-SaaS hard dependency (Slack/PagerDuty are optional/excluded, email available).
- **PII minimization / GDPR** — OR-004 hashes fingerprints and redacts keys.
- **{DOD:DDR-2} SLI/SLO alignment** — SC-004 + OBJ2/OBJ3 match the DOD SLI/SLO table (availability 99.9%, activation ≥99.9%, issuance p95 <300 ms, tenant isolation 100%→page); validate-latency provisioned "pending" until E013.

**Violations**: none.

**Non-blocking notes** (resolve at Plan): (1) the `{DOD:DDR-2}` epic-source label mirrors the project plan, but the substantive derivation is the DOD "Observability and Monitoring", "SLI/SLO", and "Reliability Engineering" sections — reconcile the project-plan DDR labeling during Plan; (2) optional Slack routing is a SaaS but non-mandatory (email available); (3) log-retention/GDPR erasability is inherited from DOD retention policy (aggregation backend is out of scope) — confirm inheritance at Plan.
