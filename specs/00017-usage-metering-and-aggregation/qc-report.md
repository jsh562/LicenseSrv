# QC Report — E016 Usage Metering & Aggregation

**Feature**: `00017-usage-metering-and-aggregation` | **Epic**: E016 | **Date**: 2026-07-24
**Overall Verdict**: **PASS**

Delegated QC: `sddp-qc-auditor` (PASS) + `sddp-story-verifier` (PASS after iteration-2 gap closure). Reached PASS after two fix iterations inside the loop (one enforced-gate blocker + three spec-vs-implementation gaps the task decomposition under-covered). Final state: 0 test failures, 0 lint/type errors, 0 prod-audit high/critical, enforced coverage gate met, no project-instructions violation.

## Test Results
- Runner: Vitest 2 (v8 coverage), real Postgres via @testcontainers/postgresql.
- Enforced full-suite gate `npm run test:cov` — **exit 0**: **128 files passed / 1 skipped; 807 tests passed / 9 skipped / 0 failed** (1089s with coverage).
- Usage suite (`npx vitest run src/server/modules/usage src/server/modules/catalog`) — **23 files / 142 tests passed** (incl. the parallel-producer dedupe race and the iteration-2 additions).
- All 9 skips are env-gated/CI-only (Docker image smoke + observability config-rule skips) — no usage test skipped.

## Static Analysis
- `npm run build` (tsc) exit 0; `npm run typecheck` (strict + noUncheckedIndexedAccess) 0 errors; `npm run lint` (eslint, module-boundary rule) 0 issues — the new `usage` module respects the cross-module-boundary rule (only the metered-entitlement definition touches E007 catalog).

## Security Audit
- `npm audit --omit=dev` — **0 vulnerabilities**. Iteration 2 cleared 1 pre-existing HIGH transitive advisory (brace-expansion via OpenTelemetry) with `npm audit fix` (semver-safe, no `--force`; brace-expansion 2.1.2→2.1.4), zero regression. The usage module adds **no new production dependency**.
- `secret-leakage.test.ts` (4 tests) — no secret / API key / signing key, no card/PAN, and no PII beyond license/entitlement/dimension refs appears in any response body, log line (in-memory pino capture), or audit entry; the dimension allow-list rejects (never drops) non-scalar/oversized/bad-key dimensions and rejection messages never echo the smuggled value (SC-013).
- Semgrep (SAST): SKIPPED → CI-gated (not installed locally; runs in `.github/workflows/usage.yml`).

## PI Compliance
No violations.
- **Principle I (offline-first / key never exposed)**: metering is an ONLINE control-plane feature with no offline-verification path and NO new crypto / no signer; FR-019 forbids exposing any secret/API key/signing key (verified by secret-leakage).
- **Principle II (tenant isolation + RBAC)**: `usage_event`/`usage_rollup`/`usage_unique_value` forced-RLS; ingest behind the new least-privilege `usage.ingest` scope, fail-closed on a non-active license (FR-021); operator query behind console RBAC with the raw true-net bounded to admin/E014 (SC-019); cross-tenant → 404 / per-event not_found; unset-GUC → 0 rows on all three tables (SC-012).
- **Principle III (single security core + append-only audit)**: append-only `usage_event` (SELECT/INSERT grants only, prune/erase on owner role); append-only audit of ingest/definition/over-quota/reversal/prune with rollup+prune workers attributed to a synthetic system actor (FR-018, SC-021).
- **PII minimization**: dimension allow-list schema; GDPR erase across all three usage tables (FR-016, SC-013).
- **Anti-replay + idempotency + rate limiting**: UNIQUE `(tenant, source, event_id)` + batch `INSERT ON CONFLICT DO NOTHING RETURNING` → exactly-once, proven under genuine parallel producers (SC-001/015); per-key rate limit + 429 + Retry-After + batch cap (FR-005).
- **Payment/billing boundary**: metering computes NO money; the aggregate is read-only to E014 true-up (the TRUE signed net, not the floored display); no card/PAN (FR-020).

## Requirements Traceability (Story Verifier)
Per-story: **US1 PASS, US2 PASS, US3 PASS, US4 PASS, US5 PASS, US6 PASS**. All FR-001..FR-021 met; all SC-001..SC-021 met — each traced to implementing code + ≥1 passing test.

