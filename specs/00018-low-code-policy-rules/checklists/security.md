# Security Checklist: Low-Code Policy Rules

**Created**: 2026-08-12 | **Feature**: [spec.md](../spec.md)

## Sandbox Hard Boundary (No Arbitrary Code Execution)

- [X] CHK001 Is the operator/field allow-list specified as a POSITIVE enumeration (only these constructs permitted) rather than a denylist of forbidden ones, so that anything unlisted is refused by default? [Clarity, FR-002/FR-009] <!-- Evaluator: Covered by spec.md §FR-002 (reject any operator/field/construct OUTSIDE the allow-list) + plan.md HINT-001 (the operator allow-list IS the security boundary) + contract PolicyCondition -->
- [X] CHK002 Is the requirement that the sandbox forbids `eval`/`Function`/`vm`/host/globals/I-O stated as an explicit MUST-NOT rather than only as an example of a rejected construct? [Completeness, FR-009] <!-- Evaluator: Covered by spec.md §FR-009 (System MUST fully sandbox — no eval/Function/vm/host access, no I/O, no side effects) -->
- [X] CHK003 Are author-time safety-lint and reject-before-persist defined so that an unsafe rule can NEVER be persisted or reach evaluation? [Completeness, FR-002] <!-- Evaluator: Covered by spec.md §FR-002 (validate + safety-lint BEFORE persist; reject, never persisting or evaluating) -->
- [X] CHK004 Are the resource bounds (evaluation timeout, JSON condition size, AST-depth, complexity) required to be enforced at BOTH author-validation AND evaluation time? [Consistency, FR-002/FR-009] <!-- Evaluator: Covered by spec.md §FR-002 (author-time bounds check) + §FR-009 (rejected at author time AND fails closed at runtime) + plan HINT-001 -->
- [X] CHK005 Are the concrete threshold values (timeout ms, max size/depth/complexity) specified or delegated to a named config with a bounded range, so the sandbox limit is testable rather than open-ended? [Measurability, plan.md NEW-CONFIG/HINT-001] <!-- Evaluator: Covered by spec.md Implementation Signals NEW-CONFIG + plan.md config.ts (named eval resource bounds) + contract condition_too_large details {limit, actual, dimension} -->
- [X] CHK006 For a given sandbox-escape attempt, is the expected disposition unambiguous — refused at author time vs failed-closed at evaluation — so the same probe cannot be both persisted and silently applied? [Clarity, FR-002/FR-009/FR-010] <!-- Evaluator: Covered by spec.md Edge Cases (host/global/eval → rejected at author time, never persisted/evaluated) + §FR-010 (runtime error → fail closed) -->
- [X] CHK007 Is fail-closed-to-base-static-decision required for every error, timeout, and resource-bound breach, with the decision path guaranteed not to crash or block? [Completeness, FR-010/SC-006] <!-- Evaluator: Covered by spec.md §FR-010 + SC-006 (base static decision stands; path neither crashes nor blocks; audited) -->
- [X] CHK008 Is the unguarded absent-context-field case required to fail closed for THAT rule only (not the whole decision), and is the `has()`-guard obligation on usage fields specified? [Coverage, FR-004/FR-010] <!-- Evaluator: Covered by spec.md §FR-004 (usage fields MUST be has()-guarded; unguarded absent access fails THAT rule closed) + §FR-010 -->
- [X] CHK009 Is a cap specified on the number of rules evaluated per issuance (and/or per-tenant rule-set size) to bound total evaluation cost on the signing path, or is unbounded rule-set growth an unaddressed denial-of-service surface? [Completeness, gap vs FR-008/FR-009] <!-- Evaluator: Resolved — added FR-019 (per-tenant max rule-set size + max rules/issuance, author-time reject + fail-closed) + SC-017 to spec.md, NEW-CONFIG/Error-Handling/coverage to plan.md, rule_set_limit_exceeded code to contract -->


## Principle I Boundary (Issuance-Only, No Verifier/Crypto Surface)

- [X] CHK010 Is it stated unambiguously that the engine runs ONLY on the issuance/signing control plane and NEVER in the offline verifier core? [Clarity, FR-008/SC-016] <!-- Evaluator: Covered by spec.md §FR-008 + SC-016 + Scope→Excluded (control plane only; never in the offline verifier core) -->
- [X] CHK011 Is the requirement of NO new cryptography and NO new signing surface stated as an explicit MUST-NOT? [Completeness, FR-018] <!-- Evaluator: Covered by spec.md §FR-018 (System MUST introduce NO new cryptography and NO signing surface) -->
- [X] CHK012 Is the offline token guaranteed byte-unchanged (no LIC1 token-format change) with an already-issued token verifying exactly as before? [Measurability, SC-014/SC-016] <!-- Evaluator: Covered by spec.md SC-014 + SC-016 (already-issued token verifies byte-unchanged; no token bytes changed) -->
- [X] CHK013 Does the spec close the indirect path — is it clear a rule effect can only adjust pre-sign entitlement VALUES via a trusted applier and can never reach the E004 signer or alter token bytes? [Consistency, FR-003/FR-018/HINT-002] <!-- Evaluator: Covered by spec.md §FR-003 (effect descriptor applied by a trusted applier) + FR-018 + plan HINT-002 (post-processes pre-sign; MUST NOT touch signer/token/verifier) -->
- [X] CHK014 Is the deferral of per-request online (E013 validate-time) evaluation stated as an explicit scope boundary so no rule runs on the verify hot path? [Coverage, FR-008/SC-016] <!-- Evaluator: Covered by spec.md §FR-008 (online E013 evaluation DEFERRED) + SC-016 + Scope→Excluded -->


