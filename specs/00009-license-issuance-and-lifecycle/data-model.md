# Data Model: License Issuance and Lifecycle

> Feature `00009-license-issuance-and-lifecycle` | Epic E008 | 2026-07-08
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0005`) and the E007 catalog (`migrations/0006_catalog.sql`). Adds exactly two new tenant-owned tables — **`customer`** and **`license`** — with tenant-scoped forced RLS and audit-on-mutation. No changes to existing tables.
> Source signals: spec FR-001…FR-019, Key Entities; E002 data model `specs/00003-tenancy-and-data-foundation/data-model.md`; E007 catalog `specs/00008-no-code-licensing-catalog/data-model.md` (`migrations/0006_catalog.sql`); E004 signer `specs/00005-signing-service-and-key-custody/data-model.md` (`migrations/0004_signing_keys.sql`); `migrations/0000_init.sql`, `migrations/0005_admin_sessions.sql`.
> New migration: `migrations/0007_licensing.sql` (expand-only, sequential after 0006 — two additive tables + indexes + RLS/policies/grants).

## Conventions (inherited from E002)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `app_user` / `role` / `api_key` / `signing_key` / `product` / `plan` — so referential integrity stays tenant-local and every FK to a tenant-owned parent is a **composite FK including `tenant_id`**: a child can never bind to another tenant's parent.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **Timestamps**: `timestamptz` (UTC). `created_at` defaults `now()`; `updated_at` defaults `now()` and is bumped by the repository on every edit (lifecycle transitions, transfers, reissue, and customer anonymization are all edits).
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: every issuance/lifecycle mutation appends one row to the existing `audit_log` (INSERT/SELECT-only grant → append-only) in the same transaction (FR-014). No new audit table.
- **Status enums** are free `text` with an inline `CHECK (status IN (...))` — same technique as `role.role`, `signing_key.status`, and `product.status`.

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **customer** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, ref: text NOT NULL (UNIQUE per tenant), name: text null (minimal PII), email: text null (minimal PII), status: text NOT NULL DEFAULT 'active' CHECK IN(active,anonymized), created_at, updated_at. PK `(tenant_id, id)`; UNIQUE `(tenant_id, ref)`. | belongs_to: tenant; has_many: license; logged in: audit_log | active → anonymized (GDPR erasure of a customer that still holds licenses; one-way — [§6](#6-gdpr-erasure--referential-integrity)) |
| **license** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, product_id: uuid NOT NULL, plan_id: uuid NOT NULL, customer_id: uuid NOT NULL, status: text NOT NULL DEFAULT 'active' CHECK IN(active,suspended,revoked), issued_at: timestamptz NOT NULL DEFAULT now(), expires_at: timestamptz null (null=perpetual), max_activations: int NOT NULL CHECK(>0) [snapshot], entitlements: jsonb NOT NULL [snapshot], key_id: text null (E004 key id), token_version: int NOT NULL, nonce: text NOT NULL, transfer_count: int NOT NULL DEFAULT 0 CHECK(>=0), license_token: text NOT NULL (signed LIC1), created_at, updated_at. PK `(tenant_id, id)`; composite FKs `(tenant_id, product_id)→product`, `(tenant_id, plan_id)→plan`, `(tenant_id, customer_id)→customer`. | belongs_to: tenant, product, plan, customer; logged in: audit_log; read by: E009 activation (status + max_activations) | active ↔ suspended; active/suspended → revoked (terminal). Transfer reassigns customer_id within the transfer limit. See [§7](#7-state-machine--license-lifecycle-fr-007008009010) |

> Downstream agents consume the two rows above. `audit_log`, `tenant`, `product`, `plan`, and `signing_key` are reused from E002/E007/E004 and are **not** re-modeled here — they are referenced only at the integration boundaries ([§9](#9-integration-boundaries)).

## 2. `customer` — column detail

Tenant-scoped, pseudonymous recipient of licenses. Minimal PII by design (product's GDPR-minimizing posture, FR-011).

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical primary key. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-015). Matches RLS predicate. |
| ref | text | NOT NULL, UNIQUE `(tenant_id, ref)` | no | Tenant-provided reference/display label (FR-011). Unique **within the tenant** — a duplicate is DB-rejected. The stable handle an operator recognises; survives anonymization. |
| name | text | | yes | Optional minimal PII (FR-011). **Nulled on anonymization** (FR-019). |
| email | text | | yes | Optional minimal PII (FR-011). **Nulled on anonymization** (FR-019). |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','anonymized'))` | no | `anonymized` marks a data-subject erasure where the customer still holds licenses: PII is cleared but the row is retained so its licenses stay interpretable ([§6](#6-gdpr-erasure--referential-integrity)). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped by the repository on every edit (incl. anonymization). |

## 3. `license` — column detail

Tenant-scoped issued license. **A point-in-time snapshot** of the plan's effective definition at issue time (FR-002/006) plus the signed token and lifecycle state.

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; the **unique license id** (FR-002) embedded in the token. Stable across suspend/reinstate/transfer/reissue. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-015). |
| product_id | uuid | NOT NULL, composite FK `(tenant_id, product_id) → product(tenant_id, id)` | no | The product this license was issued under (FR-001). Intra-tenant composite FK — cannot bind to another tenant's product. |
| plan_id | uuid | NOT NULL, composite FK `(tenant_id, plan_id) → plan(tenant_id, id)` | no | The plan issued under (FR-001). Intra-tenant composite FK. The license snapshots the plan's values; the FK records provenance only — later plan edits never mutate this row ([§9](#9-integration-boundaries)). |
| customer_id | uuid | NOT NULL, composite FK `(tenant_id, customer_id) → customer(tenant_id, id)` | no | The one customer this license is assigned to (FR-011). **Changes on transfer** (FR-009). Intra-tenant composite FK; `ON DELETE NO ACTION` backstops hard-delete of a referenced customer ([§6](#6-gdpr-erasure--referential-integrity)). |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','suspended','revoked'))` | no | Lifecycle state (FR-007/008/010). `revoked` is terminal. Read by E009 to gate activation (FR-013). |
| issued_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Issue timestamp baked into the token (FR-002). Set once at issuance; unchanged by lifecycle actions. |
| expires_at | timestamptz | | yes | Expiry (FR-001). **`NULL` = perpetual**; a non-null value = time-limited term. Baked into the token; offline verification honours it. |
| max_activations | int | NOT NULL, `CHECK (max_activations > 0)` | no | **SNAPSHOT of the plan's seat limit** at issue time (FR-002). Copied from `plan.max_activations`; not a live FK-follow. Read by E009 for seat enforcement (this epic sets it; E009 enforces). |
| entitlements | jsonb | NOT NULL | no | **SNAPSHOT of the effective entitlements map** `{key: bool | number}` (FR-002), assembled from E007's effective-plan read model at issue time. Immutable for the life of the license — later catalog edits never touch it (FR-006). Also carried inside the signed token. |
| key_id | text | | yes | The E004 `signing_key.key_id` (version id) used to sign the current token (FR-003). Null only transiently before the first successful sign; changes on **reissue** after key rotation (FR-018). The signing key material itself is **never** stored here (SC-010). |
| token_version | int | NOT NULL | no | The LIC1 claims/token schema version the token was minted with — lets the verifier and future migrations reason about token shape. |
| nonce | text | NOT NULL | no | Per-license nonce mixed into the token for issuance distinctness (two licenses over identical terms produce distinct tokens). |
| transfer_count | int | NOT NULL, DEFAULT `0`, `CHECK (transfer_count >= 0)` | no | Number of times reassigned to a different customer. Incremented on each transfer (FR-009). The **upper bound is a configurable transfer limit enforced in the app** — a single-table CHECK can't reference a runtime/config value ([§8](#8-constraints--indexes), [§7](#7-state-machine--license-lifecycle-fr-007008009010)). |
| license_token | text | NOT NULL | no | The **signed, offline-verifiable LIC1 token string** (FR-003) — the public artifact returned to the admin and embedded by the customer. Re-fetched by the registry (FR-012); replaced on reissue (FR-018). Contains only public claims + signature, never the private key (SC-010). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Row creation (≈ issued_at; kept for parity with the E002 convention). |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped on every lifecycle action (suspend/reinstate/revoke/transfer/reissue). |

## 4. What lives in the token vs. the row

The `license` row is the system-of-record; `license_token` is a signed **projection** of it. The signer (E004) turns the row's snapshot claims into a LIC1 token:

| Signed into `license_token` (LIC1 claims) | Row-only (operational) |
|-------------------------------------------|------------------------|
| license `id`, `product_id`, `plan_id`, `issued_at`, `expires_at`, `max_activations`, `entitlements`, `nonce`, `token_version`, `key_id` (as `kid` header) | `status`, `customer_id`, `transfer_count`, `created_at`, `updated_at` |

> **Status and customer are deliberately NOT in the token.** They change over the license's life (suspend, transfer) while the already-distributed token is immutable and still verifies offline until expiry — the disclosed **offline revocation gap** (spec Edge Cases / Risks). Revocation/suspension take effect online at activation time (E009/E013), which read `license.status` from this row.

## 5. Snapshot semantics (FR-002 / FR-006)

- At issuance the app reads E007's **effective-plan read model** (entitlement `key`s + values, and `plan.max_activations`) and **copies** it into `entitlements` (jsonb) and `max_activations` (int) on the license row. From that moment the license is self-contained.
- `product_id` / `plan_id` FKs record **provenance**, not a live join: they let the registry show "issued under plan X" and satisfy referential integrity, but the license's entitlements/seat limit are read from its own snapshot columns, never re-derived from the catalog.
- Consequently a catalog edit after issuance (per-plan value change, seat-limit change, entitlement rename) **cannot** mutate an issued license (FR-006, SC-003). Propagating a new definition requires issuing a **new** license; propagating a new *signature* over the same terms is **reissue** (FR-018), which rewrites `license_token` + `key_id` but leaves the snapshot, id, and terms untouched.

## 6. GDPR erasure & referential integrity

Data-subject erasure (FR-019) is resolved by referential state, backstopped by the DB:

| Case | Action | Enforcement |
|------|--------|-------------|
| Customer holds **no** licenses | **Hard delete** the `customer` row. | **App** issues `DELETE`; the `DELETE` grant permits it. No license references it, so the composite FK does not block it. |
| Customer holds **one or more** licenses | **Anonymize**: null `name` + `email`, set `status = 'anonymized'`, bump `updated_at`; the row and its `ref` stay so licenses remain interpretable. | **App** — repository selects the anonymize path when any `license (tenant_id, customer_id)` exists (the `license_customer` index below serves this probe). |
| Accidental hard-delete of a **referenced** customer | **Refused** by the database. | **DB backstop** — `license_customer_fk` defaults to `ON DELETE NO ACTION`, so Postgres rejects deleting a customer that any license references. This is the safety net behind the app rule; the app should choose anonymize *before* attempting delete, not rely on catching the FK error. |

> **Why not `ON DELETE CASCADE`?** Cascading would silently destroy issued licenses (and their audit-relevant history) when a customer is erased — unacceptable. `NO ACTION` + app-level anonymize keeps licenses whole while still honouring the erasure request. Anonymization is **one-way**: `active → anonymized` only.

## 7. State machine — license lifecycle (FR-007/008/009/010)

The lifecycle has conditional branches (transfer is gated on a limit; revoke is terminal), so it is called out here rather than only inline. Any transition not in this table is **refused with a clear, specific reason** and leaves the license unchanged (FR-010, SC-008). All transitions are audited (FR-014).

| From | Action | To | Guard | Spec |
|------|--------|----|-------|------|
| — | issue | `active` | active product + active plan; active, unlocked signing key present; only active entitlements | FR-001/004/005 |
| `active` | suspend | `suspended` | — | FR-008 |
| `suspended` | reinstate | `active` | — | FR-008 |
| `active` / `suspended` | revoke | `revoked` | — | FR-007 |
| `revoked` | revoke | `revoked` | idempotent no-op (not an error) | FR-007, US2-AC3 |
| `active` / `suspended` | transfer | *(same status)* | `transfer_count < transfer_limit`; new `customer_id` ≠ current; sets `customer_id`, `transfer_count += 1` | FR-009 |
| `active` / `suspended` | reissue | *(same status)* | rotated/current signing key; rewrites `license_token` + `key_id`; id/terms/snapshot unchanged | FR-018 |

**Refused (examples, FR-010):** reinstate a license that is not `suspended`; transfer or reinstate or reissue a `revoked` license (revoked is terminal); transfer at/over the `transfer_limit`; any action on an unknown license.

> **`transfer_limit` is app-config, not a column.** `transfer_count` is stored and CHECK-bounded `>= 0` at the DB; the *upper* bound is a per-license/tenant **configurable transfer limit** compared in the app on each transfer (FR-009). It is deliberately not a table CHECK because the limit is a runtime/config value and may change without a migration.

## 8. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK (both) | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access and RLS. |
| customer ref uniqueness | `UNIQUE (tenant_id, ref)` | Per-tenant customer reference (FR-011); its index also serves tenant-scoped ref lookup. |
| license → product FK | composite `(tenant_id, product_id) → product(tenant_id, id)`, `ON DELETE NO ACTION` (Postgres default) | Provenance + intra-tenant integrity; `NO ACTION` refuses deleting a product an issued license still references (catalog is archive-not-delete — E007). |
| license → plan FK | composite `(tenant_id, plan_id) → plan(tenant_id, id)`, `ON DELETE NO ACTION` (Postgres default) | Provenance + intra-tenant integrity; `NO ACTION` refuses deleting a plan an issued license still references (archive-not-delete — E007). |
| license → customer FK | composite `(tenant_id, customer_id) → customer(tenant_id, id)`, `ON DELETE NO ACTION` | Assignment integrity; backstops the GDPR hard-delete rule ([§6](#6-gdpr-erasure--referential-integrity)). |
| `license_customer` | `CREATE INDEX license_customer ON license (tenant_id, customer_id)` | Licenses-by-customer registry view **and** the "does this customer hold licenses?" erasure probe (FR-012, FR-019). Not covered by any unique-index prefix → genuinely required. |
| `license_plan` | `CREATE INDEX license_plan ON license (tenant_id, plan_id)` | Licenses-issued-under-a-plan reporting (FR-012). |
| `license_status` | `CREATE INDEX license_status ON license (tenant_id, status)` | Registry filtering by status and status-scoped scans (FR-012/013). |
| status enums | `CHECK (status IN ('active','anonymized'))` on `customer`; `CHECK (status IN ('active','suspended','revoked'))` on `license` | Lifecycle domains (FR-007/008/019). |
| seat limit | `CHECK (max_activations > 0)` on `license` | Positive snapshot seat limit (FR-002). |
| transfer floor | `CHECK (transfer_count >= 0)` on `license` | Non-negative transfer count; upper bound is app-config (FR-009). |

All indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 convention).

## 9. Integration boundaries

- **E004 in-process signer produces `license_token`.** Issuance/reissue assembles LIC1 **claims** from the license row's snapshot ([§4](#4-what-lives-in-the-token-vs-the-row)) and calls the E004 signer for the product; the signer returns the signed LIC1 string stored in `license_token` and stamps the `key_id` used. The **private key is never stored, logged, or returned** — only the public token (FR-003, SC-010). Issuance **requires an active, unlocked signing key** for the product; a missing/locked key fails closed with **no license row created** (FR-004).
- **E007 catalog effective read model is snapshotted, not joined.** `entitlements` + `max_activations` are copied at issue time from E007's effective-plan definition; the `product_id`/`plan_id` FKs are provenance only ([§5](#5-snapshot-semantics-fr-002--fr-006)). Issuance is refused under an **archived** plan or with an **archived** entitlement (FR-005).
- **E009 activation reads this table.** Machine activation/seat enforcement (out of scope here) reads `license.status` (must be `active`) and `license.max_activations` (FR-013). This epic *sets* the seat limit and exposes status; E009 enforces against them.
- **E013/E014 downstream.** Online validation, short-TTL renewal, and revocation-list propagation (E013) and billing-driven suspension (E014) also read `license.status`; the offline revocation gap ([§4](#4-what-lives-in-the-token-vs-the-row)) is the disclosed MVP limitation they later close.
- **E005 admin console + RBAC** gates every issuance/lifecycle action (admin+ writes, viewer reads); an unauthorized attempt is denied and audited as `security_event` (FR-016, SC-009). Enforcement is in the API layer; the schema is agnostic.
- **E004 `signing_key.product_id → product` deferred FK remains out of scope.** That additive constraint (noted in `migrations/0004_signing_keys.sql` and E007 §8) is **not** part of `0007_licensing.sql`; this feature only *consumes* the signer.

## 10. RLS, policies & grants

Identical form to E002 `0002_rls_roles_grants.sql`, E004 `0004_signing_keys.sql`, and E007 `0006_catalog.sql`, applied to each new table:

```sql
ALTER TABLE customer ENABLE ROW LEVEL SECURITY; ALTER TABLE customer FORCE ROW LEVEL SECURITY;
ALTER TABLE license  ENABLE ROW LEVEL SECURITY; ALTER TABLE license  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customer USING (…) WITH CHECK (…);  -- predicate below
CREATE POLICY tenant_isolation ON license  USING (…) WITH CHECK (…);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer, license TO licensesrv_app;
```

- Policy predicate (both tables): `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, on both `USING` (read) and `WITH CHECK` (write).
- `NULLIF(current_setting('app.current_tenant', true), '')` → NULL when the GUC is unset → predicate matches **zero rows**, so an unscoped query is refused, never run unscoped (FR-015, SC-009).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too, so no owner-owned view/function can silently bypass isolation.
- `UPDATE` is granted for lifecycle transitions, transfer, reissue, anonymization, and `updated_at` bumps. `DELETE` is granted so a license-free customer can be hard-deleted (FR-019); hard-deleting a *referenced* customer is DB-refused by `license_customer_fk` `NO ACTION` ([§6](#6-gdpr-erasure--referential-integrity)).
- No changes to `audit_log` grants — it stays INSERT/SELECT-only (append-only); every issuance/lifecycle action appends a row in-transaction (FR-014).

## 11. DDL sketch — `migrations/0007_licensing.sql`

```sql
-- E008 license issuance and lifecycle (FR-001..FR-019). Extends the E002 tenancy substrate and
-- the E007 catalog (expand-only, sequential after 0006). Two new tenant-owned tables: customer,
-- license. Same tenant-scoped forced-RLS + composite-FK + audit pattern as 0000_init.sql /
-- 0004_signing_keys.sql / 0006_catalog.sql. No changes to existing tables.

-- 1. customer — tenant-scoped, pseudonymous recipient (minimal PII).
CREATE TABLE customer (
  id         uuid        NOT NULL,
  tenant_id  uuid        NOT NULL REFERENCES tenant(id),
  ref        text        NOT NULL,                          -- tenant-provided label, unique per tenant (FR-011)
  name       text,                                          -- minimal PII; nulled on anonymize (FR-019)
  email      text,                                          -- minimal PII; nulled on anonymize (FR-019)
  status     text        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','anonymized')),    -- GDPR erasure marker (FR-019)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, ref)
);

-- 2. license — tenant-scoped issued license; point-in-time snapshot of the plan (FR-002/006).
CREATE TABLE license (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  product_id      uuid        NOT NULL,
  plan_id         uuid        NOT NULL,
  customer_id     uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','revoked')),  -- lifecycle (FR-007/008/010)
  issued_at       timestamptz NOT NULL DEFAULT now(),        -- issue timestamp, baked into token (FR-002)
  expires_at      timestamptz,                               -- null = perpetual (FR-001)
  max_activations int         NOT NULL
                    CHECK (max_activations > 0),             -- SNAPSHOT of plan seat limit at issue (FR-002)
  entitlements    jsonb       NOT NULL,                      -- SNAPSHOT of effective entitlements {key: bool|number} (FR-002/006)
  key_id          text,                                      -- E004 signing key id used (FR-003); changes on reissue (FR-018)
  token_version   int         NOT NULL,                      -- LIC1 claims/token schema version
  nonce           text        NOT NULL,                      -- per-license token nonce (issuance distinctness)
  transfer_count  int         NOT NULL DEFAULT 0
                    CHECK (transfer_count >= 0),             -- upper bound is app-config transfer limit (FR-009)
  license_token   text        NOT NULL,                      -- signed LIC1 token string, public (FR-003, SC-010)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FKs: a license can never bind to another tenant's product/plan/customer.
  -- All three FKs are ON DELETE NO ACTION (Postgres default): product/plan use catalog archive-not-delete
  -- (E007), so a referenced product/plan cannot be hard-deleted, mirroring the customer backstop below.
  CONSTRAINT license_product_fk
    FOREIGN KEY (tenant_id, product_id)  REFERENCES product  (tenant_id, id),
  CONSTRAINT license_plan_fk
    FOREIGN KEY (tenant_id, plan_id)     REFERENCES plan     (tenant_id, id),
  -- ON DELETE NO ACTION (default): backstops hard-delete of a customer that still holds licenses (FR-019).
  CONSTRAINT license_customer_fk
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
CREATE INDEX license_customer ON license (tenant_id, customer_id);   -- registry-by-customer + "holds licenses?" erasure probe
CREATE INDEX license_plan     ON license (tenant_id, plan_id);       -- licenses-under-a-plan
CREATE INDEX license_status   ON license (tenant_id, status);        -- registry status filter

-- RLS: same form as E002 (0002). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE customer ENABLE ROW LEVEL SECURITY; ALTER TABLE customer FORCE ROW LEVEL SECURITY;
ALTER TABLE license  ENABLE ROW LEVEL SECURITY; ALTER TABLE license  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON license
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer, license TO licensesrv_app;
```

## 12. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant   ||--o{ customer : "owns"
    tenant   ||--o{ license  : "owns"
    tenant   ||--o{ audit_log : "logs mutations"
    customer ||--o{ license  : "assigned (transferable)"
    product  ||--o{ license  : "issued under (provenance)"
    plan     ||--o{ license  : "issued under (snapshotted)"

    customer {
        uuid id PK
        uuid tenant_id PK-FK
        text ref UK
        text name "minimal PII, nulled on anonymize"
        text email "minimal PII, nulled on anonymize"
        text status "active|anonymized"
        timestamptz created_at
        timestamptz updated_at
    }
    license {
        uuid id PK
        uuid tenant_id PK-FK
        uuid product_id FK
        uuid plan_id FK
        uuid customer_id FK
        text status "active|suspended|revoked"
        timestamptz issued_at
        timestamptz expires_at "null=perpetual"
        int max_activations "snapshot"
        jsonb entitlements "snapshot"
        text key_id "E004 key id"
        int token_version
        text nonce
        int transfer_count
        text license_token "signed LIC1"
        timestamptz created_at
        timestamptz updated_at
    }
```

</details>

## 13. Data Model Summary (drop into plan)

| Entity | Kind | Key Attributes | Relationships | State Transitions |
|--------|------|----------------|---------------|-------------------|
| `customer` | new tenant-owned table | id, tenant_id, ref (uniq per tenant), name (PII, null), email (PII, null), status{active,anonymized} | belongs_to tenant; has_many license | active → anonymized (GDPR erasure when licenses exist; one-way) |
| `license` | new tenant-owned table | id, tenant_id, product_id, plan_id, customer_id, status{active,suspended,revoked}, issued_at, expires_at (null=perpetual), max_activations>0 [snapshot], entitlements jsonb [snapshot], key_id, token_version, nonce, transfer_count≥0, license_token (signed LIC1) | belongs_to tenant+product+plan+customer (composite FKs); read by E009 (status+max_activations) | active↔suspended; active/suspended→revoked (terminal); transfer reassigns customer_id within limit; reissue rewrites token/key_id |
| `audit_log` | reused (E002) | append-only issuance/lifecycle actions (issue/revoke/suspend/reinstate/transfer/reissue/anonymize) with actor/action/target | logs both tables | append-only |

**Indexes**: PK `(tenant_id, id)` ×2; UNIQUE `(tenant_id, ref)` on customer; INDEX `license (tenant_id, customer_id)`, `license (tenant_id, plan_id)`, `license (tenant_id, status)`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY` on both; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT,INSERT,UPDATE,DELETE ON customer, license TO licensesrv_app`.

**App-layer invariants** (not expressible as a single-table CHECK): (1) the license is a **point-in-time snapshot** — `entitlements` + `max_activations` are copied from E007's effective read model at issue time and never re-derived; catalog edits after issuance never mutate an issued license (FR-006). (2) **Lifecycle state machine** — active↔suspended, active/suspended→revoked (terminal), revoke idempotent; invalid transitions refused with a clear reason ([§7](#7-state-machine--license-lifecycle-fr-007008009010), FR-007/008/010). (3) **`transfer_count` upper bound** is a configurable transfer limit compared in the app (DB only floors it ≥0) (FR-009). (4) **Issuance prerequisites** — an active/unlocked E004 signing key for the product and only active plan + entitlements; else fail closed with no row created (FR-004/005). (5) **GDPR erasure** — a license-free customer is hard-deleted; a customer with licenses is anonymized (name/email nulled, status=anonymized); the `license_customer_fk` `NO ACTION` DB-backstops accidental hard-delete of a referenced customer (FR-019).

**Migration**: `migrations/0007_licensing.sql` — expand-only, sequential after 0006: `CREATE TABLE` customer then license, indexes, `ENABLE`/`FORCE` RLS + `tenant_isolation` policies + grants. No changes to existing tables.
