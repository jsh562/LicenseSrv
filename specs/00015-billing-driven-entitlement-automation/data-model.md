# Data Model: Billing-driven Entitlement Automation

> Feature `00015-billing-driven-entitlement-automation` | Epic E014 | 2026-07-19
> Stack: PostgreSQL 16, node-postgres (`pg`) + raw SQL migrations (E002 AD-006 dropped Drizzle), Node 22 / TypeScript. Source under `/src/server`.
> Scope: EXTENDS the E002 tenancy substrate (`migrations/0000..0005`), the E007 catalog (`0006`), and the E008 `license`/`customer` tables (`0007`). Adds exactly three new tenant-owned tables — **`billing_connection`**, **`subscription`**, **`billing_event`** — plus a secret-excluding read view. **No changes to any existing table or column.** The E008 `license.status` enum (`active`/`suspended`/`revoked`) is UNTOUCHED; grace is a billing **OVERLAY** on `subscription`, not a new license state (per ADR + research §E008/E013 grounding).
> Source signals: spec FR-001…FR-022, US1…US6, Key Entities; research (webhook verify → dedupe → apply, grace overlay, stale-event guard, no-card-data); E008 `specs/00009-license-issuance-and-lifecycle/data-model.md` (`0007_licensing.sql`); E004 keystore custody `specs/00005-signing-service-and-key-custody/data-model.md` (`0004_signing_keys.sql`); `0008_activation.sql`, `0009_online_enforcement.sql` for the append-only-ledger + RLS/policy/grant pattern.
> New migration: `migrations/0010_billing.sql` (expand-only, sequential after `0009` — three additive tables + a view + indexes + RLS/policies/grants).

## Conventions (inherited from E002)

