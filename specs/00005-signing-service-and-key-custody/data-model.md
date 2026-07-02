# Data Model: Signing Service & Key Custody

> Feature `00005-signing-service-and-key-custody` | Epic E004 | 2026-07-02
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0003`). Adds exactly one new tenant-owned table — **`signing_key`** — plus a derived read-only **keyring view**. No changes to existing tables.
> Source signals: spec TR-001…TR-019, Key Entities; ADR-0003 (per-product Ed25519 keys, keystore/KMS custody, `key_id` rotation, never exposed); DDR-003 (pluggable signer, Shamir k-of-n, backup separated from unlock material); E002 data model `specs/00003-tenancy-and-data-foundation/data-model.md`.
> New migration: `migrations/0004_signing_keys.sql` (expand-only, sequential — additive table + indexes + RLS/policy/grants + keyring view).

## Conventions (inherited from E002)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `app_user` / `role` / `api_key` / `audit_log` in `0000_init.sql` — so referential integrity stays tenant-local and every FK can be a tenant-scoped composite FK.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`. All `*_id` references to tenant-owned tables use a **composite FK including `tenant_id`** so a reference can never cross tenants.
- **Timestamps**: `timestamptz` (UTC); `created_at` defaults `now()`.
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: key lifecycle events append to the existing `audit_log` (INSERT/SELECT-only grant → append-only). No new audit table.
- **Secrets never in cleartext**: private key material is never stored unwrapped in any column, response, log, or diagnostic (TR-010).

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **signing_key** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, product_id: uuid NOT NULL (FK→product, E007-deferred), key_id: text NOT NULL, algorithm: text NOT NULL DEFAULT 'ed25519', public_key: bytea NOT NULL (32-byte Ed25519), status: text NOT NULL CHECK IN(active,rotating,retired,revoked), valid_from: timestamptz, valid_until: timestamptz null, private_key_ref: bytea null (wrapped/handle — NEVER plaintext), custody_scheme: text NOT NULL, created_at: timestamptz NOT NULL DEFAULT now(), created_by: uuid null FK→app_user. PK `(tenant_id, id)`; UNIQUE `(tenant_id, product_id, key_id)`; partial UNIQUE `(tenant_id, product_id) WHERE status='active'`. | belongs_to: tenant, product; created_by → app_user; source of: product_keyring (view); logged in: audit_log | active → rotating → retired; any → revoked (see [§6 State Machine](#6-state-machine-signing_keystatus)) |
| **product_keyring** (VIEW, not a table) | Derived read-only projection of `signing_key` WHERE status IN (active, rotating, retired): key_id, algorithm, public_key, valid_from, valid_until, status. Public material only — NEVER exposes `private_key_ref` / `custody_scheme`. | reads: signing_key | — (reflects base rows) |
| **custodian share** (NOT modeled in DB) | Shamir k-of-n share of the keystore master-key unlock material. Held out-of-band via the E006 runtime secrets contract; reconstructed in memory at unlock, never persisted. | operational/config only | — |
| **product** (owned by E007 — referenced, not defined here) | The trust unit that owns a signing key and its keyring. Only `product_id` is referenced from `signing_key`; the `product` table, its columns, and the hard FK are introduced by E007. | owns: signing_key | — |

> Downstream agents consume the row above. `product` and `custodian share` are listed only to prevent them being (re)modeled as tables in this feature: **`product` is E007's**, and **custodian shares are never a DB entity**.

## 2. `signing_key` — column detail

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical primary key. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (TR-004). Matches RLS predicate. |
| product_id | uuid | NOT NULL | no | The product that owns the key (ADR-0003 per-product isolation). Composite FK `(tenant_id, product_id) → product(tenant_id, id)` is **intended but deferred** — E007 owns the `product` table. Until then, integrity is enforced by the repository + RLS + this column's NOT NULL. |
| key_id | text | NOT NULL, UNIQUE `(tenant_id, product_id, key_id)` | no | Version identifier stamped into every `LIC1` token; verifiers select the trusted public key by it (TR-003, TR-006). Unique per product. |
| algorithm | text | NOT NULL, DEFAULT `'ed25519'` | no | Only `ed25519` is currently valid (TR-005). Left as free text (no hard CHECK) so a future algorithm needs no migration; validated in the repository layer. |
| public_key | bytea | NOT NULL | no | 32-byte Ed25519 public key. Optional guard `CHECK (algorithm <> 'ed25519' OR octet_length(public_key) = 32)`. Published in the keyring. |
| status | text | NOT NULL, `CHECK (status IN ('active','rotating','retired','revoked'))` | no | Lifecycle state ([§6](#6-state-machine-signing_keystatus)). |
| valid_from | timestamptz | | yes | When the key becomes usable/trusted (set at activation). |
| valid_until | timestamptz | | yes | End of trust window; null = open-ended (trusted until rotated/retired/removed). Published in the keyring for verifier hints (TR-008). |
| private_key_ref | bytea | | yes | **Custody reference — never a plaintext private key** (see [§3](#3-private-key-custody-tr-001--tr-010)). Keystore signer: the private key *wrapped* under the keystore master key. KMS/PKCS#11 adapter: an opaque backend handle/ARN. Nullable because presence is a function of `custody_scheme`: the keystore scheme requires a **non-null wrapped blob**, whereas a KMS/PKCS#11 scheme carries an **opaque handle or leaves this null** when the backend key is resolved directly from `key_id`. Presence-per-scheme is validated in the repository layer (same pattern as `algorithm`), so a null under a handle scheme is a **valid custody state — not a missing-key integrity error**. |
| custody_scheme | text | NOT NULL | no | Identifies how `private_key_ref` is wrapped/resolved, e.g. `keystore-aes256gcm-v1`, `kms-aws`, `pkcs11`. Free text (no CHECK) so new adapters need no migration (TR-016, TR-017). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| created_by | uuid | FK → `app_user`, composite `(tenant_id, created_by) → app_user(tenant_id, id)` | yes | Provenance of the key-create action; intra-tenant (cannot reference another tenant's user), same technique as `api_key.created_by`. Null for system/bootstrap-generated keys. |

## 3. Private-key custody (TR-001 / TR-010)

**No column in this schema ever holds an unwrapped private key.** The `signing_key` row is the *public* registry entry plus a *custody reference*; the private key lives only inside the custody boundary (keystore/soft-HSM or KMS/HSM) and is loaded into memory only within that boundary.

| custody_scheme | What `private_key_ref` holds | How the key is used |
|----------------|------------------------------|---------------------|
| `keystore-aes256gcm-v1` (default) | The Ed25519 private key **envelope-encrypted** (AES-256-GCM) under the keystore **master key**. | The master key is reconstructed at runtime from **Shamir k-of-n custodian shares** (TR-012) and is **never persisted in plaintext**. Without the unlocked master key the wrapped blob is cryptographically useless — a database dump alone yields no signing capability (TR-013: keystore backup is separate from unlock material). |
| `kms-aws` / `pkcs11` (optional, P2) | An **opaque backend handle / ARN** — not key material at all. | The private key never leaves the KMS/HSM boundary; the adapter asks the backend to sign by handle. No export path exists (TR-016). |

Guarantees this model encodes:

- The `Signer` interface has **no key-read/export operation** (TR-001); nothing reads `private_key_ref` back to a caller.
- `private_key_ref` and `custody_scheme` are **excluded from the keyring view** ([§5](#5-derived-keyring-view-not-a-table)) and from every API projection, so they cannot surface in JWKS output.
- Envelope encryption + Shamir split means a stolen DB row is insufficient to forge licenses; recovery below the k threshold is a runbook condition, not silent loss (spec Edge Cases, DDR-003).

## 4. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access. |
| Unique key_id per product | `UNIQUE (tenant_id, product_id, key_id)` | A `key_id` is unique within a product (TR-003); verifiers resolve one public key per `key_id`. |
| One active key per product | partial unique `CREATE UNIQUE INDEX ... ON signing_key (tenant_id, product_id) WHERE status = 'active'` | Enforces **exactly one `active` signing key** per (tenant, product) — the one selected for new signing (TR-006). Rotating/retired/revoked rows are unconstrained in count. |
| Product lookup / keyring scan | `CREATE INDEX ... ON signing_key (tenant_id, product_id, status)` | `tenant_id`-leading; serves keyring publication (status IN active/rotating/retired), active-key selection, and per-product listing. |
| public_key shape (optional) | `CHECK (algorithm <> 'ed25519' OR octet_length(public_key) = 32)` | Guards the 32-byte Ed25519 public-key length without blocking future algorithms. |

All indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 §4).

## 5. RLS, role & grants

Identical form to E002 `0002_rls_roles_grants.sql`:

```sql
ALTER TABLE signing_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_key FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON signing_key
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON signing_key TO licensesrv_app;
```

- `NULLIF(current_setting('app.current_tenant', true), '')` → NULL when the GUC is unset → predicate matches **zero rows**, so an unscoped query is refused, never run unscoped (SC-003, TR-004).
- `FORCE ROW LEVEL SECURITY` subjects the owner too, so no owner-owned view/function can silently bypass isolation — the key to why the keyring **view** (owned material) still isolates by tenant.
- `UPDATE` is required for status transitions (activate/rotate/retire/revoke) and to stamp `valid_from`/`valid_until`. `DELETE` is used only to remove a **retired** key from the keyring after its overlap fully closes (its history persists in `audit_log`). **Revoked** keys are retained as rows (permanent distrust marker), not deleted.
- Cross-tenant isolation gives blast-radius isolation at the data layer: tenant A cannot read or use tenant B's keys (SC-003), complementing the per-`key_id` crypto isolation (a product-A token fails under product-B keys, SC-002).

## 5b. Derived keyring view (NOT a table)

The **public keyring** is a read-only VIEW over `signing_key`, not a stored table:

```sql
CREATE VIEW product_keyring
  WITH (security_invoker = true) AS   -- PG16: RLS evaluates as the invoking app role
SELECT tenant_id, product_id, key_id, algorithm, public_key, valid_from, valid_until, status
FROM   signing_key
WHERE  status IN ('active', 'rotating', 'retired');
```

- Exposes **public material only** — `key_id` + public key + validity + status — the JWKS-style trust set verifiers/bindings pin out of band (TR-008, IP-001, IP-005). Consumable as the E001 `verifier-core` pinned `Keyring`.
- **Never** projects `private_key_ref` or `custody_scheme`.
- `security_invoker = true` makes the view honor the querying app role's RLS + `app.current_tenant`, so keyring reads stay tenant-scoped rather than running with the view owner's rights.
- Publication set = `{active, rotating, retired}` (all trusted); `revoked` is excluded, so a revoked key vanishes from the published keyring immediately (TR-009, SC-005).

## 5c. Custodian share (NOT a table — operational/config only)

Shamir k-of-n custodian shares are **not** a database entity and MUST NOT be modeled as one. They:

- Are supplied out-of-band via the E006 runtime secrets contract (env/secret files), never baked into an image or DB (IP-006, TR-012).
- Reconstruct the keystore **master key in memory** at unlock; the reconstructed key and the shares are never persisted (TR-013).
- Below the k threshold → the signer fails closed (does not unlock, signs nothing) — a recoverable-by-runbook condition, not DB state (TR-011, SC-006).

## 6. State machine — `signing_key.status`

More than a simple linear lifecycle (has a from-any branch), so modeled explicitly.

| From | To | Trigger | Keyring (published/trusted) | Selected for new signing |
|------|-----|---------|-----------------------------|--------------------------|
| (create) | active | Key provisioned as the product's first/promoted signing key. Sets `valid_from`. Partial-unique index guarantees only one `active`. | yes | **yes** (the one active key) |
| (create) | rotating | Successor key generated and staged during an overlap before/instead of immediate promotion. | yes | no |
| active | rotating | Rotation: a newer key is activated; this key steps down from *the* signing key but stays trusted for the overlap window so prior tokens keep verifying (TR-007). | yes | no |
| rotating | retired | Overlap window closes: key no longer offered for signing but remains publishable/trusted until explicitly removed (spec Edge Cases). | yes | no |
| active / rotating / retired | revoked | Compromise/emergency: removed from the published keyring and never selected again; row retained for audit history (TR-009). | **no** | no |
| retired | (row removed) | Operator explicitly removes a retired key from the keyring (`DELETE`); `audit_log` preserves the lifecycle record. Alternatively ages out via `valid_until`. | no (absent) | no |

Rules:

- **Trusted/published set** = `status IN {active, rotating, retired}` → the keyring view.
- **Signing selection** = `status = 'active'` only (exactly one per product).
- `revoked` is **terminal** and always retained; it never re-enters the keyring and is never selected. There is no `revoked → active` (issue a new key instead).
- Every transition writes an append-only `audit_log` row (see [§7](#7-audit)).

## 7. Audit (reuses E002 `audit_log`)

Every key lifecycle event appends one `audit_log` row in the same transaction as the mutation (TR-014, SC-003). No private key material is ever written to `before`/`after`.

| Event | action | target_id | Notes |
|-------|--------|-----------|-------|
| Create/provision | `signing_key.created` | signing_key.id (+ key_id) | `after` = public fields only. |
| Rotate | `signing_key.rotated` | signing_key.id | Records old→new active `key_id`. |
| Retire | `signing_key.retired` | signing_key.id | End of overlap. |
| Revoke | `signing_key.revoked` | signing_key.id | `security_event = true` (compromise/emergency). |

## 8. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant   ||--o{ signing_key : "owns"
    product  ||--o{ signing_key : "owns (E007 FK deferred)"
    app_user ||--o{ signing_key : "created_by"
    tenant   ||--o{ audit_log   : "logs lifecycle"
    signing_key ||..o{ product_keyring : "projected as view"

    signing_key {
        uuid id PK
        uuid tenant_id PK-FK
        uuid product_id FK
        text key_id UK
        text algorithm
        bytea public_key
        text status
        timestamptz valid_from
        timestamptz valid_until
        bytea private_key_ref "wrapped/handle - never plaintext"
        text custody_scheme
        uuid created_by FK
        timestamptz created_at
    }

    product_keyring {
        uuid tenant_id
        uuid product_id
        text key_id
        text algorithm
        bytea public_key
        timestamptz valid_from
        timestamptz valid_until
        text status
    }

    product {
        uuid id PK "owned by E007"
        uuid tenant_id FK
    }
```

</details>

## 9. Data Model Summary (drop into plan)

| Entity / Object | Kind | Key Attributes | Relationships | State Transitions |
|-----------------|------|----------------|---------------|-------------------|
| `signing_key` | new tenant-owned table | id, tenant_id, product_id, key_id (uniq per product), algorithm='ed25519', public_key (bytea), status{active,rotating,retired,revoked}, valid_from/until, private_key_ref (wrapped/handle, nullable), custody_scheme, created_by | belongs_to tenant + product (E007 FK deferred); created_by→app_user; feeds `product_keyring`; audited in `audit_log` | active→rotating→retired; any→revoked; retired→removed |
| `product_keyring` | derived VIEW (not a table) | public_key + key_id + algorithm + validity + status, WHERE status IN(active,rotating,retired); `security_invoker` | reads signing_key | reflects base rows |
| custodian share | operational/config (NOT in DB) | Shamir k-of-n unlock material, out-of-band (E006) | unlocks keystore master key at runtime | n/a |
| `product` | E007-owned (referenced only) | referenced via `signing_key.product_id`; hard composite FK deferred to E007 | owns signing_key | n/a |
| `audit_log` | reused (E002) | append-only lifecycle events (created/rotated/retired/revoked) | logs signing_key | append-only |

**Indexes**: PK `(tenant_id, id)`; UNIQUE `(tenant_id, product_id, key_id)`; partial UNIQUE `(tenant_id, product_id) WHERE status='active'`; INDEX `(tenant_id, product_id, status)`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY`; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT,INSERT,UPDATE,DELETE ON signing_key TO licensesrv_app`.

**Custody invariant**: no column ever stores a plaintext private key; `private_key_ref` is either an AES-256-GCM-wrapped blob (useless without the Shamir-unlocked master key) or an opaque KMS/PKCS#11 handle; both `private_key_ref` and `custody_scheme` are excluded from every keyring/API projection.

**Migration**: `migrations/0004_signing_keys.sql` — expand-only, sequential: `CREATE TABLE signing_key`, indexes, `ENABLE`/`FORCE` RLS + `tenant_isolation` policy + grants, `CREATE VIEW product_keyring`.
