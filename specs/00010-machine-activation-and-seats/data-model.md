# Data Model: Machine Activation & Seat Enforcement

> Feature `00010-machine-activation-and-seats` | Epic E009 | 2026-07-13
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0005`) and the E008 `license` table (`migrations/0007_licensing.sql`). Adds exactly ONE new tenant-owned table — **`activation`** — with tenant-scoped forced RLS and audit-on-mutation. No changes to existing tables.
> Source signals: spec FR-001…FR-024, Key Entities, Edge Cases, SC-001…SC-020; research.md (K-of-N drift, race-safe seat counting, nonce store-and-replay); E008 data model `specs/00009-license-issuance-and-lifecycle/data-model.md` (`migrations/0007_licensing.sql`); E002 RLS `migrations/0002_rls_roles_grants.sql`; the E004 signer + LIC1 `Claims` in `src/server/modules/signing/token.ts` (`fp`/`fpk`/`sk`); `src/server/db/hash.ts` (salted HMAC).
> New migration: `migrations/0008_activation.sql` (expand-only, sequential after 0007 — one additive table + indexes + RLS/policy/grants).

## Conventions (inherited from E002 / E008)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `license` / `customer` / `product` / `plan` — so referential integrity stays tenant-local and the FK to the parent is a **composite FK including `tenant_id`**: an activation can never bind to another tenant's license.
- **Tenancy**: the row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **Timestamps**: `timestamptz` (UTC). `activated_at` defaults `now()`; `updated_at` defaults `now()` and is bumped by the repository on every edit (credential refresh, deactivation); `deactivated_at` is set on the flip to `deactivated`.
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: every activation, deactivation, and denied/limit-exceeded attempt appends one row to the existing `audit_log` (INSERT/SELECT-only grant → append-only) in the same transaction (FR-014); denied RBAC attempts set `security_event = true` (FR-012/SC-009). No new audit table.
- **Status enums** are free `text` with an inline `CHECK (status IN (...))` — same technique as `license.status`, `product.status`, `api_key.status`.
- **Hashes are `text`** (hex digests), matching `app_user.email_hash` / `api_key.key_hash`; arrays are `text[]`, matching `api_key.scopes`. Salted hashing is `src/server/db/hash.ts` (`saltedHash`), computed **client-side** for machine signals — the server never sees raw identifiers.

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **activation** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, license_id: uuid NOT NULL, machine_id: text NOT NULL (salted hash = canonical machine identity), signal_hashes: text[] NOT NULL (N per-signal salted hashes → token `fp`), fp_min: int NOT NULL (K threshold → token `fpk`), status: text NOT NULL DEFAULT 'active' CHECK IN(active,deactivated), nonce: text NOT NULL, machine_bound_token: text null (re-signed LIC1 credential), label: text null (pseudonymous, erasable), activated_at, updated_at, deactivated_at: timestamptz null. PK `(tenant_id, id)`; composite FK `(tenant_id, license_id)→license`; UNIQUE `(tenant_id, nonce)`; partial UNIQUE `(tenant_id, license_id, machine_id) WHERE status='active'`; CHECK `fp_min ∈ [1, cardinality(signal_hashes)]`. | belongs_to: tenant, license; logged in: audit_log | active ↔ deactivated (idempotent both directions). See [§7](#7-state-machine--activation-lifecycle-fr-010011) |
| **license** (E008, reused — NOT re-modeled) | read-only here: `status` (must be `active` to activate), `max_activations` (the snapshotted seat cap). | has_many: activation | (owned by E008 — [§10](#10-integration-boundaries)) |

> Downstream agents consume the `activation` row above. `license`, `audit_log`, and `tenant` are reused from E008/E002 and are **not** re-modeled here — they are referenced only at the integration boundaries ([§10](#10-integration-boundaries)). Seat usage is not a stored column: it is `COUNT(*)` of a license's `active` activations ([§4](#4-seat-count--race-safety-fr-003)).

## 2. `activation` — column detail

Tenant-scoped binding of one license to one machine. The machine is identified **only by salted hashes** (FR-006). A row holds no raw hardware identifier and no secret key material.

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical activation id. Tenant-local; a cross-tenant reference resolves to zero rows under RLS (FR-015, SC-012). |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-015). Matches the RLS predicate. |
| license_id | uuid | NOT NULL, composite FK `(tenant_id, license_id) → license(tenant_id, id)` | no | The license this activation consumes a seat of (FR-001). Intra-tenant composite FK — cannot bind another tenant's license. `ON DELETE NO ACTION` backstops hard-delete of a license that still has activations. |
| machine_id | text | NOT NULL | no | **Canonical machine identity** — the salted hash of the full, sorted signal set (client-computed, FR-006). The pseudonymous identity shown in the registry (FR-012, SC-011). Used for exact re-match and for the partial-unique seat constraint. **Never** a raw hardware id. |
| signal_hashes | text[] | NOT NULL, `CHECK cardinality ≥ fp_min` | no | The **N per-signal salted hashes** (client-computed via a shared activation salt). Bound into the credential as the token `fp` claim. Drives K-of-N overlap matching ([§5](#5-k-of-n-match-semantics-fr-005)). Stores **only hashes**, never raw signals (FR-006, SC-011). |
| fp_min | int | NOT NULL, `CHECK (fp_min > 0 AND fp_min <= cardinality(signal_hashes))` | no | The **K threshold** (default 3 of N=5). Bound into the credential as the token `fpk` claim; the offline verifier requires ≥ K signal matches on the bound machine (FR-005, FR-007). The DB floors K ≥ 1 and caps K ≤ N; the *default* K/N is server config, not per-request client choice. |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','deactivated'))` | no | Seat lifecycle (FR-010/011). Only `active` rows consume a seat and are constrained unique per machine. `deactivated` frees the seat and is retained as history ([§7](#7-state-machine--activation-lifecycle-fr-010011)). |
| nonce | text | NOT NULL, UNIQUE `(tenant_id, nonce)` | no | The **single-use activation-request nonce** (FR-009). Anti-replay/idempotency: a reused nonce is DB-rejected so no replay forges a second activation; a same-request retry surfaces the unique violation and replays the original result ([§6](#6-nonce-anti-replay--idempotency-fr-009), SC-010). |
| machine_bound_token | text | | yes | The **re-signed, offline-verifiable LIC1 credential** returned on activation (FR-007) — the license claims plus `fp`/`fpk`/`sk`, minted by the E004 signer. Public artifact (never the signing key, SC-010/SC-011). Null only transiently between the seat-claim INSERT and the sign UPDATE within the same transaction ([§3](#3-what-lives-in-the-machine-bound-credential-vs-the-row), [§4](#4-seat-count--race-safety-fr-003)); refreshed on re-activation. |
| label | text | | yes | Optional **client-supplied pseudonymous** hostname/nickname to help operators recognise a machine in the registry (FR-012). Minimal, erasable data — **nulled on GDPR erasure** ([§9](#9-gdpr--pii-minimization-fr-006)), analogous to `customer.name`/`email`. Never a raw hardware id. |
| activated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | First bind time. Set once; **unchanged** by credential refresh (drift re-activation keeps the original activation and its timestamp). |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped by the repository on every edit — credential refresh (K-of-N re-activation) and deactivation. |
| deactivated_at | timestamptz | | yes | Set when `status` flips to `deactivated` (FR-010). NULL while `active`. Re-activation of a previously-deactivated machine records a fresh `active` row ([§7](#7-state-machine--activation-lifecycle-fr-010011)). |

## 3. What lives in the machine-bound credential vs. the row

`activation` is the system-of-record; `machine_bound_token` is a signed **projection** of the license snapshot plus the fingerprint binding. The E004 signer (reused from E008 issuance) mints a LIC1 token whose claims are exactly today's `Claims` (`src/server/modules/signing/token.ts`) with the three fingerprint claims populated:

| Signed into `machine_bound_token` (LIC1 claims) | Row-only (operational) |
|-------------------------------------------------|------------------------|
| license claims copied from the E008 license snapshot: `lid`, `pid`, `pl`, `cid`, `iat`, `exp`, `maxa`, `ent`, `v`, `kid`, plus a fresh `non`; **and the binding**: `fp` ← `signal_hashes`, `fpk` ← `fp_min`, `sk` ← server clock-skew config | `status`, `nonce` (the activation request nonce), `machine_id`, `label`, `activated_at`, `updated_at`, `deactivated_at` |

> **The three fingerprint claims (`fp`/`fpk`/`sk`) are what make the credential machine-bound.** They already exist as optional fields in the core's `Claims` (`fingerprint`/`fpMin`/`maxSkewSecs`) and are omitted by a plain E008 license; E009 populates them so the E001 verifier core accepts the token **only** on a machine whose live signals still overlap the bound `fp` by ≥ `fpk`, within the `sk` clock-skew window — fully offline, zero network (FR-007, SC-001).
> **`sk` (clock-skew window / `maxSkewSecs`) is a server-config default, stamped into the token at sign time — deliberately NOT a stored column** (like the token itself, it is a signed projection). Persisting `signal_hashes` + `fp_min` is sufficient to re-derive/refresh the credential on drift re-activation.
> **Status is deliberately NOT in the token.** Deactivation flips `status` on this row and frees the seat online; an already-distributed credential still verifies offline until `exp` — the disclosed offline-revocation gap (spec Risks; online propagation is E013).
> **Credential `exp` reconciliation (FR-022).** `exp` is copied from the E008 license snapshot (the license expiry). Where a separate activation-credential TTL is configured (NEW-CONFIG), the value stamped into the token is the **minimum** of the license expiry and that TTL — `min(license exp, credential TTL)`, whichever is sooner — so a configured TTL can shorten but never extend the credential's life beyond the license.

## 4. Seat count & race safety (FR-003)

- **Seat usage is derived, not stored**: `SELECT count(*) FROM activation WHERE license_id = $1 AND status = 'active'`. The seat cap is `license.max_activations` — the value E008 **snapshotted** at issuance; E009 only reads it. No counter column, so it can never drift from the truth.
- **Race safety is a service-layer protocol the schema supports — no DB trigger.** The activation transaction is:
  1. `SELECT status, max_activations FROM license WHERE id = $1 FOR UPDATE` — the row lock **serialises all concurrent activation attempts for that license** (research §2).
  2. Refuse if `status <> 'active'` (FR-008 — distinct reason; suspended/revoked/expired consume no seat).
  3. Resolve the machine against the license's existing `active` activations ([§5](#5-k-of-n-match-semantics-fr-005)): a K-of-N match → refresh in place (no new seat); otherwise a new machine.
  4. For a new machine, count `active` activations; if `count < max_activations`, `INSERT` the seat-claim row; else refuse with `machine_limit_exceeded` and record **no** row (FR-004, SC-003).
  5. Sign the machine-bound credential and `UPDATE ... SET machine_bound_token`; `COMMIT`. A signer fault rolls the whole transaction back — **no seat is claimed** (fail-closed, mirroring E008 issuance).
- Because every writer holds the license row lock across count+insert, N concurrent attempts for S free seats yield **exactly S** successes; the active count never exceeds the cap (SC-002). The partial-unique index `activation_one_active` is the second line of defence — even a mis-ordered code path cannot create a second `active` row for the same machine.

## 5. K-of-N match semantics (FR-005)

A returning machine that has drifted (RAM/NIC swap) must re-use its seat, while a wholly different machine must not. Matching is computed in the service layer over the small, license-scoped set of `active` activations:

| Case | Rule | Outcome |
|------|------|---------|
| Exact machine | `machine_id` equals an existing `active` row's `machine_id` (all signals identical) | Same activation — refresh credential, no new seat. |
| Minor drift | An existing `active` row shares `≥ fp_min` (K) of its `signal_hashes` with the request's N hashes (`cardinality(intersection) ≥ K`) | **Same activation** re-used and refreshed — no additional seat (FR-005, SC-007). Verifies offline after drift (SC-007). |
| New machine | No `active` row shares ≥ K signals | Treated as **new** — consumes a seat only if one is free ([§4](#4-seat-count--race-safety-fr-003)) (SC-008). |
| Too few signals | Request carries fewer than the server-config minimum N signals to form a reliable binding | **Refused** with a distinct reason; no seat consumed (FR-016). The DB `fp_min ≤ N` CHECK backstops K > N. |

- **Multi-match tie-break (deterministic precedence).** Resolution is deterministic even when several `active` rows qualify: **(1)** an **exact `machine_id`** match wins outright — it is a full-signal match identifying exactly one row, so the exact fast path always takes precedence over an overlap match; **(2)** otherwise, among the `active` rows overlapping the request by `≥ fp_min` signals, the service refreshes the single **highest-overlap** candidate (largest `cardinality(intersection)`), breaking any remaining tie by the **most-recently-active** row (greatest `updated_at`, then greatest `activated_at`, then lexicographically greatest `id`). Exactly one existing activation is refreshed; the others are left untouched, so a returning-machine re-activation is unambiguous and repeatable (FR-005, SC-007) and consumes no new seat.
- **Why the service layer, not a DB predicate**: K-of-N is a `cardinality(unnest(a) INTERSECT unnest(b)) ≥ K` comparison against each candidate. A license's candidate set is bounded by its seat cap (typically single/low-double digits), so a scan under the `activation_seat` index `(tenant_id, license_id, status)` is cheap; no GIN/array index is required for MVP. (Should candidate sets grow, a `GIN (signal_hashes)` overlap index is an additive, non-breaking follow-up.)
- Only **hashes** are compared — the server never possesses the raw signals (FR-006, SC-011).

## 6. Nonce anti-replay & idempotency (FR-009)

The `UNIQUE (tenant_id, nonce)` constraint is the store-and-replay mechanism (research §3):

| Scenario | Mechanism | Result |
|----------|-----------|--------|
| Same-request retry (same nonce) | The retried `INSERT` hits `activation_nonce_uniq` | Service catches the violation and **replays the original activation result** — no second seat (FR-009, SC-010). |
| Replay to forge a different activation (reused nonce) | `activation_nonce_uniq` rejects the write | **Rejected** — no replay ever creates a second activation or seat (FR-009, SC-010). |
| Genuine re-activation of the same machine (new nonce) | Resolved by K-of-N ([§5](#5-k-of-n-match-semantics-fr-005)); the `activation_one_active` partial-unique index rejects a second `active` row | Existing `active` row **refreshed** in place — no new seat. |

- Nonces MUST be high-entropy (≥128-bit) single-use values (FR-021), retained for a bounded replay-rejection window (default 24h; NEW-CONFIG, research §3) and per-client scoped. Per-tenant uniqueness matches the RLS scope; cross-tenant collision of a 128-bit nonce is negligible.
- Rate-limiting the runtime activate surface (FR-013) is enforced in the API layer, not the schema.

## 7. State machine — activation lifecycle (FR-010/011)

Only two states, but with idempotent self-loops in both directions and a reactivation branch, so it is called out here rather than only inline. Every transition is audited (FR-014); a denied RBAC deactivation is audited as a `security_event` (FR-012, SC-009).

| From | Action | To | Guard / Effect | Spec |
|------|--------|----|-----------------|------|
| — | activate (new machine) | `active` | license `active` + a free seat under the FOR-UPDATE lock; INSERT seat-claim, sign credential | FR-001/003/007 |
| `active` | re-activate (K-of-N or exact match) | `active` | idempotent — refresh `machine_bound_token`, bump `updated_at`; **no new seat** ([§5](#5-k-of-n-match-semantics-fr-005)) | FR-005, SC-007 |
| `active` | deactivate (app self or operator reclaim) | `deactivated` | set `deactivated_at`, bump `updated_at`; **seat freed** immediately | FR-010, SC-005 |
| `deactivated` | deactivate again / unknown activation | `deactivated` | **idempotent success**, no error; active-seat count never goes negative | FR-011, SC-006 |
| `deactivated` | re-activate the same machine | `active` (new row) | treated as a new bind under the seat check — the freed seat is reusable; the prior `deactivated` row stays as history | FR-010, SC-005 |

- **Reactivation after deactivation is what the *partial* unique index enables**: `activation_one_active` constrains only `status='active'` rows, so a `deactivated` row never blocks a new `active` bind for the same machine, yet at most one `active` row per `(license, machine)` is ever permitted.
- Idempotent deactivation (FR-011) is a no-op UPDATE when the target is already `deactivated` or unknown — it never drives the derived active count below the true value (SC-006).
- **Concurrent deactivate + activate on the same license serialize deterministically (no interleaving).** A deactivation acquires the **same** per-license `SELECT ... FOR UPDATE` lock on the `license` row that an activation takes ([§4](#4-seat-count--race-safety-fr-003)) before it flips `status` to `deactivated`. Because both operations queue on that single row lock, a deactivation racing an at-limit activation runs strictly before or after it, never partway through: if the deactivate commits first it frees a seat that the queued activation then re-counts under the lock and **may claim** (immediate reuse, SC-005); if the activate commits first, the deactivate applies afterward against the already-consistent `active` set. The derived seat count ([§4](#4-seat-count--race-safety-fr-003)) is therefore always evaluated against a committed, serialized state — never a partially-applied interleaving (FR-003, SC-002/SC-005).

## 8. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access and RLS. |
| license FK | composite `(tenant_id, license_id) → license(tenant_id, id)`, `ON DELETE NO ACTION` (RESTRICT) | Seat belongs to a same-tenant license; **enforces FR-024** — a license MUST NOT be hard-deleted while any activation row references it. A stated referential-integrity requirement, not merely a schema default: reclamation is a soft status flip, never a hard delete. |
| `activation_nonce_uniq` | `UNIQUE (tenant_id, nonce)` | Nonce anti-replay/idempotency store-and-replay ([§6](#6-nonce-anti-replay--idempotency-fr-009)); its index also serves nonce lookup (FR-009, SC-010). |
| `activation_one_active` | `CREATE UNIQUE INDEX ... ON activation (tenant_id, license_id, machine_id) WHERE status = 'active'` | **At most one active activation per machine per license** (Key Entities invariant). Partial → idempotent re-activation can't double a seat, reactivation-after-deactivation stays allowed ([§7](#7-state-machine--activation-lifecycle-fr-010011)). |
| `activation_seat` | `CREATE INDEX ... ON activation (tenant_id, license_id, status)` | Seat `COUNT(*) WHERE status='active'` ([§4](#4-seat-count--race-safety-fr-003)) **and** the per-license registry list (via the `(tenant_id, license_id)` prefix) (FR-012). Also the candidate scan for K-of-N ([§5](#5-k-of-n-match-semantics-fr-005)). |
| status enum | `CHECK (status IN ('active','deactivated'))` | Seat lifecycle domain (FR-010/011). |
| fingerprint bound | `CHECK (fp_min > 0 AND fp_min <= cardinality(signal_hashes))` | K in `[1, N]` — at least one signal, never demanding more matches than bound (FR-005/016). |

All indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 convention).

**App-layer invariants** (not expressible as a single-table CHECK): (1) **Race-safe seat cap** — `active` count ≤ `license.max_activations`, held via `SELECT ... FOR UPDATE` on the license row across count+insert ([§4](#4-seat-count--race-safety-fr-003)); the DB partial-unique index is the backstop, not the primary guard. (2) **K-of-N match** — `cardinality(intersection(signal_hashes)) ≥ fp_min` against the license's `active` set ([§5](#5-k-of-n-match-semantics-fr-005)). (3) **License gate** — activation refused unless `license.status='active'` and not expired (FR-008); the seat count is snapshotted from `max_activations`, not re-derived from the catalog. (4) **Minimum signal count N** — a config-driven floor enforced in the app (FR-016); the DB only guarantees `fp_min ≤ N`. (5) **`sk` clock-skew** — a server-config value stamped into the credential at sign time, not a column ([§3](#3-what-lives-in-the-machine-bound-credential-vs-the-row)).

## 9. GDPR / PII minimization (FR-006)

Activation rows are **pseudonymous by construction** and fall under the platform's retention-bounded GDPR-erase path (E001):

| Concern | Design | Enforcement |
|---------|--------|-------------|
| No raw hardware identifiers | `machine_id` + `signal_hashes` are **salted hashes only**, computed client-side; the server never receives or persists raw signals, and none appear in `audit_log` (FR-014). | Contract — the runtime activate API accepts hashes; `src/server/db/hash.ts` salting is client-side. Satisfies FR-006, SC-011. |
| Erasable free-text | `label` is the only free-text field; **nulled on erasure** (analogous to `customer.name`/`email`, FR-019 in E008). | App `UPDATE ... SET label = NULL`. |
| Bounded deletion | The salted hashes are non-reversible pseudonyms; time-bounded purge of stale (deactivated) activation rows is the **platform retention/erase path**, not the app role's DML, within a bounded configurable window (default **90 days after deactivation**, NEW-CONFIG). | No `DELETE` grant to `licensesrv_app` ([§11](#11-rls-policies--grants)) — deactivation is a soft flip; retention purge runs outside the app's DML surface. |

> Because the row carries no raw identifier and no secret, ordinary pseudonymized retention plus label-nulling satisfies the erasure obligation without a hard-delete grant on the runtime role.

## 10. Integration boundaries

- **E008 `license` is read, never modified.** Activation reads `license.status` (must be `active`; suspended/revoked/expired refused, FR-008) and `license.max_activations` (the seat cap, FR-003). This epic *enforces* against the limit E008 *set*; it adds no column to `license`.
- **License lifecycle does NOT cascade to existing activation rows (FR-023).** When a license is later suspended, revoked, or expired, E009 does **not** auto-deactivate or auto-expire its existing `activation` rows: they remain `active`, the derived seat count ([§4](#4-seat-count--race-safety-fr-003)) is unchanged, and the already-issued machine-bound credentials keep verifying offline until their own `exp` — the disclosed offline-revocation tradeoff ([§3](#3-what-lives-in-the-machine-bound-credential-vs-the-row); online propagation is E013). The live `license.status` gates only **new** activations (refused per FR-008); an operator reclaims a stale seat only by **explicit deactivation** (FR-010, [§7](#7-state-machine--activation-lifecycle-fr-010011)). A license is likewise **never hard-deleted while activation rows reference it** — the composite FK is `ON DELETE NO ACTION`/RESTRICT (FR-024, [§8](#8-constraints--indexes)).
- **E004 in-process signer produces `machine_bound_token`.** Activation assembles LIC1 claims from the license snapshot ([§3](#3-what-lives-in-the-machine-bound-credential-vs-the-row)) with `fp`/`fpk`/`sk` populated and calls the same E004 signer E008 issuance uses; the private key is never stored, logged, or returned — only the public token (FR-007, SC-010/SC-011). A signer fault fails closed with **no seat claimed** ([§4](#4-seat-count--race-safety-fr-003)).
- **E001 verifier core verifies offline.** The returned credential verifies fully offline (zero network) and only on the bound machine within `fpk`/`sk` tolerance (FR-007, SC-001) — the same Rust core E003 wraps.
- **E005 auth + RBAC.** The runtime activate/deactivate surface requires an `activate`-scoped API key (FR-002, fail-closed on missing scope); the console registry/deactivate is behind the admin session (viewer reads, admin deactivates, FR-012). Enforcement is in the API layer; the schema is agnostic. A denied deactivation is audited as `security_event` (SC-009).
- **`audit_log` (E002) is reused, append-only.** Every activation, deactivation, and denied/limit-exceeded attempt appends one row in-transaction (FR-014); no new audit table, no changes to its INSERT/SELECT-only grant.
- **Out of scope (downstream).** Online validation/heartbeat and revocation propagation to already-activated offline machines (E013), air-gapped file activation (E010), and floating/heartbeat auto-reclaim (E015) build on this table but add nothing to `0008`.

## 11. RLS, policies & grants

Identical form to E002 `0002_rls_roles_grants.sql` and E008 `0007_licensing.sql`, applied to the one new table:

```sql
ALTER TABLE activation ENABLE ROW LEVEL SECURITY; ALTER TABLE activation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activation USING (…) WITH CHECK (…);  -- predicate below

GRANT SELECT, INSERT, UPDATE ON activation TO licensesrv_app;          -- no DELETE (soft flip only)
```

- Policy predicate: `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, on both `USING` (read) and `WITH CHECK` (write).
- `NULLIF(current_setting('app.current_tenant', true), '')` → NULL when the GUC is unset → predicate matches **zero rows**, so an unscoped or cross-tenant query is refused, never run unscoped; a cross-tenant activation reference resolves to not found (FR-015, SC-012).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too, so no owner-owned view/function can silently bypass isolation.
- **`UPDATE` is granted** for credential refresh (K-of-N re-activation) and deactivation (soft status flip + `deactivated_at`) and `updated_at` bumps. **No `DELETE`** — seat reclamation is a status flip, and GDPR bounded deletion is the platform retention path, not the app role's DML ([§9](#9-gdpr--pii-minimization-fr-006)).
- No changes to `audit_log` grants — it stays INSERT/SELECT-only (append-only); every activation/deactivation/denied attempt appends a row in-transaction (FR-014).

## 12. DDL sketch — `migrations/0008_activation.sql`

```sql
-- E009 machine activation & seat enforcement (FR-001..FR-024). Extends the E002 tenancy substrate and
-- the E008 license table (expand-only, sequential after 0007). One new tenant-owned table: activation.
-- Same tenant-scoped forced-RLS + composite-FK + audit pattern as 0000_init.sql / 0007_licensing.sql.
-- No changes to existing tables.
--
-- An activation binds ONE license to ONE machine. The machine is identified ONLY by salted hashes
-- (canonical machine_id + the N per-signal hashes) — NEVER raw hardware identifiers (FR-006/SC-011).
-- Seat usage = COUNT(*) of ACTIVE activations for a license; the cap is license.max_activations
-- (snapshotted at issuance, E008). The cap is enforced race-safely IN THE SERVICE LAYER by taking
-- SELECT ... FOR UPDATE on the license row before count+insert — the schema supports it; NO DB trigger
-- is used. K-of-N drift tolerance (default 3-of-5) is computed over signal_hashes in the service layer.

-- 1. activation — tenant-scoped binding of one license to a drift-tolerant machine fingerprint.
CREATE TABLE activation (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL REFERENCES tenant(id),
  license_id          uuid        NOT NULL,
  machine_id          text        NOT NULL,                      -- salted hash of the full sorted signal set = canonical machine identity (FR-006); NOT a raw id
  signal_hashes       text[]      NOT NULL,                      -- the N per-signal salted hashes -> token `fp`; K-of-N overlap match (FR-005). Hashes only, never raw ids (SC-011)
  fp_min              int         NOT NULL,                      -- the K threshold -> token `fpk` (default 3-of-5); bound into the credential (FR-005)
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','deactivated')),  -- seat lifecycle (FR-010/011)
  nonce               text        NOT NULL,                      -- single-use activation request nonce; anti-replay/idempotency (FR-009)
  machine_bound_token text,                                      -- re-signed LIC1 credential returned on activation (FR-007); public, verifies offline. Null between seat-claim and sign within the same tx
  label               text,                                      -- optional client pseudonymous hostname/nickname; minimal, erasable data (nulled on GDPR erase)
  activated_at        timestamptz NOT NULL DEFAULT now(),        -- first bind time; unchanged by refresh
  updated_at          timestamptz NOT NULL DEFAULT now(),        -- bumped on every edit (refresh, deactivate)
  deactivated_at      timestamptz,                               -- set when status flips to 'deactivated' (FR-010)
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: an activation can never bind to another tenant's license.
  -- ON DELETE NO ACTION (Postgres default): backstops hard-delete of a license that still has activations.
  CONSTRAINT activation_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id),
  -- nonce anti-replay/idempotency (store-and-replay): a reused nonce is DB-rejected so no replay can
  -- forge a second activation/seat; a same-request retry surfaces the violation and replays the result (FR-009, SC-010).
  CONSTRAINT activation_nonce_uniq UNIQUE (tenant_id, nonce),
  -- K (fp_min) must be in [1, N]: at least one signal, never demanding more matches than signals bound.
  CONSTRAINT activation_fp_min_valid CHECK (fp_min > 0 AND fp_min <= cardinality(signal_hashes))
);

-- At most ONE active activation per (license, machine): the seat-uniqueness invariant (Key Entities).
-- Partial (WHERE status='active') so idempotent re-activation of the SAME machine cannot double the seat,
-- while reactivation AFTER deactivation is still allowed (deactivated rows are not constrained).
CREATE UNIQUE INDEX activation_one_active
  ON activation (tenant_id, license_id, machine_id)
  WHERE status = 'active';

-- Seat count (COUNT(*) ... WHERE status='active') AND per-license registry reads (via the (tenant_id,
-- license_id) prefix). Tenant_id-leading, matching the RLS predicate; E002 convention.
CREATE INDEX activation_seat ON activation (tenant_id, license_id, status);

-- RLS: same form as E002 (0002) / E008 (0007). Unset GUC -> NULL -> zero rows (refuse unscoped access).
ALTER TABLE activation ENABLE ROW LEVEL SECURITY; ALTER TABLE activation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activation
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- No DELETE grant: deactivation is a soft status flip (seat reclamation is UPDATE, not DELETE).
-- GDPR erasure nulls the erasable `label`; the salted hashes are pseudonymous by construction, and
-- bounded deletion is handled by the platform retention/erase path (not the app role's DML).
GRANT SELECT, INSERT, UPDATE ON activation TO licensesrv_app;
```

## 13. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant    ||--o{ activation : "owns"
    license   ||--o{ activation : "seats (active count <= max_activations)"
    tenant    ||--o{ audit_log  : "logs activate/deactivate/denied"

    activation {
        uuid id PK
        uuid tenant_id PK-FK
        uuid license_id FK
        text machine_id "salted hash = pseudonymous identity"
        text_arr signal_hashes "N per-signal hashes -> fp"
        int fp_min "K threshold -> fpk"
        text status "active|deactivated"
        text nonce UK "anti-replay (tenant_id,nonce)"
        text machine_bound_token "re-signed LIC1, null=transient"
        text label "pseudonymous, erasable"
        timestamptz activated_at
        timestamptz updated_at
        timestamptz deactivated_at "null while active"
    }
    license {
        uuid id PK
        uuid tenant_id PK-FK
        text status "must be active to activate"
        int max_activations "seat cap (snapshot, read-only here)"
    }
```

</details>

## 14. Data Model Summary (drop into plan)

| Entity | Kind | Key Attributes | Relationships | State Transitions |
|--------|------|----------------|---------------|-------------------|
| `activation` | new tenant-owned table | id, tenant_id, license_id, machine_id (salted-hash identity), signal_hashes text[] (→`fp`), fp_min (→`fpk`, K∈[1,N]), status{active,deactivated}, nonce (uniq per tenant), machine_bound_token (re-signed LIC1, null), label (pseudonymous, erasable), activated_at, updated_at, deactivated_at | belongs_to tenant + license (composite FK); logged in audit_log | active↔deactivated (both idempotent); re-activate = refresh, no new seat; deactivate frees seat; reactivate-after-deactivate = new active row |
| `license` | reused (E008) | read-only: status (must be active), max_activations (seat cap) | has_many activation | owned by E008 |
| `audit_log` | reused (E002) | append-only activate/deactivate/denied entries with actor/action/target; `security_event` on denied RBAC | logs activation | append-only |

**Indexes**: PK `(tenant_id, id)`; UNIQUE `(tenant_id, nonce)` (nonce anti-replay); **partial UNIQUE** `(tenant_id, license_id, machine_id) WHERE status='active'` (one active seat per machine); INDEX `(tenant_id, license_id, status)` (seat count + registry + K-of-N candidate scan).

**Constraints**: FK `(tenant_id, license_id)→license` `ON DELETE NO ACTION`; CHECK `status IN ('active','deactivated')`; CHECK `fp_min > 0 AND fp_min <= cardinality(signal_hashes)`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY`; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT, INSERT, UPDATE ON activation TO licensesrv_app` (**no DELETE** — soft flip; GDPR via label-null + platform retention).

**App-layer invariants** (not a single-table CHECK): (1) **race-safe seat cap** — `active count ≤ license.max_activations` via `SELECT ... FOR UPDATE` on the license row across count+insert (SC-002); partial-unique index is the backstop. (2) **K-of-N match** — reuse a seat when `cardinality(intersection(signal_hashes)) ≥ fp_min` (default 3-of-5), else new machine (SC-007/008). (3) **License gate** — refuse unless license `active` + not expired; consume no seat (SC-004). (4) **Nonce store-and-replay** — retry replays the original result; reused-to-forge is rejected (SC-010). (5) **Minimum N signals** — config floor in the app; DB guarantees `fp_min ≤ N` (FR-016). (6) **GDPR** — hashes only (no raw ids, SC-011); `label` nulled on erase; bounded purge via platform retention.

**Migration**: `migrations/0008_activation.sql` — expand-only, sequential after 0007: `CREATE TABLE activation`, the two indexes, `ENABLE`/`FORCE` RLS + `tenant_isolation` policy + grants. No changes to existing tables.
