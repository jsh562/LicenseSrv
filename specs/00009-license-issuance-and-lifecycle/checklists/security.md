# Security Requirements Quality Checklist: License Issuance and Lifecycle
**Created**: 2026-07-08 | **Feature**: [spec.md](../spec.md)

## Signing-Key Non-Exposure

- [X] CHK001 Is it unambiguously required that no issuance/lifecycle response ever contains signing-key (private) material, only the signed public token? [Clarity, FR-003/SC-010] <!-- Evaluator: Covered by spec.md FR-003 + SC-010; contracts SECRECY INVARIANT -->
- [X] CHK002 Does the non-exposure requirement explicitly cover logs AND audit entries, not just API responses? [Completeness, SC-010/FR-014] <!-- Evaluator: Covered by spec.md FR-003 ("any response, log, or audit entry") + SC-010 -->
- [X] CHK003 Is the terminology distinguishing the "signing key" (private) from the "signed license key" (public token) defined so the prohibition cannot be misread? [Clarity, Glossary/SC-010] <!-- Evaluator: Covered by spec.md SC-010 (signing key vs signed license key/public token) + FR-003 + Glossary "Signed license key" -->
- [X] CHK004 Is the non-exposure guarantee expressed in a testable form (a defined way to assert absence of key material across responses, logs, and audit)? [Testability, SC-010] <!-- Evaluator: Covered by spec.md SC-010 (measurable) + plan.md Testing Strategy Security tier ("assert no signing-key material in any response/log") -->

## Offline Verifiability & Crypto Conformance

- [X] CHK005 Is it required that an issued token verifies offline against the E001 core rather than a bespoke verifier? [Completeness, FR-003/SC-002] <!-- Evaluator: Covered by spec.md FR-003/SC-002 + Scope Excluded (offline verification owned by E001) + plan.md Integration Points (E001) -->
- [X] CHK006 Is it explicit that no cryptography is reimplemented (issuance consumes the E004 signer; verification is the E001 core), including a conformance check before a token is returned? [Consistency, plan Instructions Check/AD-002] <!-- Evaluator: Covered by plan.md Instructions Check + AD-002 (signer conformance-verifies before return) + Summary -->
- [X] CHK007 Is the required token format and version for an issued license specified unambiguously? [Clarity, FR-002/FR-003] <!-- Evaluator: Covered by spec.md FR-003 (platform token format) + Glossary/Assumptions (Ed25519); LIC1 format + token_version in plan.md/data-model.md; byte format deferred to E001 per Scope -->


## Signer-Unavailable Fail-Closed

- [X] CHK008 Is the fail-closed rule stated as a single unambiguous condition (no active signing key OR locked/unavailable signer → issuance fails)? [Clarity, FR-004] <!-- Evaluator: Covered by spec.md FR-004 ("active signing key ... and an available (unlocked) signer; when either is missing, issuance MUST fail") -->
- [X] CHK009 Is it required that no partial or orphaned license is created when signing cannot complete? [Completeness, FR-004] <!-- Evaluator: Covered by spec.md FR-004 ("create no license") + plan.md HINT-005/Error Handling (no license created) -->
- [X] CHK010 Are both trigger conditions (missing active key, locked signer) enumerated with a "clear reason" precise enough to be testable? [Completeness, FR-004/Edge Cases] <!-- Evaluator: Covered by spec.md FR-004 + Edge Cases + contracts signer_unavailable reasons (no_active_key | signer_locked) -->


## Multi-Tenant Isolation

