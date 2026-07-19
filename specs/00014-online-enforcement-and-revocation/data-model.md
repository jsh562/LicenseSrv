# Data Model: Online Enforcement and Revocation

> Feature `00014-online-enforcement-and-revocation` | Epic E013 | 2026-07-18
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0005`), the E008 `license` (`migrations/0007_licensing.sql`), and the E009 `activation` (`migrations/0008_activation.sql`). ADDITIVE / expand-only. Adds **two additive columns on `activation`** (the online last-seen anchor — no changes to any existing column) and **two new tenant-owned tables** — **`checkin`** (bounded, TTL-pruned validate/heartbeat anti-replay + idempotent-replay store) and **`revocation_list`** (published, signed, versioned CRL metadata) — each with tenant-scoped forced RLS and audit-on-mutation. No changes to any existing column; `license`, `activation`, and `audit_log` are referenced only at the integration boundaries.
> Source signals: spec FR-001…FR-021, US1…US6, Key Entities, Edge Cases, SC-001…SC-010; `research.md` (short-TTL renewal, bounded anti-replay, CRL projection, monotonic anchor); E008 data model `specs/00009-license-issuance-and-lifecycle/data-model.md` (`migrations/0007_licensing.sql`); E009 data model `specs/00010-machine-activation-and-seats/data-model.md` (`migrations/0008_activation.sql`, `activation.status`/`machine_bound_token`/`nonce`); E004 signer + `product_keyring` (`migrations/0004_signing_keys.sql`); E002 RLS `migrations/0002_rls_roles_grants.sql`; `migrations/0000_init.sql` (`audit_log`).
> New migration: `migrations/0009_online_enforcement.sql` (expand-only, sequential after 0008 — additive `activation` columns + two additive tables + indexes + RLS/policies/grants).

## Conventions (inherited from E002 / E008 / E009)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `license` / `activation` / `customer` / `plan` — so referential integrity stays tenant-local and every FK to a tenant-owned parent is a **composite FK including `tenant_id`**: a child can never bind to another tenant's parent.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **Timestamps**: `timestamptz` (UTC). `created_at`/`generated_at` default `now()`. The `activation.last_checkin_at` / `last_anchor_at` anchors are bumped by the repository on each successful check-in (`last_anchor_at` is monotonic non-decreasing — a repo invariant, never a DB trigger, [§6](#6-monotonic-anchor--clock-tamper-fr-014)).
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: every check-in outcome and CRL publication appends one row to the existing `audit_log` (INSERT/SELECT-only grant → append-only) in the same transaction (FR-019); denied/revoked renewals and security-relevant refusals set `security_event = true`. No new audit table.
- **Status/outcome enums** are free `text` with an inline `CHECK (... IN (...))` — same technique as `license.status`, `activation.status`, `product.status`.
- **Hashes / tokens / signatures are `text`** (E009 `machine_id`, `machine_bound_token`; E008 `license_token`). The check-in store holds **only signed timestamps + ids + a short-lived token**; it carries **no raw machine identifier** (inherits E009 PII-minimization, [§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)).

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **activation** (E009, EXTENDED — two additive columns only) | + last_checkin_at: timestamptz null (wall time of last successful validate/heartbeat, FR-003), + last_anchor_at: timestamptz null (highest signed server time stamped into a renewal; monotonic non-decreasing, repo-enforced, FR-014). **All existing E009 columns unchanged** ([§4](#4-integration-boundaries-reused-vs-new)). | belongs_to: tenant, license (E009); has_many: checkin | (lifecycle owned by E009 — active↔deactivated; E013 adds no state, only anchor timestamps) |
| **checkin** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, activation_id: uuid NOT NULL, nonce: text NOT NULL, outcome: text NOT NULL CHECK IN(renewed,refused), reason: text null (specific refusal reason; NOT NULL when refused), renewed_token: text null (short-lived token minted on renewed; for idempotent replay only), created_at: timestamptz NOT NULL DEFAULT now() (server check-in time = signed anchor for this beat). PK `(tenant_id, id)`; composite FK `(tenant_id, activation_id)→activation`; UNIQUE `(tenant_id, nonce)`; CHECK outcome/token/reason shape. **Bounded: TTL-pruned to the renewal window.** | belongs_to: tenant, activation; logged in: audit_log | renewed \| refused (terminal per row; one immutable row per accepted request) |
| **revocation_list** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, product_id: uuid NOT NULL, version: bigint NOT NULL (monotonic per tenant+product), generated_at: timestamptz NOT NULL DEFAULT now(), next_update: timestamptz NOT NULL CHECK(> generated_at), key_id: text NOT NULL (E004 key used), signature: text NOT NULL (detached Ed25519 over the canonical CRL doc), revoked_ids: jsonb NOT NULL (snapshot content projected from status). PK `(tenant_id, id)`; composite FK `(tenant_id, product_id)→product`; UNIQUE `(tenant_id, product_id, version)`. **Immutable once signed.** | belongs_to: tenant, product; logged in: audit_log; content projected from: license/activation | version advances each publication (append-only; superseded versions pruned by retention) |
| **license** (E008, reused — NOT re-modeled) | read-only here: `status` (must be `active` to renew; `revoked`/`suspended`→refuse + CRL content), `expires_at`, `entitlements` (re-read per beat). | has_many: activation | (owned by E008 — [§4](#4-integration-boundaries-reused-vs-new)) |

> Downstream agents consume the three rows above (extended `activation` + `checkin` + `revocation_list`). `license`, `plan`, `audit_log`, `tenant`, and the E004 signer/`product_keyring` are reused and are **not** re-modeled here — referenced only at the integration boundaries ([§4](#4-integration-boundaries-reused-vs-new)). The **revoked-id set is NOT materialized** — it is projected on demand from `license.status='revoked'` (+ deactivated activations) ([§5](#5-revocation-list-projected-not-materialized-fr-009010)). **Per-plan renewal-window / offline-tolerance are app config, not columns** ([§7](#7-per-plan--config-boundary-fr-015016)).

## 2. `activation` — additive columns (E009 table; existing columns untouched)

E013 adds exactly **two** columns to the E009 `activation` row (`ALTER TABLE`, additive, both nullable). No existing column changes; the E009 lifecycle, seat semantics, `machine_bound_token`, and `nonce` are unchanged.

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| last_checkin_at | timestamptz | — | yes | Wall time of the **last successful** validate/heartbeat for this activation (FR-003). Advanced by the repo on each `renewed` (and re-anchored) check-in; **not** advanced on a `refused` beat or an idempotent replay. `NULL` = **never checked in online** (a never-connected/air-gapped activation, US5/FR-012 — NOT revoked-by-default). Feeds the registry "last seen" and the offline-tolerance computation ([§6](#6-monotonic-anchor--clock-tamper-fr-014)). |
| last_anchor_at | timestamptz | — | yes | The **monotonic last-seen anchor**: the highest signed server time stamped into a renewed token for this activation (FR-014). Repo-enforced **non-decreasing** via a guarded `UPDATE` (`... WHERE last_anchor_at IS NULL OR last_anchor_at <= $t`) — never a DB trigger ([§6](#6-monotonic-anchor--clock-tamper-fr-014)). `NULL` = never anchored. The server-side floor behind the client's local monotonic anchor; a request asserting a time/token preceding it is rejected. |

- **Both are server-side signed-time only — no raw machine identifiers**, inheriting E009's PII-minimization ([§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)).
- On the server the two coincide at write time (both are the server clock at a successful beat), but they carry **distinct invariants**: `last_checkin_at` is descriptive "last contact" (may be cleared/pruned under retention); `last_anchor_at` is the enforcement floor with the monotonicity guarantee. Kept separate so the anti-rollback floor is explicit and independently reasoned about (and future-proof against a design where signed-anchor time is drawn from a monotonic source distinct from wall clock).
- **The short-lived renewal token is NOT stored on `activation`** and does **NOT** overwrite `machine_bound_token`. Decision + rationale in [§4](#4-integration-boundaries-reused-vs-new) (offline-first preservation, US5).

## 3. `checkin` — column detail (bounded anti-replay + idempotent-replay store)

Tenant-scoped, **bounded** record of accepted validate/heartbeat requests. One immutable row per accepted request; retained only for the renewal-window TTL, then pruned ([§8](#8-constraints--indexes), [§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)).

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7; logical check-in id. Tenant-local; a cross-tenant reference resolves to zero rows under RLS. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-018). Matches the RLS predicate. |
| activation_id | uuid | NOT NULL, composite FK `(tenant_id, activation_id) → activation(tenant_id, id)` | no | The activation being validated/renewed. Intra-tenant composite FK — cannot reference another tenant's activation. `ON DELETE NO ACTION` — check-in TTL (short) is always shorter than the E009 activation purge (90d), so no block/orphan arises ([§8](#8-constraints--indexes)). |
| nonce | text | NOT NULL, UNIQUE `(tenant_id, nonce)` | no | The **single-use per-request nonce** (FR-008). Anti-replay/idempotency: a reused nonce is DB-rejected; a same-request retry surfaces the violation and the service **replays the stored `outcome`/`renewed_token`** ([§4a](#4a-anti-replay--idempotency-fr-008), SC-010). Distinct from E009 `activation.nonce` — see [§4a](#4a-anti-replay--idempotency-fr-008). |
| outcome | text | NOT NULL, `CHECK (outcome IN ('renewed','refused'))` | no | Whether a fresh short-lived token was issued (`renewed`) or the beat was refused (`refused`: revoked/suspended/expired/deactivated/entitlement change refusal). Both are recorded so a replay reproduces the exact original result (FR-008). |
| reason | text | `CHECK` shape below | yes | The **specific refusal reason** when `outcome='refused'` (e.g. `revoked`, `suspended`, `expired`, `activation_deactivated`) — the clear reason FR-004 requires. `NULL` when `renewed`. Also written to `audit_log` (FR-019). |
| renewed_token | text | `CHECK` shape below | yes | The **short-lived, offline-verifiable token** minted on `renewed` (FR-002), stored **only** so an idempotent replay returns the *original* token (never a re-minted one with a fresh `exp`). `NULL` on refusal. Pruned with the row. Public artifact (signed projection; never a private key). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Server check-in time = the **signed server-time anchor** stamped into this beat's response. Drives the monotonic anchor advance ([§6](#6-monotonic-anchor--clock-tamper-fr-014)) and the TTL-retention purge ([§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)). |

Shape constraint (`checkin_outcome_shape`): `(outcome='renewed' AND renewed_token IS NOT NULL AND reason IS NULL) OR (outcome='refused' AND renewed_token IS NULL AND reason IS NOT NULL)` — every renewal carries a token and no reason; every refusal carries a reason and no token.

### 4a. Anti-replay & idempotency (FR-008)

The `UNIQUE (tenant_id, nonce)` constraint is the store-and-replay mechanism (mirrors E009 §6), but the store is **BOUNDED**:

| Scenario | Mechanism | Result |
|----------|-----------|--------|
| Same-request retry (same nonce) | The retried `INSERT` hits `checkin_nonce_uniq` | Service catches the violation, `SELECT`s the existing row, and **replays the stored `outcome` + `renewed_token`** — no second token minted (FR-008, SC-010). |
| Replay to forge a second renewal (reused nonce) | `checkin_nonce_uniq` rejects the write | **Rejected** — no replay ever mints an extra token or advances the anchor. |
| Fresh beat (new nonce) | New row `INSERT`s; the service evaluates status/expiry/seat/entitlements and stamps `outcome`/`renewed_token` | Renewal issued (or refused with a reason); anchor advanced on `renewed` ([§6](#6-monotonic-anchor--clock-tamper-fr-014)). |

**Why a bounded, TTL-pruned table — and why not the E009 `activation.nonce` pattern:**

- E009 `activation.nonce` is **one permanent nonce per activation**, stored on the activation row and retained for the row's life — viable because activations are **infrequent** (one per machine bind).
- Check-ins are **frequent** (every heartbeat), so a per-request nonce cannot live on `activation` and a permanently-retained per-request table would **grow unbounded** (spec risk: CRL/growth analogue).
- **Boundedness rule**: a check-in nonce need only be remembered while a token minted for it could still be valid — i.e. **≤ the longest short-token life (the renewal window)**. Beyond that a replay of the nonce could at most reproduce an **already-expired** token (fail-closed on expiry, FR-011), so forgetting it is safe. The retention purge deletes rows older than `max(renewal-window TTL) + skew` ([§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)); live rows per activation ≈ `TTL / heartbeat-cadence` (a handful).
- **Rejected alternatives**: a *monotonic per-activation counter* (O(1) storage) cannot satisfy FR-008's *second* half — "an idempotent retry MUST return the **original result**" — because a counter remembers only "seen", not the minted token/verdict; it also forces clients to persist a durable sequence across restarts. A *windowed bloom filter* gives probabilistic reject but again cannot replay the original result. The TTL-pruned table satisfies **both** halves of FR-008 while staying bounded.

## 5. Revocation list — projected, not materialized (FR-009/010)

| Concern | Decision | Rationale |
|---------|----------|-----------|
| The revoked-**id set** (CRL content) | **Projected on demand**, never materialized. At generation the worker runs `SELECT id FROM license WHERE status='revoked'` (+ deactivated/revoked `activation` ids where policy publishes them) and snapshots it into `revocation_list.revoked_ids`. | `license.status` (E008) is the single authoritative source; a separate `revoked_license` table would **duplicate** it and risk drift. No new materialized revocation table. |
| The published **signed artifact** | **Stored** — one immutable `revocation_list` row per published version. | The CRL is **signed over exact bytes** (non-deterministic to re-sign per request), must **version monotonically** (US4-AC1), and must be **re-servable byte-stable** for CDN caching and **air-gap file export** (FR-010). On-demand-only generation cannot give a stable version/signature. |
| Scope | **Per `(tenant, product)`** — one monotonic version sequence per product. | Signing keys are **per-product** (E004 `signing_key.product_id`); the CRL is signed by the product's active key (`key_id`) and verified by clients against that **`product_keyring`** — mirroring per-product license tokens (E008). |
| `revoked_ids` shape | `jsonb`: `{"licenses":[...], "activations":[...]}` (a full snapshot for MVP). | Flexible content; the canonical encoding of `{version, generated_at, next_update, revoked_ids}` is what `signature` covers and what the CDN/file serves. **Delta CRLs** (store `base_version` + delta to cap client download — spec CRL-growth risk) are a clean **additive follow-up**, out of scope for `0009`. |
| `version` monotonicity | `bigint`, `UNIQUE (tenant_id, product_id, version)`; the worker assigns `max(version)+1` per product inside the generation transaction. | App-layer invariant (a single-table CHECK cannot compare to prior rows); gaps are tolerated, monotone increase is guaranteed (US4-AC1). |
| Retention | Immutable rows; **superseded** versions pruned by the platform retention path (past `next_update` and no longer the latest). | Keeps growth bounded; the latest served version is `max(version)` per product. |

- **Distribution is out of the schema.** The stored signed artifact is published to the CDN and offered as a downloadable file by the API/worker (FR-010); the table stays tenant-scoped forced-RLS ([§8](#8-constraints--indexes)) — the app reads the tenant's CRL under RLS, then publishes. CRL fetch fails **open** (fall back to token-TTL enforcement); token expiry fails **closed** (FR-011) — both are client/API behaviours, not schema.
- **CRL publications are audited** (append-only, FR-019): each new version records an `audit_log` row (actor = CRL worker, action, target = version).

## 6. Monotonic anchor & clock-tamper (FR-014)

- On each **successful** beat the repo advances `activation.last_checkin_at = now()` and `activation.last_anchor_at = greatest(last_anchor_at, signed-server-time)`; the signed server time is also embedded in the minted token (FR-014) and equals the beat's `checkin.created_at`.
- **Monotonic non-decrease is a repo invariant, not a DB trigger**: the advance is a guarded `UPDATE ... SET last_anchor_at = $t WHERE (tenant_id,id)=$act AND (last_anchor_at IS NULL OR last_anchor_at <= $t)` — matching the codebase's "DB provides the floor / the app enforces the transition" pattern (E008 §7, E009 §4). A request asserting a client time/token **preceding** `last_anchor_at` is **rejected** at the service layer.
- **Offline-tolerance window** (FR-015) bounds how long a client may run without a fresh anchor before it must re-anchor (renew). It is compared at renewal time against `now() - last_anchor_at`; the window value is **config**, resolved per plan ([§7](#7-per-plan--config-boundary-fr-015016)). Pure-offline perpetual rollback on a **never-connecting** client is only **bounded** by this window (not eliminated) — the disclosed, accepted limitation (spec Risks, US6-AC3).
- **Never-connected safety (US5/FR-012)**: `last_checkin_at`/`last_anchor_at` are `NULL` for an activation that never checked in; NULL means "no online state — the E009 offline credential governs to its own `exp`", **not** revoked-by-default.

## 7. Per-plan / config boundary (FR-015/016)

**Decision — per-plan renewal-window / offline-tolerance / cadence / grace / CRL `next_update` TTL are APP CONFIG (NEW-CONFIG), not new DB columns and not a new table.** No `ALTER` on `plan`.

| Config knob (FR-016) | Home | Boundary |
|----------------------|------|----------|
| Short-token TTL / renewal window (per-plan) | App config, keyed by `plan.key`/`plan.id` (global default + per-plan override) | Read **live** at each validate/heartbeat via the license's `plan_id` (E008, read-only). |
| Per-plan offline-tolerance window (FR-015) | App config, keyed by plan | Read **live**; compared against `now() - activation.last_anchor_at` ([§6](#6-monotonic-anchor--clock-tamper-fr-014)). |
| Heartbeat cadence + grace window (FR-007) | App config (deployment-wide default) | Enforced in the validate/heartbeat service + client. |
| CRL `next_update` TTL | App config (deployment-wide default) | Written into `revocation_list.next_update` at generation. |

- **Why config, not columns**: the spec's Implementation Signals classify these as `NEW-CONFIG` and the `MIGRATION` signal deliberately lists only the activation anchor column + the CRL record — **no plan columns**. These are **enforcement policy read live** (an operator retunes without a migration and without reissuing tokens — they are *not* snapshotted into the license/token like entitlements are), so a static/overrideable config keyed by plan is the right home. This also keeps `plan` (E008) unchanged, honouring "no changes to existing columns".
- **The DB boundary** is `plan.id`/`plan.key` (E008, read-only) as the **lookup key** the service uses to resolve per-plan windows from config; the license's `plan_id` FK (E008) selects the plan.
- **Deferred additive option (documented, out of scope for `0009`)**: if per-tenant-per-plan DB-persisted overrides become necessary, adding nullable `renewal_window_secs` / `offline_tolerance_secs` columns to `plan` (NULL = inherit the app default) is a clean expand-only follow-up. Not needed for the MVP.

## 8. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK (both new tables) | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access and RLS. |
| `checkin` → activation FK | composite `(tenant_id, activation_id) → activation(tenant_id, id)`, `ON DELETE NO ACTION` | Intra-tenant integrity; check-in TTL (short) < E009 activation purge (90d), so a referenced activation is never purged while check-ins remain → no block/orphan ([§3](#3-checkin--column-detail-bounded-anti-replay--idempotent-replay-store)). |
| `checkin_nonce_uniq` | `UNIQUE (tenant_id, nonce)` | Anti-replay/idempotency store-and-replay ([§4a](#4a-anti-replay--idempotency-fr-008)); its index also serves the replay lookup (FR-008, SC-010). |
| `checkin_outcome_shape` | `CHECK ((outcome='renewed' AND renewed_token IS NOT NULL AND reason IS NULL) OR (outcome='refused' AND renewed_token IS NULL AND reason IS NOT NULL))` | Renewal ⇒ token, no reason; refusal ⇒ reason, no token (FR-004/008). |
| `checkin_activation` | `CREATE INDEX ... ON checkin (tenant_id, activation_id, created_at DESC)` | Recent check-ins per activation (anchor advance, registry "last seen"). Tenant_id-leading. |
| `checkin_prune` | `CREATE INDEX ... ON checkin USING brin (created_at)` | Bounded-retention purge on an append-only, time-ordered table — BRIN is cheap to maintain and ideal for age-range deletes ([§9](#9-pii--gdpr-retention-bounded-deletable-check-in-data)). |
| `revocation_list` → product FK | composite `(tenant_id, product_id) → product(tenant_id, id)`, `ON DELETE NO ACTION` | Intra-tenant integrity; a product with published CRLs is not hard-deleted (catalog is archive-not-delete, E007). |
| `revocation_list_version_uniq` | `UNIQUE (tenant_id, product_id, version)` | One row per published version per product; also the **latest-version** lookup (`max(version)`) (FR-009, US4-AC1). |
| `revocation_list_window` | `CHECK (next_update > generated_at)` | A CRL's validity horizon is after its generation (FR-009/010). |
| status/outcome enums | `CHECK (outcome IN ('renewed','refused'))` on `checkin` | Outcome domain (FR-004/008). |

All indexes are `tenant_id`-leading (except the intentional BRIN age index used by the owner-role retention purge), matching the RLS predicate and the repository's tenant-first access pattern (E002 convention).

**App-layer invariants** (not expressible as a single-table CHECK): (1) **Monotonic anchor** — `last_anchor_at` never decreases; the guarded `UPDATE` is the enforcement ([§6](#6-monotonic-anchor--clock-tamper-fr-014)). (2) **Renewal gate** — a beat renews only if `license.status='active'` AND not expired AND `activation.status='active'` AND entitlements re-read; else `refused` with a reason (FR-004/005, [§4a](#4a-anti-replay--idempotency-fr-008)). (3) **Idempotent replay** — a reused nonce replays the stored result; a fresh nonce evaluates and stamps the outcome (FR-008). (4) **CRL version monotonicity** — `max(version)+1` per product in the generation tx (FR-009). (5) **Per-plan windows** — renewal/offline-tolerance resolved from config keyed by plan, read live ([§7](#7-per-plan--config-boundary-fr-015016)).

## 9. PII / GDPR (retention-bounded, deletable check-in data)

The check-in path holds **only signed timestamps + ids + a short-lived token** — inheriting E009's PII-minimization posture (Key Entities; FR-006 analogue):

| Concern | Design | Enforcement |
|---------|--------|-------------|
| No raw machine identifiers | `checkin` references the activation by id; it stores **no** `machine_id`, signal, hostname, or `label`. The anchor columns on `activation` are **signed server timestamps only**. | Contract — the validate/heartbeat API carries the activation id + nonce; no raw identifier is persisted or logged (`audit_log` unchanged). |
| Retention-bounded, deletable | `checkin` rows are **TTL-pruned** to `max(renewal-window TTL) + skew` (a nonce beyond that could only replay an already-expired token). A stale activation's anchor timestamps age out with the E009 activation retention (90d after deactivation). | Bounded deletion is the **platform retention path** (owner role, using the `checkin_prune` BRIN index) — **no `DELETE` grant** to the app role ([§10](#10-rls-policies--grants)), matching E009 §9. |
| CRL artifacts non-personal | `revocation_list` holds license/activation **ids** (pseudonymous), a version, timestamps, a `key_id`, and a signature — no PII. | Immutable signed snapshots; superseded versions pruned by the platform path. |

> Because no row carries a raw identifier or secret, ordinary pseudonymized retention + TTL pruning satisfies the erasure/retention obligation without a hard-delete grant on the runtime role.

## 4. Integration boundaries (reused vs new)

**Reused (referenced, NOT re-modeled):**

- **E008 `license` — read, never modified.** Every validate/heartbeat re-reads `license.status` (must be `active`; `revoked`/`suspended`→`refused` and CRL content), `expires_at` (expiry re-check, FR-004), and `entitlements` (the renewed token reflects current effective entitlements, FR-017). E013 adds **no** column to `license`. The revoked-id CRL set projects from `license.status='revoked'` ([§5](#5-revocation-list-projected-not-materialized-fr-009010)).
- **E009 `activation` — extended additively, lifecycle unchanged.** E013 adds only `last_checkin_at` + `last_anchor_at` ([§2](#2-activation--additive-columns-e009-table-existing-columns-untouched)); it re-reads `activation.status` per beat (must be `active`, FR-004) and the seat validity E009 owns. The E009 offline credential (`machine_bound_token`) is **left untouched by the online path** — the renewal path mints a **separate short-lived token** returned to the client and **NOT** persisted (it is re-minted each beat; storing a high-churn ephemeral token adds no value and would couple to E009's durable offline credential). This directly preserves US5/FR-012: a never-connected client keeps its original long-lived `machine_bound_token` to its own `exp`; only the frequent, ephemeral renewal token is short. (For idempotent replay only, the *most recent* minted token is held on the `checkin` row for its TTL window, [§3](#3-checkin--column-detail-bounded-anti-replay--idempotent-replay-store).)
- **E004 signer + `product_keyring` — reused for both the renewal token and the CRL signature.** The short-lived renewal token and the signed CRL are minted/signed by the **existing** E004 per-product signer (`key_id` stamped, verified against `product_keyring`) — **no new key custody** (FR-002/009, Assumptions). The private key is never stored, logged, or returned.
- **E002 `audit_log` — reused, append-only.** Every check-in outcome and CRL publication appends one row in-transaction (FR-019); denied/revoked renewals + security-relevant refusals set `security_event=true`. No new audit table, no grant change.
- **E002 tenancy + RLS** — the same non-owner `licensesrv_app` role, forced RLS, and `app.current_tenant` GUC gate every new table (FR-018).

**New (this migration):**

- Two additive `activation` columns (the online last-seen anchor).
- `checkin` — bounded, TTL-pruned validate/heartbeat anti-replay + idempotent-replay store.
- `revocation_list` — published, signed, versioned per-product CRL metadata.

**Out of scope (downstream):** floating/concurrent seat leases + reclamation (E015), billing-driven revocation automation (E014), OCSP-style per-request lookups (rejected — research), delta/filter-cascade CRL encoding (additive follow-up, [§5](#5-revocation-list-projected-not-materialized-fr-009010)), per-plan DB-persisted window overrides ([§7](#7-per-plan--config-boundary-fr-015016)). Rate-limiting the validate/heartbeat/CRL surface (FR-021) is API-layer, not schema.

## 10. RLS, policies & grants

Identical form to E002 `0002_rls_roles_grants.sql`, E008 `0007_licensing.sql`, and E009 `0008_activation.sql`, applied to each new table:

```sql
ALTER TABLE checkin         ENABLE ROW LEVEL SECURITY; ALTER TABLE checkin         FORCE ROW LEVEL SECURITY;
ALTER TABLE revocation_list ENABLE ROW LEVEL SECURITY; ALTER TABLE revocation_list FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON checkin         USING (…) WITH CHECK (…);  -- predicate below
CREATE POLICY tenant_isolation ON revocation_list USING (…) WITH CHECK (…);

