# API Quality Checklist: No-Code Licensing Catalog
**Created**: 2026-07-07 | **Feature**: [spec.md](../spec.md)

## Status Code Coverage

- [X] CHK001 Is the full set of success and error status codes (200/201/204/400/401/403/404/409) enumerated for each of the 19 `/admin/catalog` operations rather than only a representative subset? [Completeness, plan §API Surface Summary] <!-- Evaluator: Covered by contract §paths (every operation enumerates its applicable codes) + plan §API Surface Summary "Status-code conventions" documenting the deliberate per-operation set -->

- [X] CHK002 Is the status code returned for a missing or mismatched CSRF token specified for every mutation, given the CsrfToken parameter only states the request is "rejected" without naming a code (403 vs 401)? [Completeness, contract components.parameters.CsrfToken] <!-- Evaluator: Resolved — named 403 forbidden on missing/invalid X-CSRF-Token in contract CsrfToken param + Forbidden response (now documents CSRF failure, with csrfFailure example) + plan §Error Handling; matches E005 -->

- [X] CHK003 For the upsert `PUT setPlanEntitlementValue`, is it stated whether a first-time attachment returns 201 versus the 200 used for an update, or is 200 intentionally specified for both cases? [Clarity, contract /admin/catalog/plans/{planId}/entitlements/{entitlementId}.put] <!-- Evaluator: Resolved — contract PUT now states an idempotent upsert returns 200 for BOTH first-time attach and update (never 201), in both the operation description and the 200 response description -->

- [X] CHK004 For the idempotent `DELETE removePlanEntitlement`, is the boundary between a 204 (attachment already absent) and a 404 unambiguously defined (e.g., 404 only for an unknown plan)? [Clarity, contract ...entitlements/{entitlementId}.delete] <!-- Evaluator: Resolved — contract DELETE now defines the boundary: 204 whenever both plan+entitlement exist (attachment present OR already absent); 404 ONLY when the planId/entitlementId is unknown in the tenant -->

- [X] CHK005 Is the deliberate absence of 400 on GET-by-id and archive operations (no body/query to validate) documented so reviewers can distinguish intent from omission? [Completeness, contract paths] <!-- Evaluator: Resolved — documented in contract info.description "STATUS CODES" and plan §API Surface Summary "Status-code conventions" (400 omitted from GET-by-id/archive; 409 omitted from reads; omissions intentional) -->

- [X] CHK006 Are the operations that can return 409 (createProduct/createPlan/createEntitlement duplicate_key, updateEntitlement type_locked) distinguished from mutations that cannot conflict (updateProduct/updatePlan), and is that distinction deliberate? [Consistency, contract components.responses.Conflict] <!-- Evaluator: Covered — contract shows 409 only on creates + updateEntitlement; updateProduct/updatePlan schemas exclude the immutable key and have no lockable type, so they cannot conflict. Made deliberate in plan §API Surface Summary "Status-code conventions" -->


## Error Model Consistency

- [X] CHK007 Is the error envelope `{code, message, details?}` defined once with `code` and `message` required and `details` optional, and referenced by every error response? [Consistency, contract components.schemas.Error] <!-- Evaluator: Covered by contract components.schemas.Error (required [code, message], details optional); every error response ($ref BadRequest/Unauthorized/Forbidden/NotFound/Conflict + inline 400/409) references it -->

- [X] CHK008 Is the `in_use` code reconciled between plan §Error Handling (which lists it for hard-delete of a referenced entity) and the contract, which omits it from the Error enum and — under archive-not-delete — exposes no operation that returns it? [Consistency, plan §Error Handling Strategy vs contract schemas.Error] <!-- Evaluator: Resolved — added in_use to the contract Error enum as a RESERVED backstop code (documented: no E007 route returns it; archive is the only retirement path and DELETE plan-entitlement detaches an attachment, never a definition). Plan §Error Handling row revised to match; plan + contract now consistent -->

- [X] CHK009 Is each enumerated code bound to exactly one HTTP status (validation_error→400, unauthenticated→401, forbidden→403, not_found→404, duplicate_key/entitlement_type_locked→409) without ambiguity? [Clarity, contract components.schemas.Error] <!-- Evaluator: Covered — every enum member carries an inline status binding, including the two added codes (archived→409, in_use→409); one status per code, no ambiguity -->

