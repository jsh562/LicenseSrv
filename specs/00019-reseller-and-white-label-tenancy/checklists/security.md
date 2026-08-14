# CHL001 Security: Reseller and White-label Tenancy
**Created**: 2026-08-14 | **Feature**: [spec.md](../spec.md)

## Tenant Isolation & Downward-Only Access

- [X] CHK001 Do the requirements state that any out-of-subtree reference resolves to 404 with no disclosure of the tenant's existence, in 100% of attempts? [Clarity, FR-004/SC-002] <!-- Evaluator: Covered by spec.md FR-004 + SC-002 (100% of attempts, no existence disclosure) -->
- [X] CHK002 Is the distinction between 404 (out-of-scope, no disclosure) and 403 (RBAC/CSRF deny) unambiguous per endpoint, so a reviewer can tell which applies and why 403 is barred for cross-tenant ids? [Consistency, plan Error Handling/HINT-002] <!-- Evaluator: Covered by plan Error Handling table + HINT-002 (403 leaks existence) + contract error enum comments -->
- [X] CHK003 Is enforcement at the data-access layer (zero rows returned) required as distinct from API-layer checks, rather than left as an implementation note? [Completeness, FR-005/SC-007] <!-- Evaluator: Covered by spec.md FR-005 ("not only at the API") + SC-007 (zero rows at data layer) + data-model INV-2 -->
- [X] CHK004 Is "upward and lateral escalation" defined concretely as parent, platform, and sibling reach so each direction is independently testable? [Testability, FR-005/SC-007] <!-- Evaluator: Covered by spec.md FR-005 (parent/platform/sibling) + SC-007 + HINT-002 (test upward/lateral/IDOR) -->
- [X] CHK005 Is the behavior for an unset/empty tenant GUC (zero rows, access refused not unscoped) stated as a requirement rather than only a schema invariant? [Completeness, data-model INV-1] <!-- Evaluator: Resolved — added Edge Case to spec.md (unset/empty tenant scope → zero rows, fail-closed) elevating data-model INV-1 to a spec requirement -->
- [X] CHK006 Do the requirements state that plane and subtree membership are derived server-side from the session and never from a client-supplied tenant/reseller id? [Clarity, FR-004/005] <!-- Evaluator: Covered by contract securitySchemes (plane + subtree membership derived server-side, never from client-supplied id, FR-004/005) -->
- [X] CHK007 Is IDOR-by-id (a valid but out-of-subtree id) covered as a negative requirement distinct from a non-existent id? [Coverage, HINT-002] <!-- Evaluator: Covered by HINT-002 (IDOR-by-id test) + FR-004/contract (out-of-subtree indistinguishable from non-existent id) -->
- [X] CHK008 Is the one-reseller-level rule (a reseller cannot itself be a sub-tenant; no nesting) specified as an enforced requirement, including the promote-existing conflict case? [Completeness, plan onboarding_conflict/data-model INV-3] <!-- Evaluator: Covered by data-model INV-3 + contract 409 onboarding_conflict (already_reseller|already_sub_tenant) + FR-001 shallow one-level -->


## RBAC & Delegated Authority

