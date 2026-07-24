# QC Report — E015 Floating & Concurrent Seats

**Feature**: `00016-floating-and-concurrent-seats` | **Epic**: E015 | **Date**: 2026-07-24
**Overall Verdict**: **PASS**

Delegated QC: `sddp-qc-auditor` (PASS) + `sddp-story-verifier` (PASS — all 5 US / 26 FR / 23 SC MET). Reached PASS after three fix iterations inside the loop (one enforced-gate blocker + two completeness gaps + one pre-existing cross-epic flake). Final state: 0 test failures, 0 lint/type errors, 0 prod-audit high/critical, enforced coverage gate met, no project-instructions violation.

## Test Results
- Runner: Vitest 2 (v8 coverage), real Postgres via @testcontainers/postgresql + the real E004 keystore signer.
- Enforced full-suite gate `npm run test:cov` — **exit 0**: **107 files passed / 1 skipped; 678 tests passed / 9 skipped / 0 failed** (833s with coverage).
- Lease suite in isolation (`npx vitest run src/server/modules/lease`) — **18 files / 122 tests passed** (incl. the genuine-concurrency race and the salt-rotation IT added in iteration 2).
- All 9 skips are env-gated/CI-only (Docker image smoke + observability config-rule skips) — no lease test skipped.

## Static Analysis
- `npm run build` (tsc) exit 0; `npm run typecheck` (strict + noUncheckedIndexedAccess) 0 errors; `npm run lint` (eslint, module-boundary rule) 0 issues — the new `lease` module respects the cross-module-boundary rule.

## Security Audit
- `npm audit --omit=dev` — **0 vulnerabilities** (0 high/critical). Iteration 2 cleared 3 pre-existing HIGH transitive advisories (brace-expansion, fast-uri, find-my-way, protobufjs) via `npm audit fix` (semver-safe, no `--force`; Fastify stayed 5.8.5) with proven-zero regression. The lease module adds **no new production dependency** (reuses Fastify, `pg`, `node:crypto`, the E004 signer).
- `secret-leakage.test.ts` (4 tests) — no signing private key, raw holder reference, holder-key salt, raw hardware identifier, or card/PAN survives into any response body, log line (in-memory pino capture), lease row, or audit entry; only the pseudonymous `holderKey` + public `LEASE1` handle + opaque `keyId` are exposed (SC-015).
- Semgrep (SAST): SKIPPED → CI-gated (not installed locally; runs in `.github/workflows/lease.yml` semgrep job, `p/typescript` + `p/owasp-top-ten` over `src/server/modules/lease`).

## PI Compliance
No violations.
- **Principle I (offline-first / key never exposed)**: floating is an explicitly ONLINE concurrency layer that does not alter offline node-lock (E009); the lease handle reuses the E004 signer with a domain-separated payload `LICSRV-LEASE-v1` (verified a distinct third domain beside the LIC1 token + CRL), NO new crypto; the signing key never returned/logged; signer fault → 503 fail-closed, no seat (FR-022, SC-015/018/021).
- **Principle II (tenant isolation + RBAC)**: `lease` forced-RLS + `tenant_isolation` policy on the `app.current_tenant` GUC; runtime surface behind a scoped `lease` API key (FR-002); admin registry/force-release behind console session + RBAC + double-submit CSRF (FR-015/016); cross-tenant → 404 (unset-GUC → 0 rows), with the documented RLS-safe idempotent-200 release carve-out (FR-019, SC-012).
- **Principle III (single security core + append-only audit)**: reuses E004 signer + E008 status + E009 fingerprint; no per-language crypto; append-only audit of every acquire/renew/release/reclaim/force-release + every denial, reclamations attributed to a synthetic `lease-reclaim-worker` actor (FR-018).
- **PII minimization**: `holder_key` is a salted SHA-256 hash of a client-supplied reference under a server-held, per-tenant, rotatable salt never distributed to the client (FR-020, FR-026, SC-023); GDPR-erasable.
- **Anti-replay + rate limiting**: single-use acquire token `UNIQUE(tenant_id, nonce)` → replay returns the original lease (FR-014, SC-011); per-API-key rate limit + 429 + `Retry-After` + audited security event (FR-017, SC-014); generation fence + status/expiry predicate reject stale renew (FR-011).
- **Race-safe accounting**: per-license `pg_advisory_xact_lock` count+insert (AD-001) — proven exactly-C-of-N under genuine concurrency (FR-003, SC-002).

## Requirements Traceability (Story Verifier)
Per-story: **US1 PASS, US2 PASS, US3 PASS, US4 PASS, US5 PASS**. All FR-001..FR-026 MET; all SC-001..SC-023 MET — each traced to implementing code + ≥1 passing test.

