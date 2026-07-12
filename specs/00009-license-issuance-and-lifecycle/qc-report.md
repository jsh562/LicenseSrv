# QC Report — E008 License Issuance & Lifecycle

**Feature**: 00009-license-issuance-and-lifecycle
**Run**: full (first QC for this feature)
**Overall Verdict**: **PASS** (with P2 US6 reissue deferred)

Independently verified by the QC Auditor (gates) and Story Verifier (US/SC traceability). All runnable gates
pass. One MEDIUM and two LOW correctness findings from the QC Auditor were fixed inline before this verdict.

## Test Results

| Suite | Runner | Result |
|-------|--------|--------|
| Full server suite (all epics, real Postgres via Testcontainers) | Vitest 2 | **131 passed / 3 skipped** |
| Issuance module (new) | Vitest 2 | 16 (3 claims unit + 13 integration) |
| SPA (jsdom + React Testing Library) | Vitest 2 | **46 passed** |

3 skipped = the E006 `DOCKER_SMOKE` image smoke (self-skips; CI-gated). No failures.

The issuance integration suite exercises: issue → LIC1 verifies offline against the product key via the real
Rust core (entitlements/seat/expiry embedded); perpetual (no-expiry) license; signer-unavailable → 503 with
**no** license row; archived-plan 409 + snapshot immutability after a catalog edit; archived-**entitlement**
409; revoke (terminal + idempotent); suspend/reinstate (409 on invalid transition); transfer within/at the
limit (409); registry list/get/key + viewer 403 + `security_event`; tenant isolation (cross-tenant → 404, 0
rows); GDPR erase (anonymize-if-licensed else hard-delete) + refusal to issue to an anonymized customer;
audit of all 7 actions with no PII / no signing key; single-issuance perf < 1s.

## Static Analysis

- **Server typecheck** (`tsc --noEmit`): PASS · **SPA typecheck**: PASS
- **ESLint** (`eslint src/server`, incl. the module-boundary rule): PASS (0 issues). Issuance imports only the
  shared `src/server/console/` auth and the **non-internal** signing/catalog seams (`app.signer`,
  `getEffectivePlanDefinition`) — the boundary rule is satisfied.
- **Semgrep**: CI-only (declared in `.github/workflows/licensing.yml` over `src/server/modules/issuance` +
  `src/server/console` + `src/admin-ui/src/pages/licensing`). Consistent with E002–E007; not installed locally.

## Security Audit

- **Server production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities**
- **SPA production deps**: **0 vulnerabilities**. (Dev-only vite/vitest advisories are informational, not
  shipped — out of scope for the production-audit gate.)

## Code Coverage (>=80% line + branch gate)

- **Server**: 92.66% lines / 81.70% branches / 95.38% functions — gate PASS.
- **SPA**: 95.49% lines / 86.37% branches / 80% functions — gate PASS. Licensing views: Issue 95.9/81.8,
  Licenses 92.4/82.4, Customers 97.3/84.6, Licensing 100/100.

## PI Compliance

No violations.
- **Signing key never exposed** — only the public LIC1 token is returned (issue + `GET .../key`); `Signer` is
  sign-only, `KeyMaterial` redacts on serialize; the audit blob is asserted to contain no key material.
- **Tenant isolation fail-closed** — migration 0007 `ENABLE`+`FORCE` RLS + `tenant_isolation` policy over
  `NULLIF(current_setting('app.current_tenant', true), '')::uuid` (unset GUC → zero rows); composite
  intra-tenant FKs; cross-tenant id → 404 (proven live).
- **Append-only audit, no PII** — every issue/lifecycle/customer action `writeAudit`; erasure records
  action+target only (never name/email).
- **Raw SQL migration 0007, no ORM**; source under `/src`; the offline verifier core is untouched.

## Requirements Traceability

| User story | Priority | Status |
|-----------|----------|--------|
| US1 — Issue a signed license | P1 | PASS |
| US2 — Revoke | P1 | PASS |
| US3 — Suspend / reinstate | P1 | PASS |
| US4 — Transfer (bounded) | P1 | PASS |
| US5 — Registry + customers + key retrieval + RBAC + isolation | P1 | PASS |
| US6 — Reissue after key rotation | P2 | **DEFERRED** (T034/T035) |

Success criteria: **SC-001…SC-011 all PASS**. FR-001…FR-016 + FR-019 mapped to concrete code + tests; FR-017
(perf) verified by a single-issuance < 1s assertion; FR-018 (reissue) deferred with US6.

## Findings Fixed This Run

- **[MEDIUM] FR-005 archived-entitlement now enforced** — the effective read model (`catalog/effective.ts`)
  additively reports `archivedEntitlementKeys`; `issueLicense` refuses with `409 plan_not_issuable` when a plan
  references an archived entitlement (previously the entitlement was silently dropped from the snapshot,
  contradicting the OpenAPI contract + FR-005). New integration test; the E007 read model's active-only
  `entitlements` list is unchanged.
- **[LOW] Erased-customer guard** — issuing to an anonymized customer is refused (`409 customer_anonymized`),
  matching the SPA's active-only filter and GDPR intent (FR-019). New integration test.
- **[LOW] Concurrent-removal race** — a plan/customer removed between the pre-checks and the insert now maps
  the FK violation (23503) to a clean `404`, not a 500. Fail-closed (no partial license) throughout.
- **[LOW] Traceability** — a Delivery Note in `tasks.md` records the two-suite test consolidation and the
  above remediations.

## Deferred (out of scope for this gate)

US6 Reissue after key rotation (T034/T035, P2) — non-blocking for the P1 MVP; the E004 overlapping keyring
keeps already-issued tokens verifying after a rotation.