GRANT SELECT, INSERT ON checkin, revocation_list TO licensesrv_app;          -- append-only from the app; retention purge is the platform path
```

- Policy predicate (both tables): `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, on both `USING` (read) and `WITH CHECK` (write).
- `NULLIF(current_setting('app.current_tenant', true), '')` → NULL when the GUC is unset → predicate matches **zero rows**, so an unscoped or cross-tenant query is refused, never run unscoped (FR-018, SC — cross-tenant renewal resolves to not-found).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too — no owner-owned view/function can silently bypass isolation.
- **`GRANT SELECT, INSERT` only** on both new tables — **no `UPDATE`** (a check-in record and a signed CRL version are **immutable** once written; a replay *reads*, never mutates) and **no `DELETE`** (bounded TTL pruning of check-ins and superseded CRL versions is the **platform owner path**, keeping the app role least-privileged — matching E009's retention model). The two additive `activation` columns are covered by E009's existing table-level `UPDATE` grant (no new grant needed).
- No changes to `audit_log` grants — it stays INSERT/SELECT-only (append-only); every check-in outcome + CRL publication appends a row in-transaction (FR-019).

## 11. DDL sketch — `migrations/0009_online_enforcement.sql`

```sql
-- E013 online enforcement & revocation (FR-001..FR-021). Extends the E002 tenancy substrate, the E008
-- license/plan, and the E009 activation table (expand-only, sequential after 0008). NO changes to any
-- EXISTING column. Adds two additive columns on `activation` (the online last-seen anchor), and two new
-- tenant-owned tables: `checkin` (bounded, TTL-pruned validate/heartbeat anti-replay + idempotent
-- replay) and `revocation_list` (published, signed, versioned per-product CRL metadata). Same
-- tenant-scoped forced-RLS + composite-FK + audit pattern as 0000/0007/0008.
--
-- The revoked-id SET is NOT materialized: it is projected on demand from license.status='revoked'
-- (+ deactivated activations) at generation time. Only the SIGNED, VERSIONED CRL artifact is stored,
-- because a signature is over exact bytes and the version must advance monotonically and be
-- re-servable/air-gap exportable. Per-plan renewal-window / offline-tolerance are APP CONFIG
-- (NEW-CONFIG), read live at renewal time — NOT columns and NOT a new table (see the plan boundary).

-- 1. activation — additive online last-seen anchor (E009 table; existing columns unchanged).
--    NULL on a never-connected activation: the E009 offline credential governs; NOT revoked-by-default
--    (US5/FR-012). last_anchor_at is monotonic non-decreasing — a REPO invariant (guarded UPDATE),
--    NOT a DB trigger (FR-014).
ALTER TABLE activation
  ADD COLUMN last_checkin_at timestamptz,   -- wall time of the last SUCCESSFUL validate/heartbeat (FR-003); NULL = never online
  ADD COLUMN last_anchor_at  timestamptz;   -- highest signed server time stamped into a renewal (FR-014); monotonic non-decreasing (repo-enforced)

-- 2. checkin — BOUNDED, TTL-pruned per-request store for validate/heartbeat anti-replay (FR-008) and
--    idempotent replay-returns-original. One immutable row per accepted request. A nonce need only be
--    remembered while a token minted for it could still be valid (<= the renewal window); beyond that a
--    replay could only reproduce an already-expired token, so it is pruned. Distinct from the E009
--    activation.nonce (one PERMANENT nonce per activation) precisely because check-ins are FREQUENT.
CREATE TABLE checkin (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL REFERENCES tenant(id),
  activation_id uuid        NOT NULL,                       -- the activation being validated/renewed
  nonce         text        NOT NULL,                       -- single-use per-request nonce; anti-replay/idempotency (FR-008)
  outcome       text        NOT NULL
                  CHECK (outcome IN ('renewed','refused')), -- renewal issued vs refused (revoked/suspended/expired/deactivated/...)
  reason        text,                                       -- specific refusal reason when refused; NULL when renewed (also audited, FR-019)
  renewed_token text,                                       -- short-lived token minted on 'renewed', stored ONLY for idempotent replay; NULL on refusal; pruned with the row
  created_at    timestamptz NOT NULL DEFAULT now(),         -- server check-in time = the signed anchor for this beat; drives the TTL purge
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a check-in can never reference another tenant's activation.
  -- ON DELETE NO ACTION: check-in TTL (short) is always shorter than the E009 activation purge (90d),
  -- so a referenced activation is never purged while check-ins remain -> no block/orphan.
  CONSTRAINT checkin_activation_fk
    FOREIGN KEY (tenant_id, activation_id) REFERENCES activation (tenant_id, id),
  -- anti-replay/idempotency store-and-replay: a reused nonce is DB-rejected; a same-request retry
  -- surfaces the violation and the service replays the stored outcome/token (FR-008, SC-010).
  CONSTRAINT checkin_nonce_uniq UNIQUE (tenant_id, nonce),
  -- shape: a renewal carries a token and no reason; a refusal carries a reason and no token.
  CONSTRAINT checkin_outcome_shape CHECK (
    (outcome = 'renewed' AND renewed_token IS NOT NULL AND reason IS NULL)
    OR (outcome = 'refused' AND renewed_token IS NULL AND reason IS NOT NULL)
  )
);

-- Recent check-ins per activation (anchor advance, registry "last seen"); tenant_id-leading.
CREATE INDEX checkin_activation ON checkin (tenant_id, activation_id, created_at DESC);
-- Bounded-retention purge on an append-only, time-ordered table -> BRIN is cheap & ideal for age deletes.
CREATE INDEX checkin_prune ON checkin USING brin (created_at);

-- 3. revocation_list — published, signed, versioned CRL metadata, per (tenant, product). Immutable
--    once signed. revoked_ids is a point-in-time SNAPSHOT projected from license/activation status at
--    generation (not a live join); signature covers the canonical encoding of the artifact.
CREATE TABLE revocation_list (
  id           uuid        NOT NULL,
  tenant_id    uuid        NOT NULL REFERENCES tenant(id),
  product_id   uuid        NOT NULL,                        -- CRL is per product (signed by that product's E004 key; verified vs product_keyring)
  version      bigint      NOT NULL,                        -- monotonic per (tenant, product); advances each publication (FR-009, US4-AC1)
  generated_at timestamptz NOT NULL DEFAULT now(),
  next_update  timestamptz NOT NULL,                        -- CRL validity horizon; CDN cache-control aligns to it (FR-010)
  key_id       text        NOT NULL,                        -- E004 signing key id used to sign this CRL
  signature    text        NOT NULL,                        -- detached Ed25519 signature over the canonical CRL document (never a private key)
  revoked_ids  jsonb       NOT NULL,                        -- snapshot content {"licenses":[...],"activations":[...]} projected from status at generation
  PRIMARY KEY (tenant_id, id),
  -- intra-tenant composite FK: a CRL can never bind to another tenant's product.
  CONSTRAINT revocation_list_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id),
  -- one published version per product; also the "latest version" (max version) lookup.
  CONSTRAINT revocation_list_version_uniq UNIQUE (tenant_id, product_id, version),
  -- a CRL's validity horizon is after its generation.
  CONSTRAINT revocation_list_window CHECK (next_update > generated_at)
);

-- RLS: same form as E002 (0002) / E008 (0007) / E009 (0008). Unset GUC -> NULL -> zero rows.
ALTER TABLE checkin         ENABLE ROW LEVEL SECURITY; ALTER TABLE checkin         FORCE ROW LEVEL SECURITY;
ALTER TABLE revocation_list ENABLE ROW LEVEL SECURITY; ALTER TABLE revocation_list FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON checkin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON revocation_list
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only from the app: SELECT + INSERT only. No UPDATE (check-ins and signed CRL versions are
-- immutable), no DELETE (the bounded TTL purge of checkins and superseded CRL versions is the platform
-- owner path -> least-privileged app role, matching E009 retention). The two additive activation
-- columns are covered by E009's existing table-level UPDATE grant.
GRANT SELECT, INSERT ON checkin, revocation_list TO licensesrv_app;
```

## 12. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant     ||--o{ activation      : "owns"
    tenant     ||--o{ checkin         : "owns"
    tenant     ||--o{ revocation_list : "owns"
    tenant     ||--o{ audit_log       : "logs check-ins / CRL publications"
    license    ||--o{ activation      : "seats (E009, read per beat)"
    activation ||--o{ checkin         : "validated / renewed by"
    product    ||--o{ revocation_list : "per-product signed CRL"

    activation {
        uuid id PK
        uuid tenant_id PK-FK
        uuid license_id FK
        text status "active|deactivated (E009)"
        text machine_bound_token "long-lived offline credential (E009, untouched)"
        timestamptz last_checkin_at "NEW: last successful beat (FR-003); null=never online"
        timestamptz last_anchor_at "NEW: monotonic signed-time anchor (FR-014)"
    }
    checkin {
        uuid id PK
        uuid tenant_id PK-FK
        uuid activation_id FK
        text nonce UK "anti-replay (tenant_id,nonce)"
        text outcome "renewed|refused"
        text reason "refusal reason; null when renewed"
        text renewed_token "short-lived token; idempotent-replay only; null on refusal"
        timestamptz created_at "signed anchor for the beat; drives TTL purge"
    }
    revocation_list {
        uuid id PK
        uuid tenant_id PK-FK
        uuid product_id FK
        bigint version "monotonic per (tenant,product)"
        timestamptz generated_at
        timestamptz next_update "CRL validity horizon"
        text key_id "E004 signing key"
        text signature "detached Ed25519 over canonical doc"
        jsonb revoked_ids "snapshot projected from license/activation status"
    }
    license {
        uuid id PK
        uuid tenant_id PK-FK
        text status "active|suspended|revoked (gate + CRL content)"
        timestamptz expires_at "re-checked per beat"
        jsonb entitlements "re-read into renewed token"
    }
    product {
        uuid id PK
        uuid tenant_id PK-FK
    }
```

</details>

## 13. Data Model Summary (drop into plan)

| Entity | Kind | Key Attributes | Relationships | State Transitions |
|--------|------|----------------|---------------|-------------------|
| `activation` | **extended** (E009) — two additive columns | + last_checkin_at (last successful beat, FR-003; null=never online), + last_anchor_at (monotonic signed-time anchor, FR-014). Existing E009 columns unchanged. | belongs_to tenant+license; has_many checkin | lifecycle owned by E009 (active↔deactivated); E013 only advances anchors |
| `checkin` | new tenant-owned table (BOUNDED, TTL-pruned) | id, tenant_id, activation_id, nonce (uniq per tenant), outcome{renewed,refused}, reason (refusal), renewed_token (idempotent-replay only), created_at | belongs_to tenant+activation (composite FK); logged in audit_log | one immutable row per accepted beat (renewed \| refused) |
| `revocation_list` | new tenant-owned table (immutable signed snapshots) | id, tenant_id, product_id, version (monotonic per tenant+product), generated_at, next_update, key_id, signature, revoked_ids (jsonb snapshot) | belongs_to tenant+product (composite FK); content projected from license/activation; logged in audit_log | version advances per publication; superseded versions pruned |
| `license` | reused (E008) | read-only: status (gate + CRL content), expires_at, entitlements (re-read per beat) | has_many activation | owned by E008 |
| `audit_log` | reused (E002) | append-only check-in outcomes + CRL publications; `security_event` on denied/revoked | logs both new tables | append-only |

**Indexes**: PK `(tenant_id, id)` ×2; `checkin` UNIQUE `(tenant_id, nonce)` (anti-replay), INDEX `(tenant_id, activation_id, created_at DESC)`, **BRIN** `(created_at)` (retention purge); `revocation_list` UNIQUE `(tenant_id, product_id, version)` (latest-version lookup).

**Constraints**: `checkin` FK `(tenant_id, activation_id)→activation` `ON DELETE NO ACTION`, CHECK `outcome IN ('renewed','refused')`, shape CHECK (renewed⇒token/no-reason, refused⇒reason/no-token); `revocation_list` FK `(tenant_id, product_id)→product` `ON DELETE NO ACTION`, CHECK `next_update > generated_at`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY` on both new tables; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT, INSERT ON checkin, revocation_list TO licensesrv_app` (**no UPDATE/DELETE** — immutable rows; TTL/superseded purge is the platform path). Additive `activation` columns use E009's existing UPDATE grant.

**Resolved decision points**: (1) **Anti-replay** → bounded, TTL-pruned `checkin` table (not the E009 permanent per-activation nonce, not a counter — the counter can't replay the *original result* FR-008 needs). (2) **CRL** → revoked-id set **projected** from `license.status='revoked'` (no materialized `revoked_license` table); only the **signed, versioned per-product artifact** is stored in `revocation_list`. (3) **Renewal token** → a **separate short-lived token**, returned to the client and **not persisted** (the E009 `machine_bound_token` offline credential is left untouched — US5); the most recent minted token is held on the `checkin` row for TTL-window idempotent replay only. (4) **Per-plan windows** → **app config** (NEW-CONFIG) keyed by plan, read live; **no `plan` column, no new config table** (deferred additive `plan` columns documented). (5) **Anchor** → `timestamptz last_anchor_at`, repo-enforced monotonic non-decreasing (not a DB trigger/counter).

**App-layer invariants** (not a single-table CHECK): (1) **Monotonic anchor** — guarded `UPDATE` keeps `last_anchor_at` non-decreasing (FR-014). (2) **Renewal gate** — renew only if license `active`+unexpired AND activation `active` AND entitlements re-read, else `refused` with a reason (FR-004/005/017). (3) **Idempotent replay** — reused nonce replays the stored result (FR-008, SC-010). (4) **CRL version** — `max(version)+1` per product in the generation tx (FR-009). (5) **Per-plan windows** — resolved from config keyed by plan, read live (FR-015/016).

**Migration**: `migrations/0009_online_enforcement.sql` — expand-only, sequential after 0008: `ALTER TABLE activation` (two additive anchor columns), `CREATE TABLE checkin` + its two indexes, `CREATE TABLE revocation_list`, `ENABLE`/`FORCE` RLS + `tenant_isolation` policies + grants on both new tables. No changes to any existing column.
</content>
</invoke>
