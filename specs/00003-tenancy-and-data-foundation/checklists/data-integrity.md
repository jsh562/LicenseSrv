# Data Integrity Requirements Quality Checklist

> Purpose: A unit test for the SPEC of the multi-tenant data foundation — verifies that requirements adequately specify data-integrity guarantees (tenant scoping, constraints, append-only audit, safe migrations); it does not test running code.

**Created**: 2026-06-27 | **Feature**: [spec.md](../spec.md) | **Domain**: Data Integrity | **Audience**: PR reviewer

## Tenant-Ownership & tenant_id Coverage

- [X] CHK101 Do the requirements state explicitly that EVERY tenant-owned row carries a non-null `tenant_id`, and identify `tenant` itself as the only exempt (root) table? [Completeness, Spec TR-001 / data-model §Conventions]
- [X] CHK102 Is it specified that the `tenant_id`-leading composite index requirement applies to every tenant-owned table without exception, including `audit_log`? [Coverage, Spec TR-004 / data-model §4]
- [X] CHK103 Are requirements defined for how future tenant-scoped tables (E004–E009) must inherit the same `tenant_id` + index + RLS pattern, so the integrity rule is enforced beyond the foundational five entities? [Coverage, data-model §9b]

## FK, Uniqueness & Tenant-Scoped Constraints

- [X] CHK104 Do the requirements define the tenant-scoped uniqueness constraints precisely (e.g., `UNIQUE (tenant_id, email)` on `user`, `UNIQUE (tenant_id, user_id, role)` on `role`) rather than leaving uniqueness scope ambiguous? [Clarity, data-model §1 / §4]
- [X] CHK105 Is it specified that `api_key.key_hash` is GLOBALLY unique (not tenant-scoped) and that auth derives `tenant_id` from the matched row, and is this intentional asymmetry against the otherwise tenant-scoped pattern justified? [Consistency, data-model §4 / §10]
- [X] CHK106 Do the requirements mandate that all `*_id` FKs referencing tenant-owned tables use a composite FK including `tenant_id`, so referential integrity cannot cross a tenant boundary? [Completeness, data-model §2 / §99]
- [X] CHK107 Are requirements defined for FK `ON DELETE` behavior (restricted vs cascade) so a tenant delete cannot orphan or silently cascade across tenant-owned rows outside the GDPR erase path? [Edge-Case, data-model §2 / §8]
- [X] CHK108 Is the intra-tenant constraint on provenance columns (`role.granted_by`, `api_key.created_by`) specified, so a grant/creation reference cannot point at a principal in another tenant? [Edge-Case, data-model §1 role/api_key notes] <!-- Evaluator: Covered by data-model.md §1 — api_key.created_by composite FK (tenant_id, created_by) → user(tenant_id, id); role.granted_by intra-tenant by the same composite-FK technique -->


## Tenant Isolation as an Integrity Boundary

- [X] CHK109 Do the requirements unambiguously define what happens to a tenant-owned query issued with NO resolved tenant scope — refused before SQL AND zero-rows under RLS — rather than running unscoped? [Ambiguity, Spec TR-001 / SC-002 / data-model §3]
- [X] CHK110 Is the single sanctioned cross-tenant (platform-admin) write path specified with its integrity obligations (audited, `security_event`), so the only boundary-crossing route is explicit and traceable? [Completeness, Spec TR-011 / data-model §3]
- [X] CHK111 Are requirements measurable for "100% blocked" cross-tenant access (SC-001), or is the blocking guarantee stated only qualitatively? [Measurability, Spec SC-001 / TR-002]

## Append-Only Audit Integrity

- [X] CHK112 Do the requirements specify whether the audit log's append-only guarantee is enforced by GRANTs, by a `BEFORE UPDATE OR DELETE` trigger, or by both, and is the authoritative mechanism vs. optional hardening clearly distinguished? [Completeness, Spec TR-008 / data-model §5]
- [X] CHK113 Is it specified that the mutation and its corresponding audit-log INSERT occur in the SAME transaction, so an audit-write failure rolls back the mutation (no silent integrity gaps)? [Completeness, Spec SC-005 / data-model §5]
- [X] CHK114 Are the mandatory audit-entry fields (actor, action, target, timestamp) defined as NOT NULL where required, and is the optionality of `before`/`after` snapshots stated? [Clarity, Spec TR-008 / data-model §1 audit_log]
- [X] CHK115 Is the status of the tamper-evidence hash-chain (`prev_hash`) requirement explicit — i.e., clearly marked reserved/deferred and NOT required for MVP — so reviewers do not treat an optional control as a gate? [Consistency, data-model §5 / §92]
- [X] CHK116 Do the requirements define which events MUST be recorded with `security_event = true` (blocked cross-tenant attempts, denied RBAC operations), so the integrity of the alerting signal is specified, not implied? [Coverage, Spec TR-011 / SC-007]

## Migration Integrity (Expand/Contract & Single-Runner)

