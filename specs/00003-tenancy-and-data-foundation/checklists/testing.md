# Testing Requirements-Quality Checklist: Tenancy and Data Foundation

> A "unit test for the spec": each item asks whether the requirements specify adequate, verifiable testability and coverage for the multi-tenant data foundation — not whether code passes.

**Created**: 2026-06-27 | **Feature**: [spec.md](../spec.md)

## Coverage-Target Completeness

- [X] CHK201 Is the ≥80% coverage threshold stated as a measurable requirement bound to a named scope (`src/server/`) rather than a generic aspiration? [Measurability, Spec §Technical Constraints / Plan §Testing Strategy]
- [X] CHK202 Is the coverage measurement tool (c8) and the artifact it covers identified unambiguously so a reviewer can confirm the threshold applies to the right subtree? [Clarity, Plan §Testing Strategy]
- [X] CHK203 Does the coverage requirement specify what counts toward the metric (e.g., lines/branches) so "≥80%" is not interpretable in conflicting ways? [Ambiguity, Spec §Technical Constraints] <!-- Evaluator: Covered by spec.md §Clarifications ("Lines AND branches both ≥ 80% over src/server/") + plan.md §Testing Strategy Coverage row -->
- [X] CHK204 Is every P1 objective (OBJ1 isolation, OBJ2 schema/migrations, OBJ3 audit/skeleton) covered by at least one stated test obligation, so coverage is not concentrated only in low-risk modules? [Coverage, Spec §Technical Objectives]

## Isolation Guarantees Tied to Verifiable Tests

- [X] CHK205 Is each isolation guarantee — tenant A cannot read tenant B, A cannot write B, unscoped query refused, pool no-bleed — tied to a distinct, verifiable validation criterion rather than bundled into one claim? [Completeness, Spec §OBJ1 / TR-001/TR-003]
- [X] CHK206 Does the requirement state that the cross-tenant read/write blocked guarantee is verified across BOTH the repository layer AND the RLS layer (defense in depth), not just one? [Coverage, Spec §SC-001 / TR-001/TR-002]
- [X] CHK207 Is the unscoped-query-refusal behavior defined precisely enough to test (hard-fail at repository before SQL, and zero-rows under RLS) so a reviewer can confirm both legs are asserted? [Measurability, Spec §SC-002 / data-model §3/§10]
- [X] CHK208 Is the pool no-bleed guarantee expressed as a reproducible scenario (connection reused across requests carries no prior tenant context) that a test can deterministically exercise? [Edge-Case, Spec §TR-003 / data-model §6]
- [X] CHK209 Are the "100% blocked" / "never" absolute claims in SC-001/SC-002 paired with a defined test population so the assertion is falsifiable rather than rhetorical? [Ambiguity, Spec §SC-001/SC-002] <!-- Evaluator: Covered by spec.md §SC-001 (every tenant-owned table, representative read/write ops, ≥2 distinct tenants) + SC-002 (pool-reuse test) -->

## RLS and Role Model Against Real Postgres

- [X] CHK210 Does the testing requirement mandate execution against a real PostgreSQL (Testcontainers), explicitly excluding mocked DB behavior for the isolation and RLS guarantees? [Coverage, Spec §Technical Constraints / Plan §Testing Strategy]
- [X] CHK211 Is there a stated obligation to verify `FORCE ROW LEVEL SECURITY` is in effect (not merely `ENABLE`) so an owner/`SECURITY DEFINER` path cannot silently bypass it? [Completeness, Spec §TR-002 / data-model §3]
- [X] CHK212 Does a requirement specify that tests run as the non-owner, non-superuser, `NOBYPASSRLS` application role rather than an owner/superuser that would mask RLS failures? [Consistency, Spec §TR-002 / Plan §AD-002] <!-- Evaluator: Covered by plan.md §Testing Strategy Integration row (tests connect as the non-owner app role `licensesrv_app`, never owner/superuser) -->
- [X] CHK213 Is the privileged-role / non-owner-role boundary itself a testable assertion (owner role does DDL, app role gets only scoped access) so the role model is verified, not assumed? [Traceability, Spec §Edge Cases / data-model §3 Roles] <!-- Evaluator: Covered by plan.md §Testing Strategy Integration row (tests assert the app role is denied DDL) -->

## Migration and Audit Test Obligations

- [X] CHK214 Is the advisory-locked single-runner guarantee tied to a verifiable concurrent-runner scenario (two starters → exactly one applies, other waits/no-ops) rather than a narrative claim? [Measurability, Spec §SC-003 / TR-007 / data-model §7]
- [X] CHK215 Is the expand/contract backward-compatibility guarantee expressed as a testable obligation (a prior app version runs unchanged against the migrated schema) with a defined "prior version" reference point? [Edge-Case, Spec §SC-004 / TR-006] <!-- Evaluator: Covered by spec.md §SC-004 (the immediately preceding released schema, N-1, runs unchanged against the migrated schema) -->
- [X] CHK216 Is the append-only audit denial defined as a verifiable assertion that the application role is refused UPDATE and DELETE on `audit_log`, distinct from the audit-write-on-mutation requirement? [Completeness, Spec §SC-005 / TR-008 / data-model §5]
- [X] CHK217 Does a requirement make the audit-on-every-mutation guarantee testable (each tenant/admin mutation produces exactly one append-only entry within the same transaction) so missing-audit gaps are detectable? [Coverage, Spec §SC-005 / data-model §5]

## RBAC and Security-Scanning Requirements

- [X] CHK218 Is RBAC gating stated as a testable requirement (an unauthorized role is denied the operation) tied to specific roles, not a general "operations are gated" statement? [Measurability, Spec §SC-007 / TR-013]
- [X] CHK219 Is the blocked cross-tenant attempt's security-event recording (audited/alertable, `security_event = true`) defined as a verifiable outcome distinct from the plain block? [Completeness, Spec §TR-011 / SC-007]
- [X] CHK220 Are the security-scanning gates (`npm audit` and Semgrep/SAST) stated as standing requirements with a defined pass condition, not just listed tooling? [Measurability, Spec §Technical Constraints / Plan §Testing Strategy] <!-- Evaluator: Covered by plan.md §Testing Strategy Security row (gate fails on any high/critical advisory or high-severity SAST finding) -->
- [X] CHK221 Does a requirement scope what Semgrep must cover (e.g., SQL injection and authz) so the SAST obligation is verifiable rather than open-ended? [Clarity, Plan §Testing Strategy]

## Determinism, Reproducibility, and Traceability

- [X] CHK222 Do the test requirements demand determinism/reproducibility against the real DB (e.g., isolated container state per run, no shared mutable fixtures) so isolation results are not flaky or order-dependent? [Consistency, Plan §Testing Strategy] <!-- Evaluator: Covered by plan.md §Testing Strategy Integration mock-boundary (real Postgres, fresh container per run — deterministic) -->
- [X] CHK223 Is each P1 success criterion (SC-001…SC-008) traceable to a specific requirement (TR-###) and a named test tier, with no success criterion left without a verification path? [Traceability, Spec §Success Criteria] <!-- Evaluator: Covered by plan.md §Requirement Coverage Map "SC → TR → test tier" mapping (SC-001..SC-012 each mapped to TR-### and a test tier) -->
- [X] CHK224 Are the GDPR export/erase obligations (export per tenant, audit redaction with preserved event record) expressed as verifiable test outcomes rather than design notes? [Coverage, Spec §SC-008 / TR-012 / data-model §8] <!-- Evaluator: Covered by plan.md §Testing Strategy Integration scope (GDPR export/erase) + SC-008 → TR-012 → Integration(GDPR) mapping -->
