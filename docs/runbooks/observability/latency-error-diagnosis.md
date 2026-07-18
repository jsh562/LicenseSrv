# Runbook: On-call latency / error diagnosis (RR-004)

**Use when**: on-call needs to diagnose elevated latency or errors on the online path — whether triggered
by a burn-rate page, a customer report, or a dashboard glance. This is the standard
**dashboard -> burn alert -> exemplar trace -> per-tenant logs** flow that ties the three telemetry
pillars together (logs, metrics, traces — ADR-0009).

## The pivot chain

The three pillars interlink so you can move from a symptom to a root cause without guessing:

- **Metrics** (Prometheus/Grafana) tell you *that* something is wrong and *how much* (RED + SLIs).
- **Exemplars** on the histograms bridge a specific latency/error bucket to a **representative trace**.
- **Traces** (OTel via the Collector) tell you *where* the time/error is — app vs DB vs signer span.
- **Logs** (`trace_id`-correlated) tell you *who* and *what* — the exact tenant, route, and outcome.

## Step 1 — Dashboard (what and how much)

Open Grafana -> "License API SLOs" -> the SLO overview
(`observability/grafana/dashboards/slo-overview.json`). Read the RED signals:

- **Rate** — request volume by route; a cliff or spike narrows the timeframe and the affected route.
- **Errors** — `sum(rate(http_requests_total{outcome="server_error"}[5m]))` by route; which endpoint is
  erroring.
- **Duration** — the latency percentiles (e.g. `job:issuance_latency:p95_5m`) vs the SLO target.

Note the affected `route` and the start time — you'll carry them through the rest of the flow.

## Step 2 — Burn alert (is it budget-relevant?)

Check whether a burn-rate alert is firing (`observability/prometheus/alert-rules.yml`): its labels tell you
the affected `slo`, the `burn_rate` tier, and the `severity`. If a page fired, the alert already named the
SLI; if you started from a customer report, this tells you whether the symptom is already eroding the error
budget (page-worthy) or a sub-threshold blip. (If `MetricsTargetDown` is ALSO firing, the metrics may be
stale — see `telemetry-stack-failure.md` before trusting the dashboard.)

## Step 3 — Exemplar trace (where)

On the latency histogram panel, click an **exemplar** marker on an elevated bucket (or a bucket at/above
the SLO boundary — e.g. the 300 ms bucket for issuance). It links to a representative **trace** for a
request in that bucket. Read the span breakdown:

- Slow/failing **`signer.sign`** span -> the signer (availability/latency/outcome only; no key material).
  Cross-check `signer_up` and `signer_request_duration_seconds`.
- Slow **`pg`** span -> the database or a specific query. Cross-check `pg_pool_connections_waiting` (pool
  contention) and `pg_pool_connections_total`.
- Time in the **Fastify** span with fast children -> app-level cost (CPU/GC/event-loop), or an upstream
  wait. Cross-check the process metrics (`process_cpu_seconds_total`, event-loop lag).

Copy the **`trace_id`** from the trace.

## Step 4 — Per-tenant logs (who and what)

Filter the structured logs by that `trace_id` to reach the exact one-per-request line(s). Each carries the
`REQUEST_LOG_CONTRACT` fields (`src/server/observability/logger.ts`): `tenant_id`, `request_id`, `route`,
`method`, `outcome`, `status`, `duration_ms`, and `product_id`. From here:

- **Scope by tenant** — filter `tenant_id="<id>"` to see if the problem is one tenant (abuse / a specific
  license / a hot loop) or platform-wide (`tenant_id` varies).
- **Scope by route + outcome** — filter `route="<route>", outcome="server_error"` to enumerate the failing
  requests and read their surrounding context. Secrets/PII are redacted (OR-004/020) — no license keys, API
  keys, DSNs, or raw fingerprints appear; fingerprints are one-way hashed.
- **Reconstruct the timeline** — first/last matching line bounds the incident window.

Note: `trace_id` is present on EVERY request line regardless of the trace sampling decision (SC-002), so
even a request whose span was not exported still correlates to its logs.

## Step 5 — Act

Route to the mitigation in `docs/runbooks/observability/slo-burn-response.md#mitigate` (rollback,
signer/DB restore, per-tenant rate limit). If diagnosis shows the API is actually healthy and the signal is
a telemetry artifact, pivot to `docs/runbooks/observability/telemetry-stack-failure.md`. If logs show a
cross-tenant `tenant_id` mismatch or the isolation page fired, STOP and follow
`docs/runbooks/observability/tenant-isolation-page.md` (security incident) instead.