- [X] CHK011 Is strict tenant-scoping required for BOTH licenses and customers, with no cross-tenant read or write? [Completeness, FR-015] <!-- Evaluator: Covered by spec.md FR-015 ("All licenses and customers MUST be strictly tenant-scoped — no cross-tenant read or write") -->
- [X] CHK012 Is the no-cross-tenant guarantee stated specifically for the retrieve-key and registry-list paths? [Clarity, FR-012/FR-015] <!-- Evaluator: Covered by spec.md FR-012 (registry browse + retrieve-key) under blanket FR-015 + SC-009/US5 Independent Test; contracts resolve cross-tenant ids to 404 on all routes -->
- [X] CHK013 Is tenant isolation expressed as a measurable outcome (a second tenant sees none of the first tenant's licenses/customers)? [Testability, SC-009] <!-- Evaluator: Covered by spec.md SC-009 ("one tenant never sees another's") + US5 Independent Test -->
- [X] CHK014 Is behavior on unscoped or missing tenant context defined as fail-closed (no rows) rather than left unspecified? [Completeness, FR-015] <!-- Evaluator: Resolved — amended spec.md FR-015 to require fail-closed behaviour when tenant context is absent/unresolved (unscoped request returns no rows, performs no write); reinforces data-model.md §10 (unset GUC -> zero rows) -->


## Fail-Closed RBAC & Audited Denial

- [X] CHK015 Are the required roles per action (admin+ for issue and lifecycle, viewer for registry read) unambiguously specified? [Clarity, FR-016] <!-- Evaluator: Covered by spec.md FR-016 + contracts x-rbac (minRole) per operation (viewer read / admin write) -->
- [X] CHK016 Is it required that an unauthorized action is both denied AND recorded as a security event? [Completeness, FR-016/SC-009] <!-- Evaluator: Covered by spec.md FR-016 ("denied and recorded as a security event") + SC-009 -->
- [X] CHK017 Is a default-deny (fail-closed) posture stated for roles or actions not explicitly permitted? [Completeness, FR-016] <!-- Evaluator: Covered by spec.md FR-016 (allow-list roles + "an unauthorized action MUST be denied") + plan.md Instructions Check ("fail-closed RBAC") + contracts RBAC (fail-closed) -->
- [X] CHK018 Is the distinction between authentication failure and authorization denial specified? [Clarity, plan Error Handling] <!-- Evaluator: Covered by plan.md Error Handling (401 unauthenticated vs 403 forbidden + recordSecurityEvent on authz denial) + contracts Unauthorized vs Forbidden -->


## Audit Coverage

- [X] CHK019 Is auditing required for every issuance and lifecycle action, with the action set enumerated (issue, revoke, suspend, reinstate, transfer, reissue)? [Completeness, FR-014] <!-- Evaluator: Resolved — amended spec.md FR-014 to add `reissue` to the enumerated audited action set (was issue/revoke/suspend/reinstate/transfer); aligns with data-model.md §13 -->
- [X] CHK020 Are the required audit fields (actor, action, target) specified? [Clarity, FR-014] <!-- Evaluator: Covered by spec.md FR-014 ("with actor, action, and target") -->
- [X] CHK021 Is the append-only / immutable property of the audit trail stated as a requirement? [Completeness, FR-014/data-model §10] <!-- Evaluator: Covered by spec.md FR-014 ("append-only audit log") + data-model §10 (audit_log INSERT/SELECT-only, append-only) -->
- [X] CHK022 Is it specified whether refused actions and customer erasure/anonymization are audited, not only successful mutations? [Clarity, FR-019/FR-014] <!-- Evaluator: Resolved — amended spec.md FR-014 to audit customer register/erase (anonymize or hard-delete) without recording erased PII, and to clarify that authorization-refused actions are security events (FR-016) while refused lifecycle transitions are non-mutating -->


## Snapshot Integrity & Immutability

- [X] CHK023 Is it unambiguously required that catalog edits after issuance never mutate an already-issued license? [Clarity, FR-006/SC-003] <!-- Evaluator: Covered by spec.md FR-006 + SC-003 + data-model §5 (snapshot semantics) -->
- [X] CHK024 Are the immutable snapshot fields enumerated (entitlements, seat limit, product/plan/customer identity, issued-at, expiry, license id)? [Completeness, FR-002] <!-- Evaluator: Covered by spec.md FR-002 (enumerates entitlement keys/values, seat limit, product/plan/customer identity, issue timestamp, expiry, unique license id) -->
- [X] CHK025 Is it consistent which license attributes may legitimately change post-issue (status, customer, transfer count, token on reissue) versus which are frozen? [Consistency, FR-006/FR-009/FR-018] <!-- Evaluator: Covered by spec.md FR-006 (frozen snapshot), FR-007/008 (status), FR-009 (customer/transfer count), FR-018 (token/keyId on reissue) + data-model §4 (signed vs row-only) -->
- [X] CHK026 Is reissue constrained to re-sign the same terms without changing the license's identity, entitlements, or expiry? [Clarity, FR-018] <!-- Evaluator: Covered by spec.md FR-018 ("re-signing the same terms ... without changing the license's identity or terms") + data-model §5/§7 -->


## Lifecycle-Transition Safety

- [X] CHK027 Is the complete set of valid lifecycle transitions defined as a well-formed state machine? [Completeness, FR-010] <!-- Evaluator: Covered by spec.md FR-010 + FR-007/008/009 + data-model §7 (full transition table) + contracts LIFECYCLE STATE MACHINE -->
- [X] CHK028 Is every invalid transition required to be refused with a clear, specific reason while leaving the license unchanged? [Clarity, FR-010/SC-008] <!-- Evaluator: Covered by spec.md FR-010 ("refused with a clear, specific reason") + SC-008 ("leaves the license unchanged") -->
- [X] CHK029 Is `revoked` defined as terminal (no reinstate, transfer, or reissue) with revoke-of-revoked specified as an idempotent no-op rather than an error? [Consistency, FR-007] <!-- Evaluator: Covered by spec.md FR-007 (terminal revoked; no reinstate/transfer/reissue; re-revoke = no-op) + data-model §7 -->
- [X] CHK030 Is the per-license transfer limit (with configurable default) and its over-limit refusal specified? [Completeness, FR-009] <!-- Evaluator: Covered by spec.md FR-009 ("per-license transfer limit (with a configurable default); a transfer that would exceed the limit MUST be refused") -->


## Customer PII Minimization & GDPR Erasure

- [X] CHK031 Is "minimal PII / pseudonymous" defined precisely enough to be enforceable (which fields count as PII)? [Clarity, FR-011] <!-- Evaluator: Resolved — amended spec.md FR-011 to define pseudonymous (tenant-supplied ref, not a natural-person id) and enumerate the only PII fields as optional display name + contact email (the fields cleared on anonymization); aligns with data-model §2/§6 -->
- [X] CHK032 Is customer erasure required to honor data-subject deletion, with the anonymize-vs-hard-delete rule tied to referential integrity with issued licenses? [Completeness, FR-019] <!-- Evaluator: Covered by spec.md FR-019 (deletion or anonymization; anonymize-if-licensed vs hard-delete, referential-integrity-tied) + data-model §6 -->
- [X] CHK033 Is the one-way / irreversible nature of anonymization specified? [Completeness, data-model §6] <!-- Evaluator: Covered by data-model §6 ("Anonymization is one-way: active -> anonymized only") + contracts ("Anonymization is irreversible") -->


## Offline-Revocation-Gap Disclosure

- [X] CHK034 Is the offline revocation gap explicitly stated as a disclosed MVP limitation rather than hidden? [Completeness, Edge Cases/Risks] <!-- Evaluator: Covered by spec.md Edge Cases ("disclosed MVP limitation, not a defect") + Risks ("communicated to buyers, not hidden") -->
- [X] CHK035 Is it clear that a revoked or suspended license's already-distributed token still verifies offline until it expires? [Clarity, Edge Cases] <!-- Evaluator: Covered by spec.md Edge Cases ("a revoked/suspended license's already-distributed token still verifies offline until it expires") + contracts OFFLINE REVOCATION GAP -->
- [X] CHK036 Is the mitigation and scope boundary (revocation taking effect online via E009/E013; short-TTL later) unambiguous? [Consistency, Risks/Scope Excluded] <!-- Evaluator: Covered by spec.md Edge Cases/Risks (revocation takes effect online E009/E013; short-TTL + online renewal later) + Scope Excluded (online validation/renewal/revocation-list owned by E013) -->

