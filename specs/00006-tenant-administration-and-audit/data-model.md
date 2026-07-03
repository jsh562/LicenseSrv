# Data Model: Tenant Administration & Audit

> Feature `00006-tenant-administration-and-audit` | Epic E005 | 2026-07-02
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations, Node 22 / TypeScript. Source under `/src/server`.
> Scope: **EXTENDS** the E002 tenancy substrate (`migrations/0000..0004`). Adds interactive human sign-in credentials (on the existing `app_user`) and one new tenant-owned table — **`admin_session`**. **Reuses** the E002 `role`, `api_key`, and append-only `audit_log` tables unchanged. No new audit table, no new role table.
> Source signals: spec FR-001…FR-018, Key Entities (User, Role, Session, API key, Audit entry); ADR-0004 (shared-schema + RLS); ADR-0007 (REST/JSON admin API). E002 schema `migrations/0000_init.sql`, `0002_rls_roles_grants.sql`; E002 data model `specs/00003-tenancy-and-data-foundation/data-model.md`.
> New migration: `migrations/0005_admin_sessions.sql` (expand-only, sequential — additive `ALTER app_user` columns + `CREATE TABLE admin_session` + indexes + RLS/policy/grants).

## Conventions (inherited from E002 — do not re-decide)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `app_user` / `role` / `api_key` / `audit_log` in `0000_init.sql` — so every FK to a tenant-owned table can be a tenant-scoped **composite FK** and referential integrity stays tenant-local.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`. All `*_id` references to tenant-owned tables use a **composite FK including `tenant_id`** so a reference can never cross tenants.
- **Timestamps**: `timestamptz` (UTC); `created_at` defaults `now()`.
- **Status columns**: `text NOT NULL DEFAULT '…' CHECK (status IN (…))` — the actual migration idiom (see `api_key.status`, `signing_key.status`), not native pgEnum.
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`, form `USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`. Unset GUC → NULL → **zero rows** (unscoped access refused, never run unscoped). App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Secrets never in cleartext**: credential material is stored only as a one-way hash (`api_key.key_hash`). E005 adds two more hashed-only columns — `app_user.password_hash` and `admin_session.token_hash`. Raw passwords and raw session tokens are never stored, logged, or returned.
- **Audit on mutation**: every administrative mutation appends one row to the existing `audit_log` in the **same transaction** (INSERT/SELECT-only grant → append-only). No new audit table.

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **app_user** (EXTENDED — `ALTER`, expand-only) | *existing (E002):* id: uuid, tenant_id: uuid NOT NULL FK→tenant, email_hash: text NOT NULL, created_at. *added by E005:* password_hash: text **null** (slow-KDF hash — scrypt/argon2; NEVER plaintext, FR-017), status: text NOT NULL DEFAULT 'active' CHECK IN(invited,active,deactivated) (FR-006/007), failed_login_count: int NOT NULL DEFAULT 0, locked_until: timestamptz **null** (FR-018). PK `(tenant_id, id)`; existing UNIQUE `(tenant_id, email_hash)`. | belongs_to: tenant; has_many: role (grants), admin_session; created_by of: api_key, signing_key; logged in: audit_log | invited → active (first password set / activation); active → deactivated (FR-006/007); deactivated → active (reactivate). See [§11](#11-state-machines) |
| **admin_session** (NEW table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, user_id: uuid NOT NULL (composite FK→app_user), token_hash: text NOT NULL **UNIQUE** (hash of the opaque random cookie token — raw token NEVER stored, mirrors `api_key.key_hash`), expires_at: timestamptz NOT NULL, revoked_at: timestamptz **null**, created_at: timestamptz NOT NULL DEFAULT now(), last_seen_at: timestamptz **null**. PK `(tenant_id, id)`. | belongs_to: tenant, app_user; logged in: audit_log | active → expired (`now() ≥ expires_at`) / revoked (sign-out, `revoked_at` set). See [§4](#4-sessions--the-two-lookups-fr-001fr-003), [§11](#11-state-machines) |
| **role** (REUSED — E002, unchanged) | id, tenant_id FK→tenant, user_id (composite FK→app_user), role: text CHECK IN(owner,admin,viewer), granted_by. UNIQUE `(tenant_id, user_id, role)`. | belongs_to: tenant, app_user (assignee), app_user (granted_by) | grant = INSERT row; change = swap rows; **last-owner safeguard is an app-layer invariant** ([§7](#7-role-assignments--last-owner-safeguard-fr-008)) |
| **api_key** (REUSED — E002, unchanged) | id, tenant_id FK→tenant, key_hash UNIQUE, scopes text[], status CHECK IN(active,revoked), created_by, created_at, revoked_at. | belongs_to: tenant; created_by → app_user | create → rotate (revoke old + create new) → revoke. Secret shown once, never re-projected ([§8](#8-api-key-lifecycle-reuses-api_key-fr-009fr-010)) |
| **audit_log** (REUSED — E002, unchanged) | id, tenant_id FK→tenant, actor text, action text, target text, before jsonb, after jsonb, security_event bool, ts. INSERT/SELECT-only grant. | belongs_to: tenant | append-only, immutable (FR-013) |

> Downstream agents consume the rows above. Only **`app_user` (ALTER)** and **`admin_session` (new)** carry DDL in this feature; `role`, `api_key`, and `audit_log` are listed to make explicit that E005 **reuses** them and MUST NOT recreate them.

## 2. `app_user` extension — column detail (`ALTER`, expand-only, FR-006/007/017/018)

All four columns are additive and backward-compatible (each is nullable or defaulted), so a prior app version keeps running against the extended table (expand-only, TR/E002 §7).

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| password_hash | text | — | **yes** | **Slow-KDF one-way hash** of the interactive password — scrypt/argon2/bcrypt with a per-user salt embedded in the encoded hash (FR-017). **NEVER plaintext**, never logged, never returned by any API ([§10](#10-secret-hygiene-invariant-fr-009fr-017)). Nullable because a principal may legitimately have **no password**: an invited-but-not-yet-activated user (`status='invited'`, activated to `'active'` on first password set), or a P2 SSO-only user (FR-016). A null `password_hash` means "cannot sign in via password" — distinct from `status='deactivated'` (the two "cannot sign in" states are not conflated). |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('invited','active','deactivated'))` | no | Account state (FR-006). Closed domain of **three** values (matches the API contract `UserStatus` enum `[invited, active, deactivated]`): **`invited`** = created but not yet activated — no `password_hash` set, so cannot sign in via password (invite-first user); **`active`** = normal, can sign in and act; **`deactivated`** = blocked. The column DEFAULT is `'active'` (a user created together with a password lands `active`); the **invite-first** flow explicitly inserts `status='invited'`, and setting the first password transitions **`invited → active`** ([§11](#11-state-machines)). `deactivated` blocks sign-in and all actions on subsequent requests **immediately** (FR-007, [§11](#11-state-machines)). Same text+CHECK idiom as `api_key.status`. (The E002 data-model's aspirational `active/disabled/deleted` naming is superseded here by the FR-006/007 `active/deactivated` lifecycle plus the contract's `invited` pre-activation state; GDPR erase remains the E002 job, not a `status` value.) |
| failed_login_count | int | NOT NULL, DEFAULT `0` | no | Consecutive failed sign-in attempts since the last success (FR-018). Incremented on each failed password verify; reset to `0` on a successful sign-in. Drives lockout ([§9](#9-brute-force-lockout-semantics-fr-018)). |
| locked_until | timestamptz | — | **yes** | When set and `now() < locked_until`, sign-in is **refused regardless of a correct password** (temporary brute-force lockout, FR-018). Cleared on successful sign-in or when the window elapses. Null = not locked. Independent of `status` (a lock is temporary; deactivation is administrative). |

> Login by email: `email_hash` is UNIQUE **only per tenant** (`UNIQUE (tenant_id, email_hash)`), so interactive sign-in requires a **tenant selector** (slug/subdomain). The app resolves slug → tenant, sets `app.current_tenant`, then looks up the user by `email_hash` **under RLS** and verifies the entered password against `password_hash`. Contrast the **session-token** lookup, which is pre-tenant ([§4](#4-sessions--the-two-lookups-fr-001fr-003)). No new index is needed — the existing `(tenant_id, email_hash)` unique index backs the login lookup.
>
> `app_user` already has RLS `ENABLE`+`FORCE`, the `tenant_isolation` policy, and `SELECT/INSERT/UPDATE/DELETE` grants from E002 `0002`. The `ALTER` adds columns only and **inherits** that isolation and those grants unchanged — the migration adds no RLS/grant statement for `app_user`.

## 3. `admin_session` — column detail (new table, FR-001/FR-003)

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical session id (safe to surface in a session list). |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | The single tenant the session is bound to (FR-001). Matches the RLS predicate; a session can never span tenants (FR-002, SC-002). |
| user_id | uuid | NOT NULL, composite FK `(tenant_id, user_id) → app_user(tenant_id, id)` | no | The human principal the session authenticates. Intra-tenant composite FK (cannot reference a user in another tenant), same technique as `api_key.created_by` / `role.user_id`. |
| token_hash | text | NOT NULL, **UNIQUE** | no | **One-way hash of the opaque, high-entropy random session token** carried in the cookie — raw token is **NEVER stored** (mirrors `api_key.key_hash`, FR-017). A **fast** hash (SHA-256, optionally HMAC-keyed like `key_hash`) is sufficient and correct here: the token is not a guessable low-entropy secret, so a slow KDF is unnecessary (contrast `password_hash`, which MUST be slow-KDF). Globally UNIQUE → enables the **pre-tenant** resolution lookup ([§4](#4-sessions--the-two-lookups-fr-001fr-003)). |
| expires_at | timestamptz | NOT NULL | no | Absolute expiry (bounded lifetime, FR-003). A session with `now() ≥ expires_at` grants no access even if not explicitly revoked. |
| revoked_at | timestamptz | — | yes | Set on explicit sign-out or admin/forced revocation (FR-003). Non-null ⇒ the session authenticates nothing, effective for the next request. |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Sign-in time. |
| last_seen_at | timestamptz | — | yes | Best-effort activity telemetry, bumped on use (supports idle-timeout policy and the user's session list). Not authoritative for expiry. |

> A session is **valid** iff `revoked_at IS NULL AND now() < expires_at` (and the owning `app_user.status = 'active'`). Sign-out sets `revoked_at = now()`. Expired/revoked rows are retained for audit/telemetry and pruned by a background job (`DELETE`) — their lifecycle is preserved in `audit_log`.

## 4. Sessions — the two lookups (FR-001/FR-003)

There are two distinct credential lookups, mirroring the E002 split between the machine-auth bootstrap and tenant-scoped work:

| Lookup | When | Keyed by | Tenant context | Path |
|--------|------|----------|----------------|------|
| **Interactive sign-in** | Password login | `email_hash` (UNIQUE **per tenant**) | Tenant already resolved from the slug/subdomain selector | Tenant-scoped: `withTenant` → RLS-scoped `SELECT app_user … WHERE email_hash=$1`, verify `password_hash`, then `INSERT admin_session`. |
| **Session resumption** | Every subsequent request carrying the cookie | `token_hash` (**globally** UNIQUE) | **Not yet known** — this is the *pre-tenant* lookup | **Privileged pre-tenant lookup**, exactly like `resolveApiKey`: run on the privileged (RLS-bypassing) connection — `SELECT tenant_id, user_id, expires_at, revoked_at FROM admin_session WHERE token_hash=$1`; validate not expired/revoked and owner `status='active'`; **then** set `app.current_tenant` and drop to `licensesrv_app` for all further work. |

- The privileged resumption reads only the row needed to resolve `(tenant_id, user_id)` and validity; it never returns `token_hash` and does nothing tenant-scoped. This is the one legitimate cross-tenant read for sessions, matching `src/server/auth/apikey.ts::resolveApiKey` + `db/client.ts::privileged`.
- **Tenant-scoped session listing** — a signed-in user viewing/revoking *their own* sessions — runs under ordinary RLS via `withTenant`, so it can only ever see the current tenant's rows (FR-002).
- Because the whole request runs under one resolved tenant with `FORCE` RLS, a plugged-in admin surface (catalog/issuance/etc.) inherits the session's tenant scope and cannot read or act outside it (FR-015, SC-010).

## 5. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| `admin_session` PK | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access + the intra-tenant composite FK from nothing-else-yet (self-contained). |
| `admin_session.user_id` FK | `FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)` | Session belongs to a user **inside the same tenant**; cross-tenant binding is structurally impossible. |
| Global token lookup | `UNIQUE (token_hash)` (implicit unique index) | The pre-tenant resumption lookup ([§4](#4-sessions--the-two-lookups-fr-001fr-003)); one token ⇒ at most one session, resolved without a tenant. Mirrors `api_key.key_hash`. |
| Per-user session listing | `CREATE INDEX idx_admin_session_user ON admin_session (tenant_id, user_id)` | `tenant_id`-leading; serves "list/revoke my sessions" and per-user active-session scans under RLS. |
| `app_user` login lookup | *(reuses existing)* `UNIQUE (tenant_id, email_hash)` | No new index — the existing per-tenant email-hash unique index backs interactive sign-in. |

All new indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 §4). The composite FK `(tenant_id, user_id)` is backed by `idx_admin_session_user`, so FK validation stays tenant-local.

## 6. RLS, role & grants (`admin_session`)

Identical form to E002 `0002_rls_roles_grants.sql` / E004 `0004_signing_keys.sql`:

```sql
ALTER TABLE admin_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_session FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON admin_session
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_session TO licensesrv_app;
```

- Unset GUC → `NULLIF(...)` → NULL → predicate matches **zero rows**, so any tenant-scoped session query without a resolved tenant is refused, never run unscoped (FR-002, SC-002).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too, so no owner-owned view/function silently bypasses isolation.
- `UPDATE` is required to bump `last_seen_at` and to set `revoked_at` (sign-out); `DELETE` prunes expired/revoked rows. `INSERT` creates a session at sign-in.
- The **pre-tenant resumption** ([§4](#4-sessions--the-two-lookups-fr-001fr-003)) deliberately runs on the **privileged** connection (not `licensesrv_app`), because with the GUC unset RLS would return zero rows for the token lookup — exactly the sanctioned bootstrap path used by `resolveApiKey`.
- No grant/RLS change for `app_user`, `role`, `api_key`, `audit_log` — they keep their E002 policies and grants.

## 7. Role assignments & last-owner safeguard (FR-008)

E005 reuses the E002 `role` table verbatim — **no new role table, no DDL**:

- **Grant a role** = `INSERT` a `role` row `(tenant_id, id, user_id, role, granted_by)`; `UNIQUE (tenant_id, user_id, role)` prevents duplicate grants.
- **Change a role** = insert the new grant and delete the old (a swap), within one transaction.
- **Deactivate a user** = set `app_user.status='deactivated'` (their grants may remain but confer no access while deactivated).

**Last-owner safeguard = app-layer invariant, NOT a DB constraint.** Whether removing/demoting an owner would strand the tenant is **cross-row** logic (a count of remaining active-user owners for the tenant), which a per-row CHECK/FK cannot express. It is enforced in the repository, in the same transaction as the mutation:

- Before deleting or demoting an `owner` grant, assert **≥ 1 other `active`-user owner** remains for the tenant; otherwise **refuse (fail-closed)** and record a `security_event` (FR-005/008, SC-005).
- **Concurrency**: two simultaneous demotions could each pass a naive count and jointly strand the tenant. Guard with row-locking (`SELECT … FOR UPDATE` over the tenant's owner grants) or a `SERIALIZABLE` transaction so the invariant holds under contention. Also treat deactivating the last active owner as covered by the same guard.

Documented here as an invariant so it is implemented in the repository/app layer, not (re)modeled as a database constraint.

## 8. API-key lifecycle (reuses `api_key`, FR-009/FR-010)

No new table — the runtime API-key surface drives the existing E002 `api_key`:

| Action | Effect on `api_key` | Audit |
|--------|---------------------|-------|
| Create | `INSERT` row with `scopes[]`, `status='active'`, `created_by`; the raw secret is **shown exactly once** at creation, only `key_hash` is stored. | `api_key.created` |
| Rotate | Revoke the old row (`status='revoked'`, `revoked_at=now()`) **and** create a new key (or a new key superseding the old); the old secret stops authenticating. | `api_key.rotated` (+ create/revoke) |
| Revoke | `status='revoked'`, `revoked_at=now()`; the key authenticates nothing thereafter. | `api_key.revoked` |
| View later | Project **metadata/status only** — `key_hash` is never returned ([§10](#10-secret-hygiene-invariant-fr-009fr-017)). | (read; not a mutation) |

`api_key` retains its E002 RLS/grants; `resolveApiKey` (the machine-auth pre-tenant lookup) is unchanged.

## 9. Brute-force lockout semantics (FR-018)

Sign-in is throttled/locked using the two new `app_user` columns:

1. **Failed attempt** → `failed_login_count = failed_login_count + 1`. When it crosses the threshold `N`, set `locked_until = now() + backoff` (fixed or exponential window). Emit an auditable lockout/throttle event (`auth.login_locked`, `security_event = true`).
2. **While locked** (`locked_until IS NOT NULL AND now() < locked_until`) → sign-in is refused **before** password verification, regardless of a correct password. Emit `auth.login_throttled` (security event).
3. **Successful sign-in** → `failed_login_count = 0`, `locked_until = NULL`, `INSERT admin_session`, audit `auth.login`.
4. **Independent from `status`**: `status='deactivated'` blocks sign-in permanently (until reactivated, FR-007); `locked_until` blocks it temporarily (self-clears). Both gates are checked; either one denies. A null `password_hash` also denies password sign-in (no credential set).

To avoid user enumeration, the same generic failure is returned to the client whether the email/tenant is unknown, the password is wrong, the account is locked, or the user is deactivated — the distinction lives only in the audit trail.

## 10. Secret-hygiene invariant (FR-009/FR-017)

Mirrors the E004 custody invariant: **no hashed-credential column is ever returned by any API projection or written to any log.**

- `app_user.password_hash` — never selected into any response, never logged. User projections expose `id`, `status`, and a masked/`email_hash`-derived identifier only.
- `admin_session.token_hash` — never returned. The raw token exists only in the `Set-Cookie` at sign-in and in the client cookie; the server stores and compares only the hash. Session listings project `id`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at` — never `token_hash`.
- `api_key.key_hash` / raw secret — unchanged E002 rule: secret shown once at creation, never re-derivable, `key_hash` never projected (FR-009).
- `audit_log.before/after` snapshots MUST be PII/secret-minimized at write time — never snapshot a password, token, or key hash.

## 11. State machines

### `app_user.status`

Simple two-state lifecycle (inline):

`invited → active` (first password set / activation — an invite-first user with a null `password_hash` becomes `active` once they set a password); `invited → deactivated` (admin cancels a pending invite before activation); `active → deactivated` (admin deactivate, FR-006) — blocks sign-in and all actions on the next request (FR-007); `deactivated → active` (admin reactivate; a reactivated user returns to `active`, never back to `invited`). No other transitions are defined. GDPR erase remains the separate E002 job (not a `status` value). Guarded by the last-owner safeguard when deactivating an owner ([§7](#7-role-assignments--last-owner-safeguard-fr-008)).

### `admin_session` lifecycle

Simple lifecycle (inline). A session is **valid** iff `revoked_at IS NULL AND now() < expires_at AND owner.status='active'`:

- `active → revoked` — explicit sign-out or forced revocation sets `revoked_at = now()` (FR-003). Terminal.
- `active → expired` — implicit at `now() ≥ expires_at`; no column change, but the session grants no access (FR-003).
- Deactivating/erasing the owner invalidates all their sessions on the next request (owner-status gate; sessions may also be revoked eagerly).
- Expired/revoked rows are retained then background-`DELETE`d; the event history persists in `audit_log`.

### `api_key.status`

Unchanged from E002: `active → revoked` (terminal); rotate = revoke + create new. No `revoked → active`.

## 12. Audit (reuses E002 `audit_log`, FR-011..014)

Every administrative mutation and every denial appends one `audit_log` row in the **same transaction** (atomic — an audit-write failure rolls back the mutation). Columns are the actual E002 schema: `actor, action, target, before, after, security_event, ts`. No secret material is ever written to `before`/`after`.

| Event | action | target | security_event | Notes |
|-------|--------|--------|----------------|-------|
| Sign-in | `auth.login` | admin_session.id | false | Attributes the acting principal (FR-014). |
| Sign-out / revoke session | `auth.logout` / `session.revoked` | admin_session.id | false | |
| Failed login / lockout / throttle | `auth.login_failed` / `auth.login_locked` / `auth.login_throttled` | app_user.id | **true** | Credential-guess events are auditable (FR-018). |
| Create / deactivate / reactivate user | `user.created` / `user.deactivated` / `user.reactivated` | app_user.id | false | `after` = non-secret fields only. |
| Grant / change / revoke role | `role.granted` / `role.changed` / `role.revoked` | role.id (+ user_id) | false | |
| Last-owner refusal / RBAC denial | `role.last_owner_blocked` / `authz.denied` | target of the attempt | **true** | Fail-closed denials recorded as security events (FR-005, SC-003/SC-005). |
| API-key create / rotate / revoke | `api_key.created` / `api_key.rotated` / `api_key.revoked` | api_key.id | false / rotate: false | Secret never in `before`/`after` (FR-009). |

The audit log is **append-only and tamper-evident**: `licensesrv_app` holds only `INSERT`/`SELECT` on `audit_log` (no `UPDATE`/`DELETE`), so no console action by any role — including owner — can edit or delete an entry (FR-013, SC-007). The read-only audit view (FR-011/012) filters by `ts` range and `security_event`, both backed by the E002 indexes `idx_audit_tenant_ts` and partial `idx_audit_security_event`.

## 13. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant   ||--o{ app_user      : "owns"
    tenant   ||--o{ admin_session : "owns"
    tenant   ||--o{ role          : "owns"
    tenant   ||--o{ api_key       : "owns"
    tenant   ||--o{ audit_log     : "owns"
    app_user ||--o{ admin_session : "authenticates"
    app_user ||--o{ role          : "assigned"
    app_user ||--o{ api_key       : "created_by"

    app_user {
        uuid id PK
        uuid tenant_id PK-FK
        text email_hash UK
        text password_hash "slow-KDF - never plaintext"
        text status "invited|active|deactivated"
        int failed_login_count
        timestamptz locked_until
        timestamptz created_at
    }

    admin_session {
        uuid id PK
        uuid tenant_id PK-FK
        uuid user_id FK
        text token_hash UK "hash of cookie token - never raw"
        timestamptz expires_at
        timestamptz revoked_at
        timestamptz last_seen_at
        timestamptz created_at
    }

    role {
        uuid id PK
        uuid tenant_id PK-FK
        uuid user_id FK
        text role "owner|admin|viewer"
        uuid granted_by
    }

    api_key {
        uuid id PK
        uuid tenant_id PK-FK
        text key_hash UK
        text_array scopes
        text status "active|revoked"
        uuid created_by FK
        timestamptz revoked_at
    }

    audit_log {
        uuid id PK
        uuid tenant_id PK-FK
        text actor
        text action
        text target
        jsonb before
        jsonb after
        bool security_event
        timestamptz ts
    }
```

</details>

## 14. Data Model Summary (drop into plan)

| Entity / Object | Kind | Key Attributes | Relationships | State Transitions |
|-----------------|------|----------------|---------------|-------------------|
| `app_user` | **EXTENDED** (E002 table, `ALTER` expand-only) | +password_hash (slow-KDF, nullable, never plaintext), +status{invited,active,deactivated} DEFAULT active (invite-first inserts invited), +failed_login_count int DEFAULT 0, +locked_until (nullable) | belongs_to tenant; has_many role, admin_session; created_by of api_key/signing_key; audited | invited→active; active↔deactivated |
| `admin_session` | **NEW** tenant-owned table | id, tenant_id, user_id (composite FK→app_user), token_hash (**UNIQUE**, hash of cookie token — never raw), expires_at, revoked_at, created_at, last_seen_at | belongs_to tenant + app_user; audited | valid → revoked (sign-out) / expired |
| `role` | REUSED (E002) | user→role grant {owner,admin,viewer}; UNIQUE(tenant_id,user_id,role); **last-owner safeguard = app-layer invariant (FR-008), not a DB constraint** | belongs_to tenant, app_user | grant=insert; change=swap; revoke=delete (guarded) |
| `api_key` | REUSED (E002) | key_hash UNIQUE, scopes[], status{active,revoked}; rotate = revoke old + create new; secret shown once | belongs_to tenant; created_by→app_user; audited | active→revoked |
| `audit_log` | REUSED (E002) | append-only (actor, action, target, before, after, security_event, ts); INSERT/SELECT-only | belongs_to tenant | append-only, immutable |

**New indexes**: `admin_session` PK `(tenant_id, id)`; `UNIQUE (token_hash)` (global pre-tenant lookup); `INDEX idx_admin_session_user (tenant_id, user_id)` (per-user listing under RLS). `app_user` login reuses existing `UNIQUE (tenant_id, email_hash)` — no new index. Audit filtering reuses E002 `idx_audit_tenant_ts` + partial `idx_audit_security_event`.

**RLS/grants**: `admin_session` gets `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`, `GRANT SELECT,INSERT,UPDATE,DELETE ON admin_session TO licensesrv_app`. `app_user` `ALTER` **inherits** its existing E002 RLS/policy/grants (migration adds none). No RLS/grant change to `role`/`api_key`/`audit_log`.

**Two credential lookups**: interactive login by `email_hash` is **tenant-scoped** (needs a slug/subdomain selector; email_hash unique only per tenant); session resumption by `token_hash` is a **privileged pre-tenant lookup** (globally UNIQUE), mirroring `resolveApiKey` + `db/client.ts::privileged`, after which `app.current_tenant` is set and all work is RLS-scoped.

**Secret-hygiene invariant**: `password_hash` (slow-KDF), `token_hash` (fast hash of high-entropy token), and `key_hash` are **never** returned by any API projection or written to any log; raw password/token/secret are never stored. `before`/`after` audit snapshots are secret-minimized.

**Migration**: `migrations/0005_admin_sessions.sql` — expand-only, sequential (after `0004`): `ALTER TABLE app_user ADD COLUMN … (password_hash, status, failed_login_count, locked_until)`; `CREATE TABLE admin_session (…)` + composite FK; `CREATE UNIQUE INDEX`/`CREATE INDEX`; `ENABLE`/`FORCE` RLS + `tenant_isolation` policy + grants. No new audit/role table; `role`, `api_key`, `audit_log` reused unchanged.
