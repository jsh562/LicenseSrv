# Data Model: License Server

> Feature 00001-license-server | 2026-06-26 | PostgreSQL 16, tenant-scoped. Every tenant-owned table carries `tenant_id` (FK → tenant) and is filtered by the repository layer + Row-Level Security (ADR-0004).

## Conventions

- PKs are UUID v7 (`id`). Timestamps are `timestamptz` (UTC).
- Secret-bearing values stored as hashes only: `key_hash`, `api_key_hash`, `fingerprint_hash`, `external_ref` (salted SHA-256).
- Soft state via `status` enums; hard deletes only for GDPR erase (FR-022).

## Entities

### tenant
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| name | text | |
| created_at | timestamptz | |

### user / role (RBAC — console humans, FR-028)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK | |
| email | citext unique-per-tenant | |
| password_hash | text | argon2id |
| role | enum(owner, admin, viewer) | RBAC scope |

### api_key (runtime/machine auth, FR-018)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK | |
| api_key_hash | text | HMAC lookup + hash |
| scopes | text[] | e.g. activate, validate, admin |
| created_at, revoked_at | timestamptz | |

### product
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK | |
| name | text | |
| signing_key_id | uuid FK → signing_key | active key (per-product, ADR-0003) |

### signing_key (FR-011, FR-029)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id, product_id | uuid FK | |
| key_id | text | short id embedded in tokens, selects keyring entry |
| public_key | bytea | Ed25519 public |
| kms_ref | text | KMS key handle; private key never stored here |
| status | enum(active, retiring, retired) | rotation overlap |
| created_at, retired_at | timestamptz | |

### plan (policy)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id, product_id | uuid FK | |
| name | text | |
| model | enum(node_locked, subscription, perpetual, trial) | |
| max_activations | int default 1 | FR-031 |
| expiry_kind | enum(none, fixed, duration) | perpetual = none |
| duration_days | int null | for subscription/trial |
| trial_days | int null | |
| max_version | text null | upgrade entitlement |
| maintenance_until | timestamptz null | |
| transfer_limit | int default 3 | FR-007 |

### entitlement (definition) + plan_entitlement
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id, product_id | uuid FK | |
| key | text | e.g. `export_pdf`, `max_projects` |
| type | enum(bool, int) | FR-002 |
| default_value | jsonb | |
| plan_entitlement(plan_id, entitlement_id, value) | | per-plan value; license may override |

### customer
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK | |
| external_ref | text | hashed/pseudonymous (FR-022) |

### license
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id, product_id, plan_id, customer_id | uuid FK | |
| key_hash | text | hash of issued key (lookup) |
| status | enum(active, suspended, revoked, expired) | |
| issued_at, expires_at | timestamptz | expires_at null = perpetual |
| max_version, maintenance_until | | snapshot from plan, overridable |
| entitlement_overrides | jsonb | per-license overrides |
| transfer_count | int default 0 | enforce transfer_limit |

### activation (machine)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id, license_id | uuid FK | |
| fingerprint_hash | text | salted hash of 5 signals (FR-015) |
| fingerprint_signals | jsonb | per-signal hashes for 3-of-5 match |
| status | enum(active, deactivated) | |
| token_id | uuid | last issued token |
| activated_at, last_seen_at | timestamptz | |

Unique partial index `(license_id, fingerprint_hash) where status='active'`; seat cap enforced via `SELECT … FOR UPDATE` count vs `plan.max_activations` (FR-013, race-safe).

### audit_log (append-only, FR-020)
| Field | Type | Notes |
|-------|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK | |
| actor | text | user/api_key/system |
| action | text | e.g. license.issued, license.revoked |
| target | text | entity id |
| before, after | jsonb null | |
| ts | timestamptz | |

No UPDATE/DELETE grants; insert-only. Optional hash-chain (`prev_hash`) for tamper-evidence.

### P2/P3 (deferred)
- `lease` (floating seats, FR-025), `revocation` + CRL (FR-023), `usage_event` (FR-026, idempotency_key unique), `webhook` (FR-024), `policy_rule` (FR-027).

## State Transitions

**license.status**: `active → suspended` (payment/admin) → `active` (reinstate) ; `active|suspended → revoked` (terminal) ; `active → expired` (time). Revoked/suspended block new activations and renewal (FR-006).

**activation.status**: `active → deactivated` (frees seat, FR-014). Reactivation creates a new row or flips back within transfer_limit.

## Validation Rules

- `plan.max_activations ≥ 1`; default 1 when unspecified (FR-031).
- `trial` plans: at most one `active` license per `(product_id, fingerprint_hash)` (FR-031 trial dedup).
- `transfer_count ≤ plan.transfer_limit` before a transfer succeeds (FR-007).
- Every write asserts `tenant_id` equals the caller's tenant (repository guard + RLS).
