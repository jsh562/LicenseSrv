# Data Model: No-Code Licensing Catalog

> Feature `00008-no-code-licensing-catalog` | Epic E007 | 2026-07-07
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0005`). Adds exactly four new tenant-owned tables — **`product`**, **`plan`**, **`entitlement`**, **`plan_entitlement`** — with tenant-scoped forced RLS and audit-on-mutation. No changes to existing tables.
> Source signals: spec FR-001…FR-016, Key Entities; E002 data model `specs/00003-tenancy-and-data-foundation/data-model.md`; E004 pattern `specs/00005-signing-service-and-key-custody/data-model.md` (`migrations/0004_signing_keys.sql`); `migrations/0000_init.sql`, `migrations/0005_admin_sessions.sql`.
> New migration: `migrations/0006_catalog.sql` (expand-only, sequential after 0005 — four additive tables + indexes + RLS/policies/grants).

## Conventions (inherited from E002)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `app_user` / `role` / `api_key` / `signing_key` — so referential integrity stays tenant-local and every FK to a tenant-owned parent is a **composite FK including `tenant_id`**: a child can never bind to another tenant's parent.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **Timestamps**: `timestamptz` (UTC). `created_at` defaults `now()`; `updated_at` defaults `now()` and is bumped by the repository on every edit (edits matter for products, plans, entitlements, and per-plan values).
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: every catalog mutation appends one row to the existing `audit_log` (INSERT/SELECT-only grant → append-only) in the same transaction (FR-012). No new audit table.
- **Status enums** are free `text` with an inline `CHECK (status IN ('active','archived'))` — same technique as `role.role` and `signing_key.status`; archive is soft-retire, never a hard delete (FR-013).

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **product** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, key: text NOT NULL (UNIQUE per tenant), name: text NOT NULL, description: text null, status: text NOT NULL DEFAULT 'active' CHECK IN(active,archived), created_at, updated_at. PK `(tenant_id, id)`; UNIQUE `(tenant_id, key)`. | belongs_to: tenant; has_many: plan; logged in: audit_log; referenced by: signing_key.product_id (E004, [§8](#8-integration-boundaries)) | active → archived (soft-retire; archiving a product archives its plans — app-cascaded) |
| **plan** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, product_id: uuid NOT NULL, key: text NOT NULL (UNIQUE per product), name: text NOT NULL, description: text null, max_activations: int NOT NULL DEFAULT 1 CHECK (>0), status: text NOT NULL DEFAULT 'active' CHECK IN(active,archived), created_at, updated_at. PK `(tenant_id, id)`; composite FK `(tenant_id, product_id) → product`; UNIQUE `(tenant_id, product_id, key)`. | belongs_to: tenant, product; has_many: plan_entitlement; logged in: audit_log | active → archived |
| **entitlement** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, key: text NOT NULL (UNIQUE per tenant — embedded in E001 signed tokens), name: text NOT NULL, type: text NOT NULL CHECK IN(boolean,integer_limit), description: text null, status: text NOT NULL DEFAULT 'active' CHECK IN(active,archived), created_at, updated_at. PK `(tenant_id, id)`; UNIQUE `(tenant_id, key)`. | belongs_to: tenant; has_many: plan_entitlement; logged in: audit_log | active → archived. `key` + `type` immutable once referenced ([§6](#6-referential-integrity--lifecycle-invariants), app-enforced) |
| **plan_entitlement** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, plan_id: uuid NOT NULL, entitlement_id: uuid NOT NULL, bool_value: boolean null, int_value: int null, created_at, updated_at. PK `(tenant_id, id)`; composite FKs `(tenant_id, plan_id) → plan` and `(tenant_id, entitlement_id) → entitlement`; UNIQUE `(tenant_id, plan_id, entitlement_id)`; CHECK exactly one of bool_value/int_value set; CHECK int_value ≥ 0. | belongs_to: tenant, plan, entitlement; logged in: audit_log | none (value rows are edited in place; edits affect only future issuance — [§8](#8-integration-boundaries)) |

> Downstream agents consume the four rows above. `audit_log`, `tenant`, and `app_user` are reused from E002 and are **not** re-modeled here. `signing_key` (E004) is referenced only to note the now-satisfiable deferred FK ([§8](#8-integration-boundaries)).

## 2. `product` — column detail

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical primary key. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-010). Matches RLS predicate. |
| key | text | NOT NULL, UNIQUE `(tenant_id, key)` | no | Stable per-tenant catalog key (FR-002). Duplicate within tenant is DB-rejected. Non-reserved identifier — no quoting needed. |
| name | text | NOT NULL | no | Human display name (FR-002). |
| description | text | | yes | Optional operator-facing description. |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','archived'))` | no | Soft-retire lifecycle (FR-013). Archived = retained but excluded from active selection. |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped by the repository on every edit. |

