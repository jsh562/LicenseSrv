# Requirements Quality Checklist: Observability and SLOs
**Created**: 2026-07-17 | **Feature**: [spec.md](../spec.md)

## SLI/SLO Definition Completeness

- [X] CHK001 Is a numeric SLO target stated for every SLI named in OR-009 (activation success, issuance p95 latency, availability)? [Completeness, Spec OR-009/SC-004] <!-- Evaluator: Covered by spec.md SC-004 + OBJ2 VC2 (≥99.9% / <300 ms / 99.9%) -->>
- [X] CHK002 Is the measurement/evaluation window specified for each SLO (e.g., rolling 30-day) so error-budget math is reproducible? [Measurability, Spec OR-010/OR-015] <!-- Evaluator: Resolved — added OR-019 (rolling 30-day SLO window sourced from {DOD:DDR-2}) to spec.md -->>
- [X] CHK003 Are "activation success" and "control-plane availability" each defined precisely enough to classify a request outcome as good vs. failed, rather than left implicit? [Ambiguity, Spec OR-006/OR-009] <!-- Evaluator: Resolved — OR-019 defines activation good/total (excl. policy denials) and availability (non-error over total) per {DOD:DDR-2} -->>
- [X] CHK004 Does every SLI have a stated good/total (or percentile) computation that the recording rules are required to implement? [Measurability, Spec OR-010] <!-- Evaluator: Covered by spec.md OR-010 (good/total ratios + latency percentiles) reinforced by new OR-019 -->>
- [X] CHK005 Is the per-SLO error budget quantified rather than only defined generically in the glossary? [Completeness, Spec Glossary/OR-015] <!-- Evaluator: Resolved — OR-019 quantifies per-SLO budgets (availability 0.1%/~43.8 min/month, activation 0.1%, isolation 0) from the DOD table -->>

## Logging Requirement Coverage

- [X] CHK006 Is the log-field contract fully enumerated (all mandatory fields, types, and naming) rather than described by example? [Completeness, Spec OR-001/OBJ1] <!-- Evaluator: Covered by spec.md OR-001 (fields named, not by example) + OBJ1 deliverable "documented log-field contract" + SC-002 trace_id -->>
- [X] CHK007 Is "exactly one log line per request" unambiguous for error paths, early auth rejections, and non-`/v1` requests? [Ambiguity, Spec OR-001/SC-001] <!-- Evaluator: Resolved — OR-001 amended: one line via the response hook for every HTTP request (error/pre-auth/non-/v1), tenant_id null when unresolved -->>
- [X] CHK008 Is the redaction rule set enumerated per field (API keys/license keys redacted, fingerprints hashed) rather than stated generally? [Completeness, Spec OR-004] <!-- Evaluator: Resolved — OR-004 extended so the per-field redaction set spans logs, metrics, traces, and the /metrics surface (matching Edge Cases) -->>
- [X] CHK009 Is the `LOG_LEVEL`-driven verbosity behavior specified (permitted levels and a default)? [Clarity, Spec OR-004/OR-018] <!-- Evaluator: Resolved — OR-004 now names pino levels (trace|debug|info|warn|error|fatal) and default info, grounded in ADR-0009 -->>
- [X] CHK010 Is per-tenant log queryability stated as a testable requirement (filtering by tenant returns only that tenant's lines)? [Measurability, Spec OR-003/SC-001] <!-- Evaluator: Covered by spec.md OR-003 + OBJ1 VC2 (filter by tenant_id returns only that tenant's lines) -->>

## Metrics Requirement Coverage

- [X] CHK011 Are the RED metrics enumerated for each named path (activation, issuance) with rate, error, and duration each required? [Completeness, Spec OR-006] <!-- Evaluator: Covered by spec.md OR-006 (rate + error + latency histograms for activation and issuance) -->>
- [X] CHK012 Are the seat-contention and failed-validation/tamper counters defined with explicit increment conditions? [Clarity, Spec OR-006] <!-- Evaluator: Resolved — OR-006 states increment conditions (seat-limit contention denial; token signature/tamper validation failure) -->>
- [X] CHK013 Are the infrastructure metrics enumerated (process CPU/memory, DB pool/connections, signer availability) with a source for each? [Completeness, Spec OR-007] <!-- Evaluator: Covered by spec.md OR-007 + ADR-0009 §Decision.2 (prom-client process, pg-pool, signer-availability gauges) + plan metrics.ts -->>
- [X] CHK014 Are latency histogram bucket boundaries specified so the p95 <300ms target is computable from the metric? [Measurability, Spec OR-006/OR-010] <!-- Evaluator: Resolved — OR-006 requires bucket boundaries to include the SLO thresholds (120 ms, 300 ms) so p95/p99 are computable -->>
- [X] CHK015 Is the OpenMetrics/Prometheus exposition contract required unambiguously (single endpoint, content type)? [Clarity, Spec OR-005/SC-003] <!-- Evaluator: Covered by plan §API Surface (GET /metrics dedicated port, text/plain OpenMetrics) + SC-003 -->>

