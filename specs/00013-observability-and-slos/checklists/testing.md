# Testing Quality Checklist: Observability and SLOs
**Created**: 2026-07-17 | **Feature**: [spec.md](../spec.md)

## Verification-Criteria Completeness

- [X] CHK001 Does every operational objective (OBJ1-OBJ5) carry at least one verification criterion whose Given/When/Then is independently testable? [Completeness, Spec §Operational Objectives] <!-- Evaluator: Covered by spec.md §Operational Objectives — OBJ1-OBJ5 each carry independently-testable Given/When/Then VCs -->

- [X] CHK002 Is there a verification criterion covering the OBJ1 deliverable "documented log-field contract" (required fields + redaction rules), or is the contract asserted only implicitly by VC1? [Completeness, Spec §OBJ1] <!-- Evaluator: Covered by spec.md OBJ1 VC1 + SC-001 (required fields present, no secrets/PII) + OR-004 (per-field redaction rule set) -->

- [X] CHK003 Does success criterion SC-006 (no tenant_id/request_id/license_key as a metric label) trace to an objective verification criterion that inspects labels, rather than resting only on the OR-008 constraint? [Traceability, Spec §SC-006 / OR-008] <!-- Evaluator: Resolved — added OBJ2 VC4 that inspects the emitted metric label sets, giving SC-006 an objective-level verification criterion -->

- [X] CHK004 Are acceptance/verification criteria defined for the Runbook Requirements RR-001..RR-004 (what makes a runbook complete/valid), or do they only assert existence? [Completeness, Spec §Runbook Requirements] <!-- Evaluator: Covered by spec.md RR-001..RR-004 — each enumerates the required content/flow (RR-001 binds to the OR-011 signal + log fields), defining completeness beyond mere existence -->

- [X] CHK005 Is each verification criterion phrased with an observable, asserted outcome (not "works"/"correctly") so a reviewer can confirm it is testable? [Clarity, Spec §Operational Objectives] <!-- Evaluator: Covered by spec.md §Operational Objectives — every VC asserts an observable outcome (one line emitted, blocked + page fires, renders against target); no "works/correctly" vagueness -->

- [X] CHK006 Does every operational requirement OR-001..OR-018 map to at least one verification or success criterion so no requirement is left untested? [Traceability, Spec §Requirements] <!-- Evaluator: Covered — OR-001..OR-016 each map to a VC/SC (SC-001..009 + OBJ VCs); OR-017 (overlay) and OR-018 (config keys) are structural deliverables verified via plan Requirement Coverage Map + Testing Strategy (config unit tests, overlay integration) -->


## SLI Measurability

- [X] CHK007 Is the "good vs total" definition for activation success rate specified (which request outcomes count as success/failure) so the ≥99.9% SLI can be asserted deterministically? [Measurability, Spec §OR-010 / SC-004] <!-- Evaluator: Covered by spec.md OR-019 — activation success = successful activations over total activation attempts excluding policy denials -->

- [X] CHK008 Is the issuance-latency SLI's measurement method fully specified (percentile = p95, per-route scope, histogram buckets) so the <300ms target is testable? [Measurability, Spec §OR-006 / SC-004] <!-- Evaluator: Covered by spec.md OR-019 (p95 of issuance duration histogram) + OR-006 (bucket boundaries include 120ms and 300ms) -->

- [X] CHK009 Is the availability SLI's numerator/denominator defined (which requests count, how errors are classified) so 99.9% is measurable and not ambiguous? [Ambiguity, Spec §SC-004] <!-- Evaluator: Covered by spec.md OR-019 — availability = good (non-error) responses over total, measured from real traffic plus synthetic probes -->

- [X] CHK010 Is the evaluation window / time period for each SLI and its error budget defined so burn and compliance can be computed and asserted? [Measurability, Spec §OR-010 / §Glossary] <!-- Evaluator: Covered by spec.md OR-019 — rolling 30-day window with quantified per-SLO error budgets (0.1% ~43.8 min/month etc.) -->

- [X] CHK011 For the validate-latency SLI, is the "pending data" state defined as a distinguishable, assertable panel condition (vs. a breach or an empty series)? [Measurability, Spec §OBJ2 VC3 / OR-009] <!-- Evaluator: Covered by spec.md OBJ2 VC3 + OR-009 — panel renders "pending data" rather than a breach until E013 -->

- [X] CHK012 Are the SLI recording rules (OR-010) specified in enough detail that their output can be verified against expected good/total ratios and latency percentiles? [Completeness, Spec §OR-010] <!-- Evaluator: Covered by spec.md OR-010 + OR-019 (good/total classification, percentiles, 30-day window) + OR-006 (histogram buckets) -->


## Edge-Case Coverage