## 3. `plan` — column detail

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-010). |
| product_id | uuid | NOT NULL, composite FK `(tenant_id, product_id) → product(tenant_id, id)` | no | The one product this plan belongs to (FR-003). The composite FK makes it structurally impossible to bind a plan to another tenant's product. |
| key | text | NOT NULL, UNIQUE `(tenant_id, product_id, key)` | no | Stable key unique **within the product** (FR-003). |
| name | text | NOT NULL | no | Display name. |
| description | text | | yes | Optional. |
| max_activations | int | NOT NULL, DEFAULT `1`, `CHECK (max_activations > 0)` | no | Seat limit — max machine activations a license issued under this plan may hold (FR-004). Defaults to 1; any positive integer accepted. Read by E008/E009; enforcement is E009's. |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','archived'))` | no | Soft-retire (FR-013). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped on edit. |

## 4. `entitlement` — column detail

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-010). |
| key | text | NOT NULL, UNIQUE `(tenant_id, key)` | no | **The canonical feature key embedded in E001 signed tokens** (FR-005, spec US3). Unique per tenant. Immutable once referenced by any `plan_entitlement` (app-enforced — [§6](#6-referential-integrity--lifecycle-invariants)) so a license in the field never loses its gate. |
| name | text | NOT NULL | no | Display name. |
| type | text | NOT NULL, `CHECK (type IN ('boolean','integer_limit'))` | no | `boolean` = on/off feature; `integer_limit` = numeric cap (FR-005). Fixed once referenced (FR-006, app-enforced). |
| description | text | | yes | Optional. |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','archived'))` | no | Soft-retire (FR-013). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped on edit. |

## 5. `plan_entitlement` — column detail

The per-plan value binding a plan to an entitlement (the no-code core, FR-007).

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-010). |
| plan_id | uuid | NOT NULL, composite FK `(tenant_id, plan_id) → plan(tenant_id, id)` | no | The plan granting the value. Intra-tenant composite FK. |
| entitlement_id | uuid | NOT NULL, composite FK `(tenant_id, entitlement_id) → entitlement(tenant_id, id)` | no | The entitlement being valued. Intra-tenant composite FK. |
| bool_value | boolean | | yes | Set **iff** the entitlement's `type = 'boolean'`. Exactly one of `bool_value`/`int_value` is non-null (XOR CHECK below). |
| int_value | int | | yes | Set **iff** the entitlement's `type = 'integer_limit'`. `CHECK (int_value IS NULL OR int_value >= 0)` — non-negative limit (FR-007/FR-008). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped when the value is edited (FR-009 — takes effect immediately). |

**Constraints:**

- `UNIQUE (tenant_id, plan_id, entitlement_id)` — an entitlement is valued at most once per plan.
- `CHECK (num_nonnulls(bool_value, int_value) = 1)` — **exactly one** value column is set (a value row is never empty and never carries both a flag and a number).
- `CHECK (int_value IS NULL OR int_value >= 0)` — integer limits are non-negative.

> **Cross-row type agreement is app-enforced.** A column `CHECK` cannot join to `entitlement`, so it cannot assert that `bool_value` is set **when** `entitlement.type = 'boolean'` (and `int_value` when `'integer_limit'`). The XOR CHECK guarantees exactly one value is present; the repository additionally validates that the *populated* column matches the referenced entitlement's `type`, rejecting a mismatch with a field-level message (FR-008, SC-005). This is the same "cross-row invariant lives in the app layer" pattern E004 used for `signing_key` custody-scheme presence.

## 6. Referential integrity & lifecycle invariants

