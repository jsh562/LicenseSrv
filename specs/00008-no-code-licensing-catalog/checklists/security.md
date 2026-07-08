# Security Checklist: No-Code Licensing Catalog
**Created**: 2026-07-07 | **Feature**: [spec.md](../spec.md)

## Multi-Tenant Isolation

- [X] CHK001 Are cross-tenant read AND write prohibitions specified for every catalog entity (product, plan, entitlement, plan_entitlement)? [Completeness, FR-010] <!-- Evaluator: Covered by spec.md §FR-010 + contracts §Tenant Scoping + data-model §9 (forced RLS on all four tables) -->

- [X] CHK002 Is it specified that the owning tenant is resolved from the session and can never be widened by a caller-supplied path/query parameter? [Clarity, contracts §Tenant Scoping] <!-- Evaluator: Covered by contracts §Tenant Scoping (no tenant path/query param; tenant resolved from session, never widened by caller) -->

- [X] CHK003 Is the required behavior defined when the tenant scope is unset or absent (fail-closed to zero rows rather than an unscoped query)? [Completeness, data-model §9] <!-- Evaluator: Covered by data-model §9 (unset app.current_tenant GUC → NULL → predicate matches zero rows; unscoped query refused, never run unscoped) -->

- [X] CHK004 Is the cross-tenant reference outcome specified as not-found rather than a response that confirms the entity exists in another tenant? [Clarity, plan §Error Handling Strategy] <!-- Evaluator: Covered by plan §Error Handling Strategy (Not found / cross-tenant → RLS 0 rows → 404 not_found) + contracts §NotFound ("does not exist within the session's tenant") -->

- [X] CHK005 Are the tenant-isolation requirements consistent across FR-010, acceptance scenario US5-AC3, and SC-007? [Consistency, SC-007] <!-- Evaluator: Covered by spec.md — FR-010 (no cross-tenant read/write), US5-AC3 (tenant B sees none of tenant A), SC-007 (never visible/editable from another tenant); mutually consistent -->