- [X] CHK010 Is the shape of `details` specified per code (field/value for validation_error, key for duplicate_key, referencedByPlans for entitlement_type_locked) rather than left fully open? [Completeness, contract components.responses.BadRequest/Conflict] <!-- Evaluator: Resolved — contract schemas.Error.details description now enumerates the per-code shape (validation_error→{field,value,expectedType?}, duplicate_key→{field,value}, entitlement_type_locked→{entitlementId,referencedByPlans}, archived→{planId?/entitlementId?,status}, not_found→missing id); reinforced by the response examples -->

- [X] CHK011 Is it required that error `message` and `details` never carry credential material or cross-tenant existence disclosure? [Completeness, contract components.schemas.Error] <!-- Evaluator: Resolved — contract schemas.Error description now requires no credential material AND no cross-tenant existence disclosure (cross-tenant access resolves to 404 not_found, never 403); details description repeats the constraint -->


## Request / Response Schema Completeness

- [X] CHK012 Are request and response bodies specified for all five resource families (products, plans, entitlements, per-plan values, effective plan) with camelCase field names throughout? [Completeness, contract components.schemas] <!-- Evaluator: Covered — Create/Update + response schemas for products, plans, entitlements, PlanEntitlement, EffectivePlanDefinition; camelCase throughout (productId, maxActivations, entitlementId, planKey, productKey, createdAt) -->

- [X] CHK013 Are the required-field sets for each response schema (Product, Plan, Entitlement, PlanEntitlement, EffectivePlanDefinition) explicitly declared? [Completeness, contract components.schemas] <!-- Evaluator: Covered — Product [id,key,name,status,createdAt]; Plan [id,productId,key,name,maxActivations,status,createdAt]; Entitlement [id,key,name,type,status,createdAt]; PlanEntitlement [entitlementId,key,type,value]; EffectivePlanDefinition [planKey,productKey,maxActivations,entitlements] -->

- [X] CHK014 Are create/update request schemas constrained with `additionalProperties: false` and PATCH bodies with `minProperties: 1` so unknown or empty payloads are a defined 400? [Testability, contract schemas.Create*/Update*Request] <!-- Evaluator: Covered — all Create*/Update*Request + SetPlanEntitlementValueRequest have additionalProperties:false; UpdateProduct/UpdatePlan/UpdateEntitlementRequest have minProperties:1 -->

