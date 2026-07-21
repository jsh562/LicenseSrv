# QC Report — E014 Billing-driven Entitlement Automation

**Feature**: `00015-billing-driven-entitlement-automation` | **Epic**: E014 | **Date**: 2026-07-20
**Overall Verdict**: **PASS**

Delegated QC: `sddp-qc-auditor` (independent re-verification: PASS) + `sddp-story-verifier` (PASS-WITH-NOTES). Reached PASS after three fix iterations inside the loop — two spec/plan gaps and two test-reliability defects were found and closed for real (see *Loop History*). Final state: 0 test failures, 0 lint/type errors, 0 production-audit highs, enforced coverage gate (global 80/80) met, billing-module coverage bar (≥80% line+branch) met, no project-instructions violations.

## Test Results
- Runner: Vitest 2 (v8 coverage), real Postgres via @testcontainers/postgresql + the real E004 AES-256-GCM custody + the real HMAC-signed webhook path.
- Enforced full-suite gate `npm run test:cov` — **exit 0**: **88 files passed / 1 skipped; 551 tests passed / 9 skipped / 0 failed** (678s with coverage).
- Billing suite in isolation (`npx vitest run src/server/modules/billing`) — **28 files / 174 tests passed**.
- All 9 skips are env-gated/CI-only, not failures: `image.smoke` (3, Docker image smoke — run via `test:docker`) + 6 pre-existing observability config-rule skips. **No billing test skipped.**

## Static Analysis
- `npm run build` (tsc) exit 0; `npm run typecheck` (strict + noUncheckedIndexedAccess) 0 errors; `npm run lint` (eslint, module-boundary rule) 0 issues.

## Security Audit
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities** (the prod CI gate). Billing adds **no new production dependencies** (reuses `@fastify/rate-limit`, `pg`, `zod`, `node:crypto`).
- `secret-leakage.test.ts` (4 tests) — no card/PAN/CVV/expiry/cardholder value survives into `billing_event.payload_summary` (key-based allow-list `PAYLOAD_SUMMARY_KEYS`); the webhook signing secret never appears in any create/list/rotate response, the `billing_connection_public` view, or any captured log line (in-memory pino buffer scan). Test hardened during QC to use collision-proof canary sentinels (see *Loop History §3*).
- Semgrep (SAST): SKIPPED → WARNING (CI-only, not installed locally; non-blocking; runs in `.github/workflows/billing.yml` semgrep job, `p/typescript` + `p/owasp-top-ten`).

## PI Compliance
No violations.
- **Principle I (signing-key integrity)**: the webhook HMAC secret reuses the E004 **generic AES-256-GCM custody** (`wrapKey`/`unwrapKey`) — a distinct, lower-tier envelope, NOT the Ed25519 signing key. No new crypto primitive. License mutations flow through the EXISTING E008 issuance services (`issueLicense`/`suspend`/`reinstate`/`revoke`) via an added backward-compatible `q?: TxQuery` seam; no signing path altered.
- **Principle II (tenant isolation)**: all three new tables (`billing_connection`, `subscription`, `billing_event`) are ENABLE+FORCE RLS with `tenant_isolation` policies; the ledger is append-only (SELECT/INSERT grants only to the app role — no DELETE). Every access goes through `withTenant`. Cross-tenant → 404; unset-GUC → 0 rows (proven, SC-011).
- **Principle III (auditability / no new crypto)**: append-only `audit_log`; webhook mutations carry the provider event id, worker/reconcile mutations a synthetic system actor + subscription id.
- **FR-018 (PCI out of scope)**: no card/PAN data is accepted, stored, returned, or logged; no outbound charge/payment-initiation code path exists (the only provider egress is the read-only reconcile `ProviderFetch`).

## Requirements Traceability (Story Verifier)
Per-story: **US1 PASS, US2 PASS, US3 PASS, US4 PASS, US5 PASS, US6 PASS (server primitive — see Notes)**. All FR-001..FR-022 met; all SC-001..SC-015 trace to code + ≥1 passing test.

Highlights: signed-webhook → applied exactly once, bad/missing/stale/future sig rejected with no state change (SC-001); concurrent redelivery of the same `provider_event_id` → exactly one `applied`, one row via `ON CONFLICT DO NOTHING` (SC-002); subscription-created → E008 provision + 1:1 link, renewal → E007 effective re-read + term extend + grace cleared (SC-003); cancel/fail → grace/past_due overlay with license still active, grace elapsed → worker E008-suspend, payment-in-grace/from-suspended → reinstate (SC-004/005); refund/chargeback → E008 revoke terminal, later events do not resurrect (SC-006); operator connects provider no-code with write-only secret (SC-007); audit attribution split webhook-event-id vs synthetic-actor (SC-008); reconcile corrects drift (SC-009); out-of-order event rejected on both webhook + reconcile paths (SC-010); cross-tenant → 404 under forced RLS (SC-011); no card/PAN in ledger (SC-012); dual-granularity rate-limit 429 + fast ack p95 ~45ms < 200ms (SC-013); secret custody rotatable current+prev, never returned/logged (SC-014); ledger retention prune + GDPR erasure enforced (SC-015 — closed in iteration 2).

