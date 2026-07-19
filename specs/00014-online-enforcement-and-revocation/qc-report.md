# QC Report — E013 Online Enforcement and Revocation

**Feature**: `00014-online-enforcement-and-revocation` | **Epic**: E013 | **Date**: 2026-07-19
**Overall Verdict**: **PASS**

Delegated QC: `sddp-qc-auditor` (PASS) + `sddp-story-verifier` (PASS-WITH-NOTES). No blocking defects — 0 test failures, 0 lint/type errors, 0 production-audit highs, coverage gate (global 80/80 + enforcement-module aggregate) met, no project-instructions violations.

## Test Results
- Runner: Vitest 2 (v8 coverage), real Postgres via @testcontainers/postgresql + the real E004 signer + offline verify via the E001 WASM core.
- **60 files passed / 1 skipped; 377 tests passed / 9 skipped / 0 failed.**
- All 9 skips are env-gated/CI-only, not failures: `image.smoke` (3, Docker image smoke) + 6 pre-existing observability config-rule skips. **No enforcement test skipped.**

## Static Analysis
- `npm run build` (tsc) exit 0; `npm run typecheck` (strict + noUncheckedIndexedAccess) 0 errors; `npm run lint` (eslint, module-boundary rule) 0 issues.

## Security Audit
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities** (the prod CI gate). Enforcement adds **no new production dependencies**.
- `secret-leakage.test.ts` — no signing seed / custodian shares / api-key secret / token transport bytes in any success or error response; the short-lived token is a public `LIC1.`, the CRL signature a public 64-byte detached base64url sig, error bodies `{code,message,details?}`.
- Semgrep (SAST): SKIPPED → WARNING (CI-only, not installed locally; non-blocking).

## PI Compliance
No violations. Principle I (renewal + CRL signed by the EXISTING E004 signer; the new `signDetached` is domain-separated `LICSRV-CRL-v1` vs the LIC1 token domain; no key material in any response; offline verifier + E009 credential UNCHANGED; never-connected unaffected), Principle II (validate/heartbeat/CRL tenant-scoped; new `checkin`/`revocation_list` forced-RLS, SELECT/INSERT-only), Principle III (reuses E001 verifier + E004 signer, no new crypto; audited append-only) — all upheld.

## Requirements Traceability (Story Verifier)
Per-story: US1 PASS, US2 PASS, US3 PASS, US4 PASS, US5 PASS, US6 PASS. All FR-001..023 + all SC-001..015 trace to code + ≥1 test.

Highlights: short-TTL token verifies OFFLINE via the E001 core (SC-001); revoke→200 `revoked`, outstanding token lapses ≤ TTL (SC-002/004); renewed token carries CURRENT effective entitlements verified offline (FR-017/SC-003); never-connected activation unchanged, not revoked-by-default (SC-005); stalenessWindow in-band (SC-006); CRL detached-sig verifies, byte-stable json==file, monotonic version (SC-007/012); tampered CRL fails verify (SC-011 detection primitive); rate-limit 429 on all 3 routes (SC-013); cross-tenant→404 under RLS (SC-014); append-only audit (SC-015); server monotonic anchor floor never regresses (SC-009).

## Traceability Notes (non-blocking — correct architectural boundary)
1. **Client-side CRL/anchor obligations delivered as server primitives + docs** — FR-011 (fetch fail-open), FR-022 client caching/anti-downgrade, FR-023 (untrusted-signature ignore/no-cache) are CLIENT responsibilities; the plan's coverage map routes them to "contracts + docs". The server delivers the primitives (`verifyDetached`, monotonic `version`, `isFresherCrlVersion`, 404-on-miss) and documents the three client outcomes in `enforcement/README.md`. Correct for a server epic — E013 is the server side.
2. **US6 clock-tamper is server-side monotonic-anchor + signed-time only** — per HINT-005 (clock-tamper is client-side; never-connected rollback is bounded, not prevented). The T040 tasks.md description overstated a server-side clock gate that (correctly, per spec) does not exist; the implementation matches the spec. Honest, not a functional gap.
3. **SC-008 perf self-skip guard did not trigger** — the autocannon test asserted (p97.5 ~47-53ms << 120ms) in the actual runs; the noise-guard skip is a fallback for underpowered CI.

## Code Coverage
- Enforced gate: global 80% line + 80% branch (vitest config) — **passed**.
- Overall: lines **93.14%**, branches **81.43%**, functions 95.45%.
- Enforcement module aggregate: lines **94.13%**, branches **82.77%**, functions 98.27% (the plan's "≥80% on new enforcement" gate — met).
- WARNING (non-blocking, informational — not a configured-gate failure): three files below 80% on a per-file branch basis, and `config.ts` at 74% line — all uncovered spots are defensive/edge branches (`ENFORCEMENT_PLAN_OVERRIDES` malformed-JSON parse + override loop in config.ts; perpetual-license `exp==null` path in token.ts; unreachable defensive throws in validate.ts). Follow-up: add targeted unit tests if per-file 80% is desired.

## Checklist Fulfillment (spot-check [Security]/[Testing])
Security: no-key-material + isolation + rate-limit + anti-replay + prod audit clean — satisfied. Testing: unit + real-Postgres integration + security + perf tiers all present and green — satisfied.

## Performance (FR-020 / SC-008)
Real autocannon on POST /v1/validate (built app + real signer + real Postgres, non2xx=0): p50 ~32ms, p90 ~40-44ms, **p97.5 ~47-53ms, p99 ~54-60ms — well under the 120ms SLO**. Companion SC-004 (token TTL ≤ renewal window) passed.

## Accessibility / Browser Runtime / Manual Testing
SKIPPED — backend API feature, no UI surface. All validation automated.

## Tool Recommendations (SKIPPED locally, run in CI)
- semgrep (SAST): CI-gated (`enforcement.yml` semgrep job).

## Bug Tasks Generated
None. No blocking defects. The coverage per-file WARNING, the SC-008 noise-guard, and the T040 description imprecision are non-blocking follow-ups — both delegated QC agents classified them as informational / correct-architectural-boundary, none a CRITICAL or project-instructions violation, and the enforced coverage gate passes.
