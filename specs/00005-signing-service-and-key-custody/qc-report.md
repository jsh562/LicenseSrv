# QC Report — Signing Service and Key Custody (E004)

> Date: 2026-07-02 | Feature: `specs/00005-signing-service-and-key-custody/` | Verdict: **PASS (partial — OBJ5 cloud-KMS adapter deferred as P2)**

## Test Results

- Runner: **Vitest 2.1.x — 58/58 passed** across 8 files (signing module: 6 files / 34 tests; E002 foundation regression: 2 files / 24 tests).
- Signing tests: `custody.unit` (6), `token.unit` (4), `signing.unit` (8), `secret-leakage` (2), `signing.integration` (8 — real Postgres via Testcontainers), `routes.integration` (6 — Fastify inject + real Postgres).
- Failures: none. Full suite (`npm test`) green — no E002 regression from registering the signing module.

## Static Analysis

- **ESLint** (`npm run lint`): **PASS** — 0 errors, incl. the module-boundary `no-restricted-imports` rule (the signing module imports only its own internals + shared `db`/`audit`/`auth`).
- **TypeScript** (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`): **PASS** — 0 errors.

## Security Audit

- **Dependencies** (`npm audit --omit=dev --audit-level=high`): **PASS — 0 vulnerabilities**. No new runtime deps were added (CBOR + Shamir are hand-rolled and unit-tested — a documented deviation for a self-contained, auditable, offline-friendly module).
- **SAST (Semgrep)**: **SKIPPED locally — CI-only** (not installed on this machine; enforced in `.github/workflows/server-ci.yml` on `src/server/**`). Consistent with the E002/E003 precedent.
- **No secret leakage** (TR-010, verified): private material lives only inside the custody boundary (wrapped-then-`fill(0)`), is routed through the `KeyMaterial` redaction boundary (`toJSON`/`toString` → `"[KeyMaterial redacted]"`, non-enumerable `#sign`), and never appears in any API response / log / error. `SigningKeyMetadata` + JWKS `KeyringKey` carry public material only (no `d`); the `product_keyring` view excludes `private_key_ref`/`custody_scheme`. Asserted by `secret-leakage.test.ts` + `routes.integration` (no `private_key_ref` on provision, no `d` on keyring).

## PI Compliance

- **Principle I (Offline-First)**: **PASS** — the default keystore signer works fully offline (node:crypto Ed25519 + AES-256-GCM + Shamir); cloud-KMS is opt-in and deferred (P2).
- **Principle II (Multi-Tenant Isolation)**: **PASS** — `signing_key` is `tenant_id`-scoped under forced RLS via `withTenant`/`licensesrv_app`; cross-tenant read/use denied (integration-tested).
- **Principle III (Single Security Core, Audited)**: **PASS** — the LIC1 byte format is **single-sourced by the Rust verifier-core**; the Node encoder is proven byte-identical and every minted token is conformance-verified against the real core (E003 WASM) before return (AD-001/TR-018). No verification crypto is reimplemented. Every key lifecycle event is append-only audited.
- No CRITICAL `project-instructions.md` violations.

## Requirements Traceability

Story Verifier verdict: **P1 PASS**. OBJ1–OBJ4 each satisfy both Validation Criteria against real source + a verifying test; OBJ5 deferred.

| Work Item | Priority | Status |
|---|---|---|
| OBJ1 — signer interface + keystore signer | P1 | PASS |
| OBJ2 — per-product keys + registry | P1 | PASS |
| OBJ3 — rotation + keyring + REST | P1 | PASS |
| OBJ4 — custody, recovery & fail-closed | P1 | PASS |
| OBJ5 — cloud-KMS/PKCS#11 adapter | P2 | **DEFERRED** (T032–T034 `[DEFERRED]`; config seam present) |

| SC | Status | Proof |
|----|--------|-------|
| SC-001 | PASS | `signing.integration` mints conformant token (core code 0) + `token.unit` byte-identity |
| SC-002 | PASS | per-product isolation (A fails under B; A verifies under A), distinct `key_id` |
| SC-003 | PASS | RLS tenant isolation + lifecycle audit (create/revoke security-event) |
| SC-004 | PASS | rotation keeps a prior-key token verifiable under the published keyring |
| SC-005 | PASS | revocation-by-omission from the keyring |
| SC-006 | PASS | fail-closed <k shares / locked custody; no key in error |
| SC-007 | **DEFERRED** | OBJ5/KMS-swap (P2) |
| SC-008 | PASS (inspection) | recovery runbook (backup separation) + custody unit (neither backup alone reconstructs) |

TR-001…TR-015, TR-017, TR-018, **TR-019** (bounded/operator-configurable overlap window + retire — implemented and integration-tested this pass), TR-013 (runbook) all covered. TR-016 (KMS) deferred with the config seam in place.

## Traceability Gaps

- **TR-016 / SC-007 (OBJ5 KMS adapter)** — deferred as P2 (non-blocking for the P1 MVP gate); `createSigner` throws for `signer:"kms"` (seam present, asserted).
- Minor (non-blocking): rotate/retire audit rows are written but not each directly asserted (SC-003 met via create + revoke assertions).

## Code Coverage

- Tool: Vitest v8 coverage. **Global thresholds ≥ 80% lines AND branches (enforced in `vitest.config.ts`) — gate PASSED** (`npm run test:cov` exit 0; the added fail-closed/branch tests brought branches over the line).

## Checklist Fulfillment (spot-check)

- **Security**: fail-closed, private-key non-exposure, Shamir k-of-n, per-product isolation, no-crypto-reimpl — satisfied by code + tests.
- **Data Integrity**: forced RLS, one-active-key partial-unique, status machine, keyring view (public only), no-plaintext-private column — satisfied.
- **API Quality**: apiKey + scope RBAC (403), 400/401/404/409 error model, JWKS no-`d`, tenant/product scoping — satisfied by `routes.integration`.

## Performance / Accessibility / Browser

- **Performance**: signing is sub-ms (Ed25519 + one in-process conformance verify); no dedicated latency NFR beyond the E008 issuance p95 budget (out of this feature's scope). N/A for a service module.
- **Accessibility / Browser**: N/A — no UI (REST/JSON service surface).

## Manual Testing

None required.

## Tool Recommendations

- Install `semgrep` locally to run the SAST gate outside CI; currently CI-only.

## Bug Tasks Generated

None. (The Story Verifier's TR-019 gap was fixed inline this QC pass — bounded configurable overlap window + `retireKey` integration test — rather than deferred to a bug task.)

## Overall Verdict

**PASS (partial — deferred remain).** All P1 objectives (OBJ1–OBJ4) and their success criteria are implemented and verified; build/lint/typecheck, 58/58 tests, dependency security (0 vulns), coverage (≥80%), and PI compliance (Principles I/II/III) all pass. **OBJ5 (cloud-KMS/PKCS#11 adapter, TR-016/017, SC-007) is deferred as P2** — non-blocking for the P1 MVP gate, with the config-driven signer seam already in place. Standing condition (CI-enforced, per prior precedent): **Semgrep SAST runs in CI only**.