## Tracing & Log-Trace Correlation

- [X] CHK016 Is span attribution scope defined for app, DB (pg), and the signer (manual span) rather than left open? [Completeness, Spec OR-013/OBJ4] <!-- Evaluator: Covered by spec.md OR-013 + OBJ4 deliverable (Fastify+pg+http auto-instrumentation + manual signer span) -->>
- [X] CHK017 Is the log-to-trace correlation mechanism specified as a MUST (trace_id embedded in the log line)? [Completeness, Spec SC-002/OR-013] <!-- Evaluator: Covered by spec.md OR-013 (MUST correlate to logs by trace id) + SC-002 + OBJ1 VC3 -->>
- [X] CHK018 Are `request_id` (business correlation) and `trace_id` (per-request) distinguished so each is required consistently across logs and traces? [Consistency, Spec OR-002/research] <!-- Evaluator: Covered by spec.md OR-002 + Glossary(request_id) + research §per-tenant logging + ADR-0009 §Decision.4 -->>
- [X] CHK019 Is the client-supplied correlation header's non-authoritative handling stated unambiguously (recorded as a tag, never trusted for security decisions)? [Ambiguity, Spec OR-002/Edge Cases] <!-- Evaluator: Covered by spec.md OR-002 + Edge Cases + AD-002 (non-authoritative tag, server-side request_id, never trusted for security) -->>
- [X] CHK020 Is the trace-sampling requirement stated as configurable with a stated default rate? [Clarity, Spec OR-014/AD-007] <!-- Evaluator: Resolved — OR-014 states a default (parent-based ratio, 10%), operator-configurable, grounded in AD-007 + overhead budget -->>

## Metric Label-Cardinality Constraints

- [X] CHK021 Is the forbidden-label set explicitly enumerated (`tenant_id`, `request_id`, `license_key`) as a MUST-NOT on all metrics? [Completeness, Spec OR-008/SC-006] <!-- Evaluator: Covered by spec.md OR-008 (MUST NOT) + SC-006 + Constraints + ADR-0009 §Decision.5 -->>
- [X] CHK022 Is the exemplar drill-down obligation stated at consistent strength between OR-008 (SHOULD) and the operational constraints? [Consistency, Spec OR-008/Constraints] <!-- Evaluator: Covered — OR-008 SHOULD and the Constraints "bridged by exemplars" are consistent (constraint describes the SHOULD-level mechanism, no contradictory strength); ADR-0009 §Decision.2/.5 corroborates -->>
- [X] CHK023 Is a verification method for the cardinality invariant defined (label allowlist review / inspection) rather than assumed? [Measurability, Spec SC-006/Risks] <!-- Evaluator: Covered by spec.md Risks (label-allowlist review) + plan §Testing (unit test asserts no forbidden labels) + §Risk Mitigation -->>

## Dashboards & Recording Rules

- [X] CHK024 Are recording-rule requirements defined for every SLI that backs a dashboard panel or an alert? [Completeness, Spec OR-009/OR-010] <!-- Evaluator: Covered by spec.md OR-010 (recording rules back the dashboards and alerts) + new OR-019 SLI definitions -->>
- [X] CHK025 Is a dashboard panel required for each live SLI plus the provisioned validate panel, and is "render against SLO target" defined rather than left to interpretation? [Coverage, Spec OR-009/SC-004] <!-- Evaluator: Covered by spec.md OR-009 (panels per SLI + validate pending panel) + SC-004/OBJ2 VC2 (render against target values) -->>
- [X] CHK026 Are dashboards and rules unambiguously required as versioned in-repo artifacts? [Consistency, Spec OR-009/OR-016] <!-- Evaluator: Covered by spec.md OR-016 + Scope + OBJ2 deliverable + AD-006 + Assumptions (versioned in-repo config) -->>

## Alerting, Paging & Escalation