Highlights: exactly-once dedupe under 24 parallel producers (SC-001/015); watermark RECOMPUTE-from-raw rollup → idempotent re-run yields identical aggregate + late-event bucket re-open (SC-004/007); reference-free signed reversals with true-net stored / floor-at-zero display / per-aggregation semantics (SC-008/017); viewer floored vs admin/E014 raw-net with viewer raw→403 (SC-019); quota signal-only with derived-flag-clear + retained crossing audit (SC-009); event-timestamp retention bound, closed-bucket-only prune, rollup survives, UNIQUE_COUNT final pre-prune (SC-010/020); metered-entitlement definition + freeze-on-usage (SC-005/006).

## Loop History (iterations to PASS — full transparency)
1. **Iteration 1** — implemented all 45 tasks; the engine (idempotent ingest, watermark rollup, reversals, quota, retention/GDPR, RLS, PII) passed a 130-test suite. QC found: (a) **`npm audit` 1 HIGH** (pre-existing transitive OTel dep) reddening the usage CI gate; (b) **US3 metered-entitlement definition was repo-layer only** — the HTTP catalog route rejected `type:metered`, so an operator could not define a meter through the product (a spec-vs-tasks under-coverage); (c) **US2 app-facing aggregate read** was absent (NEW-API "operator console + app", FR-020 app self-read); (d) **UNIQUE_COUNT window semantics** (sum of per-hour distinct counts) were undocumented/untested.
2. **Iteration 2** — cleared the audit HIGH via semver-safe `npm audit fix`; exposed metered create/edit + freeze on the HTTP catalog route + admin-ui authoring (SC-005/006 via a new route IT); added `GET /v1/licenses/:id/usage` app self-read (floored-only, tenant-scoped, cross-tenant→404, raw→400) + IT; documented UNIQUE_COUNT's bucket-grain-distinct window semantics in the spec (SC-005 + Edge Case) and locked it with a cross-hour test. Final `test:cov` exit 0.

## Traceability Notes (non-blocking — honest limitations)
1. **UNIQUE_COUNT window total = SUM of per-hourly-bucket distinct counts** (bucket-grain distinct), not a single distinct-over-the-window set — a value recurring in two hours counts once per hour. This is a **deliberate, documented, reproducible** semantic (SC-005 + Edge Case): a true window-distinct set cannot survive raw-event pruning, whereas the per-bucket distinct count is finalized durably (SC-020). Exact and reproducible at the bucket grain; approximate (over-counting) at a multi-hour window by design.
2. **API keys are tenant-scoped, not license-bound** — FR-001's "tenant- and license-bound" is enforced as: the key authenticates the tenant (RLS), and the event's `licenseId` + composite FK scope accrual to a real in-tenant license; the app self-read's enforceable isolation boundary is the tenant. No cross-tenant leak; a minor wording nuance vs the actual key model.

## Code Coverage
- Enforced gate: global 80% line + 80% branch — **passed**: lines **93.69%** (7986/8523), branches **83.76%** (2342/2796), functions 94.62%.
- **Usage module aggregate (plan's ≥80% line+branch bar) — met**: lines **97.62%**, branches **88.95%**. No usage file below 80% branch (lowest `retention-worker.ts` 80.00%).

## Performance (FR-005 / SC-011)
Real measurement (real Postgres, high-write burst): ingest fast-ack **p95 ~27–34ms** — far under the ~200ms ceiling.

## Checklist Fulfillment (spot-check [Security]/[Data-Integrity]/[API-Quality])
Security: least-privilege scope + RLS + no-secret/PII-leak + rate-limit + prod audit clean — satisfied. Data-Integrity: exactly-once dedupe, recompute-idempotent rollup, reversal net, retention/prune correctness, forced RLS — satisfied. API-Quality: two-vocabulary error split, per-event summary, floored-vs-raw authorization, window bound — satisfied.

## Accessibility / Browser Runtime / Manual Testing
Backend API feature with an operator surface (admin-ui Usage + catalog metered authoring); admin-ui vitest suite green. All validation automated.

## Tool Recommendations (SKIPPED locally, run in CI)
- semgrep (SAST): CI-gated (`usage.yml` semgrep job).

## Bug Tasks Generated
None outstanding. The four items found in-loop were fixed and re-verified within this QC cycle (not deferred). Remaining items — semgrep CI-only, and the two honest notes (UNIQUE_COUNT bucket-grain semantics, tenant-scoped key model) — are non-blocking; both delegated QC agents classified them as informational / correct-per-design, none a CRITICAL or project-instructions violation, and every enforced gate passes.