- [X] CHK015 Is the immutability of `key` (and a plan's owning product) expressed by excluding those fields from the update request schemas, consistently across product/plan/entitlement? [Consistency, FR-006 / contract schemas.Update*Request] <!-- Evaluator: Covered — UpdateProductRequest (name/description), UpdatePlanRequest (name/description/maxActivations), UpdateEntitlementRequest (name/description/type) all omit key; UpdatePlanRequest also omits productId (no re-parenting) -->

- [X] CHK016 Is the per-plan value union (boolean for `boolean`, non-negative integer for `integer_limit`) specified together with the cross-field rule (value must match the entitlement's type) as a defined 400? [Clarity, FR-008] <!-- Evaluator: Covered — schemas.EntitlementValue oneOf [boolean, integer minimum:0]; PUT setPlanEntitlementValue description + 400 examples (typeMismatch, negative) define the value↔type cross-field rule as validation_error -->

- [X] CHK017 Is the seat-limit field (`maxActivations`) specified with its default of 1 and minimum of 1 on both create and update requests? [Completeness, FR-004] <!-- Evaluator: Covered — CreatePlanRequest.maxActivations minimum:1 default:1; UpdatePlanRequest.maxActivations minimum:1 (default intentionally omitted on PATCH so an omitted field leaves the seat limit unchanged rather than resetting to 1); Plan response also carries minimum:1 default:1 -->

- [X] CHK018 Is list-response bounding (pagination, a cap, or an explicit "return all / unbounded" decision) specified for listProducts/listPlans/listEntitlements? [Completeness, plan §Scale/Scope] <!-- Evaluator: Resolved — decision recorded as plan AD-009 + HINT-006 (bounded, not paginated: full set ordered by createdAt up to a 1000-item cap); contract info.description "LIST BOUNDING" + maxItems:1000 on ProductList/PlanList/EntitlementList arrays -->


## RBAC & CSRF Authorization

- [X] CHK019 Is a minimum role declared for all 19 operations (viewer for reads, admin for mutations) through a single consistent mechanism (`x-rbac.minRole`)? [Completeness, FR-011] <!-- Evaluator: Covered — every operation carries x-rbac: { minRole: viewer|admin }; reads viewer, mutations admin, one consistent extension -->

- [X] CHK020 Is the role hierarchy (owner > admin > viewer) defined so "admin or higher" unambiguously includes owner for every mutation? [Clarity, contract description §RBAC] <!-- Evaluator: Covered — contract info.description RBAC section defines "owner > admin > viewer" and states mutations require "admin or higher" (so owner is included) -->

- [X] CHK021 Is the fail-closed outcome for an under-privileged mutation specified as 403 plus recording of an auditable security event? [Consistency, FR-011] <!-- Evaluator: Covered — contract Forbidden response + info.description RBAC: denied fail-closed with 403 and recorded as an auditable security event (FR-011); plan §Error Handling recordSecurityEvent -->

- [X] CHK022 Is the double-submit CSRF token (`X-CSRF-Token` matching the CSRF cookie) required on every state-changing operation and explicitly not required on reads? [Completeness, plan §Instructions Check] <!-- Evaluator: Covered — contract info.description CSRF + CsrfToken parameter (required:true on every POST/PATCH/PUT/DELETE, must equal the CSRF cookie; GET reads do not require it); every mutation lists the CsrfToken parameter -->

- [X] CHK023 Is the human session cookie (`admin_session`) specified as the sole credential for all operations, explicitly excluding the machine `X-API-Key`? [Consistency, contract components.securitySchemes.sessionCookie] <!-- Evaluator: Covered — global security: [sessionCookie]; securitySchemes.sessionCookie describes admin_session as the HUMAN credential and info.description AUTH MODEL explicitly excludes X-API-Key -->

- [X] CHK024 Is the cross-tenant access outcome specified as 404 (not 403) so another tenant's entity existence is never disclosed? [Clarity, FR-010] <!-- Evaluator: Covered — plan §Error Handling maps not-found/cross-tenant (RLS→0 rows) to 404 not_found, "never 403"; contract schemas.Error description now states cross-tenant access resolves to 404 not 403, no existence disclosure; NotFound is tenant-scoped -->


## Filtering & Upsert Semantics

- [X] CHK025 Is `?status=active|archived|all` defined with its default (`active`) and the meaning of each value, and applied consistently to every list that carries a lifecycle status? [Completeness, FR-013] <!-- Evaluator: Covered — components.parameters.StatusFilter enum [active,archived,all] default active with each value's meaning; referenced by listProducts/listPlans/listEntitlements (listPlanEntitlements has no lifecycle status, so correctly omitted) -->

- [X] CHK026 Is an out-of-enum `status` value specified to produce a 400 validation_error? [Testability, contract components.responses.BadRequest] <!-- Evaluator: Covered — BadRequest.invalidStatus example (code validation_error, details {field:status, value:"retired"}); StatusFilter enum bounds the value and each list carries the 400 BadRequest response -->

- [X] CHK027 Are the PUT-upsert semantics for per-plan values unambiguous about attach-vs-update, idempotency, and effect on future issuance only? [Clarity, FR-007 / FR-009] <!-- Evaluator: Covered — PUT setPlanEntitlementValue description states attach-or-update as an idempotent upsert (200 for both, re-send is a no-op) affecting FUTURE issuance only (FR-009/016); reinforced by CHK003 resolution -->

- [X] CHK028 Is it specified whether an archived plan or archived entitlement may still be attached/valued via the upsert, or whether the upsert requires both to be active? [Completeness, FR-013] <!-- Evaluator: Resolved — contract PUT now requires BOTH plan and entitlement to be active; attaching/valuing against an archived plan or entitlement is refused with 409 archived (new enum code + 409 response with archivedPlan/archivedEntitlement examples). Recorded as plan AD-010 + HINT-006 + Error Handling row -->

- [X] CHK029 Is archive-cascade (archiving a product archives its plans) specified in the API surface along with its effect on subsequent list and effective-plan reads? [Completeness, FR-013] <!-- Evaluator: Resolved — archiveProduct already specifies the cascade to plans; added its effect on subsequent reads (archived product+plans drop from default active lists, cannot receive new attachments → 409 archived, effective definition stays readable for interpreting issued licenses) -->


## Effective-Plan Read Model (E008 Contract)

- [X] CHK030 Is the effective-plan shape `{planKey, productKey, maxActivations, entitlements:[{key,type,value}]}` specified as the authoritative read-model contract E008 issuance consumes? [Completeness, FR-014 / plan AD-006] <!-- Evaluator: Covered — schemas.EffectivePlanDefinition (planKey, productKey, maxActivations, entitlements:[EffectiveEntitlement{key,type,value}]) + example; getEffectivePlanDefinition marked x-issuance-read-model:true and described as the E008 read model (plan AD-006) -->

- [X] CHK031 Is it stated that the effective plan reflects the latest saved per-plan values and contains only static literal values (no computed/guarded rules, deferred to E017)? [Clarity, FR-014 / SC-009] <!-- Evaluator: Covered — getEffectivePlanDefinition + EffectivePlanDefinition descriptions state it reflects the latest saved per-plan values (SC-009) and returns static values only (no computed/guarded rules — those are E017) -->

- [X] CHK032 Is the treatment of archived entitlements or archived attachments in the effective definition specified (included or excluded), given issuance snapshots from it? [Completeness, FR-014] <!-- Evaluator: Resolved — contract getEffectivePlanDefinition + EffectivePlanDefinition.entitlements now state the effective model includes ONLY active attachments (archived entitlements / detached bindings excluded), so issuance snapshots only active grants; recorded as plan AD-010 + HINT-005 -->

- [X] CHK033 Is an empty `entitlements` array specified as a valid effective plan (a plan that grants no gated features)? [Completeness, contract schemas.EffectivePlanDefinition] <!-- Evaluator: Covered — EffectivePlanDefinition.entitlements description ("empty if the plan grants no gated features") + the "empty" response example with entitlements: [] -->


## Identifier & Naming Consistency

- [X] CHK034 Is the entity ID format reconciled between the plan (uuid, AD-002/HINT-001) and the contract, whose `id` schema and examples show prefixed strings (`prd_`/`pln_`/`ent_`)? [Consistency, plan AD-002 vs contract components.schemas] <!-- Evaluator: Resolved — reconciled to uuid per AD-002/HINT-001: every prd_/pln_/ent_ example replaced with canonical UUIDs and every id/path-param/body id given format:uuid; no prefixed ids remain in the contract -->

- [X] CHK035 Does the contract itself flag its prefixed ID examples as illustrative only (uuid authoritative), rather than relying solely on plan HINT-001? [Clarity, contract schemas.Product.id] <!-- Evaluator: Resolved — contract info.description now carries an "IDENTIFIERS (AD-002)" note declaring UUID the authoritative wire format and the prd_/pln_/ent_ prefixes illustrative-only/not emitted; examples themselves are now UUIDs, so the contract no longer relies solely on plan HINT-001 -->

- [X] CHK036 Is the `id` / path-parameter wire format specified (e.g., `format: uuid` or a pattern) instead of a bare `type: string`? [Completeness, contract components.parameters.ProductId/PlanId/EntitlementId] <!-- Evaluator: Resolved — ProductId/PlanId/EntitlementId path params and the Product/Plan/Entitlement id + Plan.productId + PlanEntitlement.entitlementId body fields now specify type:string, format:uuid (no longer bare type:string) -->

- [X] CHK037 Is the `CatalogKey` slug format (pattern and length bounds) defined once and reused for product/plan/entitlement keys and for `planKey`/`productKey` in the read model? [Consistency, contract components.schemas.CatalogKey] <!-- Evaluator: Covered — schemas.CatalogKey (pattern ^[a-z][a-z0-9_]*$, minLength 1, maxLength 64) defined once and $ref'd (via allOf) by Product/Plan/Entitlement.key, PlanEntitlement.key, EffectiveEntitlement.key, and EffectivePlanDefinition.planKey/productKey -->