- [X] CHK027 Is the multi-window burn-rate table (windows plus burn-rate thresholds, page vs. ticket tiers) specified or traceably referenced? [Measurability, Spec OR-015/AD-005] <!-- Evaluator: Covered by plan AD-005 (page 14.4x@1h/5m + 6x@6h/30m; ticket 1x@3d/6h) + research §burn-rate + OR-015 -->>
- [X] CHK028 Does the set of SLOs covered by burn-rate alerts (availability, activation-success, latency) match the dashboarded SLIs? [Coverage, Spec OR-015/OR-009] <!-- Evaluator: Covered — OR-015 SLOs {availability, activation-success, latency} match OR-009 dashboarded SLIs (validate pending E013) -->>
- [X] CHK029 Is SEV1/SEV2 severity assignment defined per alert type, and is the escalation-policy window quantified? [Completeness, Spec OR-016/OBJ5] <!-- Evaluator: Resolved — OR-016 maps severities per alert type and quantifies windows (SEV1 10 min, SEV2 ~30 min) per {DOD:DDR-2} -->>
- [X] CHK030 Is the tenant-isolation page consistently required as immediate (never burn-rate smoothed) across OR-012 and the constraints? [Consistency, Spec OR-012/Constraints] <!-- Evaluator: Covered by spec.md OR-012 + Constraints + OBJ3 + AD-004 (immediate page, never burn-rate smoothed), consistent throughout -->>
- [X] CHK031 Is the synthetic canary's behavior specified (cadence, pages only if a cross-tenant attempt succeeds, no false positives on same-tenant traffic)? [Clarity, Spec OR-012/OBJ3] <!-- Evaluator: Resolved — OR-012 now states a configurable cadence (default ~60 s); pages-only-on-success and no-same-tenant-false-positives were already in OBJ3 -->>

## Fail-Open & Overhead Budget

- [X] CHK032 Is "fail-open" defined with a testable outcome (error rate unchanged, API does not crash) for each backend (Collector/Prometheus/Grafana)? [Measurability, Spec OR-014/SC-009] <!-- Evaluator: Covered by spec.md SC-009 + Edge Cases (down Collector/Prometheus/Grafana → error rate unchanged, no crash) + OR-014 -->>
- [X] CHK033 Does fail-open coverage extend beyond export to the metrics-port bind failure? [Coverage, Spec OR-014/plan §Error Handling] <!-- Evaluator: Resolved — OR-014 extended to the metrics-port bind failure and to guaranteeing the isolation security signal is never dropped by sampling/batched export -->>
- [X] CHK034 Is the observability overhead budget quantified (latency/CPU) so sampling and fail-open can be validated against it? [Measurability, Spec Constraints/plan §Technical Context] <!-- Evaluator: Covered by plan §Technical Context (added latency ≤ ~2 ms p95, ≤ ~5% CPU) + plan §Testing (autocannon validates against that budget) + ADR-0009 -->>

## Validate-Latency / E013 Boundary

- [X] CHK035 Is the validate panel's "pending" state defined distinctly from a breach state so it cannot be misread as an SLO violation? [Ambiguity, Spec OR-009/Edge Cases] <!-- Evaluator: Covered by spec.md OR-009 + Edge Cases + OBJ2 VC3 ("pending data" rendered distinctly, not a breach) -->>
- [X] CHK036 Is the E013 hand-off documented (harness ready now; the condition that activates the validate SLI when the handler ships)? [Traceability, Spec OR-009/IP-003] <!-- Evaluator: Covered by spec.md IP-003 + Scope Excluded (harness now; SLI activates when E013 ships the /v1 validate handler) -->>

## Config, Access Control & Traceability

- [X] CHK037 Are the observability config keys enumerated (metrics port, OTLP endpoint, sampling rate, log format) with the `<VAR>_FILE` convention for exporter secrets? [Completeness, Spec OR-018] <!-- Evaluator: Covered by spec.md OR-018 (keys enumerated + <VAR>_FILE for exporter secrets) + NEW-CONFIG signal -->>
- [X] CHK038 Is the `/metrics` access-control requirement unambiguous (is access-control OR a non-public port sufficient, or are both required)? [Ambiguity, Spec OR-005/AD-001] <!-- Evaluator: Resolved — OR-005 reconciled to the dedicated internal non-public port per {SAD:ADR-0009}/AD-001 (authoritative) -->>
- [X] CHK039 Do the spec's SLO targets trace to the DOD SLI/SLO source table ({DOD:DDR-2})? [Traceability, Spec IP-004/SC-004] <!-- Evaluator: Covered by spec.md IP-004 + frontmatter epic_sources {DOD:DDR-2} + SC-004/new OR-019 targets match the DOD SLI/SLO table -->>
- [X] CHK040 Is a runbook required for each named operational failure mode (isolation page, SLO burn, stack failure, diagnosis flow)? [Coverage, Spec RR-001..RR-004] <!-- Evaluator: Covered by spec.md RR-001 (isolation page), RR-002 (SLO burn), RR-003 (stack failure), RR-004 (log/trace diagnosis) -->>