- [X] CHK013 Is fail-open under a down Collector/Prometheus stated as a measurable criterion (request error rate unchanged AND no crash), with a defined baseline to compare against? [Coverage, Spec §SC-009 / OBJ4 VC3] <!-- Evaluator: Covered by spec.md SC-009 / OBJ4 VC3 — request error rate does not increase (vs pre-outage baseline) AND API does not crash -->

- [X] CHK014 Is a metrics-port bind failure captured as a spec-level requirement or verification criterion (non-fatal to the API), or does it appear only in plan.md error handling? [Coverage, Spec §Edge Cases / plan Error Handling] <!-- Evaluator: Resolved — captured as spec-level requirement in OR-014 (non-fatal + up==0 alert) and added OBJ2 VC5 making it verifiable -->

- [X] CHK015 Is there a verification criterion that inspects the emitted metric label sets to prove tenant_id/request_id/license_key never appear as labels (the cardinality guard)? [Coverage, Spec §OR-008 / SC-006] <!-- Evaluator: Resolved — added OBJ2 VC4 that inspects the label set of every exposed /metrics series -->

- [X] CHK016 Does the synthetic isolation canary have verification criteria for both the positive path (blocked + page fires) and the negative path (same-tenant traffic → no false-positive page)? [Coverage, Spec §OBJ3 VC2-VC3] <!-- Evaluator: Covered by spec.md OBJ3 VC2 (positive: blocked + alert path exercised) and VC3 (negative: same-tenant → no page) -->

- [X] CHK017 Is the canary's own failure mode specified (what is asserted if the canary cannot run or cannot reach the alert path)? [Completeness, Spec §OR-012] <!-- Evaluator: Resolved — OR-012 specifies distinct classification of canary failure; added OBJ3 VC4 (no isolation page + lower-severity dead-man's-switch alert) -->

- [X] CHK018 Is the validate-SLI-pending edge case (OBJ2 VC3) traceable to the E013 dependency so a reviewer can confirm the "pending" behavior is required until E013 lands? [Traceability, Spec §OBJ2 / IP-003] <!-- Evaluator: Covered by spec.md IP-003 + OR-009 + OR-019 + Scope-Excluded — "pending" panel explicitly tied to E013 -->

- [X] CHK019 Is the client-supplied correlation header edge case (recorded as a non-authoritative tag, never trusted) backed by a verification criterion distinguishing it from the server-generated request_id? [Coverage, Spec §OR-002 / §Edge Cases] <!-- Evaluator: Resolved — added OBJ1 VC4 (sanitized value under distinct client_request_id, drives no security/routing decision, never a metric label) -->

- [X] CHK020 Is secret/PII redaction across logs, metrics, traces AND the /metrics surface each individually verifiable (which fields redacted vs. hashed), rather than a single blanket statement? [Coverage, Spec §OR-004 / OR-005] <!-- Evaluator: Covered by spec.md OR-004 (enumerated redact-vs-hash field set applied across all signal types + error/exception payloads) + OR-005/OR-013/OR-020 -->


## Overhead / Performance-Budget Verification

- [X] CHK021 Is the observability overhead budget quantified in the spec (numeric latency + CPU bound) rather than only "bounded", so it is testable? [Measurability, Spec §Operational Constraints / plan Performance Goals] <!-- Evaluator: Resolved — quantified budget (≤ ~2 ms p95 added latency, ≤ ~5% CPU) in spec §Operational Constraints and §Edge Cases -->

- [X] CHK022 Is there a success or verification criterion for the overhead budget (none of SC-001..SC-009 currently measures instrumentation overhead)? [Completeness, Spec §Success Criteria] <!-- Evaluator: Resolved — added SC-010 [OBJ2, OBJ4] measuring instrumentation overhead against the budget -->

- [X] CHK023 Is the overhead measurement method defined (baseline vs. instrumented, p95, sample rate held constant) so the budget can be asserted reproducibly? [Measurability, Spec §Operational Constraints] <!-- Evaluator: Resolved — SC-010 defines baseline-vs-instrumented p95 latency/CPU delta at the default (held-constant) sample rate; plan Testing Strategy Performance tier -->

- [X] CHK024 Is trace-sampling backpressure behaviour specified with an observable outcome (sample rate lowered, requests never blocked) so it can be verified? [Measurability, Spec §OR-014 / plan Error Handling] <!-- Evaluator: Covered by plan Error Handling (overhead breach → lower sample rate; never block a request) + Testing Strategy Performance ("sampling backpressure holds") -->


## Coverage Gate Scope

- [X] CHK025 Is the ≥80% coverage gate's scope unambiguously bounded (which paths under src/server/observability/*) and traceable to a project coverage mandate? [Clarity, plan Testing Strategy] <!-- Evaluator: Covered — scoped to new src/server/observability/* and now cites project-instructions Coverage Target 80% / DOD CI in plan Testing Strategy -->