| Invariant | Enforcement | Spec |
|-----------|-------------|------|
| A plan cannot bind to another tenant's product; a value cannot bind to another tenant's plan/entitlement. | **DB** — composite FKs `(tenant_id, …)` on `plan`, `plan_entitlement`. | FR-003, FR-010 |
| Hard-deleting a referenced product / plan / entitlement is refused. | **DB backstop** — the composite FKs default to `ON DELETE NO ACTION`, so Postgres refuses to delete a `product` with plans, or a `plan`/`entitlement` with value rows. Archive (status → archived) is the supported retire path. | FR-013, spec Edge Cases, Risk: referential breakage |
| `entitlement.key` and `entitlement.type` are immutable once referenced by any `plan_entitlement`. | **App** — repository checks for an existing `plan_entitlement (tenant_id, entitlement_id)` (index below) and refuses a `key`/`type` change if any exists. Immutable keys keep field licenses interpretable. | FR-006, spec US3-AC3, Risk: key churn |
| Archiving a product archives its plans; archived entries are excluded from active selection but retained. | **App** — cascade on archive + `status = 'active'` filters on active-selection reads. | FR-013, spec Edge Cases, SC-008 |
| A per-plan value edit changes only **future** issuance; already-issued licenses are unaffected. | **Integration boundary** — E008 snapshots the effective plan definition at issue time ([§8](#8-integration-boundaries)); catalog edits never mutate issued licenses. | FR-016, spec Edge Cases, SC-004 |
| A plan with zero entitlements is valid. | **Model** — `plan_entitlement` is optional (0..N per plan); no minimum. | spec Edge Cases |

## 7. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK (all four) | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access and RLS. |
| product key uniqueness | `UNIQUE (tenant_id, key)` | Per-tenant product key (FR-002); its index also serves tenant-scoped key lookup. |
| plan key uniqueness | `UNIQUE (tenant_id, product_id, key)` | Per-product plan key (FR-003); the `(tenant_id, product_id)` prefix also serves plan-listing-within-product. |
| entitlement key uniqueness | `UNIQUE (tenant_id, key)` | Per-tenant entitlement key (FR-005). |
| value uniqueness | `UNIQUE (tenant_id, plan_id, entitlement_id)` | One value per (plan, entitlement); the `(tenant_id, plan_id)` prefix also serves effective-plan-definition assembly. |
| `plan_product` | `CREATE INDEX plan_product ON plan (tenant_id, product_id)` | Explicit tenant-leading index for plan-listing-within-product (mirrors E002 §4 convention; the unique-index prefix also covers it). |
| `plan_entitlement_plan` | `CREATE INDEX plan_entitlement_plan ON plan_entitlement (tenant_id, plan_id)` | Assemble a plan's effective definition (FR-014); mirrors the unique-index prefix. |
| `plan_entitlement_entitlement` | `CREATE INDEX plan_entitlement_entitlement ON plan_entitlement (tenant_id, entitlement_id)` | **Referenced-by-entitlement lookup** — the `is this entitlement referenced?` guard for key/type immutability and archive-not-delete ([§6](#6-referential-integrity--lifecycle-invariants)). Not covered by any unique-index prefix, so genuinely required. |
| value XOR | `CHECK (num_nonnulls(bool_value, int_value) = 1)` | Exactly one value column set. |
| non-negative limit | `CHECK (int_value IS NULL OR int_value >= 0)` | Integer limits ≥ 0 (FR-007). |
| status | `CHECK (status IN ('active','archived'))` on each of the four | Soft-retire lifecycle (FR-013). |
| seat limit | `CHECK (max_activations > 0)` on `plan` | Positive seat limit, default 1 (FR-004). |

All indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 §4).

## 8. Integration boundaries

- **E008 license issuance snapshots the effective plan definition.** E007 exposes the read model — a plan's entitlement `key`s, their `bool_value`/`int_value`, and `max_activations` (FR-014, SC-009). E008 **copies** those values into the issued license at issue time; later catalog edits (per-plan value, seat limit, entitlement rename-before-reference) never mutate an already-issued license (FR-016). The catalog holds current definitions; the license holds a point-in-time snapshot. This is why `entitlement.key` immutability-once-referenced matters: it keeps a field license's snapshotted key resolvable.
- **E001 signed tokens embed `entitlement.key`.** The per-tenant-unique `entitlement.key` is the canonical feature key the Rust verifier core checks (spec US3, Principle I/III). Key churn after issuance is mitigated by the immutable-once-referenced rule.
- **E004 `signing_key.product_id` deferred FK is now satisfiable.** `migrations/0004_signing_keys.sql` declares `product_id uuid NOT NULL` with the composite FK `(tenant_id, product_id) → product(tenant_id, id)` **intended but deferred** ("E007-deferred; IP-007"). With `product` now created, that FK can be added additively. **Deferred to an explicit decision / follow-on step, NOT included in `0006_catalog.sql`,** because it changes existing `signing_key` insert ordering (a product must exist first) and is outside this feature's four-entity scope. When taken, the exact step is:
  ```sql
  -- (integration follow-up, not part of 0006)
  ALTER TABLE signing_key
    ADD CONSTRAINT signing_key_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id);
  ```
- **E005 admin console + RBAC** gates all catalog mutations (owner/admin write, viewer read); unauthorized mutations are denied and audited as `security_event` (FR-011, SC-006). Enforcement is in the API layer; the schema is agnostic.

## 9. RLS, policies & grants

Identical form to E002 `0002_rls_roles_grants.sql` and E004 `0004_signing_keys.sql`, applied to each of the four tables:

```sql
ALTER TABLE product          ENABLE ROW LEVEL SECURITY; ALTER TABLE product          FORCE ROW LEVEL SECURITY;
ALTER TABLE plan             ENABLE ROW LEVEL SECURITY; ALTER TABLE plan             FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement      ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement      FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_entitlement ENABLE ROW LEVEL SECURITY; ALTER TABLE plan_entitlement FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product          USING (…) WITH CHECK (…);  -- predicate below, per table
-- …one policy per table…

GRANT SELECT, INSERT, UPDATE, DELETE ON product, plan, entitlement, plan_entitlement TO licensesrv_app;
```

- Policy predicate (every table): `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, on both `USING` (read) and `WITH CHECK` (write).
- `NULLIF(current_setting('app.current_tenant', true), '')` → NULL when the GUC is unset → predicate matches **zero rows**, so an unscoped query is refused, never run unscoped (FR-010, SC-007).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too, so no owner-owned view/function can silently bypass isolation.
- `UPDATE` is granted for edits + soft-retire (`status → archived`) and to bump `updated_at`. `DELETE` is granted at the privilege layer but hard-deleting a referenced row is DB-refused by the composite FKs ([§6](#6-referential-integrity--lifecycle-invariants)); archive is the app path.
- No changes to `audit_log` grants — it stays INSERT/SELECT-only (append-only); every catalog mutation appends a row in-transaction (FR-012).

## 10. DDL sketch — `migrations/0006_catalog.sql`

```sql
-- E007 no-code licensing catalog (FR-001..FR-016). Extends the E002 tenancy substrate
-- (expand-only, sequential after 0005). Four new tenant-owned tables: product, plan,
-- entitlement, plan_entitlement. Same tenant-scoped forced-RLS + composite-FK + audit
-- pattern as 0000_init.sql / 0004_signing_keys.sql. No changes to existing tables.

-- 1. product — tenant-scoped catalog root.
CREATE TABLE product (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL REFERENCES tenant(id),
  key         text        NOT NULL,                      -- stable key, unique per tenant (FR-002)
  name        text        NOT NULL,
  description text,
  status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),  -- soft-retire (FR-013)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);

-- 2. plan — belongs to one product; carries the seat limit.
CREATE TABLE plan (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  product_id      uuid        NOT NULL,
  key             text        NOT NULL,                   -- unique per product (FR-003)
  name            text        NOT NULL,
  description     text,
  max_activations int         NOT NULL DEFAULT 1
                    CHECK (max_activations > 0),          -- seat limit, default 1 (FR-004)
  status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a plan can never bind to another tenant's product.
  CONSTRAINT plan_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id),
  UNIQUE (tenant_id, product_id, key)
);

-- 3. entitlement — tenant-scoped feature definition; key embeds into E001 signed tokens.
CREATE TABLE entitlement (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL REFERENCES tenant(id),
  key         text        NOT NULL,                       -- unique per tenant; token feature key (FR-005)
  name        text        NOT NULL,
  type        text        NOT NULL
                CHECK (type IN ('boolean','integer_limit')),
  description text,
  status      text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);

-- 4. plan_entitlement — per-plan value binding a plan to an entitlement.
CREATE TABLE plan_entitlement (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL REFERENCES tenant(id),
  plan_id        uuid        NOT NULL,
  entitlement_id uuid        NOT NULL,
  bool_value     boolean,                                 -- set iff entitlement.type='boolean'
  int_value      int,                                     -- set iff entitlement.type='integer_limit'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT plan_entitlement_plan_fk
    FOREIGN KEY (tenant_id, plan_id)        REFERENCES plan        (tenant_id, id),
  CONSTRAINT plan_entitlement_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id),
  UNIQUE (tenant_id, plan_id, entitlement_id),
  -- Exactly one value column set. Cross-row agreement with entitlement.type
  -- (bool ⇔ 'boolean', int ⇔ 'integer_limit') is enforced in the app layer (a CHECK can't join).
  CONSTRAINT plan_entitlement_one_value CHECK (num_nonnulls(bool_value, int_value) = 1),
  CONSTRAINT plan_entitlement_int_nonneg CHECK (int_value IS NULL OR int_value >= 0)
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 §4 convention).
CREATE INDEX plan_product                 ON plan             (tenant_id, product_id);
CREATE INDEX plan_entitlement_plan        ON plan_entitlement (tenant_id, plan_id);
CREATE INDEX plan_entitlement_entitlement ON plan_entitlement (tenant_id, entitlement_id);

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE product          ENABLE ROW LEVEL SECURITY; ALTER TABLE product          FORCE ROW LEVEL SECURITY;
ALTER TABLE plan             ENABLE ROW LEVEL SECURITY; ALTER TABLE plan             FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement      ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement      FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_entitlement ENABLE ROW LEVEL SECURITY; ALTER TABLE plan_entitlement FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON plan
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON entitlement
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON plan_entitlement
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON product, plan, entitlement, plan_entitlement TO licensesrv_app;
```

## 11. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant      ||--o{ product          : "owns"
    tenant      ||--o{ entitlement      : "owns"
    tenant      ||--o{ audit_log        : "logs mutations"
    product     ||--o{ plan             : "has"
    plan        ||--o{ plan_entitlement : "grants"
    entitlement ||--o{ plan_entitlement : "valued by"
    product     ||--o{ signing_key      : "E004 FK (deferred, satisfiable)"

    product {
        uuid id PK
        uuid tenant_id PK-FK
        text key UK
        text name
        text description
        text status
        timestamptz created_at
        timestamptz updated_at
    }
    plan {
        uuid id PK
        uuid tenant_id PK-FK
        uuid product_id FK
        text key UK
        text name
        int max_activations
        text status
        timestamptz created_at
        timestamptz updated_at
    }
    entitlement {
        uuid id PK
        uuid tenant_id PK-FK
        text key UK
        text name
        text type
        text status
        timestamptz created_at
        timestamptz updated_at
    }
    plan_entitlement {
        uuid id PK
        uuid tenant_id PK-FK
        uuid plan_id FK
        uuid entitlement_id FK
        boolean bool_value
        int int_value
        timestamptz created_at
        timestamptz updated_at
    }
```

</details>

## 12. Data Model Summary (drop into plan)

| Entity | Kind | Key Attributes | Relationships | State Transitions |
|--------|------|----------------|---------------|-------------------|
| `product` | new tenant-owned table | id, tenant_id, key (uniq per tenant), name, description, status{active,archived} | belongs_to tenant; has_many plan; referenced by signing_key.product_id (E004) | active → archived (archives its plans) |
| `plan` | new tenant-owned table | id, tenant_id, product_id, key (uniq per product), name, max_activations≥1 (default 1), status{active,archived} | belongs_to tenant+product (composite FK); has_many plan_entitlement | active → archived |
| `entitlement` | new tenant-owned table | id, tenant_id, key (uniq per tenant; E001 token key), name, type{boolean,integer_limit}, status{active,archived} | belongs_to tenant; has_many plan_entitlement | active → archived; key+type immutable once referenced (app) |
| `plan_entitlement` | new tenant-owned table | id, tenant_id, plan_id, entitlement_id, bool_value XOR int_value(≥0); uniq(tenant,plan,entitlement) | belongs_to tenant+plan+entitlement (composite FKs) | none (edited in place; future issuance only) |
| `audit_log` | reused (E002) | append-only catalog mutations (create/edit/archive) with actor/action/target | logs the four tables | append-only |

**Indexes**: PK `(tenant_id, id)` ×4; UNIQUE `(tenant_id, key)` on product + entitlement; UNIQUE `(tenant_id, product_id, key)` on plan; UNIQUE `(tenant_id, plan_id, entitlement_id)` on plan_entitlement; INDEX `plan (tenant_id, product_id)`, `plan_entitlement (tenant_id, plan_id)`, `plan_entitlement (tenant_id, entitlement_id)`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY` on all four; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT,INSERT,UPDATE,DELETE ON product, plan, entitlement, plan_entitlement TO licensesrv_app`.

**App-layer invariants** (not expressible as a single-table CHECK): (1) `plan_entitlement` populated value column agrees with `entitlement.type`; (2) `entitlement.key` + `type` immutable once a `plan_entitlement` references it; (3) archive-not-delete cascade (archiving a product archives its plans; no hard delete of referenced rows — DB-backstopped by composite FK `NO ACTION`); (4) catalog edits affect future issuance only — E008 snapshots values at issue time.

**Migration**: `migrations/0006_catalog.sql` — expand-only, sequential after 0005: `CREATE TABLE` product/plan/entitlement/plan_entitlement, indexes, `ENABLE`/`FORCE` RLS + `tenant_isolation` policies + grants. No changes to existing tables.
