# Security Requirements Quality Checklist: Tenancy and Data Foundation

> A "unit test for the spec" — each item probes whether the security requirements are complete, clear, consistent, measurable, and traceable. It does NOT test code behavior.

**Created**: 2026-06-27 | **Feature**: [spec.md](../spec.md)

## Tenant-Isolation Enforcement (Repository + RLS Defense-in-Depth)

- [X] CHK001 Are the repository-layer and RLS-layer isolation duties stated as two independently-required controls (defense in depth), rather than one being treated as optional given the other? [Consistency, Spec TR-001/TR-002]
- [X] CHK002 Is the behavior of a tenant-owned query issued with an unset/NULL tenant GUC specified unambiguously as "refuse / affect zero rows" rather than "run unscoped"? [Ambiguity, Spec §Edge Cases/data-model §3]
- [X] CHK003 Do the requirements distinguish the repository hard-fail (before SQL) from the RLS zero-row match (at the database), so a reviewer knows both layers are required for the unscoped-query case? [Clarity, Spec TR-001/data-model §3/§6]
- [X] CHK004 Is "tenant-owned" defined precisely enough to classify every entity (e.g., `tenant` as the root with no `tenant_id` vs. `user`/`role`/`api_key`/`audit_log` that carry `tenant_id`)? [Completeness, Spec §Key Entities/data-model §1]
- [X] CHK005 Are requirements stated for write-side isolation (INSERT/UPDATE carrying another tenant's `tenant_id`), not just read-side, via a `WITH CHECK`-equivalent requirement? [Coverage, Spec TR-001/data-model §3]

## RLS Hardening (FORCE RLS, Non-Owner NOBYPASSRLS Role, SECURITY DEFINER/Owner Bypass)

- [X] CHK006 Is `FORCE ROW LEVEL SECURITY` (not merely `ENABLE`) required on every tenant-owned table, and is the rationale (subject the owner to RLS too) captured? [Completeness, Spec TR-002/data-model §3]
- [X] CHK007 Are the application role's required attributes specified completely — non-owner, non-superuser, AND `NOBYPASSRLS` — rather than only "non-owner"? [Completeness, Spec TR-002/plan AD-002]
- [X] CHK008 Is there a requirement that no `SECURITY DEFINER` function or owner-owned view may silently bypass RLS for application queries? [Coverage, Spec §Edge Cases/§Risks]
- [X] CHK009 Is the separation between the migration/owner role and the application role stated as a requirement (DDL vs. traffic), and is each role's privilege set bounded? [Clarity, Spec TR-002/data-model §3/§7]
- [X] CHK010 Is the "current Postgres patch level (RLS CVE exposure)" constraint expressed measurably (e.g., a named minimum/supported patch level or update policy) rather than the vague word "current"? [Measurability, Spec §Technical Constraints/§Risks] <!-- Evaluator: Covered by spec.md §Requirements TR-014 (PostgreSQL 16.4+, patches within 30 days) + Clarifications; plan.md §Technical Context Storage "16.4+" + Coverage Map TR-014 -->

## Connection-Pool Tenant-Context Bleed

- [X] CHK011 Do the requirements mandate per-transaction (not per-session/per-connection) tenant scope so a pooled connection cannot carry a prior request's tenant context? [Completeness, Spec TR-003/data-model §6]
- [X] CHK012 Is a reset-on-connection-return requirement (e.g., `DISCARD ALL` / `RESET app.current_tenant`) stated as an explicit backstop, with its scope defined? [Coverage, Spec TR-003/data-model §6/plan AD-005]
- [X] CHK013 Is the acceptance condition for "no context bleed" expressed measurably (a reused-connection scenario yields zero residual tenant state) rather than asserted qualitatively? [Measurability, Spec SC-002/§Validation Criteria]

## API-Key Custody (HMAC Hash, Never Raw)

- [X] CHK014 Do the requirements state that the raw API key is never persisted and only a hash (HMAC-SHA-256) plus a non-secret prefix is stored? [Completeness, Spec TR-012/plan AD-004/data-model §1]
- [X] CHK015 Is the hashing/lookup algorithm requirement consistent across artifacts (HMAC for `api_key.key_hash` vs. salted SHA-256 for `user.email_hash`), with no conflicting "argon2/HMAC" ambiguity left unresolved? [Consistency, Spec TR-012/plan §Technical Context/data-model §Conventions] <!-- Evaluator: Covered by plan.md §Technical Context "HMAC-SHA-256 (api_key) + salted SHA-256 (user.email_hash); argon2 deferred to E005", consistent with data-model §Conventions/§1/§8 -->
- [X] CHK016 Are requirements defined for API-key lifecycle states (`active → revoked`, terminal, no reactivation) and the rule that a revoked key authenticates no request? [Edge-Case, data-model §9/§1]

## RBAC Gating of Operations

- [X] CHK017 Is the requirement that operations are gated by a principal's tenant-scoped role stated, and is the role set (`owner`, `admin`, `viewer`) and its meaning defined? [Completeness, Spec TR-013/data-model §1]
- [X] CHK018 Is the relationship between coarse API-key `scopes` and RBAC `role` defined so a reviewer can tell which gate governs which operation (and how they combine)? [Clarity, data-model §1/Spec TR-013] <!-- Evaluator: Covered by spec.md §Requirements TR-016 (fail-closed scope AND role; denial by either → security event SC-007) + Clarifications; plan.md Coverage Map TR-016 -->
- [X] CHK019 Is the outcome of an unauthorized-role operation specified (deny, fail-closed) and required to be surfaced as an auditable event? [Coverage, Spec SC-007/TR-011/TR-013]
- [X] CHK020 Are requirements free of ambiguity about cross-tenant role grants — i.e., is it required that a role/grant cannot reference a user in another tenant? [Ambiguity, data-model §1/§2]

## Audit-Log Integrity & Immutability

- [X] CHK021 Is the audit log required to be append-only with the application role granted only INSERT/SELECT and explicitly denied UPDATE and DELETE? [Completeness, Spec TR-008/data-model §5]
- [X] CHK022 Is the set of mandatory audit fields fully specified (actor, action, target, timestamp) and is the optional/required status of before/after snapshots stated? [Completeness, Spec TR-008/data-model §1]
- [X] CHK023 Is it required that every tenant/administrative mutation produces an audit entry in the same transaction (so an audit-write failure rolls back the mutation, leaving no silent gaps)? [Coverage, Spec SC-005/data-model §5]
- [X] CHK024 Is the "no UPDATE/DELETE" guarantee measurable as a grant/permission assertion rather than only a narrative claim, so a reviewer can verify it? [Measurability, Spec SC-005/data-model §10]
- [X] CHK025 Is the boundary of optional immutability hardening (e.g., BEFORE UPDATE/DELETE trigger, `prev_hash` hash-chain) clearly marked as reserved/out-of-MVP so it is not conflated with required behavior? [Clarity, data-model §5]

## Cross-Tenant Access as an Audited Security Event

- [X] CHK026 Is a cross-tenant access attempt required to be both blocked AND surfaced as a security event (audited/alertable), not merely blocked? [Completeness, Spec TR-011/SC-007]
- [X] CHK027 Is the only sanctioned cross-tenant route (the explicit, audited platform-admin path) defined, including how its access is scoped and recorded? [Coverage, Spec §Technical Constraints/data-model §3]
- [X] CHK028 Is it specified under which `tenant_id` a platform-admin cross-tenant action is recorded (e.g., the affected tenant), so audit attribution is unambiguous? [Ambiguity, data-model §1]
- [X] CHK029 Is the `security_event` semantics defined consistently (set on blocked cross-tenant attempts AND denied RBAC operations) across spec and data model? [Consistency, Spec TR-011/SC-007/data-model §5]

## PII Minimization & GDPR Export/Erase

- [X] CHK030 Are lookup-only identifiers required to be stored hashed and minimized, with the specific fields (`user.email_hash`, `display_name`) and their handling named? [Completeness, Spec TR-012/data-model §8]
- [X] CHK031 Does the schema have a stated requirement to support per-tenant export of personal data, and is the export scope (which tables) defined? [Coverage, Spec TR-012/SC-008/data-model §8]
- [X] CHK032 Is the erase requirement specified for the audit-log tension — redacting `before`/`after`/`target_id` of erased subjects while preserving the immutable actor/action/timestamp record? [Edge-Case, data-model §8/§5]
- [X] CHK033 Are tenant-deletion semantics defined (tombstone via `deleted_at` precedes physical purge; restricted `ON DELETE`) so erase ordering is unambiguous? [Clarity, data-model §1/§2/§8]
- [X] CHK034 Is there a requirement that audit before/after snapshots are PII-minimized at write time (never snapshot raw secrets or full PII payloads)? [Coverage, data-model §8]

## SQL-Injection / Authz Scope (SAST)

- [X] CHK035 Is the security-scanning scope defined for this domain (SAST for SQL injection and authz, plus dependency scanning) with the tools named (Semgrep, npm audit)? [Completeness, Spec §Technical Constraints/plan §Testing Strategy]
- [X] CHK036 Are the integration-test conditions that exercise isolation (tenant A cannot see B, forced RLS, unscoped-query refusal, pool no-bleed) stated against a real PostgreSQL, with a measurable pass condition (100% blocked)? [Measurability, Spec SC-001/plan §Testing Strategy]

## Traceability & Consistency Across Artifacts

- [X] CHK037 Does every security requirement (TR-001…TR-003, TR-008, TR-009, TR-011…TR-013) map to at least one Success Criterion and a component/path in the Requirement Coverage Map? [Traceability, Spec §Requirements/§Success Criteria/plan §Requirement Coverage Map]
- [X] CHK038 Are the RLS policy predicates consistent across artifacts (root `tenant` scoped by `id`; tenant-owned tables scoped by `tenant_id = current_setting('app.current_tenant')`)? [Consistency, data-model §3/plan AD-001]
- [X] CHK039 Is the advisory-lock / migration-runner control free of contradictions about who applies migrations (owner role only, single runner, never migrate-on-boot) so a security reviewer can confirm no app-role DDL path exists? [Consistency, Spec TR-006/TR-007/data-model §7]
- [X] CHK040 Are all security terms used in the requirements defined (RLS, FORCE RLS, NOBYPASSRLS, append-only audit, advisory lock) so the spec is interpretable without external assumptions? [Clarity, Spec §Glossary/data-model §Conventions]