- [X] CHK117 Is the backward-compatibility requirement quantified — destructive/contract changes deferred at least TWO releases — rather than stated as a vague "backward-compatible" goal? [Measurability, Spec TR-006 / data-model §7]
- [X] CHK118 Do the requirements define what "a prior application version still runs against the migrated schema" means concretely enough to verify (SC-004), including which change classes count as destructive? [Clarity, Spec SC-004 / data-model §7]
- [X] CHK119 Are requirements defined for the advisory-lock single-runner guarantee precisely enough to prevent double-apply — including a STABLE lock key and the behavior of the second (blocked) runner (waits then no-ops)? [Completeness, Spec TR-007 / data-model §7]
- [X] CHK120 Is migration idempotency/repeatability specified so re-running the runner against an up-to-date schema is a safe no-op rather than a re-application? [Edge-Case, Spec SC-003 / data-model §7]
- [X] CHK121 Is it specified that migrations (including RLS policies, roles, grants, and `FORCE ROW LEVEL SECURITY`) run as the OWNER role while the app connects only as the non-owner role, so DDL-time vs runtime privilege separation is unambiguous? [Consistency, Spec TR-002 / data-model §7]
- [X] CHK122 Are requirements defined for migration FAILURE/partial-apply semantics (atomicity, lock release on crash), so a failed migration cannot leave the schema in a half-applied integrity-violating state? [Edge-Case, plan §Error Handling / data-model §7] <!-- Evaluator: Covered by spec TR-015 + data-model §7 "Atomicity & crash safety" (per-migration transaction, advisory-lock auto-release on crash) + SC-012 -->


## Transactional Consistency & RLS Write Checks

- [X] CHK123 Do the requirements specify that every tenant-owned write is re-checked by RLS `WITH CHECK` (not only the repository guard), so a row carrying a foreign `tenant_id` cannot be inserted/updated? [Completeness, Spec TR-002 / data-model §3 / §10]
- [X] CHK124 Is the per-transaction tenant-context model (`SET LOCAL` + reset-on-return / `DISCARD ALL`) specified as a correctness requirement against context bleed, with an observable acceptance criterion? [Measurability, Spec TR-003 / SC-002 / data-model §6]

## GDPR Erase vs Audit-Integrity Tension

- [X] CHK125 Do the requirements resolve the tension between GDPR erasure (TR-012) and append-only audit immutability (TR-008) — e.g., redact `before`/`after`/`target_id` while preserving the immutable actor/action/ts event record? [Consistency, Spec TR-012 / TR-008 / data-model §8]
- [X] CHK126 Is the schema's support for tenant-scoped EXPORT and DELETE of personal data specified completely enough to enumerate which tables/fields are covered (user, role, api_key, audit_log, future tables)? [Coverage, Spec TR-012 / SC-008 / data-model §8]
- [X] CHK127 Are requirements defined for the tenant tombstone (`deleted_at`) lifecycle preceding physical purge, so a "deleted" tenant's residual rows have specified integrity/retention semantics? [Edge-Case, data-model §1 tenant / §8 / §9]
- [X] CHK128 Is it specified that audit `before`/`after` snapshots must be PII-minimized AT WRITE TIME (never snapshot raw secrets/full PII), so erasure obligations do not later conflict with retained snapshots? [Completeness, data-model §8]

## Secret & Identifier Integrity

- [X] CHK129 Do the requirements state that raw secrets (API-key material) are NEVER persisted and only `key_hash` (HMAC) + non-secret `key_prefix` are stored, with the hashing algorithm specified? [Clarity, Spec TR-012 / data-model §Conventions / AD-004]
- [X] CHK130 Is the distinction between `user.email` (directly identifying, erasable) and `email_hash` (pseudonymous lookup) specified clearly enough that integrity of the lookup key survives erasure of the raw field? [Clarity, data-model §1 user / §8]

## Traceability & Cross-Artifact Consistency

- [X] CHK131 Does every data-integrity requirement (TR-001..TR-013) trace to at least one Success Criterion (SC-001..SC-008) and a coverage-map component, so no integrity rule is unverifiable or unowned? [Traceability, Spec §Success Criteria / plan §Requirement Coverage Map] <!-- Evaluator: Covered — new SC-009 (TR-004 index), SC-010 (TR-005 schema), SC-011 (TR-010 module boundary) close the prior gaps; all TR-001..TR-013 now trace to an SC (plan SC→TR map) and a coverage-map component (plan §Requirement Coverage Map) -->

- [X] CHK132 Are the entities and constraints in `data-model.md` fully consistent with the Key Entities and TRs in `spec.md` (no entity, field, or constraint present in one but absent in the other)? [Consistency, Spec §Key Entities / data-model §1]
- [X] CHK133 Is the enum domain for `role.role` (`owner`, `admin`, `viewer`) and the status enums (`tenant_status`, `user_status`, `api_key_status`) specified as a closed set, so integrity-relevant state values are bounded and not open text? [Completeness, data-model §1 / §9]
- [X] CHK134 Are the state-transition rules (e.g., `api_key` active→revoked terminal, no revoked→active) specified so that integrity-invalid transitions are explicitly disallowed rather than left undefined? [Edge-Case, data-model §9]
- [X] CHK135 Is the timestamp/UTC and PK (UUID v7) convention specified uniformly across all entities, so ordering- and identity-dependent integrity assumptions (e.g., audit id≈time ordering) hold? [Consistency, data-model §Conventions / §1 audit_log]
- [X] CHK136 Are requirements free of ambiguity about whether RLS scopes `tenant` by `id` (root) versus other tables by `tenant_id`, so the isolation predicate is unambiguous per table? [Ambiguity, data-model §3]
