# Runbook: Observability-stack failure (RR-003)

**Severity**: SEV2 — operational (loss of visibility, NOT a request-path outage).
**Applies to**: `MetricsTargetDown` / `MetricsTargetAbsent` (`observability/prometheus/alert-rules.yml`),
`TenantIsolationCanaryDown` / `TenantIsolationCanaryAbsent`, and any Prometheus / Grafana / Alertmanager /
OpenTelemetry Collector component being down.

## Core principle: telemetry is FAIL-OPEN — the API is unaffected

Instrumentation is scoped to be fail-open (OR-014, ADR-0009): a down or slow Collector, a down Prometheus,
or a failed metrics-port bind is **non-fatal to request handling**. Fail-open is scoped strictly to
telemetry export/backends — it NEVER relaxes request-path enforcement (auth, RLS, tenant isolation), which
stays fail-closed, and it NEVER suppresses the tenant-isolation security signal (that page reaches
Alertmanager via a path independent of trace sampling and batched OTLP export). So an observability-stack
failure is a **visibility incident**, not a customer-facing outage — but it must not be a SILENT blind
spot, which is exactly why `MetricsTargetDown`/`Absent` exist.

## First response (confirm the API is UNAFFECTED)

Before touching telemetry, prove the request path is healthy — independently of the metrics you just lost:

1. **Hit the health probes directly** (not via Prometheus): `GET /internal/health/ready` and
   `/internal/health/live` on the API port should return ok. A real request (e.g. a known validate/activate
   call) should still succeed.
2. **Check the API logs directly** at the log destination (stdout / log store). Structured request lines
   (`event/msg="request completed"`, `outcome`, `status`, `duration_ms`) should still be flowing — logging
   does not depend on Prometheus/Collector. If request lines are flowing with healthy outcomes, the API is
   serving; the problem is confined to the telemetry backends.
3. **Confirm the blast radius is visibility only.** If `MetricsTargetDown` fired but request logs are
   healthy, do NOT roll back the app — this is a telemetry restore, not an app incident.

## Diagnose & restore by component

- **Metrics endpoint / scrape (`MetricsTargetDown`, up == 0)** — the API is up but its metrics port is not
  scrapeable.
  - The metrics listener binds to loopback on `OBS_METRICS_PORT` (default 9464) and is fail-open: a bind
    failure logs `metrics listener bind failed ... (fail-open)` and the API keeps serving. Grep the API
    logs for that warning.
  - In the self-host overlay Prometheus scrapes `127.0.0.1:9464` via the shared API network namespace
    (`network_mode: "service:api"`). Confirm the Prometheus container is up and its target is `UP`
    (Prometheus -> Status -> Targets, job `license-api`). A port collision or `OBS_METRICS_PORT` mismatch
    is the usual cause — align the port and restart the API.
- **`MetricsTargetAbsent`** — Prometheus has no `license-api` target at all: the scrape job is
  misconfigured or Prometheus did not load `prometheus.yml`. Check the mounted config and reload
  (`--web.enable-lifecycle` -> `POST /-/reload`) or restart Prometheus.
- **Prometheus down** — dashboards and burn-rate alerts stop evaluating. Restart the Prometheus service;
  verify the mounted rule files load cleanly (`promtool check rules` on `recording-rules.yml` and
  `alert-rules.yml`). Historical data persists in the `prometheus-data` volume.
- **OpenTelemetry Collector down** — traces stop being ingested; the app keeps running (OTLP export is
  fail-open, spans are dropped on overflow). Request logs still carry `trace_id`, so log correlation is
  preserved even without stored traces. Restart the Collector; confirm the app's OTLP endpoint
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, `otel-collector:4318`) resolves.
- **Grafana down** — visualization only; Prometheus/alerts are unaffected. Restart Grafana; dashboards and
  datasource re-provision from `observability/grafana/provisioning/` on boot.
- **Alertmanager down** — Prometheus still evaluates alerts but cannot notify. THIS IS THE DANGEROUS ONE:
  while Alertmanager is down, even a SEV1 (including the tenant-isolation page) would not deliver. Treat
  restoring Alertmanager as top priority; validate config first (`amtool check-config config.yml`).

## Canary dead-man's switch

`TenantIsolationCanaryDown` / `TenantIsolationCanaryAbsent` mean the synthetic isolation canary stopped
completing probes — loss of breach *visibility*, not a breach (see
`docs/runbooks/observability/tenant-isolation-page.md`). Restore the canary worker (check it started, the
reserved synthetic tenants exist, DB reachable) and confirm `canary_up == 1` with a fresh
`canary_last_success_timestamp_seconds`.

## Escalation & closure

SEV2 escalates to the lead at ~30 min if unresolved (OR-016). Close only after: the affected component is
back, Prometheus targets are `UP`, `MetricsTargetDown`/`Absent` clears, and (if it fired) the canary
dead-man's switch clears. If the API itself was found unhealthy during first response, this is no longer a
telemetry incident — pivot to `docs/runbooks/observability/latency-error-diagnosis.md`.