## Deterministic Evaluation as a Security Property

- [X] CHK015 Is determinism required as a security invariant — same context yields same decision, with no wall-clock, randomness, network, or out-of-context lookup? [Completeness, FR-005] <!-- Evaluator: Covered by spec.md §FR-005 (deterministic; no wall-clock/randomness/network/out-of-context lookup) -->
- [X] CHK016 Is the sole time source required to be an INJECTED decision timestamp (never `Date.now()`/ambient clock), and is the evaluator required to expose no time/random/network operator? [Clarity, FR-005/HINT-001] <!-- Evaluator: Covered by spec.md §FR-005 (time only from injected decision timestamp) + plan HINT-001/AD-007 (no time/random/network operator; never Date.now()) -->
- [X] CHK017 Is idempotent re-evaluation specified as a verifiable outcome (re-running the same rule set against the same context returns an identical decision)? [Measurability, SC-003] <!-- Evaluator: Covered by spec.md SC-003 (same rule set + same context twice → identical decision) -->
- [X] CHK018 Is deterministic conflict resolution (highest-priority-wins, stable rule-id/version tiebreak, exactly one effect per entitlement, no chaining) specified so overlapping rules cannot yield an order-dependent outcome? [Consistency, FR-006/SC-010] <!-- Evaluator: Covered by spec.md §FR-006 (highest-priority-wins, stable tiebreak, exactly one effect, no chaining) + SC-010 -->


## Effect Bounding (Over-Permissive-Effect Prevention)

- [X] CHK019 Is the authored per-entitlement MAXIMUM defined as the security ceiling an applied effect can never exceed, at author time AND (as defense-in-depth clamp) at evaluation? [Completeness, FR-007/SC-004] <!-- Evaluator: Covered by spec.md §FR-007 (refused at author time; clamped at evaluation as defense-in-depth) + SC-004 + data-model INV-4 -->
- [X] CHK020 Is it required that a rule can never grant an entitlement the plan does not define, nor toggle a boolean the plan does not mark rule-eligible? [Coverage, FR-003/SC-015] <!-- Evaluator: Covered by spec.md §FR-003 (toggle only where plan marks rule-eligible) + FR-007 + SC-015 -->
- [X] CHK021 Is the effect surface specified as a CLOSED, typed, allow-listed set (adjust-limit / toggle-boolean / select-tier with range-validated values) returned as a descriptor to a trusted applier, never a free state mutation? [Clarity, FR-003] <!-- Evaluator: Covered by spec.md §FR-003 (closed, allow-listed, typed effect descriptor applied by a trusted applier) + plan AD-002 + contract PolicyEffect -->
- [X] CHK022 Is the authored maximum itself constrained (required ≥ base plan value) and its authoring/change audited, so the ceiling cannot be raised arbitrarily to defeat the bound? [Completeness, gap vs FR-007/data-model INV-4] <!-- Evaluator: Resolved — added FR-021 (authored-max authoring is admin-only, CSRF-protected, audited; validated ≥ base AND within an absolute cap) + SC-019 to spec.md, note to data-model INV-4, Error-Handling/coverage to plan.md -->
- [X] CHK023 Is select-tier required to be constrained to plan-defined tiers only, so a rule cannot select an undefined tier? [Coverage, FR-003/FR-007/SC-015] <!-- Evaluator: Covered by spec.md §FR-003 (select a tier from the plan-defined tiers) + FR-007 + SC-015 -->


## Tenant Isolation, RBAC, and CSRF

