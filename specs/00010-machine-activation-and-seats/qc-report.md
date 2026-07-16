# QC Report — E009 Machine Activation & Seat Enforcement

**Feature**: 00010-machine-activation-and-seats
**Run**: full (first QC for this feature)
**Overall Verdict**: **PASS**

Independently verified by the QC Auditor (gates) and Story Verifier (US/SC traceability). All runnable gates
pass. Three Story-Verifier FR partials (FR-014 denial audit, FR-020 rate-limit keying, FR-021 nonce window)
were resolved inline before this verdict.

## Test Results

| Suite | Runner | Result |
|-------|--------|--------|
| Full server suite (all epics, real Postgres via Testcontainers) | Vitest 2 | **158 passed / 3 skipped** |
| Activation module (new) | Vitest 2 | 27 (7 fingerprint-unit + 5 claims-unit + 15 integration) |
| SPA (jsdom + React Testing Library) | Vitest 2 | **54 passed** |

3 skipped = the E006 `DOCKER_SMOKE` image smoke (self-skips; CI-gated). No failures.

The activation integration suite exercises: activate → machine-bound LIC1 that verifies **offline** against
the product key WITH the machine fingerprint (`core.verify(kr, token, now, null, signals)`); race-safe seat
cap (5 racers, 2 seats → exactly 2×201 / 3×409); non-active-license refusal (existing activations NOT
auto-deactivated, FR-023); nonce store-and-replay (retry 200, forge 409); runtime scope 403 + missing-key
401; app + operator deactivation (idempotent, frees the seat); K-of-N drift re-use + offline re-verify;
`<K` new-machine + too-few-signals 400; registry (no credential/signals) + RBAC 403 security_event +
cross-tenant 404; forced-RLS unset-GUC → 0 rows; append-only audit of created/refreshed/deactivated **and
denied** attempts with no signals/nonce/token/key; rate limit 429 + Retry-After + audited; perf < 1s.

## Static Analysis

- **Server typecheck** (`tsc --noEmit`): PASS · **SPA typecheck**: PASS
- **ESLint** (`eslint src/server`, incl. the module-boundary rule): PASS (0 issues). Activation imports only
  the shared console auth + the **non-internal** E004 signer / E008 `getLicense` seams.
- **Semgrep**: CI-only (declared in `.github/workflows/activation.yml` over the activation + console + SPA
  sources). Consistent with E002–E008; not installed locally.

## Security Audit

- **Server production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities** (incl. the new
  `@fastify/rate-limit@11.1.0`).
- **SPA production deps**: **0 vulnerabilities**.

## Code Coverage (>=80% line + branch gate)

- **Server**: 93.19% lines / 82.18% branches / 95.47% functions — gate PASS.
- **SPA**: 96.82% lines / 87.76% branches / 89.17% functions — gate PASS. `Activations.tsx` 100/100/100.

## PI Compliance

No violations.
- **Signing key never exposed** — only the public machine-bound LIC1 token + an opaque `keyId` are returned;
  the private seed stays inside the `KeyMaterial` boundary and is wiped. The E004 conformance-oracle change
  (pass the token's fingerprint to the core) is backward-compatible — E008 tokens pass `null` and behave
  identically; all E004/E008 suites remain green.
- **Tenant isolation fail-closed** — migration 0008 `ENABLE`+`FORCE` RLS + `tenant_isolation`; unset GUC → 0
  rows (proven); cross-tenant registry → 404.
- **Append-only audit, no PII/no secrets** — every activation, deactivation, and denied/limit-exceeded attempt
  audited (reason code / pseudonymous machineId only; the blob is asserted to exclude signals, nonce, token,
  and key material).
- **Race-safe seat counting** — `SELECT … FOR UPDATE` on the license row; partial-unique active-seat index
  backstop. **PII minimization** — only salted hashes stored. **Anti-replay nonce + rate limiting** in place.
  **Raw-SQL migration 0008, no ORM**.

## Requirements Traceability

| User story | Priority | Status |
|-----------|----------|--------|
| US1 — Activate + race-safe seats | P1 | PASS |
| US2 — Deactivate to free a seat | P1 | PASS |
| US3 — Tolerate hardware drift (K-of-N) | P1 | PASS |
| US4 — Browse the activation registry | P1 | PASS |

FR-001…FR-024 and SC-001…SC-020 all mapped to code + a covering test. No P2/DEFERRED work.

## Findings Resolved This Run

- **[FR-014] Denied attempts now audited** — a refused activation (seat-limit, non-active license, replayed
  nonce, too-few signals) writes an `activation.denied` security event in a fresh transaction (the business
  tx has rolled back), reason code only — never the fingerprint or nonce. New integration assertion.
- **[FR-020] Rate-limit keying reconciled** — the limiter runs at `onRequest` (before the body is parsed), so
  the license id is not yet available; keying is per API key (the correct actor granularity). Spec, plan
  AD-008, and the contract were reconciled to per-API-key keying with the rationale documented.
- **[FR-021] Nonce entropy + retention reconciled** — the nonce minimum length was raised to guarantee ≥128
  bits in any encoding; nonces are stored uniquely per tenant on the activation record for its lifetime
  (purged by the platform retention path, not a separate shorter TTL). Spec + data-model reconciled.

## Notes (non-blocking)

- The stale-activation retention sweep (90-day default) and the multi-instance distributed rate-limit store
  (Redis) are documented operational deferrals (single-instance MVP), consistent with the project stack notes.
- CSRF-on-reclaim (FR-017) and the license hard-delete restrict (FR-024/SC-018) are enforced by the shared
  E005 console middleware and the schema composite FK respectively, and covered by their own suites; no
  E009-specific duplicate test was added.