Highlights: exactly-C-of-N race under real parallelism (12 pool clients + 10 parallel HTTP; SC-002); machine vs session seat sharing (SC-016); stale-renew-after-reclaim → 409 with no double-count (SC-008); revoke → proactive reclaim / suspend|expire → timer, now with the configurable non-default branches wired (FR-024); signed handle tamper-evident vs E004 public key, TTL ≤ heartbeat (SC-018); absent `max_concurrent` → 403 fail-closed (SC-019); overage metered to append-only audit (SC-009); registry viewer-RBAC + force-release admin+CSRF (SC-010/013); salt rotation leaves live leases renewable/releasable while a new acquire re-derives a different holder-key (SC-023).

## Traceability Notes (non-blocking — honest architectural boundaries)
1. **Machine-scope trusts the client-supplied E009 fingerprint** — the server salts/hashes/folds the signals but does not independently compute a machine fingerprint; machine-scope seat-sharing is only as trustworthy as the honest-client fingerprint. This exactly matches the spec's honest-client threat model (Assumptions) — not a gap.
2. **The generation fence is monotonic-counter + status/expiry predicate, not a client-supplied expected-generation compare** in the live renew path — reclaim↔renew mutual exclusion is enforced and proven by the `WHERE status='live' AND expires_at>now()` predicate + Postgres row locking; the generation guard exists as unit-tested defense-in-depth. Correctness (no double-count) is proven.

## Code Coverage
- Enforced gate: global 80% line + 80% branch (vitest config) — **passed**: lines **93.17%** (6936/7444), branches **82.83%** (1993/2406), functions 94.33%.
- **Lease module aggregate (plan's ≥80% line+branch bar) — met**: lines **96.57%**, branches **87.42%**. Every lease file ≥80% branch (lowest `renew.ts` 80.95%).

## Performance (FR-017 / SC-014 companion)
Real measurement (real Postgres + real E004 signer): acquire **p95 ~20–23ms**, renew **p95 ~24–28ms** — far under the ~200ms fast-ack ceiling. Dual-granularity intent: per-API-key rate limit sized to admit heartbeat cadence (default ≥2× aggregate rate); over-limit → 429 + Retry-After, audited.

## Checklist Fulfillment (spot-check [Security]/[Data-Integrity]/[API-Quality])
Security: scoped-key + RBAC + CSRF + isolation + no-secret-leak + rate-limit + prod audit clean — satisfied. Data-Integrity: race-safe advisory-lock accounting, fence, one-live invariant, idempotent renew/release, snapshot immutability, FK NO ACTION, forced RLS — satisfied. API-Quality: `{code,message,details?}` envelope, distinct codes, idempotency semantics, pagination/truncation, rate-limit headers — satisfied.

## Accessibility / Browser Runtime / Manual Testing
Backend API feature with a minimal operator surface (admin-ui Leases page); admin-ui vitest suite (62 tests) green. All validation automated; no manual browser testing required.

## Tool Recommendations (SKIPPED locally, run in CI)
- semgrep (SAST): CI-gated (`lease.yml` semgrep job).

## Loop History (iterations to PASS — full transparency)
1. **Iteration 1** — implemented all 43 tasks; QC found: (a) **`npm audit` 3 HIGH** in pre-existing transitive deps → the `lease.yml` `--audit-level=high` CI step would fail; (b) FR-024's *configurable* suspend/expire→reclaim branch unwired (mandated default worked); (c) SC-023 salt-rotation "live leases survive" half untested.
2. **Iteration 2** — cleared the audit highs via semver-safe `npm audit fix` (no Fastify major bump, zero regression proven); wired the suspend/expire→reclaim policy (defaults unchanged) + tests; added the salt-rotation IT. Full run then exposed **1 failure**: `billing/rotation.integration.test.ts`, proven a **pre-existing, bump-independent clock-skew flake** (reproduced identically with the old lockfile).
3. **Iteration 3** — fixed the billing flake at root cause: `isRotationWindowOpen` used an `elapsedSecs >= 0` guard comparing a DB-clock `secret_rotated_at` against the host clock, so container clock-lead spuriously closed the rotation grace window (a real production robustness bug). Added a bounded 120s negative-skew tolerance + unit coverage; 5/5 deterministic; billing suite 175 tests green.
4. **Final gate** — `npm run test:cov` exit 0: 678 pass / 9 skipped / 0 fail; global 93.17% line / 82.83% branch; `npm audit` 0 high/critical.

## Bug Tasks Generated
None outstanding. The four items found in-loop were fixed and re-verified within this QC cycle (not deferred). Remaining items — semgrep CI-only, and the two honest architectural notes (machine-scope client-fingerprint, generation-fence defense-in-depth) — are non-blocking; both delegated QC agents classified them as informational / correct-per-spec, none a CRITICAL or project-instructions violation, and every enforced gate passes.