- [X] CHK024 Is forced RLS (fail-closed) specified such that an unset tenant GUC yields ZERO rows on the policy tables? [Measurability, FR-015/SC-012] <!-- Evaluator: Covered by spec.md §FR-015 + SC-012 + data-model INV-1/RLS DDL (unset GUC → NULL → zero rows) -->
- [X] CHK025 Is a cross-tenant rule reference required to resolve to not-found (404) rather than leak existence, for read, author, and evaluate paths? [Clarity, FR-015/SC-012] <!-- Evaluator: Covered by spec.md §FR-015 + SC-012 + contract (cross-tenant ruleKey/licenseId/entitlementId → 404 not_found, never 403) -->
- [X] CHK026 Is admin-only authoring/editing/enabling specified with a viewer explicitly unable to author, on the console session + RBAC surface? [Completeness, FR-016/SC-011] <!-- Evaluator: Covered by spec.md §FR-016 (admin authors/edits/enables; viewer reads) + SC-011 + contract x-rbac -->
- [X] CHK027 Is a double-submit CSRF token required on every mutating rule operation, failing closed with 403 on a missing/mismatched token? [Completeness, FR-016/SC-011] <!-- Evaluator: Covered by spec.md §FR-016 (double-submit CSRF, fail-closed 403) + SC-011 + contract CsrfToken parameter -->
- [X] CHK028 Is each denied or CSRF-failed attempt required to be audited as a distinct security event? [Coverage, FR-016] <!-- Evaluator: Covered by spec.md §FR-016 (MUST audit each denied or CSRF-failed attempt as a security event) -->


## PII / Secret Non-Exposure

- [X] CHK029 Is the referenceable decision context defined as an EXPLICIT allow-listed field schema that doubles as the minimization boundary? [Completeness, FR-004/FR-017] <!-- Evaluator: Covered by spec.md §FR-004 (EXPLICIT allow-listed field schema = type-check target AND minimization boundary) + contract DecisionContext (additionalProperties:false) -->
- [X] CHK030 Is it required that no secret, signing key, or PII (beyond a pseudonymous reference) appears in any rule condition, decision context, response, log, or audit entry? [Coverage, FR-017/SC-013] <!-- Evaluator: Covered by spec.md §FR-017 + SC-013 (no secret/signing key/PII beyond a pseudonymous reference in expression/context/response/log/audit) -->
- [X] CHK031 Is the "pseudonymous reference" allowance defined precisely enough to distinguish an acceptable customer reference from disallowed PII? [Clarity, FR-017] <!-- Evaluator: Covered by contract DecisionContext.license.customerReference (pseudonymous ref, never name/email/card/PII) + FR-017; SECRECY & PII INVARIANTS section -->
- [X] CHK032 Is it stated that a rule expression is structurally unable to read or emit a secret (not merely discouraged)? [Consistency, FR-017/SC-013] <!-- Evaluator: Covered by spec.md §FR-017 (a rule expression MUST NOT be able to read or emit a secret) + §FR-004 allow-listed context structurally excludes secrets -->


## Audit Integrity and Dry-Run Injection Surface

- [X] CHK033 Is the evaluation trail required to be append-only, tenant-scoped, RLS-protected, and mode-marked (enforced | preview | dry-run)? [Completeness, FR-014] <!-- Evaluator: Covered by spec.md §FR-014 (ONE unified, tenant-scoped, RLS-protected, append-only trail, mode-marked) + data-model INV-8 -->
- [X] CHK034 Is every evaluation required to record the fired rule id+version AND the considered-but-not-applied rule ids+versions, plus an input snapshot/hash and resolved decision? [Coverage, FR-014/FR-006/SC-009] <!-- Evaluator: Covered by spec.md §FR-014 + FR-006 + SC-009 (fired rule id+version, considered-but-not-applied ids+versions, input snapshot/hash, resolved decision) -->
- [X] CHK035 Is the audit trail required to contain no secrets or PII, consistent with the minimization boundary? [Consistency, FR-014/FR-017] <!-- Evaluator: Covered by spec.md §FR-014 (all without secrets or PII) + FR-017 + data-model INV-10 -->
- [X] CHK036 Is the dry-run supplied-context itself required to be schema-validated and size/depth-bounded, so an admin cannot inject a malicious or oversized context that escapes the evaluation resource bounds? [Completeness, gap vs FR-013/FR-002] <!-- Evaluator: Resolved — added FR-020 (dry-run supplied context validated vs the SAME allow-listed schema + SAME size/AST-depth/field-count bounds as the real context; rejected before evaluation) + SC-018 to spec.md, Error-Handling/coverage to plan.md -->
- [X] CHK037 Is it specified that a dry-run persists an audit row but changes no live decision, license, or rule-enforcement state, and that its synthetic license reference is nullable/marked? [Coverage, FR-013/FR-014/SC-007] <!-- Evaluator: Covered by spec.md §FR-013 + FR-014 (nullable/synthetic license ref, mode-marked dry-run) + SC-007 + data-model INV-9 -->
- [X] CHK038 Is the rule/lifecycle change trail (author/edit/enable/disable/version) required to be audited alongside evaluations so a security-relevant rule change is always traceable? [Traceability, FR-014/FR-016] <!-- Evaluator: Covered by spec.md §FR-014 (MUST record every rule author/edit/enable/disable/version change on the audit trail) + FR-016 -->

