# Research — E012 Observability and SLOs

Domain best practices for the observability + SLO baseline over the E006 control plane (Node 22 / Fastify 5 / PostgreSQL 16, multi-tenant, self-hostable, cloud-agnostic). DOD choices are fixed (JSON logs, Prometheus/Grafana, OTel tracing, Alertmanager, the SLI/SLO table); this covers the "how".

## RED/USE metric methodology
Instrument each request path (activate, deactivate, issue) with RED — Rate, Errors, Duration (histogram) — as the primary SLIs; reserve USE (Utilization, Saturation, Errors) for infra/DB/signer resources. Map directly: issuance Duration → p95<300ms; activate Errors/Rate → activation success ≥99.9%; aggregate Errors/Rate → 99.9% availability. Emit duration histograms per route+outcome so SLO queries are good/total ratios. Avoid: averages instead of percentiles; per-tenant labels; mixing infra saturation into service SLIs.
Sources: sre.google/sre/book (four golden signals); infoworld RED method.

## Multi-window multi-burn-rate SLO alerting
Alert on error-budget burn rate, not raw thresholds. For 99.9% SLOs use paired long+short windows (short ≈ 1/12 of long), both must exceed the threshold to fire. Tiers: page at 14.4x burn (1h/5m), 6x (6h/30m); ticket at 1x (3d/6h). The short window suppresses alerts once burning stops, cutting false pages. Avoid: single-window threshold alerts; paging on the ticket tier.
Source: sre.google/workbook/alerting-on-slos (canonical burn-rate tables).

## Per-tenant logging + trace correlation
Bind tenant_id, request_id, product_id, outcome into a per-request logger context (Fastify request hook / AsyncLocalStorage). Use an OTel-aware log bridge so each JSON line auto-carries trace_id/span_id, giving one-click log↔trace pivot. Keep request_id as the business correlation ID (trace_id changes per request). Logs/traces are the correct home for high-cardinality tenant detail and per-tenant queryability. Avoid: logging PII/license secrets; inconsistent field names; logs as a metrics substitute.
Sources: opentelemetry.io/docs/concepts/signals/logs; OWASP Multi-Tenant Security cheat sheet.

## OpenTelemetry in Node/Fastify
Start with auto-instrumentations-node (Fastify + pg + http) loaded before app import; add manual spans only for the external signer call so traces attribute app vs DB vs signer time. Export OTLP to a self-hosted Collector (not direct to a backend) for buffering, sampling, and vendor-agnostic routing. Use BatchSpanProcessor + head/tail sampling to bound cost. Avoid: SimpleSpanProcessor and 100% sampling in prod; unused instrumentations. Budget ~0.5–2ms/req, 2–5% CPU.
Sources: npm auto-instrumentations-node; base14 Fastify+pg OTel guide.

## Tenant-isolation as a paged invariant
Treat cross-tenant-blocked=100% as a hard invariant with a dedicated security signal. Enforce isolation at the query layer (mandatory tenant predicate / RLS), then continuously assert it: emit a distinct counter/log event whenever an authenticated tenant ≠ the row/resource tenant, and route any nonzero occurrence straight to an immediate page (not budget-based). Add a synthetic canary that periodically attempts a known cross-tenant access and pages if it ever succeeds. Avoid: burying breaches in aggregate error rates; burn-rate smoothing a security invariant; sampling that could drop the event.
Sources: OWASP Multi-Tenant Security cheat sheet; sre.google/workbook (invariant vs budget alerting).

## Cardinality control for tenant labels
Never use tenant_id (or request_id, license_key) as a Prometheus metric label — it multiplies every series by tenant count and grows unbounded, exhausting TSDB RAM. Keep metrics aggregate (per route/outcome); push per-tenant/per-request identity into logs and trace attributes, which are built for high cardinality. Attach exemplars (trace_id) to histograms so a slow aggregate metric links to a representative tenant trace without a tenant label. Per-tenant queryability comes from the log store, not metrics.
Sources: prometheus.io/docs/practices/naming; last9 high-cardinality guide.

## E006 instrumentation seams (grounding)
Existing to extend: health probes (`/internal/health/{live,ready,startup}`, `src/server/health/index.ts`); the validated Zod config contract + `<VAR>_FILE` secrets (`src/server/config/`), where `LOG_LEVEL` exists but is inert. Global hooks live in `src/server/app.ts` (`createApp`, the tenant-auth preHandler setting `req.tenant`); bootstrap in `src/server/main.ts`. The single DB tenant choke point is `withTenant()` in `src/server/db/client.ts` (sets `app.current_tenant` GUC + `SET LOCAL ROLE` per-tx RLS) — the natural isolation-assertion point. Gaps E012 creates: a real request-scoped structured logger (Fastify logger is currently `false`), request_id generation/propagation (no AsyncLocalStorage today), the entire metrics surface, and OTel tracing. Note: the online **validate/heartbeat** path does not exist yet (only a `validate` scope placeholder) — it is delivered by E013, so the validate-latency SLI has no handler to instrument until then.
