# Research — E007 No-Code Licensing Catalog

Lightweight pass. The catalog is a tenant-scoped CRUD surface built entirely on established project
patterns (E002 tenancy/RLS/audit, E005 console/RBAC/CSRF/SPA); no new external technology. Baseline from
`specs/sad.md` + the E002/E005 implementations. Only design-shaping choices are recorded.

## Catalog data modeling
- **Decision**: four bare-named tenant-owned tables (`product`, `plan`, `entitlement`, `plan_entitlement`)
  with `PK (tenant_id, id)`, composite intra-tenant FKs, forced RLS, and `licensesrv_app` grants — the exact
  E002/E005 form. Per-plan value as typed `bool_value`/`int_value` with a `num_nonnulls=1` CHECK.
- **Why**: matches the project-plan Shared Data Entities consumed by E008/E017; keeps tenant isolation at
  the DB layer; typed values stay queryable. A SQL CHECK cannot join `entitlement.type`, so value↔type
  agreement is an app-layer invariant (documented in data-model.md).
- **Sources**: project ADR-0004 (tenancy), existing migrations 0000/0002/0005.

## No-code catalog UX
- **Decision**: forms in the E005 console shell (Products / Plans / Entitlements / per-plan values), viewer
  read / admin write via `RequireRole`; edits persist immediately via the `/admin/catalog` REST.
- **Why**: the differentiating requirement is "change packaging without an engineering release"; the console
  already owns auth, RBAC, CSRF, and the SPA shell — the catalog plugs in.
- **Sources**: PRD CAP-001 + persona (non-developer admin); E005 admin console.

## Entitlement-key stability
- **Decision**: `entitlement.key` (and product/plan keys) immutable once referenced; archive-not-delete.
- **Why**: entitlement keys are embedded in E001 signed tokens and read by the offline verifier; renaming or
  deleting a referenced key would break feature gating in already-issued licenses. Catalog edits are template
  changes affecting future issuance only; E008 snapshots values at issue time.
- **Sources**: E001 token entitlements map; spec FR-006/013/016.

## Effective-plan read model
- **Decision**: `GET /admin/catalog/plans/{id}/effective` returns literal `{planKey, productKey,
  maxActivations, entitlements:[{key,type,value}]}` — a pure tenant-scoped read, no computed logic.
- **Why**: E008 issuance needs one resolved definition to snapshot; dynamic/guarded rules are E017's concern.
- **Sources**: spec FR-014; project-plan E008 dependency contract.