- **PK**: `id uuid` (UUID v7, application-generated, time-ordered). Physical primary key is the **composite `(tenant_id, id)`** — matching `license` / `activation` / `checkin` — so referential integrity stays tenant-local and every FK to a tenant-owned parent is a **composite FK including `tenant_id`**: a child can never bind to another tenant's parent.
- **Tenancy**: every tenant-owned row carries `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **Timestamps**: `timestamptz` (UTC). `created_at` defaults `now()`; `updated_at` defaults `now()` and is bumped by the repository on every edit. Monotonic anchors (`last_applied_event_at`) are advanced by a **guarded repository UPDATE, never a DB trigger** (the E013 `last_anchor_at` precedent).
- **RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY`; single permissive policy `tenant_isolation` gated on the per-transaction GUC `app.current_tenant`. App connects as the non-owner, `NOBYPASSRLS` role `licensesrv_app`.
- **Audit**: every billing-driven license mutation appends one row to the existing `audit_log` (INSERT/SELECT-only grant → append-only) **in the same transaction**, carrying the triggering `provider_event_id` (FR-013). No new audit table.
- **Status enums** are free `text` with an inline `CHECK (... IN (...))` — same technique as `license.status`, `activation.status`, `checkin.outcome`.
- **Secrets never in cleartext** (E004 precedent): the inbound webhook HMAC secret is never stored unwrapped in any column, response, log, or diagnostic, and is excluded from every API projection ([§4](#4-webhook-signing-secret-custody-fr-015)).
- **Append-only ledger** (E009/E013 precedent): the event ledger is `GRANT SELECT, INSERT` only; dedup is a UNIQUE constraint; bounded retention is a platform-owner prune path, not the app role's DML.

## 1. Entities (compact — primary artifact)

| Entity | Attributes (name: type, constraints) | Relationships | State Transitions |
|--------|--------------------------------------|---------------|-------------------|
| **billing_connection** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, provider: text NOT NULL CHECK IN(stripe,paddle,generic), status: text NOT NULL DEFAULT 'active' CHECK IN(active,disabled), signing_secret_ref: bytea NOT NULL (custody-wrapped, NEVER plaintext/returned), signing_secret_prev: bytea null (rotation window), secret_custody_scheme: text NOT NULL, secret_rotated_at: timestamptz null, plan_map: jsonb NOT NULL DEFAULT '{}', default_grace_seconds: int NOT NULL DEFAULT 1209600 CHECK(>0), grace_overrides: jsonb NOT NULL DEFAULT '{}', created_at, updated_at. PK `(tenant, id)`; UNIQUE `(tenant, provider)`. | belongs_to: tenant; has_many: subscription, billing_event; projected by: billing_connection_public (view); logged in: audit_log | active ↔ disabled (config lifecycle) |
| **subscription** (new table) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, provider: text NOT NULL, external_subscription_id: text NOT NULL, license_id: uuid NOT NULL, billing_state: text NOT NULL DEFAULT 'active' CHECK IN(active,past_due,grace,canceled,refunded), grace_expires_at: timestamptz null, last_applied_event_at: timestamptz null (recency guard, monotonic), created_at, updated_at. PK `(tenant, id)`; UNIQUE `(tenant, provider, external_subscription_id)`; UNIQUE `(tenant, license_id)`; composite FKs `(tenant,license_id)→license`, `(tenant,provider)→billing_connection`. | belongs_to: tenant, billing_connection; links 1:1: license; has_many: billing_event; **drives** E008 `license.status` (overlay); logged in: audit_log | active ↔ past_due/grace → canceled; any non-refunded → refunded (terminal). See [§6](#6-state-machine--subscriptionbilling_state) |
| **billing_event** (new table, append-only) | id: uuid, tenant_id: uuid NOT NULL FK→tenant, provider: text NOT NULL, provider_event_id: text NOT NULL, type: text NOT NULL (canonical), subscription_id: uuid null (unmapped→dead-letter), occurred_at: timestamptz NOT NULL (provider ts), received_at: timestamptz NOT NULL DEFAULT now(), outcome: text NOT NULL CHECK IN(applied,deadletter,rejected), reason: text null, payload_summary: jsonb null (minimized, NO card/PAN). PK `(tenant, id)`; **UNIQUE `(tenant, provider, provider_event_id)`** (idempotency); composite FKs `(tenant,subscription_id)→subscription`, `(tenant,provider)→billing_connection`. | belongs_to: tenant, billing_connection; refs: subscription (nullable); logged in: audit_log | append-only; per-event outcome ∈ {applied, deadletter, rejected} (duplicate = never stored, [§7](#7-idempotency--the-ledger-fr-003)) |

> Downstream agents consume the three rows above. `license`, `customer`, `plan`, `product`, `signing_key`, and `audit_log` are **reused** from E002/E007/E008/E004 and are **not** re-modeled here — they appear only at the integration boundaries ([§9](#9-integration-boundaries)).

## 2. `billing_connection` — column detail

Per-tenant provider connection: the inbound-webhook secret custody, the subscription-plan→catalog-plan map, and the grace policy. One per `(tenant, provider)`.

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-014). Matches RLS predicate. |
| provider | text | NOT NULL, `CHECK (provider IN ('stripe','paddle','generic'))`, UNIQUE `(tenant_id, provider)` | no | Adapter discriminator (FR-004). One connection per provider per tenant; also the **natural link key** the composite FKs on `subscription`/`billing_event` reference. |
| status | text | NOT NULL, DEFAULT `'active'`, `CHECK (status IN ('active','disabled'))` | no | Config lifecycle. `disabled` stops APPLYING new webhooks without deleting the connection: a delivery to a disabled connection is STILL signature/timestamp-verified (verify-before-process preserved), then dead-lettered (`billing_event.outcome='deadletter'`, `reason='connection_disabled'`) and acked, never mapped to a lifecycle change. Deletion is FK-blocked while subscriptions/events reference it — [§8](#8-constraints--indexes). |
| signing_secret_ref | bytea | NOT NULL | no | The **CURRENT** inbound-HMAC secret, custody-wrapped — **NEVER plaintext, NEVER returned by any API** (FR-015, [§4](#4-webhook-signing-secret-custody-fr-015)). |
| signing_secret_prev | bytea | | yes | The **PREVIOUS** secret, kept only during a rotation transition window so both are accepted (FR-015, US5-AC2); nulled when the window closes. |
| secret_custody_scheme | text | NOT NULL | no | Names how the two secret refs are wrapped/resolved, e.g. `keystore-aes256gcm-v1` \| `secretref-file` \| `kms-aws`. Free text, no CHECK (new adapters need no migration — same technique as `signing_key.custody_scheme`). |
| secret_rotated_at | timestamptz | | yes | Start of the current transition window: `signing_secret_prev` stays accepted while `now() - secret_rotated_at < window` (the window duration is app-config). Null if never rotated. |
| plan_map | jsonb | NOT NULL, DEFAULT `'{}'` | no | Provider plan/price id → `{product_id, plan_id}` catalog reference (FR-015). Drives provisioning (FR-005). **App-validated** against E007 (a CHECK can't join to the catalog). |
| default_grace_seconds | int | NOT NULL, DEFAULT `1209600`, `CHECK (default_grace_seconds > 0)` | no | Sane default grace window (~14d, provider dunning order) (FR-011). |
| grace_overrides | jsonb | NOT NULL, DEFAULT `'{}'` | no | Per-plan grace-duration overrides `{plan_key: seconds}` (FR-011, "configurable per plan"). Each override value is **app-validated to be a positive integer (> 0)** — a jsonb CHECK can't constrain every entry, so the config validator enforces it (matching the API `GraceOverrides` `minimum: 1`) — so **no effective grace window (default or override) is ever zero or negative** (FR-011). |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped on every edit (secret rotation, map/policy change, disable). |

## 3. `subscription` — column detail

The external subscription ↔ license link and the grace **overlay**. The billing layer's state-of-record; it *drives* `license.status` via the E008 lifecycle but never adds a state to that enum.

| Field | Type | Key / Constraint | Nullable | Notes |
|-------|------|------------------|----------|-------|
| id | uuid | part of PK `(tenant_id, id)` | no | UUID v7. |
| tenant_id | uuid | NOT NULL, FK → `tenant(id)`, part of PK | no | Tenancy scope (FR-014). |
| provider | text | NOT NULL, composite FK `(tenant_id, provider) → billing_connection(tenant_id, provider)` | no | The connection this subscription belongs to; intra-tenant (FR-014). |
| external_subscription_id | text | NOT NULL, UNIQUE `(tenant_id, provider, external_subscription_id)` | no | The provider subscription id (`sub_…`); the **resolve key** an incoming event maps to exactly one row (FR-012). |
| license_id | uuid | NOT NULL, UNIQUE `(tenant_id, license_id)`, composite FK `(tenant_id, license_id) → license(tenant_id, id)` | no | The **one** managed license (1:1). `UNIQUE` enforces at most one subscription per license; the FK is intra-tenant and `ON DELETE NO ACTION`. **Set ONCE at provisioning and IMMUTABLE thereafter** — the repo never re-points `license_id`, so a subscription is never re-linked to a different license and the 1:1 link is permanent ([§11](#11-app-layer-invariants) inv. 9) (FR-005/012). |
| billing_state | text | NOT NULL, DEFAULT `'active'`, `CHECK (billing_state IN ('active','past_due','grace','canceled','refunded'))` | no | The **overlay** state ([§5](#5-grace-overlay--billing_state--licensestatus)/[§6](#6-state-machine--subscriptionbilling_state)). Distinct from `license.status`. |
| grace_expires_at | timestamptz | `CHECK (billing_state IN ('past_due','grace') OR grace_expires_at IS NULL)` | yes | The **auto-suspend deadline** (FR-007/008). Set when entering `past_due`/`grace`; the scheduled job suspends the license at/after it; cleared on recovery or on suspend. |
| last_applied_event_at | timestamptz | | yes | `occurred_at` of the most-recently-**applied** provider event (or reconciliation snapshot ts): the **stale/out-of-order recency guard** (FR-016). An event with `occurred_at <= last_applied_event_at` is ignored. **Monotonic non-decreasing**, advanced by a guarded repo UPDATE (not a trigger). NULL = no event applied yet. |
| created_at | timestamptz | NOT NULL, DEFAULT `now()` | no | |
| updated_at | timestamptz | NOT NULL, DEFAULT `now()` | no | Bumped on every state/grace transition. |

## 4. Webhook signing-secret custody (FR-015)

**Decision — envelope-encrypt-at-rest (default), reusing the E004/E006 keystore custody; a secret-ref (`<VAR>_FILE`/external manager) as an alternative scheme; two columns for rotation.** No column ever holds the secret in plaintext, and no API projection ever returns it.

| `secret_custody_scheme` | What `signing_secret_ref` / `signing_secret_prev` holds | Why |
|-------------------------|---------------------------------------------------------|-----|
| `keystore-aes256gcm-v1` (default) | The webhook HMAC secret **envelope-encrypted (AES-256-GCM)** under the same keystore master key custody E004 already ships (E006 runtime unlock). | **Scales to multi-tenant SaaS**: each per-tenant connection carries its own secret in-row, decrypted into memory only to verify a webhook. A DB dump alone yields no usable secret (master key not in the DB). |
| `secretref-file` | An **opaque reference** (an env/secret-file name — the spec's `NEW-CONFIG <VAR>_FILE`) resolved at runtime via the E006 secrets contract; the material never lands in the DB. | Best for a **single-tenant self-host** with a known, fixed connection; matches the project's "secret material supplied out-of-band, never baked into the DB/image" posture. |
| `kms-aws` / `pkcs11` (optional) | An opaque backend handle used to compute/verify the HMAC in the backend. | Parity with the E004 pluggable-signer optionality; no export path. |

**Why a *lower* custody tier than the E004 Ed25519 signing key — and why that is correct.** The E004 signing key is *no-read / no-export*: the `Signer` interface never returns it, it is Shamir-split and sign-by-handle, so it can stay behind a boundary that never reveals bytes. The inbound webhook HMAC secret is different in kind: to verify a webhook the server **must recompute the HMAC over the raw body**, so it **must be readable server-side on every request**. It therefore cannot be Shamir-split-behind-no-export or delegated to a KMS *sign-by-handle*; the verifier needs the plaintext bytes in memory. The custody model matches that constraint — **encrypt-at-rest + decrypt-in-memory-to-verify** — while preserving the same three hard guarantees as the signing key:

1. **Never returned by any API.** `signing_secret_ref` / `signing_secret_prev` are excluded from every response and from the `billing_connection_public` read view ([§10](#10-rls-policies--grants)) — the exact `product_keyring`-excludes-`private_key_ref` pattern (FR-015, SC-007).
2. **Never plaintext at rest / never logged.**
3. **`FORCE ROW LEVEL SECURITY`** so even the table owner cannot read another tenant's secret through a view/function.

**Rotation (two secrets, transition window).** A rotation writes the new secret to `signing_secret_ref`, moves the outgoing secret to `signing_secret_prev`, and stamps `secret_rotated_at`. The verifier accepts a signature valid under **either** secret while `now() - secret_rotated_at < window` (a bounded, configurable transition window; **default 24h** — FR-022); once the window closes the repo nulls `signing_secret_prev`, so a superseded secret is not accepted indefinitely. This gives the "both old and new accepted during a transition window" behaviour (US5-AC2) without a separate table — the same two-slot approach E004 uses for key overlap, scaled down to a symmetric secret. **By contrast, the immediate-replace path (admin `PATCH signingSecret`) overwrites `signing_secret_ref` with NO transition window**, so any in-flight webhook still signed with the prior secret is rejected (`401 invalid_signature`) — operators MUST use rotate-secret for a graceful, overlap-preserving rotation.

## 5. Grace overlay — `billing_state` ↔ `license.status`

`subscription.billing_state` is a **billing overlay**; the E008 `license.status` enum is unchanged. The mapping the service applies (research §grace; ADR "grace is an overlay"):

| `billing_state` | Driven `license.status` (via E008 lifecycle) | `grace_expires_at` | Meaning |
|-----------------|----------------------------------------------|--------------------|---------|
| `active` | `active` | null | Paid & current. |
| `past_due` | `active` (still usable) | **set** | Payment failed; dunning-grace running. Recover on a later successful payment. |
| `grace` | `active` (still usable) | **set** | Cancellation-grace running. Recover on reactivation. |
| `canceled` | `suspended` | null (cleared on suspend) | Grace elapsed / subscription ended → E008 **suspend**. Recovery from `suspended` still allowed. |
| `refunded` | `revoked` | null | Refund/chargeback → E008 **revoke** (terminal). |

> During `past_due`/`grace` the license stays `active` (usable) — the overlay tracks the billing window without touching `license.status`. Only on grace-expiry does the scheduled job drive `active → suspended`; only a refund drives `→ revoked`. This is exactly E008's `active ↔ suspended` + `→ revoked (terminal)` machine — E014 supplies the *triggers*, E008 owns the *transitions* (FR-005…010).

## 6. State machine — `subscription.billing_state`

Conditional branches (grace is time-driven; refund is terminal; a revoked license can't be resurrected), so modeled explicitly. Every transition that drives a license mutation is audited with the triggering `provider_event_id` (FR-013). Guarded by the recency check ([§3](#3-subscription--column-detail) `last_applied_event_at`, FR-016).

| From | Trigger | To | License action (E008) | Notes |
|------|---------|----|-----------------------|-------|
| — | subscription created/activated (mapped) | `active` | **provision** (issue/activate) + link | FR-005; sets `license_id`, `last_applied_event_at`. |
| `active` | renewal / invoice-paid | `active` | **extend** term, keep active | FR-006; clears any grace. |
| `active` | payment-failure | `past_due` | none (stays usable) | FR-007; sets `grace_expires_at = now()+grace`. |
| `active` | cancellation | `grace` | none (stays usable) | FR-007; sets `grace_expires_at`. |
| `past_due`/`grace` | successful payment / reactivation | `active` | **reinstate if suspended**, clear grace | FR-009; recovery. |
| `past_due`/`grace` | grace window elapses (scheduled job) | `canceled` | **suspend** | FR-008; time-driven, not webhook-driven. |
| `canceled` | successful payment / reactivation | `active` | **reinstate** | FR-009; recovery from suspended is allowed. |
| any non-`refunded` | refund / chargeback | `refunded` | **revoke** (terminal) | FR-010. |
| `refunded` | any later event | `refunded` | none (idempotent no-op) | FR-010; **revoked is terminal — never resurrected.** |
| any | stale event (`occurred_at <= last_applied_event_at`) | *(unchanged)* | none | FR-016; ledger `outcome='rejected'`, `reason='stale_event'`. |

## 7. Idempotency & the ledger (FR-003)

- The dedup key is **`UNIQUE (tenant_id, provider, provider_event_id)`** on `billing_event`. The ledger row is INSERTed **in the same transaction as its side effect** via `INSERT … ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING`, so an at-least-once redelivery applies **at most once** (research: transactional processed-events).
- A **redelivery** conflicts on the UNIQUE → 0 rows inserted → the service returns idempotent success; **no second row is written** (the UNIQUE forbids it). Therefore a stored row's `outcome` is one of `applied` / `deadletter` / `rejected`; **`duplicate` is the API/response vocabulary for the no-op, never a stored ledger row.** (`provider` is part of the key so two providers can't alias on the same id — this realizes the FR-003 "at most once per tenant" guarantee.)
- **Outcomes**: `applied` (side effect committed, `reason` null), `deadletter` (unmapped subscription / unhandled type / failed-after-ack — `subscription_id` may be null; FR-020), `rejected` (post-verification reject recorded for visibility, e.g. stale-event guard — FR-016). **A signature/timestamp failure is rejected inline with NO ledger row and no state change** (FR-002/020); the ledger only holds post-verification events.
- **`type`** is the adapter-normalized canonical event type (FR-004) — provider-specific parsing stays in the adapter; the ledger and downstream logic see one internal vocabulary.

## 8. PII / GDPR & no-card-data (FR-018 / FR-021)

**Decision — store minimized, allow-listed metadata only; NEVER the raw provider payload; NEVER card/PAN data.**

- **No raw payload persisted.** `billing_event` stores the columned metadata (`provider_event_id`, `type`, `subscription_id`, `occurred_at`, `outcome`, `reason`) plus an optional **`payload_summary jsonb`** that carries an **app-enforced allow-list** of non-sensitive normalized fields only (e.g. canonical event type, plan/price id, subscription status, invoice amount-status flag). **Never** card number/PAN, CVV, expiry, full billing address, or raw customer PII beyond the pseudonymous E008 `customer.ref`. A CHECK can't prove "no PAN", so the allow-list is an **app-layer invariant** enforced by the adapter/normalizer (documented in [§11](#11-app-layer-invariants)).
- **Why not the raw payload.** Providers embed PII/financial fields (email, address, card last4) in webhook bodies; storing them verbatim pulls the ledger toward PCI/GDPR exposure. A minimized summary keeps the ledger useful for audit, dead-letter triage, and reconciliation while staying **outside PCI scope** (FR-018) and trivially prunable.
- **Retention-bounded + deletable (FR-021).** `billing_event` is append-only to the app (`GRANT SELECT, INSERT`); age-based deletion is a **platform-owner prune path** on `received_at` (BRIN index, the E013 `checkin` precedent), with a horizon that exceeds the provider retry window (≥48h). `subscription` inherits the E008 GDPR posture: it holds **no PII** (only pseudonymous provider ids + the `license_id` link); customer identity lives in E008 `customer` and is erased/anonymized there. A GDPR erasure of a customer flows through E008; the billing rows carry no independent PII to erase beyond pruning the ledger.
- **No new key custody / no new PII surface**: provisioning issuance is delegated to E004/E008 (no new signing key); the only new secret is the inbound webhook HMAC secret, custody-handled in [§4](#4-webhook-signing-secret-custody-fr-015).

## 9. Integration boundaries

- **E008 `license` + lifecycle services are reused, not re-modeled.** `subscription.license_id` composite-FKs `license(tenant_id, id)`; E014 **drives** `license.status` through the existing E008 provision/extend/suspend/reinstate/revoke services ([§5](#5-grace-overlay--billing_state--licensestatus)/[§6](#6-state-machine--subscriptionbilling_state)). E014 adds **no** column and **no** enum value to `license`/`customer`. `revoked` remains terminal (FR-010).
- **E004 signer is reused for provisioning.** A subscription-created event provisions a license via the E008 issuance path, which calls the E004 in-process signer — E014 introduces **no new signing key or key custody**; the webhook HMAC secret ([§4](#4-webhook-signing-secret-custody-fr-015)) is a distinct provider-inbound-auth secret, not an Ed25519 key.
- **E013 propagates.** E014 only sets `license.status`; propagation of suspension/revocation to connected clients (online validate/heartbeat non-reissue + CRL) is owned by E013. The offline-revocation gap is E013's to close.
- **E007 catalog is referenced via `plan_map`, not FK-joined.** `billing_connection.plan_map` maps provider plans → `{product_id, plan_id}`; validated in the app at config time (a CHECK can't join the catalog). Provisioning reads the mapped plan through the E008 issuance path.
- **`audit_log` (E002) is reused.** Every billing-driven mutation appends one append-only row in-transaction with the triggering `provider_event_id` (FR-013). No new audit table; grants unchanged.
- **Workers.** The scheduled grace-expiry/auto-suspend job (FR-008) reads `subscription` via `subscription_grace`; the reconciliation job (FR-017) reads `subscription_state` and calls the provider API. Both run tenant-scoped under RLS and are fail-open (spec Implementation Signals). Neither adds schema.

## 10. RLS, policies & grants

Identical form to E002 `0002` / E008 `0007` / E009 `0008` / E013 `0009`, applied to each new table:

```sql
ALTER TABLE billing_connection ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription       ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription       FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_event      ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_event      FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON billing_connection USING (…) WITH CHECK (…);   -- predicate below
CREATE POLICY tenant_isolation ON subscription       USING (…) WITH CHECK (…);
CREATE POLICY tenant_isolation ON billing_event      USING (…) WITH CHECK (…);

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_connection TO licensesrv_app;   -- configure / rotate secret / disconnect
GRANT SELECT, INSERT, UPDATE         ON subscription       TO licensesrv_app;   -- state/grace transitions; no DELETE (retain)
GRANT SELECT, INSERT                 ON billing_event      TO licensesrv_app;   -- append-only ledger + idempotency dedup
```

- Policy predicate (all three): `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, on both `USING` (read) and `WITH CHECK` (write). Unset GUC → NULL → **zero rows**, so an unscoped query is refused (FR-014).
- `FORCE ROW LEVEL SECURITY` subjects the table owner too — the reason the secret-excluding view below still isolates by tenant.
- **Secret-excluding read view** (the `product_keyring` pattern — enforces FR-015 "secret never returned"):

```sql
CREATE VIEW billing_connection_public
  WITH (security_invoker = true) AS       -- honours the caller's app.current_tenant under RLS
  SELECT tenant_id, id, provider, status, secret_custody_scheme, secret_rotated_at,
         plan_map, default_grace_seconds, grace_overrides, created_at, updated_at
    FROM billing_connection;              -- NEVER projects signing_secret_ref / signing_secret_prev
GRANT SELECT ON billing_connection_public TO licensesrv_app;
```

- `billing_connection` gets `DELETE` (operator disconnect), but the `(tenant_id, provider)` composite FKs from `subscription`/`billing_event` are `ON DELETE NO ACTION`, so a connection still referenced **cannot** be hard-deleted → operators `status='disabled'` instead ([§8](#8-constraints--indexes)). `subscription` has no `DELETE` (canceled/refunded are soft states; retention/erasure is the platform path). `billing_event` is `SELECT, INSERT` only.

## 11. App-layer invariants

Not expressible as a single-table CHECK:

1. **Verify → dedupe → apply.** Verify the raw-body HMAC + timestamp recency against `signing_secret_ref` (or `signing_secret_prev` within the rotation window) **before any processing**; reject invalid inline with no row and no state change (FR-002). Then `INSERT … ON CONFLICT DO NOTHING` the ledger row in the same tx as the side effect ([§7](#7-idempotency--the-ledger-fr-003)).
2. **Recency guard.** Apply an event only if `occurred_at > subscription.last_applied_event_at`; otherwise record `outcome='rejected', reason='stale_event'` and leave state unchanged (FR-016). `last_applied_event_at` advances monotonically via a guarded UPDATE.
3. **Overlay mapping.** `billing_state` transitions drive `license.status` through the E008 lifecycle per [§5](#5-grace-overlay--billing_state--licensestatus); `revoked` is terminal and never resurrected (FR-010).
4. **Time-driven grace.** The scheduled job suspends when `grace_expires_at <= now()` even absent a webhook (FR-008).
5. **`plan_map` validity.** Mapped `{product_id, plan_id}` must reference active E007 catalog rows (app-validated; a CHECK can't join) (FR-005/015).
6. **Secret handling.** Secret refs are never returned by any API/log and never plaintext at rest ([§4](#4-webhook-signing-secret-custody-fr-015)); rotation keeps two secrets for a bounded window (FR-015).
7. **No card/PAN + minimized payload (closed allow-list).** `payload_summary` is a CLOSED, deny-by-default allow-list enforced by the adapter/normalizer: ONLY these fields may be persisted — canonical event type, provider plan/price key, subscription/billing status, invoice payment-status flag, external subscription id, and occurred-at — and any field NOT on this exhaustive list is dropped before persistence. No card/PAN/CVV/expiry/PII (FR-018/021). The testable invariant is that no field outside the allow-list ever reaches the ledger (webhook OR reconciliation ingest).
8. **Bounded pre-resolution lookup (non-oracle).** Resolving `{connectionId}` before signature verification is a bounded, non-oracle risk: the connection id is an unguessable server-minted UUID, so neither the `404 connection_not_found` outcome nor its response timing (returned before any HMAC computation, versus a `401` after) yields a usable existence/enumeration oracle over the 128-bit id space; the per-source-IP webhook rate limit (FR-019) additionally bounds the pre-authentication lookup flood.
9. **1:1 link immutability.** `subscription.license_id` is set exactly once at provisioning (FR-005) and is never UPDATEd afterward — the repo's subscription-mutation path touches only `billing_state` / `grace_expires_at` / `last_applied_event_at`, never `license_id` — so a subscription is never re-linked to a different license. Combined with `UNIQUE (tenant_id, license_id)` (a license is driven by at most one subscription) this makes the subscription↔license link a permanent 1:1 (FR-012).

## 12. Constraints & indexes

| Object | Definition | Purpose |
|--------|------------|---------|
| PK (all three) | `PRIMARY KEY (tenant_id, id)` | Tenant-local identity; backs tenant-first access + RLS. |
| connection uniqueness | `UNIQUE (tenant_id, provider)` on `billing_connection` | One connection per provider per tenant; the FK target + lookup key. |
| subscription resolve key | `UNIQUE (tenant_id, provider, external_subscription_id)` | Every event resolves to exactly one subscription (FR-012); its index serves event→subscription lookup. |
| 1:1 sub↔license | `UNIQUE (tenant_id, license_id)` on `subscription` | At most one subscription per license; doubles as the license→subscription lookup. |
| **idempotency key** | `UNIQUE (tenant_id, provider, provider_event_id)` on `billing_event` | The FR-003 dedup — at most one ledger row per provider event; `ON CONFLICT DO NOTHING`. |
| sub → license FK | composite `(tenant_id, license_id) → license`, `ON DELETE NO ACTION` | Intra-tenant link integrity; backstops hard-delete of a linked license. |
| sub → connection FK | composite `(tenant_id, provider) → billing_connection`, `ON DELETE NO ACTION` | Every subscription belongs to a configured connection (FR-014); blocks deleting an in-use connection. |
| event → subscription FK | composite `(tenant_id, subscription_id) → subscription`, `ON DELETE NO ACTION`, nullable | Resolved events reference a same-tenant subscription; MATCH SIMPLE skips the check when `subscription_id` is NULL (unmapped dead-letter, FR-020). |
| event → connection FK | composite `(tenant_id, provider) → billing_connection`, `ON DELETE NO ACTION` | Events belong to the verified connection (FR-014). |
| grace shape | `CHECK (billing_state IN ('past_due','grace') OR grace_expires_at IS NULL)` | `grace_expires_at` set only while a grace window runs. |
| outcome/reason shape | `CHECK ((outcome='applied' AND reason IS NULL) OR (outcome<>'applied' AND reason IS NOT NULL))` | applied carries no reason; dead-letter/reject carry one. |
| grace default | `CHECK (default_grace_seconds > 0)` | Positive default grace window (FR-011). |
| enums | `provider IN (stripe,paddle,generic)`; `billing_connection.status IN (active,disabled)`; `billing_state IN (active,past_due,grace,canceled,refunded)`; `outcome IN (applied,deadletter,rejected)` (stored; `duplicate` is an ack-only value, never a row) | Domains (FR-004/007/010/020). |
| `subscription_grace` | `CREATE INDEX subscription_grace ON subscription (tenant_id, grace_expires_at) WHERE grace_expires_at IS NOT NULL` | Partial index for the scheduled auto-suspend sweep (FR-008). |
| `subscription_state` | `CREATE INDEX subscription_state ON subscription (tenant_id, billing_state)` | Reconciliation / registry scans by state (FR-017). |
| `billing_event_subscription` | `CREATE INDEX billing_event_subscription ON billing_event (tenant_id, subscription_id, occurred_at DESC)` | Per-subscription event trail + ordering (FR-013/016). |
| `billing_event_deadletter` | `CREATE INDEX billing_event_deadletter ON billing_event (tenant_id, received_at) WHERE outcome = 'deadletter'` | Partial index — the operator dead-letter queue (FR-020). |
| `billing_event_prune` | `CREATE INDEX billing_event_prune ON billing_event USING brin (received_at)` | Age-based retention prune on an append-only, time-ordered ledger (FR-021). |

All B-tree indexes are `tenant_id`-leading, matching the RLS predicate and the repository's tenant-first access pattern (E002 convention).

## 13. Tenant-isolation notes

- Every new table carries `tenant_id NOT NULL REFERENCES tenant(id)`, PKs on `(tenant_id, id)`, and `ENABLE`+`FORCE ROW LEVEL SECURITY` with the `tenant_isolation` policy — a webhook's effects are confined to the tenant that owns the resolving connection (FR-014).
- **All** cross-table references are `tenant_id`-leading composite FKs, so a subscription can never link another tenant's license and an event can never bind another tenant's connection/subscription.
- The secret-excluding `billing_connection_public` view uses `security_invoker = true`, so it honours the caller's `app.current_tenant` — a connection's secret is never readable across tenants, even through the view, and never at all through the API.
- The grace/reconciliation workers run per-tenant under the same GUC; an unset GUC yields zero rows (fail-closed), never an unscoped scan.

## 14. DDL sketch — `migrations/0010_billing.sql`

```sql
-- E014 billing-driven entitlement automation (FR-001..FR-022). Extends the E002 tenancy substrate, the
-- E007 catalog, the E008 license table, and the E004/E006 keystore-custody precedent (expand-only,
-- sequential after 0009). Three new tenant-owned tables: billing_connection, subscription, billing_event
-- (+ a secret-excluding view). Same tenant-scoped forced-RLS + composite-FK + audit-on-mutation +
-- append-only-ledger pattern as 0007/0008/0009. NO changes to any existing table/column — the E008
-- license.status enum (active/suspended/revoked) is UNTOUCHED; grace is a billing OVERLAY on subscription.
--
-- Secret custody: the inbound webhook HMAC secret is NEVER plaintext and NEVER returned by any API
-- (FR-015). It is envelope-encrypted at rest (keystore custody, reused from E004) or an opaque secret-ref
-- (<VAR>_FILE / external manager), and is decrypted into memory ONLY to verify a webhook. Unlike the E004
-- Ed25519 signing key (no-read/no-export, Shamir-split, sign-by-handle), this secret MUST be readable
-- server-side on every webhook to recompute the HMAC -- a lower custody tier, same never-returned /
-- FORCE-RLS / excluded-from-projection guarantees. Rotation keeps a second secret for a transition window.
--
-- Idempotency: billing_event UNIQUE (tenant_id, provider, provider_event_id) is the dedup key (FR-003);
-- the row is INSERT ... ON CONFLICT DO NOTHING in the same tx as its side effect -> at-least-once
-- redelivery applies at most once. Append-only (SELECT,INSERT); dead-letter is outcome='deadletter'
-- (FR-020). No card/PAN data is ever stored (FR-018); only minimized, allow-listed metadata,
-- retention-bounded + deletable via the platform prune path (FR-021).

-- 1. billing_connection -- per-tenant provider connection: secret custody + plan map + grace policy.
CREATE TABLE billing_connection (
  id                    uuid        NOT NULL,
  tenant_id             uuid        NOT NULL REFERENCES tenant(id),
  provider              text        NOT NULL
                          CHECK (provider IN ('stripe','paddle','generic')),  -- adapter discriminator (FR-004)
  status                text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','disabled')),            -- config lifecycle
  signing_secret_ref    bytea       NOT NULL,                    -- CURRENT inbound-HMAC secret, custody-wrapped; NEVER plaintext / NEVER returned (FR-015)
  signing_secret_prev   bytea,                                   -- PREVIOUS secret during the rotation transition window; null outside a rotation (US5-AC2)
  secret_custody_scheme text        NOT NULL,                    -- keystore-aes256gcm-v1 | secretref-file | kms-aws (free text; no CHECK, like signing_key.custody_scheme)
  secret_rotated_at     timestamptz,                             -- start of the transition window (prev accepted while now()-this < app-config window); null if never rotated
  plan_map              jsonb       NOT NULL DEFAULT '{}',       -- provider plan/price id -> {product_id, plan_id}; app-validated vs E007 (a CHECK can't join)
  default_grace_seconds int         NOT NULL DEFAULT 1209600
                          CHECK (default_grace_seconds > 0),     -- sane default grace window (~14d) (FR-011)
  grace_overrides       jsonb       NOT NULL DEFAULT '{}',       -- per-plan grace overrides {plan_key: seconds} (FR-011)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- one connection per provider per tenant; also the natural link key for subscription/billing_event.
  UNIQUE (tenant_id, provider)
);

-- 2. subscription -- external subscription <-> license link + grace OVERLAY (FR-007/008/009/012).
CREATE TABLE subscription (
  id                       uuid        NOT NULL,
  tenant_id                uuid        NOT NULL REFERENCES tenant(id),
  provider                 text        NOT NULL,                 -- matches its billing_connection
  external_subscription_id text        NOT NULL,                 -- provider subscription id (sub_...); the resolve key
  license_id               uuid        NOT NULL,                 -- the ONE managed license (1:1)
  billing_state            text        NOT NULL DEFAULT 'active'
                             CHECK (billing_state IN ('active','past_due','grace','canceled','refunded')),  -- overlay (FR-007..010)
  grace_expires_at         timestamptz,                          -- auto-suspend deadline; set in past_due/grace (FR-007/008)
  last_applied_event_at    timestamptz,                          -- occurred_at of the last APPLIED event; stale/out-of-order guard (FR-016); monotonic (repo-enforced)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- the link key: one subscription per (tenant, provider, external id).
  CONSTRAINT subscription_external_uniq UNIQUE (tenant_id, provider, external_subscription_id),
  -- 1:1 subscription <-> license: a license is managed by at most one subscription.
  CONSTRAINT subscription_license_uniq  UNIQUE (tenant_id, license_id),
  -- intra-tenant composite FK: a subscription can never link to another tenant's license.
  CONSTRAINT subscription_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id),
  -- intra-tenant composite FK: every subscription belongs to a configured connection (FR-014).
  CONSTRAINT subscription_connection_fk
    FOREIGN KEY (tenant_id, provider)   REFERENCES billing_connection (tenant_id, provider),
  -- grace_expires_at is meaningful only while a grace window runs.
  CONSTRAINT subscription_grace_shape
    CHECK (billing_state IN ('past_due','grace') OR grace_expires_at IS NULL)
);

-- 3. billing_event -- per-tenant, append-only, signature-verified webhook ledger + idempotency dedup.
CREATE TABLE billing_event (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL REFERENCES tenant(id),
  provider          text        NOT NULL,
  provider_event_id text        NOT NULL,                        -- provider event id (evt_...); the idempotency key
  type              text        NOT NULL,                        -- canonical/normalized event type (adapter output, FR-004)
  subscription_id   uuid,                                        -- resolved subscription; NULL when unmapped -> dead-letter (FR-020)
  occurred_at       timestamptz NOT NULL,                        -- provider event timestamp; ordering + recency guard (FR-016)
  received_at       timestamptz NOT NULL DEFAULT now(),          -- server receive/ack time; drives the retention prune
  outcome           text        NOT NULL
                      CHECK (outcome IN ('applied','deadletter','rejected')),  -- FR-003/016/020 (duplicate is never stored — the UNIQUE forbids a 2nd row)
  reason            text,                                        -- dead-letter/reject reason; null when applied
  payload_summary   jsonb,                                       -- MINIMIZED, allow-listed metadata ONLY; NO card/PAN/PII (FR-018/021); app-enforced allow-list
  PRIMARY KEY (tenant_id, id),
  -- IDEMPOTENCY dedup (FR-003): at most one ledger row per provider event; INSERT ... ON CONFLICT DO
  -- NOTHING in the same tx as the side effect => at-least-once redelivery applies exactly once.
  CONSTRAINT billing_event_idem_uniq UNIQUE (tenant_id, provider, provider_event_id),
  -- resolved event references a same-tenant subscription; NULL (MATCH SIMPLE) = unmapped dead-letter.
  CONSTRAINT billing_event_subscription_fk
    FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscription (tenant_id, id),
  -- every persisted event was verified against a configured connection's secret.
  CONSTRAINT billing_event_connection_fk
    FOREIGN KEY (tenant_id, provider) REFERENCES billing_connection (tenant_id, provider),
  -- shape: applied carries no reason; deadletter/rejected carry one (duplicate is never stored -> the unique).
  CONSTRAINT billing_event_outcome_reason
    CHECK ((outcome = 'applied' AND reason IS NULL) OR (outcome <> 'applied' AND reason IS NOT NULL))
);

-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
CREATE INDEX subscription_grace ON subscription (tenant_id, grace_expires_at)
  WHERE grace_expires_at IS NOT NULL;                             -- scheduled auto-suspend sweep (FR-008)
CREATE INDEX subscription_state ON subscription (tenant_id, billing_state);  -- reconciliation scans (FR-017)
CREATE INDEX billing_event_subscription ON billing_event (tenant_id, subscription_id, occurred_at DESC);  -- per-sub trail + ordering (FR-013/016)
CREATE INDEX billing_event_deadletter ON billing_event (tenant_id, received_at)
  WHERE outcome = 'deadletter';                                  -- operator dead-letter queue (FR-020)
CREATE INDEX billing_event_prune ON billing_event USING brin (received_at);  -- age-based retention prune (FR-021)

-- RLS: same form as E002 (0002) / E008 (0007) / E009 (0008) / E013 (0009). Unset GUC -> NULL -> zero rows.
ALTER TABLE billing_connection ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription       ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription       FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_event      ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_event      FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON billing_connection
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON subscription
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON billing_event
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only ledger for billing_event (SELECT,INSERT). billing_connection is fully mutable (configure /
-- rotate secret / disconnect); subscription mutates for state/grace transitions but is retained (no DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_connection TO licensesrv_app;
GRANT SELECT, INSERT, UPDATE         ON subscription       TO licensesrv_app;
GRANT SELECT, INSERT                 ON billing_event      TO licensesrv_app;

-- Secret-excluding read view (the product_keyring pattern): NEVER projects the secret refs (FR-015/SC-007).
CREATE VIEW billing_connection_public
  WITH (security_invoker = true) AS
  SELECT tenant_id, id, provider, status, secret_custody_scheme, secret_rotated_at,
         plan_map, default_grace_seconds, grace_overrides, created_at, updated_at
    FROM billing_connection;
GRANT SELECT ON billing_connection_public TO licensesrv_app;
```

## 15. ER Diagram

<details><summary>ER Diagram (visual reference)</summary>

```mermaid
erDiagram
    tenant             ||--o{ billing_connection : "owns"
    tenant             ||--o{ subscription       : "owns"
    tenant             ||--o{ billing_event      : "owns"
    tenant             ||--o{ audit_log          : "logs mutations"
    billing_connection ||--o{ subscription       : "connects (tenant,provider)"
    billing_connection ||--o{ billing_event      : "verifies (tenant,provider)"
    billing_connection ||..o{ billing_connection_public : "projected as view (no secret)"
    subscription       ||--o{ billing_event      : "resolves (nullable=dead-letter)"
    license            ||--|| subscription       : "1:1 linked (drives status)"

    billing_connection {
        uuid id PK
        uuid tenant_id PK-FK
        text provider UK "stripe|paddle|generic"
        text status "active|disabled"
        bytea signing_secret_ref "custody-wrapped, never returned"
        bytea signing_secret_prev "rotation window"
        text secret_custody_scheme
        timestamptz secret_rotated_at
        jsonb plan_map "provider plan -> catalog {product,plan}"
        int default_grace_seconds
        jsonb grace_overrides
        timestamptz created_at
        timestamptz updated_at
    }
    subscription {
        uuid id PK
        uuid tenant_id PK-FK
        text provider FK
        text external_subscription_id UK
        uuid license_id FK-UK "1:1"
        text billing_state "active|past_due|grace|canceled|refunded"
        timestamptz grace_expires_at "auto-suspend deadline"
        timestamptz last_applied_event_at "recency guard"
        timestamptz created_at
        timestamptz updated_at
    }
    billing_event {
        uuid id PK
        uuid tenant_id PK-FK
        text provider FK
        text provider_event_id UK "idempotency key"
        text type "canonical"
        uuid subscription_id FK "null=unmapped"
        timestamptz occurred_at
        timestamptz received_at
        text outcome "applied|deadletter|rejected (duplicate never stored)"
        text reason
        jsonb payload_summary "minimized, no card/PAN"
    }
    license {
        uuid id PK "E008 - reused, unchanged"
        uuid tenant_id PK-FK
        text status "active|suspended|revoked"
    }
```

</details>

## 16. Data Model Summary (drop into plan)

| Entity | Kind | Key Attributes | Relationships | State Transitions |
|--------|------|----------------|---------------|-------------------|
| `billing_connection` | new tenant-owned table | id, tenant_id, provider{stripe,paddle,generic} (uniq per tenant), status{active,disabled}, signing_secret_ref (custody-wrapped, never returned), signing_secret_prev (rotation), secret_custody_scheme, secret_rotated_at, plan_map jsonb, default_grace_seconds>0, grace_overrides jsonb | belongs_to tenant; has_many subscription/billing_event; projected by billing_connection_public view; audited | active ↔ disabled |
| `subscription` | new tenant-owned table | id, tenant_id, provider (FK→connection), external_subscription_id (uniq per tenant+provider), license_id (uniq per tenant, FK→license, 1:1), billing_state{active,past_due,grace,canceled,refunded}, grace_expires_at, last_applied_event_at (recency guard, monotonic) | belongs_to tenant+billing_connection; links 1:1 license; drives license.status (overlay); audited | active↔past_due/grace→canceled(suspend); →refunded(revoke, terminal); stale event ignored |
| `billing_event` | new tenant-owned table (append-only) | id, tenant_id, provider (FK→connection), provider_event_id (**UNIQUE idempotency**), type, subscription_id (null=unmapped, FK→subscription), occurred_at, received_at, outcome{applied,deadletter,rejected}, reason, payload_summary jsonb (minimized, no card/PAN) | belongs_to tenant+billing_connection; refs subscription (nullable); audited | append-only; per-event outcome applied/deadletter/rejected (duplicate never stored) |
| `license` / `customer` / `audit_log` | **reused** (E008/E002, unchanged) | E014 drives `license.status` via E008 lifecycle; audits mutations with the triggering provider_event_id | linked by subscription; log both | — (no schema change) |

**Indexes**: PK `(tenant_id, id)` ×3; UNIQUE `(tenant_id, provider)` on billing_connection; UNIQUE `(tenant_id, provider, external_subscription_id)` + UNIQUE `(tenant_id, license_id)` on subscription; **UNIQUE `(tenant_id, provider, provider_event_id)`** on billing_event (idempotency); partial `subscription_grace (tenant_id, grace_expires_at) WHERE grace_expires_at IS NOT NULL`; `subscription_state (tenant_id, billing_state)`; `billing_event_subscription (tenant_id, subscription_id, occurred_at DESC)`; partial `billing_event_deadletter (tenant_id, received_at) WHERE outcome='deadletter'`; BRIN `billing_event_prune (received_at)`.

**RLS**: `ENABLE`+`FORCE ROW LEVEL SECURITY` on all three; policy `tenant_isolation USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`; `GRANT SELECT,INSERT,UPDATE,DELETE ON billing_connection`, `SELECT,INSERT,UPDATE ON subscription`, `SELECT,INSERT ON billing_event TO licensesrv_app`; secret-excluding `billing_connection_public` view (`security_invoker`).

**Key decisions resolved**: (1) **Secret storage** — envelope-encrypt-at-rest (keystore custody reused from E004) as default, `secretref-file`/`<VAR>_FILE` and KMS as alternate `secret_custody_scheme`s; never plaintext, never API-returned, excluded from the public view; a *lower* custody tier than the Ed25519 signing key **because** the HMAC secret must be readable server-side to verify each webhook (justified vs the no-read/no-export/Shamir signing-key precedent). (2) **Rotation** — two secret columns (`signing_secret_ref` + `signing_secret_prev`) + `secret_rotated_at` bounding an app-config transition window. (3) **Raw payload NOT persisted** — only a minimized, allow-listed `payload_summary jsonb` (no card/PAN/PII), retention-bounded via a BRIN-pruned append-only ledger (FR-018/021). (4) **Idempotency** = the `(tenant_id, provider, provider_event_id)` UNIQUE with `ON CONFLICT DO NOTHING` in-tx; `duplicate` is a response value, never a second stored row. (5) **Grace is an overlay** on `subscription.billing_state` — the E008 `license.status` enum is untouched; billing state drives `active↔suspended`/`→revoked` through the E008 lifecycle.

**Migration**: `migrations/0010_billing.sql` — expand-only, sequential after `0009`: `CREATE TABLE` billing_connection → subscription → billing_event, indexes, `ENABLE`/`FORCE` RLS + `tenant_isolation` policies + grants, `CREATE VIEW billing_connection_public`. No changes to existing tables.