## Traceability Notes (non-blocking — correct architectural boundary)
1. **US6 / FR-017 reconciliation is a real server-side self-heal engine validated against a STUBBED provider fetch.** There is no live provider and no outbound provider-API adapter — `BillingDeps.providerFetch` defaults to `noopProviderFetch`, and every reconcile test injects a deterministic `ProviderFetch` stub. The engine (candidate enumeration, recency guard, drift diff, lifecycle apply, fail-open, synthetic-actor audit, async-202 route, periodic worker) is real and fully exercised; the live-integration leg is an intentional, documented seam — expected for an EXTERNAL-SERVICE epic.
2. **Client-side propagation is out of scope (E013 owns it).** Suspend/revoke effects are proven at the DB/license-status level, which is E014's contract; online propagation to clients is E013's responsibility per the spec Scope→Excluded.
3. **FR-005 issue-vs-activate nuance.** `applyProvision` issues a new E008 license when the subscription has no link and idempotently reuses the existing 1:1 link on re-create; status recovery of a *suspended* license lives on the renewal/reactivation path (`applyRenew`), not the create event — a sound split, stated explicitly.

## Code Coverage
- Enforced gate: global 80% line + 80% branch (vitest config) — **passed**: lines **92.65%** (6017/6494), branches **82.17%** (1710/2081), functions 93.71%.
- **Billing module aggregate (the plan's "≥80% line+branch on new billing module" bar) — met**: lines **90.67%**, branches **83.27%** (raised from 76.63% in iteration 2). Files driven to 100% branch during the fix: `config.ts`, `events.ts`, `index.ts`, `adapters/generic.ts` (was 18.75%), `adapters/index.ts` (was 50%), `subscription-repo.ts`.
- WARNING (non-blocking, informational — module aggregate clears the bar): 5 files remain <80% per-file branch — `grace-worker.ts` 57.9%, `reconcile-worker.ts` 72.9%, `routes.ts` 73.2%, `connection-repo.ts` 77.8%, `lifecycle.ts` 79.1%. Uncovered spots are defensive/fail-open worker branches and error-path route validation. Follow-up: add targeted unit tests if per-file 80% is desired.

## Performance (FR-019 / SC-013)
Real measurement on POST /v1/billing/webhooks/:connectionId (validly-signed event → handler ack, real Postgres + real custody): **p95 ~45ms — well under the 200ms fast-ack SLO**. Dual-granularity rate-limit verified: per-source-IP limit trips pre-resolution (bounds a flood of unknown/invalid `connectionId`) layered under the per-connection limit; over-limit → 429 `rate_limited` + `Retry-After`; shed known-connection deliveries audited fail-safe.

## Retention & Erasure (FR-021 / SC-015)
Now ENFORCED, not just schema (closed in iteration 2): `pruneBillingEvents` (owner-role DELETE, respects the idempotency-window floor) consumed by a periodic, unref'd, fail-open `startBillingRetentionWorker` started from `main.ts` and tied to `app.close()`; `eraseTenantPersonalData` erases the tenant's `billing_connection`/`subscription`/`billing_event` in FK order. Tests: `retention.integration` (4 — aged rows pruned, floor rows retained, app-role DELETE denied, worker sweep), `retention-worker.unit` (7), `gdpr.integration` + extended `foundation.integration` (billing tables erased, other tenant untouched).

## Checklist Fulfillment (spot-check [Security]/[Data-Integrity]/[API-Quality])
Security: secret custody + no-card-data + isolation + rate-limit + append-only ledger + prod audit clean — satisfied. Data-Integrity: idempotency UNIQUE + ON CONFLICT, 1:1 set-once link, stale-event guard, retention floor — satisfied. API-Quality: write-only secret contract, viewer/admin RBAC + CSRF, deterministic ordering + truncated signal — satisfied.

## Accessibility / Browser Runtime / Manual Testing
Backend API feature with a minimal operator surface (`admin-ui` Billing page, write-only secret field); admin-ui vitest suite green. All validation automated; no manual browser testing required.

## Tool Recommendations (SKIPPED locally, run in CI)
- semgrep (SAST): CI-gated (`billing.yml` semgrep job).

## Loop History (iterations to PASS — full transparency)
1. **Iteration 1 QC** found two gaps against the spec/plan: (a) **FR-021/SC-015** retention + GDPR erasure was declared via schema (BRIN index + append-only grants) but had **no executable prune and did not erase the billing tables** — real functional shortfall; (b) **billing-module branch coverage 76.63% < 80%** — below the plan's stated module bar (only the global gate, which passed, is machine-enforced).
2. **Iteration 2** closed both: implemented the retention prune executor + fail-open worker + GDPR billing-table erasure (mirroring the E013 prune pattern) with tests, and added real branch tests raising the module to 90.67% line / **83.27% branch**.
3. **QC re-verification** found a **flaky test**: `secret-leakage.test.ts`'s 3-char CVV sentinel `"737"` collided by chance with digits inside request-id UUIDs in the whole-buffer log scan → failed ~3/4 runs. Fixed with collision-proof canary sentinels (no assertion weakened); 5/5 deterministic.
4. **Final full-suite run** exposed a **pre-existing teardown hang** in the E012 `enforcement/perf.integration.test.ts` — `pool.end()` waited forever on a pg client autocannon left stuck mid-query; E014's added Testcontainers load tipped this marginal flake into consistent failure, reddening the enforced gate. Fixed at root cause: bounded teardown + `forceCloseConnections` + inject-based warm-up + pool error handlers (perf assertion untouched); 5/5 deterministic, teardown 256s → ~20-35s.

## Bug Tasks Generated
None outstanding. The four defects found in-loop were fixed and re-verified within this QC cycle (not deferred). Remaining items — per-file billing branch WARNING (5 files, module aggregate passes), the US6/FR-017 stubbed-provider boundary, and the semgrep CI-only gate — are non-blocking; both delegated QC agents classified them as informational / correct-architectural-boundary, none a CRITICAL or project-instructions violation, and every enforced gate passes.