- [X] CHK009 Is reseller-admin authority specified as whole-subtree only, with per-sub-tenant subset scoping explicitly out of scope for the MVP? [Clarity, FR-002/Clarifications] <!-- Evaluator: Covered by spec.md FR-002 + Clarifications (whole subtree only; per-sub-tenant scoping deferred) -->
- [X] CHK010 Do the requirements state fail-closed behavior — an unpermitted action is denied AND recorded as a security event? [Completeness, FR-002] <!-- Evaluator: Covered by spec.md FR-002 (failing closed — denied and recorded as a security event) -->
- [X] CHK011 Is the delegated-authority model specified such that reseller reach is a scoped grant (subtree gate → sub-tenant's own scope), never ambient cross-tenant access? [Clarity, AD-001] <!-- Evaluator: Covered by plan AD-001 (gated scoped-descent) + Glossary "Delegated administration...a grant, never ambient cross-tenant access" -->
- [X] CHK012 Are operator-only actions (move a sub-tenant, change quota, suspend/offboard) enumerated as unreachable by a reseller-admin and denied+audited when attempted? [Completeness, FR-003/015, US1-AS4] <!-- Evaluator: Covered by FR-003/FR-015 (operator-only) + US1-AS4 (denied + security event) + contract operator-plane note -->
- [X] CHK013 Is last-owner protection specified for BOTH reseller and sub-tenant tenants, covering removal and demotion into a lock-out? [Completeness, FR-016] <!-- Evaluator: Covered by spec.md FR-016 + Edge Case (last owner cannot be removed/demoted into a lock-out) -->
- [X] CHK014 Is integration with the existing owner>admin>viewer model specified as extend-not-weaken, with read vs mutate minimum roles defined per operation? [Consistency, FR-002/plan API Surface] <!-- Evaluator: Covered by FR-002 (integrate/extend, fail-closed) + plan API Surface + contract per-op x-rbac minRole (read viewer / mutate admin) -->
- [X] CHK015 Is it specified that a reseller can never raise its own quota and only the operator may change it? [Clarity, FR-003] <!-- Evaluator: Covered by spec.md FR-003 (only the operator may change quota; a reseller can never raise its own) -->


## Cross-Tenant Audit

- [X] CHK016 Do the requirements state that EVERY reseller action on a sub-tenant is recorded with dual identity (acting reseller-admin AND target sub-tenant)? [Completeness, FR-009/SC-005] <!-- Evaluator: Covered by spec.md FR-009 + SC-005 (dual identity: acting reseller-admin + target sub-tenant) -->
- [X] CHK017 Is the append-only, tamper-evident property specified such that no role — including owner and reseller-admin — may edit or delete an audit entry? [Clarity, FR-009/SC-005] <!-- Evaluator: Covered by FR-009 ("no role may edit or delete") + US3-AS2 (any role incl. reseller-admin and owner refused) -->
- [X] CHK018 Is it required that dual-identity attribution survives a later sub-tenant transfer (acting-reseller identity stored independently of the mutable parent link)? [Completeness, AD-008] <!-- Evaluator: Covered by plan AD-008 + data-model INV-8 (actor_reseller_id stored independently of mutable parent_reseller_id, survives transfer) -->
- [X] CHK019 Are transfer/move operations required to audit BOTH source and destination, including the branding-context change? [Completeness, FR-015] <!-- Evaluator: Covered by spec.md FR-015 (audit the move + branding-context change on source and destination) -->
- [X] CHK020 Are denied escalation attempts required to be recorded as security events, not silently refused? [Completeness, SC-007/HINT-002] <!-- Evaluator: Covered by SC-007 + FR-005 Edge Case + HINT-002 (denied + security-event audit) -->
- [X] CHK021 Is the auditable-event set complete — lifecycle transitions, denials (RBAC/CSRF/out-of-scope), and successful mutations — rather than only successful actions? [Coverage, plan API Surface/FR-009] <!-- Evaluator: Covered by contract DUAL-IDENTITY AUDIT (every action, every lifecycle transition, every denied attempt RBAC/CSRF/out-of-scope) + FR-009 -->


## CSRF & Session

- [X] CHK022 Is double-submit CSRF required on EVERY mutating endpoint (POST/PUT/PATCH) across all three planes, with GET operations exempt? [Completeness, plan Constraints/contract CsrfToken] <!-- Evaluator: Covered by plan Constraints (CSRF on every mutation) + contract CsrfToken param (required on every POST/PUT/PATCH; GET exempt) -->
- [X] CHK023 Is a missing/mismatched CSRF token specified to fail closed (403, action not applied) AND be audited as a security event? [Clarity, contract CsrfToken/SC-005] <!-- Evaluator: Covered by contract CsrfToken (missing/mismatched → fail-closed 403, action not applied, audited as security event) -->
- [X] CHK024 Are session, plane, and minRole requirements specified for each new admin endpoint rather than assumed from the reused console? [Completeness, plan API Surface] <!-- Evaluator: Covered by contract — every operation carries security sessionCookie + x-rbac {plane, minRole} -->


## Privacy — Metadata-Only Boundary (FR-017)

- [X] CHK025 Is the metadata-only boundary defined by enumerating what a reseller MAY see (admin/provisioning/branding) AND what it MUST NOT (license/usage/activation operational data)? [Clarity, FR-017] <!-- Evaluator: Covered by spec.md FR-017 (admin/provisioning/branding metadata only; MUST NOT expose license/usage/activation data) -->
- [X] CHK026 Is FR-017 stated as a data-exposure prohibition (no endpoint or response exposes operational data) rather than a UI-only omission? [Completeness, FR-017/plan Testing Strategy] <!-- Evaluator: Covered by contract (EXPOSES NO license/usage/activation data) + plan Testing Strategy Security tier (no reseller access to operational data) -->
- [X] CHK027 Is any future broader reseller access to sub-tenant operational data specified to require an explicit, audited, consented grant that is out of scope now? [Clarity, FR-017] <!-- Evaluator: Covered by spec.md FR-017 (future broader access = explicit, audited, consented grant) -->


## Branding Trust Boundary

- [X] CHK028 Is the non-white-labelable trust-signal SET enumerated completely (revocation/tamper/security notices, signing identity, audit records, legal/compliance text)? [Completeness, FR-008/SC-006] <!-- Evaluator: Covered by spec.md FR-008 (revocation/tamper/security notices, signing identity, audit records, legal/compliance text) + SC-006 -->
- [X] CHK029 Is it required that trust signals are never sourced from a branding_profile, so no branding config can spoof or suppress them? [Clarity, FR-008/HINT-004] <!-- Evaluator: Covered by plan HINT-004 (NEVER sourced from branding_profile) + data-model precedence note + FR-008 -->
- [X] CHK030 Is a locked field required to be presented as non-editable WITHOUT revealing that a managing reseller exists? [Consistency, FR-006/014/SC-012, STF-004] <!-- Evaluator: Covered by spec.md FR-006 (non-editable without revealing hierarchy) + STF-004 + SC-012 -->
- [X] CHK031 Is SC-003 ("no vendor branding on partner surfaces") reconciled with the always-shown trust signals so the two requirements are not contradictory? [Consistency, SC-003/FR-008, STF-003] <!-- Evaluator: Covered by SC-003 (scoped to vendor *branding* identity, excepting FR-008 trust signals) + STF-003 resolution -->
- [X] CHK032 Is per-field branding precedence (sub-tenant → reseller → platform) with the reseller-locked exception specified unambiguously and testably? [Testability, FR-007/SC-004] <!-- Evaluator: Covered by spec.md FR-007 + SC-004 (per-field precedence, locked-field exception, confirmed by changing each level) -->


## Domain / Email Ownership Verification

- [X] CHK033 Are ownership-proof requirements specified distinctly for a custom domain (DNS TXT/CNAME) versus an email sender (SPF+DKIM/DMARC alignment proving send-authorization, not mere address control)? [Clarity, FR-013] <!-- Evaluator: Covered by spec.md FR-013 (domain via DNS TXT/CNAME; email sender via SPF + DKIM/DMARC alignment proving authorized sending, not mere address control) -->
- [X] CHK034 Is verify-before-activate specified as a mandatory gate — activation refused until ownership is verified? [Completeness, FR-013/SC-011] <!-- Evaluator: Covered by FR-013 + SC-011 + data-model INV-6 + contract /activate → 409 not_verified until verified -->
- [X] CHK035 Is the "at most one tenant per host" constraint specified as global across all tenants, with a losing claim refused and no cross-tenant disclosure? [Completeness, FR-013/SC-011, data-model INV-5] <!-- Evaluator: Covered by data-model INV-5 (global partial-unique, one binding per host, 409 binding_conflict, no cross-tenant disclosure) + FR-013/SC-011 -->
- [X] CHK036 Is anti-squatting behavior specified — multiple pending claims allowed, but only one may reach verified/active without locking out the true owner? [Coverage, data-model resolved decisions] <!-- Evaluator: Covered by data-model resolved decisions + INV-5 (many pending allowed; ≤1 verified/active; true owner not locked out; first-to-bind wins) -->
- [X] CHK037 Is the DNS challenge token specified as a PUBLIC proof and never a secret? [Clarity, FR-013] <!-- Evaluator: Covered by data-model INV-6 + contract (challenge token is a PUBLIC proof, never a secret) -->


## Principle I — No Crypto/Token Surface

- [X] CHK038 Is it explicit that this feature introduces NO cryptography, signing, or token surface and never alters a license's contents or the signed token? [Clarity, Principle I/plan Instructions Check] <!-- Evaluator: Covered by plan Instructions Check Principle I + spec Assumptions/Excluded + contract (NO cryptography/signing/token change; branding presentation-only) -->
- [X] CHK039 Is it required that already-issued licenses continue to verify offline unchanged, including under a reseller's read-only suspension cascade? [Completeness, FR-011/SC-009] <!-- Evaluator: Covered by spec.md FR-011 + SC-009 (already-issued licenses continue to verify offline under the suspend read-only cascade) -->

