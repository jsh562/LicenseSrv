# Runbook: SLO burn / error-budget response (RR-002)

**Severity**: SEV1 (fast burn) / SEV2 (slow burn) / SEV3 (ticket).
**Applies to**: the multi-window burn-rate alerts in `observability/prometheus/alert-rules.yml` —
`AvailabilityErrorBudgetBurn{Fast,Slow,Ticket}`, `ActivationErrorBudgetBurn{Fast,Slow,Ticket}`,
`IssuanceLatencyErrorBudgetBurn{Fast,Slow,Ticket}` — routed via Alertmanager
(`observability/alertmanager/config.yml`).

## Background

Each SLO has a 30-day error budget (specs/dod.md SLI/SLO table): availability 99.9% (budget 0.1%),
activation success >= 99.9% (budget 0.1%, EXCLUDING policy denials), issuance latency p95 < 300 ms
(>= 95% of issuance requests within 300 ms, budget 5%). The alerts follow the standard multi-window,
multi-burn-rate shape: a tier fires only when BOTH a long and a short window exceed the same burn-rate
threshold (fast 14.4x over 1h+5m -> SEV1; slow 6x over 6h+30m -> SEV2; ticket 1x over 3d+6h -> SEV3). The
two-window `and` means a page reflects a burn that is BOTH large AND still happening — not an old, ended
blip. The SLI definitions are the recording rules in `observability/prometheus/recording-rules.yml`.

## First response (identify the affected SLI)

1. **Read the alert labels.** `slo=` tells you which SLI is burning (`availability`,
   `activation_success`, `issuance_latency`); `burn_rate=` (`fast`/`slow`/`ticket`) tells you the urgency;
   `severity=` drives the page. A SEV1 fast burn means the budget is on track to be exhausted in ~2 days.
2. **Confirm on the SLO dashboard** (Grafana -> "License API SLOs" -> SLO overview,
   `observability/grafana/dashboards/slo-overview.json`). Locate the affected SLI panel and confirm the
   ratio/percentile is below/above its DOD target and the burn is live (short window still elevated).
3. **Quantify the burn** on the metrics port / Prometheus:
   - availability: `1 - job:request_availability:ratio_rate5m`
   - activation:   `1 - job:activation_success:ratio_rate5m`
   - issuance:     `job:issuance_latency:p95_5m` (target < 0.3)
   Compare against the budget: burn rate = observed error ratio / budget.

## Correlate (dashboards -> exemplar traces -> tenant logs)

1. **Dashboard -> exemplar trace.** RED histograms carry trace **exemplars** (ADR-0009). On the latency
   panel, click an exemplar on an elevated bucket to jump to a representative trace of a slow/failing
   request — the concrete example of what the SLI is measuring.
2. **Trace -> spans.** In the trace, read the app/DB/signer span attribution to localize the cost: a slow
   `pg` span points at the database/query; a slow or failing `signer.sign` span points at the signer; time
   in the Fastify span with fast children points at app/GC/CPU.
3. **Trace -> tenant logs.** Take the `trace_id` from the trace and filter the structured logs
   (`trace_id="<id>"`) to reach the exact one-per-request log lines — each carries `tenant_id`,
   `request_id`, `route`, `outcome`, `status`, `duration_ms` (fields per `logger.ts REQUEST_LOG_CONTRACT`).
   Filtering by `tenant_id` shows whether the burn is one tenant or platform-wide; filtering by `route`
   and `outcome=server_error` shows the failing endpoint.

## Mitigate

- **Localized to a recent deploy** — roll back to the last known-good digest-pinned image
  (`dist-bundles/docker-compose.release.yml`), then re-check the short-window burn drops.
- **Signer-driven** (activation/issuance errors or latency, slow/failing `signer.sign` spans, `signer_up`
  0) — see the signer's own runbook; fail over / restore the signer. The API cannot issue while the signer
  is down.
- **Database-driven** (slow `pg` spans, `pg_pool_connections_waiting` rising) — check pool saturation and
  slow queries; scale the pool / DB or shed load.
- **Single-tenant abuse / hot loop** — if one `tenant_id` dominates the burn, apply per-tenant rate limits.
- **Budget accounting.** For a SEV3 ticket, no immediate action beyond filing the ticket; for SEV1/SEV2,
  once the short window recovers, confirm the burn has stopped before silencing. A SEV1/SEV2 requires a
  blameless postmortem within 48 h (specs/dod.md).

## Escalation

SEV1 auto-escalates if unacknowledged within 10 min; SEV2 escalates to the lead at ~30 min (OR-016;
Alertmanager `repeat_interval` 10m/30m). Do not silence until the short-window burn rate is back under
threshold.

## Related

- `docs/runbooks/observability/latency-error-diagnosis.md` — the detailed dashboard -> trace -> log flow.
- `docs/runbooks/observability/telemetry-stack-failure.md` — if the burn alert cannot be trusted because
  telemetry itself is degraded (e.g. `MetricsTargetDown` is also firing).