- [X] CHK026 Are non-unit-testable operator artifacts (Grafana dashboards, Prometheus/Alertmanager YAML) explicitly excluded from or otherwise addressed by the coverage-gate scope? [Consistency, plan Testing Strategy] <!-- Evaluator: Resolved — plan Testing Strategy now states operator config artifacts under observability/ fall outside line-coverage scope and adds a Config-artifacts validation tier -->

- [X] CHK027 Is a validation approach defined for the versioned config artifacts (dashboards/rules/routing) so their correctness is checkable even though they fall outside line-coverage? [Coverage, plan AD-006] <!-- Evaluator: Resolved — added plan Config-artifacts test tier: promtool check/test rules, amtool check-config, Grafana JSON lint -->


## Tenant-Isolation Page Testability

- [X] CHK028 Is "immediate page" quantified (fires on first occurrence, never burn-rate smoothed) so the page's timeliness is assertable rather than vague? [Ambiguity, Spec §OR-012 / OBJ3 VC1] <!-- Evaluator: Covered by spec.md OR-012 — no burn-rate/for: window, fires on first evaluation cycle, detection-to-page ≤ ~1 min -->

- [X] CHK029 Is the end-to-end isolation alert path testable without a live pager (e.g., asserting alert-rule fire / routing), and is that seam identified? [Measurability, Spec §OBJ3 VC1 / SC-005] <!-- Evaluator: Resolved — plan Config-artifacts tier identifies the seam: promtool test rules assert isolation-page expression fires on synthetic series and amtool check-config asserts routing, without a live pager -->

- [X] CHK030 Is the property "the isolation assertion performs no cross-tenant read" stated as a verifiable requirement that a test can assert? [Coverage, Spec §Edge Cases / OR-011] <!-- Evaluator: Covered by spec.md OR-011 (compares two in-memory tenant identities without querying another tenant's rows) + HINT-003 -->

- [X] CHK031 Is the no-false-positive criterion (VC3) bounded by a defined traffic volume or duration so "no page fires" becomes a testable assertion? [Measurability, Spec §OBJ3 VC3] <!-- Evaluator: Resolved — OR-012 now bounds the assertion to a defined same-tenant request volume plus ≥1 full canary cadence cycle -->


## Consistency & Traceability

- [X] CHK032 Are the SLO target values consistent between the spec (SC-004: ≥99.9%, <300ms, 99.9%) and the {DOD:DDR-2} SLI/SLO table referenced by IP-004? [Consistency, Spec §SC-004 / IP-004] <!-- Evaluator: Covered — verified against dod.md §SLI/SLO: availability 99.9%, activation ≥99.9%, issuance p95 <300ms, validate <120/<300ms all match SC-004/OR-019 -->

- [X] CHK033 Are the burn-rate window/threshold values (only in plan AD-005) reconcilable with the spec's OBJ5 "fast+slow threshold" so the alerting criterion is testable? [Consistency, Spec §OBJ5 / plan AD-005] <!-- Evaluator: Covered — plan AD-005 (14.4x@1h/5m + 6x@6h/30m page; 1x@3d/6h ticket) implements spec OBJ5/OR-015 fast+slow burn -->

- [X] CHK034 Is the SEV1/SEV2 escalation-policy window (OBJ5 VC3 "policy window") defined with a concrete duration so escalation can be verified? [Measurability, Spec §OBJ5 VC3 / OR-016] <!-- Evaluator: Covered by spec.md OR-016 — SEV1 auto-escalates if unacked within 10 min; SEV2 escalates to lead ~30 min (matches DOD) -->

- [X] CHK035 Are the log field-name and outcome vocabularies (tenant_id, request_id, product_id, outcome) defined consistently across the logging requirements so log-query assertions are unambiguous? [Consistency, Spec §OR-001 / OBJ1] <!-- Evaluator: Covered — tenant_id/request_id/product_id/outcome used consistently across OR-001, OR-002, OBJ1 VCs, SC-001 -->

- [X] CHK036 Is the "exactly one log line per request" requirement testable across edge conditions (errors, early auth rejections, health probes) so the count assertion is unambiguous? [Ambiguity, Spec §OR-001 / OBJ1 VC1] <!-- Evaluator: Covered by spec.md OR-001 — exactly one line for error paths, early auth rejections, and non-/v1 (incl. health) requests; tenant_id null pre-auth, never omitted/duplicated -->

- [X] CHK037 Is the log↔trace correlation criterion (SC-002) measurable via a defined shared field (trace_id in the log) for both sampled and unsampled requests? [Measurability, Spec §SC-002 / OR-014] <!-- Evaluator: Resolved — OR-013 now requires trace_id in every log line regardless of the sampling decision, making SC-002 assertable for sampled and unsampled requests -->

