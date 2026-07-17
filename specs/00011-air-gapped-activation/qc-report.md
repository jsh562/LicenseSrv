# QC Report — E010 Air-Gapped Activation

**Feature**: 00011-air-gapped-activation
**Run**: full (first QC for this feature)
**Overall Verdict**: **PASS** (with P2 US4 console variant deferred)

Independently verified by the QC Auditor (gates) and Story Verifier (US/SC traceability). All runnable gates
pass. Two MEDIUM findings and the Story-Verifier PARTIAL/untested gaps were resolved inline before this verdict.

## Test Results

| Suite | Runner | Result |
|-------|--------|--------|
| Full server suite (all epics, real Postgres via Testcontainers) | Vitest 2 | **180 passed / 3 skipped** |
| Air-gap (new) | Vitest 2 | 20 (8 unit + 12 integration) |

3 skipped = the E006 `DOCKER_SMOKE` image smoke (self-skips; CI-gated). No failures. No SPA in this feature —
the console upload/download variant is US4 (deferred), so there are no admin-ui gates for E010.

The air-gap integration suite exercises: full file exchange → response file → **offline verify** via the E001
WASM core WITH the machine fingerprint (SC-001); seat consume + registry parity (SC-003); seats-full 409 with
no response file (SC-004); byte-identical idempotent replay, no 2nd seat (SC-005); K-of-N drift re-import →
same seat, `created:false` (SC-017); cross-transport shared nonce (SC-016); cross-tenant → 404 (SC-010);
every refusal a distinct code (malformed/unknown-version/stale/oversize/too-few/non-active), each audited
`airgap.denied` (SC-007/008/011); a scope-lacking key → 403, audited; an already-seen nonce replays past the
freshness window (FR-021); tampered response rejected at import (SC-006); a rotated-key credential still
verifies offline against the overlapping keyring (SC-019); signer unavailable → 503 with no seat (SC-015);
rate limit → 429 + Retry-After, throttle audited (SC-012); perf < 1s.

## Static Analysis

- **Typecheck** (`tsc --noEmit`): PASS · **ESLint** (`eslint src/server`, incl. the module-boundary rule): PASS.
- **Semgrep**: CI-only (declared in `.github/workflows/airgap.yml` over the activation + console sources).

## Security Audit

- **Server production deps** (`npm audit --omit=dev --audit-level=high`): **0 vulnerabilities**.

## Code Coverage (>=80% line + branch gate)

- **Server**: 93.36% lines / 82.69% branches / 95.57% functions — gate PASS.

## PI Compliance

No violations. The change is strictly additive — `activate.ts` (E009) and the entire `signing/` module (E004)
are unchanged (regression suites green in the same run: activation 15, issuance 13, signing 8+6, catalog 8,
admin, foundation, health, config, entrypoint).
- **Signing key never exposed** — the response file carries only the public LIC1 credential + pseudonymous
  machineId; no private material; tamper-evidence is the embedded LIC1 Ed25519 signature (no envelope
  signature, no second crypto). The airgap codec imports only `zod`/`pg`/`Buffer`.
- **No second seat model** — `processAirGapRequest` calls the E009 `activate()` verbatim; seat cap, K-of-N,
  nonce store-and-replay, tenant isolation (forced RLS via `withTenant`), and fail-closed sign-after-seat are
  all inherited.
- **PII minimization** — only salted hashes / pseudonymous machineId in files, storage, logs; audit blob
  asserted to exclude signals/nonce/token.
- **Append-only audit** — `airgap.activated` on success, `airgap.denied` on **every** refusal (business AND
  file-layer 400s AND the 403 scope denial); rate-limit throttle audited.
- **Fail-closed no-partial-state** — file-layer validation (oversize→decode→version→freshness→structure) runs
  before the E009 seat-consuming transaction; a refusal leaves no row and no partial seat.

## Requirements Traceability

| User story | Priority | Status |
|-----------|----------|--------|
| US1 — Activate via signed file exchange | P1 | PASS |
| US2 — Consumes a seat, idempotently | P1 | PASS |
| US3 — Tamper-evident + fail-closed | P1 | PASS |
| US4 — Console upload/download | P2 | **DEFERRED** (T014/T015) |

FR-001…FR-014 + FR-016…FR-028 and SC-001…SC-020 all mapped to code + a covering test. FR-015 (console)
deferred with US4.

## Findings Resolved This Run

- **[MEDIUM M2] 403 scope denial now audited** — the air-gap route emits an `airgap.denied` security event when
  a resolvable key lacks the `activate` scope (the 401 no-tenant case legitimately cannot be tenant-scoped).
  New test (polls for the fire-and-forget audit, since the scope guard replies before the write commits).
- **[MEDIUM M1] Response-envelope `keyId`/`expiresAt` reconciled** — these are informational, nullable fields;
  the authoritative signing-key id and expiry live inside the self-describing credential (its `kid`/`exp`
  claims), which the E001 core uses offline (AD-003). Contract made them nullable; FR-016/FR-022 reworded to
  state the credential carries the authoritative values (the envelope may surface them as metadata).
- **[SC-019] Rotated-key offline verify** — added a rotate-then-verify test: a credential signed by a prior key
  still verifies against the overlapping E004 keyring.
- **[FR-021] Freshness is first-sight only** — added a test: an already-seen nonce with an ancient `producedAt`
  replays (not `stale_request`).
- **[SC-015 / SC-012] Assertions tightened** — the signer-unavailable test now asserts no seat consumed; the
  rate-limit test now asserts the throttled attempt is audited.

## Notes (non-blocking)

- A 503 `signer_unavailable` (a server fault, not a client denial) is not emitted as `airgap.denied` — the
  fail-closed rollback (no seat/row) is proven instead; consistent with the plan's Error Handling table.
- GDPR retention/erasure parity (SC-020) is structural — air-gap writes the SAME E009 `activation` rows with no
  separate lifecycle (FR-026: no origin column / no migration) — inherited from E009's tested erasure path.