- [X] CHK006 Is isolation specified for child entities whose referenced parent lives in another tenant (a plan bound to another tenant's product, a value bound to another tenant's entitlement)? [Completeness, data-model §6] <!-- Evaluator: Covered by data-model §6 + §1 (composite tenant-scoped FKs on plan and plan_entitlement make binding to another tenant's parent structurally impossible) -->


## Fail-Closed RBAC & Authorization

- [X] CHK007 Is a minimum required role specified for every catalog operation (each read and each mutation), leaving no operation with an undefined authority level? [Completeness, plan §API Surface Summary] <!-- Evaluator: Covered by contracts x-rbac.minRole on every one of the 19 operations (viewer for GET, admin for mutations) + plan §API Surface Summary Auth column -->

- [X] CHK008 Is the viewer-read / admin-write authority boundary stated unambiguously, including whether "admin or higher" is intended to include owner? [Clarity, FR-011] <!-- Evaluator: Covered by contracts §RBAC (roles owner > admin > viewer; mutations require admin or higher → owner included) + FR-011 + data-model §8 (owner/admin write, viewer read) -->

- [X] CHK009 Is the handling of an unauthorized mutation specified as an explicit fail-closed denial (not a silent no-op) for every mutating operation? [Completeness, FR-011] <!-- Evaluator: Covered by FR-011 (unauthorized mutation MUST be denied) + contracts §Forbidden (403, denied fail-closed) on every POST/PATCH/PUT/DELETE -->

- [X] CHK010 Is it required that a denied privileged action be recorded as a security event, and is that event's required content specified? [Completeness, FR-011] <!-- Evaluator: Resolved via autopilot — the "record a security event" requirement existed (FR-011) but its content was unspecified; added spec.md FR-019 specifying the required content (actor, attempted action, target, denial reason) and its append-only nature, consistent with E002/E005 posture -->

- [X] CHK011 Are the roles and their ordering (owner > admin > viewer) defined consistently across spec, plan, and the contract's x-rbac declarations? [Consistency, contracts §RBAC] <!-- Evaluator: Covered by spec Assumptions (owner/admin/viewer) + plan Instructions Check (viewer read / admin write; owner/admin write) + contracts §RBAC (owner > admin > viewer, x-rbac.minRole); consistent -->

- [X] CHK012 Is the distinction between unauthenticated (401) and unauthorized (403) outcomes specified so each is independently testable? [Clarity, plan §Error Handling Strategy] <!-- Evaluator: Covered by plan §Error Handling Strategy (401 vs 403) + contracts §Unauthorized (401 unauthenticated) and §Forbidden (403 forbidden) with distinct enumerated codes -->


## Audit Coverage

- [X] CHK013 Is every catalog mutation type (create, edit, archive, value set, value remove) required to be audited, with no mutation exempted? [Completeness, FR-012] <!-- Evaluator: Covered by FR-012 ("Every catalog mutation MUST be written to the append-only audit log") + contract (each mutation incl. setPlanEntitlementValue and removePlanEntitlement marked "Audited (FR-012)") -->

- [X] CHK014 Are the required audit record fields (actor, action, target) specified for each mutation? [Clarity, FR-012] <!-- Evaluator: Covered by FR-012 + SC-010 (actor, action, target) + data-model §12 (append-only mutations with actor/action/target) -->

- [X] CHK015 Is the append-only property of the audit log stated as a requirement (no update or delete of audit rows)? [Completeness, data-model §9] <!-- Evaluator: Covered by FR-012 ("append-only audit log") + data-model §9/§Conventions (audit_log stays INSERT/SELECT-only grant → append-only, no UPDATE/DELETE) -->

- [X] CHK016 Is it specified that the audit entry is written atomically within the same transaction as the mutation it records? [Consistency, data-model §Conventions Audit] <!-- Evaluator: Covered by data-model §Conventions (Audit) and §9 ("every catalog mutation appends one row ... in the same transaction (FR-012)") -->

- [X] CHK017 Is the audit-coverage requirement measurable via SC-010 for every authorized change type? [Testability, SC-010] <!-- Evaluator: Resolved via autopilot — SC-010 enumerated only create/edit/archive, omitting the plan_entitlement value set/remove mutations; added spec.md SC-011 [US4] making audit coverage measurable for value set and value remove (all five change types) -->


## Input Validation

- [X] CHK018 Are the entitlement value↔type agreement rules specified for both directions (boolean on an integer-limit entitlement and integer on a boolean entitlement)? [Completeness, FR-008] <!-- Evaluator: Covered by spec Edge Cases ("a boolean value on an integer entitlement (and vice-versa) ... rejected") + FR-008 + contracts §setPlanEntitlementValue (both directions) + data-model §5 -->

- [X] CHK019 Is the integer-limit value rule specified as a non-negative integer, including rejection of negative and non-integer inputs? [Clarity, FR-008] <!-- Evaluator: Covered by FR-007 (non-negative integer) + spec Edge Cases + US4-AC3 (negative or non-numeric rejected) + contracts EntitlementValue (integer minimum 0) -->

- [X] CHK020 Is the key format (allowed characters, length bounds, casing) specified for product, plan, and entitlement keys? [Completeness, contracts §CatalogKey] <!-- Evaluator: Covered by contracts §CatalogKey (pattern ^[a-z][a-z0-9_]*$, minLength 1, maxLength 64, lowercase slug) reused by Product.key, Plan.key, Entitlement.key and all create requests -->

- [X] CHK021 Is duplicate-key rejection scope specified per entity (product per tenant, plan per product, entitlement per tenant)? [Clarity, spec Edge Cases] <!-- Evaluator: Covered by spec Edge Cases (product key within tenant, plan key within product, entitlement key within tenant) + FR-002/FR-003/FR-005 + contracts §Conflict duplicate_key -->

- [X] CHK022 Is the required failure mode for an invalid entitlement value specified as reject-with-field-level-message with nothing saved? [Testability, SC-005] <!-- Evaluator: Covered by SC-005 ("rejected with a clear message and nothing is saved") + FR-008 (field-level message) + contracts §setPlanEntitlementValue 400 ("nothing is saved") -->

- [X] CHK023 Is seat-limit validation specified (positive integer, default 1, rejection of values below 1)? [Completeness, FR-004] <!-- Evaluator: Covered by FR-004 (default 1, any positive integer) + contracts (maxActivations minimum 1, default 1, below 1 → 400 validation_error) + data-model CHECK (max_activations > 0) -->

- [X] CHK024 Are request-body constraints specified to bound the mutation input surface (unknown fields rejected, at least one field required on edit)? [Completeness, contracts §UpdateProductRequest] <!-- Evaluator: Covered by contracts §Update{Product,Plan,Entitlement}Request (additionalProperties: false + minProperties: 1) and all create requests (additionalProperties: false) -->


## Immutability Guards

- [X] CHK025 Is the entitlement key immutability rule unambiguous about when it applies (immutable at all times vs immutable once referenced)? [Clarity, FR-006] <!-- Evaluator: Resolved via autopilot — artifacts conflicted (contract: key immutable after creation, never accepted in PATCH; data-model/spec-Risks: immutable once referenced). Added spec.md FR-018 stating catalog keys are immutable after creation (at all times), aligning the spec with the authoritative contract surface; this strictly subsumes the data-model's "once referenced" app guard, so no contradiction -->

- [X] CHK026 Is "referenced" defined precisely for the type-immutability rule (any plan_entitlement binding vs active plans only)? [Clarity, data-model §6] <!-- Evaluator: Covered by data-model §6 ("immutable once referenced by any plan_entitlement"; guard checks for an existing plan_entitlement (tenant_id, entitlement_id) row — any binding, not active-plans-only) -->

- [X] CHK027 Is product/plan key immutability specified and consistent with entitlement key immutability? [Consistency, plan §Risk Mitigation] <!-- Evaluator: Resolved via autopilot — the spec did not state product/plan key immutability at all. Added spec.md FR-018 covering product, plan, AND entitlement key immutability uniformly (immutable after creation), matching contracts (Update{Product,Plan,Entitlement}Request omit key) and plan §Risk Mitigation -->

- [X] CHK028 Is the refusal outcome for an immutability violation specified distinctly (type-locked conflict vs a generic error)? [Clarity, plan §Error Handling Strategy] <!-- Evaluator: Covered by plan §Error Handling Strategy + contracts (distinct 409 entitlement_type_locked code, dedicated example, separate from duplicate_key; key-change attempt rejected via additionalProperties:false → 400) -->


## Archive-Not-Delete & Referential Safety

- [X] CHK029 Is hard-deletion of a referenced product, plan, or entitlement explicitly prohibited, with archive named as the required alternative? [Completeness, FR-013] <!-- Evaluator: Covered by FR-013 (hard deletion of a referenced entity MUST NOT be permitted; archive retains) + spec Edge Cases + data-model §6 (composite FK NO ACTION backstop; archive is the supported path) -->

- [X] CHK030 Is the referential-safety goal (already-issued licenses stay interpretable) tied to a stated requirement rather than left implicit? [Clarity, FR-013] <!-- Evaluator: Covered by FR-013 ("Archiving MUST retain the entity (so already-issued licenses remain interpretable)") — goal is explicit in the requirement text, reinforced by SC-008 and data-model §6 -->

- [X] CHK031 Is archive cascade behavior specified (archiving a product archives its plans)? [Completeness, spec Edge Cases] <!-- Evaluator: Covered by spec Edge Cases ("Archiving a product archives its plans") + contracts §archiveProduct ("cascades ... all of its plans are archived") + data-model §6 -->

- [X] CHK032 Is the distinction between removing a plan-entitlement attachment and deleting an entitlement definition specified? [Clarity, contracts §removePlanEntitlement] <!-- Evaluator: Covered by contracts §removePlanEntitlement ("removes only the plan↔entitlement ATTACHMENT — it does NOT delete the entitlement definition (use archive for that)") + spec Excluded (archive-not-delete) -->

- [X] CHK033 Is it specified that catalog edits affect only future issuance and never mutate an already-issued license? [Consistency, FR-016] <!-- Evaluator: Covered by FR-016 ("edits MUST affect only future issuance; licenses already issued MUST be unaffected") + spec Excluded/Edge Cases + data-model §6/§8 (E008 snapshots at issue time) -->


## Session Auth & CSRF

- [X] CHK034 Is the session-cookie authentication requirement specified for the /admin/catalog surface (httpOnly, Secure, SameSite, distinct from the machine API key)? [Completeness, contracts §Auth Model] <!-- Evaluator: Covered by contracts §Auth Model + securitySchemes.sessionCookie (opaque admin_session cookie, HttpOnly + Secure + SameSite=Strict, Path=/admin; explicitly NOT the machine X-API-Key) -->

- [X] CHK035 Is CSRF protection required for every state-changing catalog request, with the outcome for a missing or mismatched token specified? [Completeness, contracts §CSRF] <!-- Evaluator: Covered by contracts §CSRF + parameters.CsrfToken (required X-CSRF-Token double-submit on every POST/PATCH/PUT/DELETE; "a missing or mismatched token is rejected and the mutation is refused") -->

- [X] CHK036 Is it specified that read (GET) operations do not require a CSRF token while all mutations do? [Clarity, contracts §CSRF] <!-- Evaluator: Covered by contracts §CSRF + parameters.CsrfToken ("REQUIRED on every state-changing request ... GET (read) operations do not require it") -->

- [X] CHK037 Is it specified that error responses never disclose credential material or the existence of cross-tenant entities? [Clarity, contracts §Error schema] <!-- Evaluator: Covered by contracts §Error schema ("No credential material ever appears in any field"; message "Never contains any credential material") + §NotFound (cross-tenant → 404 "does not exist within the session's tenant", never confirming existence elsewhere) -->

