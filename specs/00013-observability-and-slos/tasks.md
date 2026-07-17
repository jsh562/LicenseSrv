# Tasks: Observability and SLOs

**Feature**: `00013-observability-and-slos` | **Epic**: E012 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00013-observability-and-slos/` (spec.md, plan.md, research.md, checklists/)

**Tests**: Included — the plan Testing Strategy mandates Vitest unit + @testcontainers/postgresql integration + semgrep/npm audit security + autocannon performance + a Config-artifacts tier (promtool/amtool/Grafana lint). Explicit test tasks accompany each objective.

## Project Mode

`Brownfield` — additive instrumentation over the existing E006 Fastify runtime. NO new schema, NO migration, NO API contract. The only new HTTP surface is a standard OpenMetrics `/metrics` on a dedicated internal port. All source work either creates the new cross-cutting `src/server/observability/` module or edits fixed E006 seams (`app.ts`, `main.ts`, `config/`, `db/client.ts`). Same-file edits (`app.ts`, `main.ts`, `config/index.ts`, `logger.ts`, `metrics.ts`, `alert-rules.yml`) are strictly sequential, never `[P]`.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| OBJ1 — Structured per-tenant logging + correlation | P1 🎯 MVP | pino request logger, `request_id`, redaction | One JSON line/request tagged tenant_id/request_id/product_id/outcome, per-tenant filterable, no secrets |
| OBJ2 — Metrics + SLO dashboards | P1 🎯 MVP | prom-client `/metrics`, RED+infra, recording rules, Grafana | Prometheus scrapes RED+infra; dashboard renders SLIs vs targets; no high-card labels |
| OBJ3 — Tenant-isolation paged invariant | P1 🎯 MVP | `withTenant()` assertion, security signal, immediate page, canary | Cross-tenant attempt blocked AND pages; same-tenant + canary cadence → no false page |
| OBJ4 — Distributed tracing | P2 | OTel SDK preload, app/DB/signer spans, OTLP, sampling | Traced request attributes app/DB/signer spans, trace_id↔log; Collector-down fail-open |
| OBJ5 — Burn-rate alerting + routing | P2 | multi-window burn-rate rules, Alertmanager SEV1/SEV2 | Sustained burn pages; sub-threshold blip does not; SEV1/SEV2 reach on-call |

**MVP gate**: OBJ1 + OBJ2 + OBJ3 (all P1). OBJ4 + OBJ5 are in-scope P2 (not deferred) and each lives in its own phase after the P1 phases. `[DEFERRED]` is not used in this feature.

## Brownfield Notes

- **Existing flows touched**: `src/server/app.ts` (`createApp`, tenant-auth preHandler setting `req.tenant`), `src/server/main.ts` (bootstrap), `src/server/config/index.ts` + `src/server/config/secrets.ts` (validated Zod config + `<VAR>_FILE` `readSecret`), `src/server/db/client.ts` (`withTenant()` per-tx RLS choke point). `LOG_LEVEL` already exists but is inert; the Fastify logger is currently `false`.
- **Additive-only**: no schema, no migration, no new public route. `/metrics` binds to a dedicated internal (non-public) port off the public `/v1` listener.
- **Regression focus**: telemetry is fail-open — a down Collector/Prometheus or a metrics-port bind failure MUST NOT crash or block the API (`main.ts` never throws on telemetry failure). Enabling pino changes startup output — migrate `main.ts`'s startup `log()` to pino to avoid double logging (HINT-004).
- **Validate-latency SLI is PENDING E013** — the dashboard panel/harness is provisioned but renders "pending", NOT a live SLI implemented here.

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Add prom-client, @opentelemetry/sdk-node, auto-instrumentations-node, exporter-trace-otlp-http deps + autocannon devDep in package.json
- [ ] T002 {OR-018} Add observability config keys (metricsPort, otlpEndpoint, traceSampleRatio, logFormat) + secret-free configSummary in src/server/config/index.ts → exports: AppConfig
- [ ] T003 {OR-018} Resolve OTLP/exporter secrets via `<VAR>_FILE` readSecret precedence (file wins; required-empty fails fast) in src/server/config/secrets.ts after:T002

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The `src/server/observability/` request-context + logger skeleton and the pino wiring in `app.ts` are the cross-cutting blocker every objective builds on.**

- [ ] T004 [P] {OR-002} Create request-context.ts — ALS context + server genReqId + client_request_id sanitize (≤128 ASCII) in src/server/observability/request-context.ts → exports: genReqId
- [ ] T005 [P] {OR-001} Create logger.ts base — pino from LOG_LEVEL + logFormat + base serializer in src/server/observability/logger.ts after:T002 → exports: createLogger, buildRequestLog
- [ ] T006 {OR-002} Enable pino + genReqId in `createApp` (Fastify logger false→pino, wire request-context) in src/server/app.ts after:T004,T005 ← T005:createLogger
- [ ] T007 {OR-001} Migrate main.ts startup `log()` to pino to avoid double logging (HINT-004) in src/server/main.ts after:T006

---

## Phase 3: OBJ1 — Structured per-tenant logging with request correlation (Priority: P1) 🎯 MVP

**Goal**: Exactly one structured JSON log line per request, tagged tenant_id/request_id/product_id/outcome, queryable per tenant, secrets/PII redacted, verbosity from LOG_LEVEL.

**Independent test**: An authenticated `/v1` request emits exactly one JSON line carrying the four fields (tenant_id null on pre-auth reject) with no secrets/raw PII; filtering by tenant_id returns only that tenant's lines (SC-001).

- [ ] T008 [P] [OBJ1] {OR-001} onResponse hook emits exactly one JSON line per request — all paths incl error/pre-auth/non-`/v1`, tenant_id null when unresolved in src/server/app.ts after:T006
- [ ] T009 [P] [OBJ1] {OR-004,OR-020} Redaction — secrets/headers/tokens/keys/DSNs, HMAC-hash fingerprints, fail-closed, exclude signing-key material in src/server/observability/logger.ts after:T005
- [ ] T010 [OBJ1] {OR-003} Log-field contract + tenant_id filterability (required fields, redaction rules doc) in src/server/observability/logger.ts after:T009
- [ ] T011 [P] [OBJ1] {OR-002} Record sanitized client_request_id as distinct field (never overwrites request_id; no security/metric use) in src/server/observability/request-context.ts after:T004
- [ ] T012 [P] [OBJ1] {OR-001,OR-003} [COMPLETES OR-001] Unit test — one line/request, 4 fields, tenant_id null pre-auth, per-tenant filter in src/server/observability/__tests__/logger.unit.test.ts
- [ ] T013 [P] [OBJ1] {OR-002,OR-004} [COMPLETES OR-002] Unit test — redaction, fingerprint HMAC, fail-closed, server vs client request_id in src/server/observability/__tests__/logging.unit.test.ts

---

## Phase 4: OBJ2 — Metrics and SLO dashboards for the documented SLIs (Priority: P1) 🎯 MVP

**Goal**: OpenMetrics `/metrics` on a dedicated internal port exposing RED (activation, issuance) + infra (app/DB/signer) metrics with a static bounded label set; recording rules + Grafana dashboards render the SLIs vs DOD targets.

**Independent test**: Prometheus scrapes `/metrics` and finds RED+infra series in OpenMetrics format with no tenant_id/request_id/license_key label; the SLO dashboard renders activation ≥99.9%, issuance p95 <300ms, availability 99.9% (validate panel "pending").

- [ ] T014 [OBJ2] {OR-008} Create metrics.ts — prom-client registry + STATIC label allowlist (route/outcome/method) + exemplar support in src/server/observability/metrics.ts → exports: registry
- [ ] T015 [OBJ2] {OR-006,OR-008} RED instruments (histograms, SLO buckets incl 120/300ms) + seat-contention + tamper counters in src/server/observability/metrics.ts after:T014 → exports: recordRed
- [ ] T016 [OBJ2] {OR-007,OR-020} Infra metrics — process CPU/mem, pg pool/conn stats, signer availability only (no key material) in src/server/observability/metrics.ts after:T015
- [ ] T017 [OBJ2] {OR-006} Record RED metrics per route+outcome in the onResponse hook in src/server/app.ts after:T008,T015 ← T015:recordRed
- [ ] T018 [OBJ2] {OR-005,OR-014} Dedicated internal metrics-port listener (configurable non-public bind; bind failure non-fatal/fail-open) in src/server/main.ts after:T007,T016
- [ ] T019 [P] [OBJ2] {OR-010,OR-019} SLI recording rules — good/total ratios + latency percentiles, 30-day window, DOD budgets in observability/prometheus/recording-rules.yml
- [ ] T020 [OBJ2] {OR-009,OR-019} Grafana SLO dashboards vs targets + validate-latency panel "pending" until E013 in observability/grafana/dashboards/slo-overview.json after:T019
- [ ] T021 [P] [OBJ2] {OR-008} [COMPLETES OR-008] Unit test label allowlist — no tenant_id/request_id/license_key label (SC-006) in src/server/observability/__tests__/metrics.unit.test.ts
- [ ] T022 [OBJ2] {OR-005,OR-006,OR-007} [COMPLETES OR-006] Int test — scrape RED+infra; bind-fail non-fatal in src/server/observability/__tests__/metrics.integration.test.ts after:T018
- [ ] T023 [P] [OBJ2] {OR-010,OR-019} [COMPLETES OR-019] Config test — promtool check+test recording rules + Grafana JSON lint in observability/__tests__/recording-rules.config.test.ts

---

## Phase 5: OBJ3 — Tenant-isolation paged invariant (Priority: P1) 🎯 MVP

**Goal**: Continuously assert authenticated tenant == GUC tenant at the single `withTenant()` choke point; on mismatch emit a sampling-independent security signal that pages immediately (SEV1); a synthetic canary validates the path end-to-end.

**Independent test**: A request whose authenticated tenant differs from the GUC tenant is blocked AND a page-level signal fires (SC-005); same-tenant traffic plus one full canary cadence raises no page; a canary probe failure raises the dead-man's-switch, not the isolation page.

- [ ] T024 [OBJ3] {OR-011} Assert req.tenant==GUC (no cross-tenant read); emit tenant_isolation_violation_total counter + security log in src/server/observability/isolation-assertion.ts after:T014
- [ ] T025 [OBJ3] {OR-011} Hook the assertion into withTenant() (per-tx at GUC set; assertion signals, RLS blocks) in src/server/db/client.ts after:T024
- [ ] T026 [OBJ3] {OR-012,OR-016} Isolation-page alert (no burn/for: window; fires first eval on violation>0; SEV1; ≤~1min) + canary dead-man's-switch in observability/prometheus/alert-rules.yml
- [ ] T027 [OBJ3] {OR-012} Synthetic canary — reserved synthetic tenants, cadence ~60s, pages if cross-tenant NOT blocked, probe-fail distinct in src/server/observability/canary.ts
- [ ] T028 [OBJ3] {OR-012} Wire canary startup (fail-open; distinct from breach path) in src/server/main.ts after:T018,T027
- [ ] T029 [OBJ3] {RR-001} Runbook — tenant-isolation page response (confirm via OR-011 log fields, contain, blast radius, notify) in docs/runbooks/observability/tenant-isolation-page.md
- [ ] T030 [P] [OBJ3] {OR-011} [COMPLETES OR-011] Unit test isolation — mismatch signals, same-tenant silent, no cross-tenant query in src/server/observability/__tests__/isolation.unit.test.ts
- [ ] T031 [OBJ3] {OR-012} Int test — cross-tenant blocked+pages; same-tenant no page; probe-fail→dead-man in src/server/observability/__tests__/isolation.integration.test.ts after:T025,T027
- [ ] T032 [OBJ3] {OR-012} [COMPLETES OR-012] Config test — promtool asserts isolation-page alert fires on synthetic series in observability/__tests__/isolation-rules.config.test.ts after:T026

---

## Phase 6: OBJ4 — Distributed tracing on the online path (Priority: P2)

**Goal**: OTel tracing on the online path with app/DB/signer span attribution, OTLP export to a self-hostable Collector, configurable sampling, and trace_id↔log correlation — bounded, fail-open.

**Independent test**: An activation request produces a trace attributing app/DB/signer spans (SC-007), its trace_id retrieves the correlated logs, and with the Collector unavailable request handling is unaffected (fail-open, SC-009).

- [ ] T033 [OBJ4] {OR-013} NodeSDK + auto-instr (Fastify+pg+http) + OTLP + BatchSpanProcessor; pg db.statement OFF (HINT-001 preload) in src/server/observability/tracing.ts → exports: startTracing
- [ ] T034 [OBJ4] {OR-014} Parent-based ratio sampler (configurable, default 10%) + fail-open export in src/server/observability/tracing.ts after:T033
- [ ] T035 [OBJ4] {OR-013,OR-020} Manual signer span (availability/latency/outcome only; no key/payload; exception redacted) in src/server/observability/tracing.ts after:T033
- [ ] T036 [OBJ4] {OR-013} trace_id/span_id in every log line regardless of sampling (SC-002 bridge) in src/server/observability/logger.ts after:T010,T033
- [ ] T037 [OBJ4] {OR-013,OR-014} Preload tracing via --require BEFORE app/pg/fastify import (HINT-001); telemetry failures never crash bootstrap in src/server/main.ts after:T028,T033
- [ ] T038 [P] [OBJ4] {OR-013,OR-020} [COMPLETES OR-020] Unit test — pg statement OFF, signer span no key/payload, trace_id unsampled in src/server/observability/__tests__/tracing.unit.test.ts
- [ ] T039 [OBJ4] {OR-013,OR-014} [COMPLETES OR-013] Int test — app/DB/signer spans + trace_id↔log; Collector fail-open in src/server/observability/__tests__/tracing.integration.test.ts after:T037

---

## Phase 7: OBJ5 — Multi-window burn-rate SLO alerting and routing (Priority: P2)

**Goal**: Multi-window multi-burn-rate alert rules for availability/activation-success/latency SLOs, routed through Alertmanager to on-call with SEV1/SEV2 severity and an escalation policy, all versioned in-repo.

**Independent test**: A sustained fast+slow burn pages on-call while a brief sub-threshold blip does not (SC-008); `amtool` confirms SEV1/SEV2 reach the on-call receivers and the escalation policy is present.

- [ ] T040 [OBJ5] {OR-015,OR-016} Multi-window burn-rate rules — availability/activation/latency (page 14.4x/6x; ticket 1x; SEV1/SEV2) in observability/prometheus/alert-rules.yml after:T019,T026
- [ ] T041 [OBJ5] {OR-014} [COMPLETES OR-014] Metrics-unavailability dead-man's-switch alert (target up==0) in observability/prometheus/alert-rules.yml after:T040
- [ ] T042 [OBJ5] {OR-016} [COMPLETES OR-016] Alertmanager routing — SEV1 (isolation+fast-burn), SEV2 (slow-burn), escalation 10/30min in observability/alertmanager/config.yml
- [ ] T043 [OBJ5] {OR-015,OR-016} Config test — promtool check+test burn rules (SC-008) + amtool check-config in observability/__tests__/alert-rules.config.test.ts after:T042

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T044 [P] {OR-017} Self-host stack overlay (Prometheus+Grafana+Alertmanager+OTel Collector) mounting versioned artifacts in dist-bundles/docker-compose.observability.yml
- [ ] T045 [P] {RR-002} Runbook — SLO burn response (SLI→dashboards→exemplar traces→tenant logs, mitigate) in docs/runbooks/observability/slo-burn-response.md
- [ ] T046 [P] {RR-003} Runbook — observability-stack failure (confirm API fail-open, restore telemetry) in docs/runbooks/observability/telemetry-stack-failure.md
- [ ] T047 [P] {RR-004} Runbook — latency/error diagnosis (dashboard→burn alert→exemplar trace→per-tenant logs) in docs/runbooks/observability/latency-error-diagnosis.md
- [ ] T048 [P] Performance test — autocannon instrumentation overhead vs baseline (≤~2ms p95, ≤~5% CPU; SC-010) in src/server/observability/__tests__/overhead.perf.test.ts
- [ ] T049 [P] Security test — semgrep + npm audit: no secrets/PII in any signal, metrics port not public in src/server/observability/__tests__/no-secrets.security.test.ts

---

## Dependencies

**Phase order**: Setup (Phase 1) → Foundational (Phase 2) → OBJ1 (Phase 3) → OBJ2 (Phase 4) → OBJ3 (Phase 5) → OBJ4 (Phase 6) → OBJ5 (Phase 7) → Polish (Phase 8). P1 MVP gate = OBJ1 + OBJ2 + OBJ3.

- **Setup (T001–T003)**: no dependencies. T002→T003 sequential (config/index.ts feeds the secrets.ts precedence rule).
- **Foundational (T004–T007)**: depends on Setup (config). T004, T005 are `[P]` (distinct files; T005 reads config after:T002). T006 wires both into app.ts; T007 migrates main.ts startup logging after:T006. Blocks every objective (shared logger + request context + pino).
- **OBJ1 (T008–T013)**: depends on Foundational. T008/T009/T011 are `[P]` (app.ts / logger.ts / request-context.ts distinct files); T010 follows T009 (same file). Tests T012/T013 `[P]` (distinct test files).
- **OBJ2 (T014–T023)**: depends on Foundational (config) + the OBJ1 app.ts hook (T017 after:T008). T014→T015→T016 sequential (metrics.ts). T018 metrics listener after:T007,T016. T019 recording rules `[P]`; T020 dashboards after:T019. Tests T021/T023 `[P]`; T022 after:T018.
- **OBJ3 (T024–T032)**: depends on Foundational + the OBJ2 metrics registry (T024 after:T014). T024→T025 (assertion→withTenant hook). T026 alert rule + T027 canary; T028 wires canary after:T018,T027. T030 `[P]`; T031 after:T025,T027; T032 after:T026.
- **OBJ4 (T033–T039, P2)**: depends on Foundational + OBJ1 logger (T036 after:T010) + OBJ3 canary wiring (T037 after:T028, shared main.ts). T033→T034/T035 (tracing.ts). T038 `[P]`; T039 after:T037. In-scope P2, not deferred.
- **OBJ5 (T040–T043, P2)**: depends on OBJ2 recording rules + OBJ3 alert-rules.yml (T040 after:T019,T026, shared file). T041 after:T040; T042 routing; T043 after:T042. In-scope P2, not deferred.
- **Polish (T044–T049)**: depends on all objectives complete. T044 overlay bundles OBJ2/OBJ3/OBJ5 artifacts; runbooks T045–T047 `[P]`; T048 autocannon overhead (SC-010) needs the full instrumented app; T049 security scan spans all signals.

**Parallel-safety**: no `[P]` task shares a batch with a task it references via `after:` or `←`. Same-file edits are strictly sequential across phases via `after:` edges — `app.ts` (T006, T008, T017), `main.ts` (T007, T018, T028, T037), `config/index.ts` (T002), `logger.ts` (T005, T009, T010, T036), `metrics.ts` (T014, T015, T016), `alert-rules.yml` (T026, T040, T041). Each config-artifact test uses a distinct file (T023/T032/T043) to avoid contention.

## Delivery Notes

- **Cross-cutting requirements**: OR-020 (signing-key exclusion) spans OBJ1 logger (T009), OBJ2 signer metric (T016), and OBJ4 signer span (T035), completing at the OBJ4 test T038. OR-014 (fail-open) spans the OBJ2 metrics-listener (T018), OBJ4 sampling/export (T034) + preload (T037), and the metrics-unavailability `up==0` alert (T041) where it completes. OR-016 (SEV1/SEV2) spans the isolation SEV1 label (T026), burn-rate labels (T040), and Alertmanager routing (T042) where it completes.
- **Runbook placement**: RR-001 (isolation page) ships inside OBJ3 (T029) because it acts on exactly the OR-011 signal and is P1-critical; RR-002/003/004 are cross-cutting and land in Polish (T045–T047).
- **Validate-latency SLI**: provisioned only as a "pending" Grafana panel (T020) — NOT a live SLI; it activates when E013 ships the validate/heartbeat handler (IP-003).
- **Fail-open discipline**: T018, T034, T037, T039 collectively guarantee a down Collector/Prometheus or a metrics-port bind failure never crashes or blocks the API; fail-open never suppresses the tenant-isolation page (T024/T026 emit via a sampling/OTLP-independent path).
- **Config-artifacts tier**: promtool (T023 recording, T032 isolation, T043 burn-rate), amtool (T043), and Grafana JSON lint (T023) validate operator artifacts under `observability/` without a live pager (these fall outside line-coverage scope).

## Requirement Coverage

| Req | Tasks | Req | Tasks |
|-----|-------|-----|-------|
| OR-001 | T005, T007, T008, T012 (C) | OR-011 | T024, T025, T030 (C) |
| OR-002 | T004, T006, T011, T013 (C) | OR-012 | T026, T027, T028, T031, T032 (C) |
| OR-003 | T010, T012 | OR-013 | T033, T035, T036, T037, T038, T039 (C) |
| OR-004 | T009, T013 | OR-014 | T018, T034, T037, T039, T041 (C) |
| OR-005 | T018, T022 | OR-015 | T040, T043 |
| OR-006 | T015, T017, T022 (C) | OR-016 | T026, T040, T042 (C) |
| OR-007 | T016, T022 | OR-017 | T044 |
| OR-008 | T014, T015, T021 (C) | OR-018 | T002, T003 |
| OR-009 | T020 | OR-019 | T019, T020, T023 (C) |
| OR-010 | T019, T023 | OR-020 | T009, T016, T035, T038 (C) |
| RR-001 | T029 | RR-003 | T046 |
| RR-002 | T045 | RR-004 | T047 |

`(C)` = task carrying `[COMPLETES OR-###]`. Success-criteria mapping: SC-001→T012, SC-002→T036, SC-003→T022, SC-004→T020, SC-005→T031, SC-006→T021, SC-007→T039, SC-008→T043, SC-009→T039, SC-010→T048.
