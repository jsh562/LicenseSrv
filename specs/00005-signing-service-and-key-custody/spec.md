---
feature_branch: "00005-signing-service-and-key-custody"
created: "2026-07-02"
input: "Epic E004 — Signing service and key custody: a signing service with a pluggable signer (encrypted-keystore/soft-HSM default, optional cloud-KMS adapter), per-product Ed25519 keys, the signing-key registry, and overlapping keyring rotation. Never exposes private keys."
spec_type: "technical"
spec_maturity: "draft"
epic_id: "E004"
epic_sources: "{SAD:ADR-0003}{DOD:DDR-3}"
---

# Feature Specification: Signing Service and Key Custody

**Feature Branch**: `00005-signing-service-and-key-custody`  
**Created**: 2026-07-02  
**Status**: Draft  
**Spec Type**: technical  
**Spec Maturity**: draft  
**Epic ID**: E004  
**Epic Sources**: {SAD:ADR-0003}{DOD:DDR-3}

## Problem Statement *(mandatory)*

License forgery is possible only by obtaining a private signing key, so key custody and blast-radius are the platform's central security decisions. Downstream epics — issuance (E008) and air-gapped activation (E010) — need to mint offline-verifiable tokens without ever handling private key material, and the platform must support self-hosted, air-gapped deployments where a mandatory cloud KMS is unacceptable. Without a dedicated signing service that isolates keys per product, hides private material behind a stable interface, and rotates keys without breaking already-issued licenses, a single key compromise would invalidate trust in every license and rotation would force a disruptive flag-day re-issue.

## Scope *(mandatory)*

### Included

- A pluggable **signer interface** that mints tokens in the E001 `LIC1` format, with an encrypted-keystore/soft-HSM default implementation.
- **Per-product Ed25519 keys** and a persisted **signing-key registry** (tenant- and product-scoped) versioned by `key_id`.
- **Overlapping keyring rotation**: rotate a product's active signing key while previously issued licenses remain verifiable.
- **Public keyring publication** (JWKS-style, public keys only) that verifiers/bindings pin per product.
- **Custody & fail-closed operation**: keystore unlock material split via Shamir k-of-n custodians, private keys never returned or logged on any path, signer refuses to operate when it cannot custody keys safely.
- An **optional cloud-KMS / PKCS#11 adapter** behind the same interface (opt-in; self-host default unchanged).

### Excluded

- License issuance, lifecycle, and activation flows — owned by E008/E009/E010; this feature only provides the signer they call.
- The token byte format and offline verification logic — owned by E001; this feature signs into that frozen format, it does not define it.
- Payment/billing, catalog, and admin-console UI — other epics; key management here is exposed via service/API, not a bespoke UI.
- Hardware procurement and cloud-KMS account provisioning — an operator concern; this feature integrates with them but does not provision them.

### Edge Cases & Boundaries

- The signer MUST fail **closed**: if the keystore cannot be unlocked, or a KMS/HSM is unavailable, signing returns a defined error and mints nothing (never a partial or unsigned token).
- A private key MUST NOT appear in application memory as plaintext beyond the custody boundary, in any API response, in logs, or in error/diagnostic output.
- Rotating a product's key MUST NOT invalidate tokens signed by the previous `key_id` within the overlap window; a retired key MUST stop being offered for new signing but remain publishable as trusted until explicitly removed.
- A token signed for product A MUST NOT verify against product B's keyring (blast-radius isolation).
- A compromised key MUST be revocable such that it is removed from the published keyring and never selected for signing, without deleting the audit trail of its existence.
- Loss of custodian shares below the k threshold MUST be a recoverable-by-runbook condition, not silent data loss.

## Technical Objectives *(mandatory for technical specs only)*

### Objective 1 - Pluggable signer interface + default keystore signer (Priority: P1)

A stable signer abstraction that takes signing input in the E001 token format and returns a signed `LIC1` token, with a default implementation that holds the Ed25519 private key in an encrypted keystore / soft-HSM and never surfaces it to callers.

**Why this priority**: Core value and a hard dependency — E008 issuance and E010 air-gap cannot mint any license without it; it is the single forgery-critical component.

**Rationale**: One interface lets issuance and air-gap sign identically while custody implementations vary (keystore, KMS, HSM); centralizing signing keeps private keys behind exactly one boundary.

**Deliverables**:
- A `Signer` interface (sign-token operation keyed by product + active `key_id`; no key-export operation).
- A default encrypted-keystore/soft-HSM signer that loads keys only within the custody boundary.
- Signing that produces tokens verifiable offline by the E001 `verifier-core`, verifying each minted token against the core before returning it (fail-closed on mismatch; TR-018).

**Validation Criteria**:
1. **Given** a product with an active key, **When** a caller requests a signed token for valid claims, **Then** the returned `LIC1` token verifies against that product's public key via `verifier-core`.
2. **Given** any successful or failed signing call, **When** the caller inspects the response, logs, and errors, **Then** no private key bytes appear anywhere.

### Objective 2 - Per-product keys + signing-key registry (Priority: P1)

Per-product Ed25519 key provisioning and a persisted, tenant/product-scoped registry of signing keys versioned by `key_id`, with each key's status and validity window recorded and every lifecycle change audited.

**Why this priority**: Blast-radius isolation (per ADR-0003) and rotation both require distinct, tracked, versioned keys; issuance selects the active key from this registry.

**Rationale**: The registry is the source of truth for which key signs now and which public keys clients should trust; scoping it through the E002 repository keeps it tenant-isolated and audited.

**Deliverables**:
- A `signing_key` entity persisted via the E002 tenant repository under Row-Level Security.
- Per-product key generation producing an Ed25519 keypair with a unique `key_id`.
- Append-only audit entries for key create / rotate / retire / revoke.

**Validation Criteria**:
1. **Given** two products, **When** each provisions a signing key, **Then** each has a distinct `key_id` and a token signed for product A does not verify under product B's key.
2. **Given** a request scoped to tenant A, **When** it lists or uses signing keys, **Then** it can neither read nor use tenant B's keys (repository + RLS).

### Objective 3 - Overlapping keyring rotation + public keyring publication (Priority: P1)

Rotate a product's active signing key so new tokens use a new `key_id` while tokens under the previous `key_id` keep verifying, and publish each product's set of currently-trusted public keys for verifiers/bindings to pin.

**Why this priority**: Rotation-from-day-one (ADR-0003) prevents a disruptive flag-day re-issue and is required before any license is issued; verifiers need the published keyring to trust rotated keys.

**Rationale**: An overlapping keyring (multiple simultaneously-trusted `key_id`s) is what makes zero-downtime rotation possible; publication is how offline verifiers learn the current trust set out of band.

**Deliverables**:
- A rotation operation that marks a new active key and retains prior keys as trusted within an overlap window.
- A public keyring publication surface (JWKS-style; public keys + `key_id` + validity only).
- Revocation that removes a key from the published keyring and from signing selection.

**Validation Criteria**:
1. **Given** a license signed under key_id v1, **When** the product rotates to key_id v2 and re-publishes its keyring, **Then** the old license still verifies and newly signed licenses use v2.
2. **Given** a revoked key, **When** the keyring is published, **Then** the revoked key is absent and is never selected for new signing.

### Objective 4 - Custody, recovery & fail-closed operation (Priority: P1)

Protect the keystore's unlock material with a Shamir k-of-n custodian split, back the keystore up separately from its unlock material, and make the signer fail closed whenever it cannot custody or access keys safely — with no private-key leakage on any path.

**Why this priority**: The signing key is tier-0; safe custody and recovery are non-negotiable, and a signer that fails open would be a forgery vector.

**Rationale**: Splitting unlock material (k-of-n) removes single-point catastrophic loss while enabling recovery; failing closed guarantees the system never emits an unsound or unsigned token under fault.

**Deliverables**:
- Keystore unlock gated by k-of-n custodian shares (Shamir), configurable at deploy time.
- A documented separation of keystore backup from unlock-material backup.
- Fail-closed signing behavior on unlock failure or signer/KMS unavailability, returning a defined error.

**Validation Criteria**:
1. **Given** fewer than k custodian shares presented, **When** the signer starts, **Then** it does not unlock, signs nothing, and returns a defined fail-closed error.
2. **Given** the signer backend is unavailable, **When** a signing request arrives, **Then** it is refused with a defined error and no unsigned/partial token is emitted, and no key material is logged.

### Objective 5 - Optional cloud-KMS / PKCS#11 adapter (Priority: P2)

A cloud-KMS / PKCS#11 signer adapter behind the same `Signer` interface, selectable by configuration, so managed-cloud or hardware custody is available without changing any caller and without making cloud a requirement.

**Why this priority**: Significant for managed-cloud/enterprise custody, but the self-host MVP is fully served by the default keystore signer, so it is not required for the P1 gate.

**Rationale**: A pluggable adapter (DDR-003) lets deployments choose hardware/cloud custody while preserving the self-host/air-gap default; keeping it behind the same interface prevents caller divergence.

**Deliverables**:
- A cloud-KMS/PKCS#11 adapter implementing the `Signer` interface (sign-only; no key export).
- Configuration-driven signer selection (default keystore vs. KMS/PKCS#11).

**Validation Criteria**:
1. **Given** issuance code written against the `Signer` interface, **When** the deployment switches from the keystore signer to the KMS/PKCS#11 adapter, **Then** issuance requires no code change and still produces verifiable tokens.
2. **Given** the KMS/PKCS#11 adapter, **When** a token is signed, **Then** the private key never leaves the KMS/HSM boundary and no export path exists.

### Technical Constraints

- Signing MUST use Ed25519 and emit tokens in E001's frozen `LIC1` format; the signer does not define or alter the format.
- Private keys MUST NOT be returned by any API, logged, or held in application memory as plaintext outside the custody boundary.
- Signing is tier-0; the issuance path (E008) targets p95 < 300 ms including the signer span (DOD). Caching/pre-issue to decouple from momentary backend latency is **advisory** (an E008 issuance-path strategy), not a tracked deliverable of this feature. The per-token conformance verify (TR-018) runs on the signing path; the Plan MUST confirm it fits the p95 budget or moves it pre-issue.
- The default signer MUST work fully offline / self-hosted with no cloud dependency; cloud KMS is opt-in only.
- All key persistence MUST go through the E002 tenant repository under RLS; all key lifecycle events MUST be audited (append-only).

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: The signer depends on **E001 `verifier-core`** for the `LIC1` token format and signing input; tokens it mints MUST verify offline via the core, and the published per-product public keyring MUST be consumable as the core's pinned `Keyring` (by `key_id`).
- **IP-002**: The signing-key registry depends on **E002 tenant data layer** — `signing_key` rows persist via the tenant repository under Row-Level Security, and key lifecycle events write to the append-only audit log.
- **IP-003**: **E008 license issuance** depends on this feature's `Signer` interface to sign issued licenses; the interface contract is owned here and MUST NOT be forked by callers.
- **IP-004**: **E010 air-gapped activation** depends on the `Signer` interface to sign response files.
- **IP-005**: The published public keyring depends on a distribution surface (JWKS-style endpoint/artifact) consumed by **E003 bindings / E001 clients** to pin trusted keys out of band.
- **IP-006**: Keystore unlock material and signer configuration depend on the **runtime config/secrets contract (E006)** — injected via env/secret files at runtime, never baked into an image.
- **IP-007**: The signing-key registry references a **product** identity owned by **E007 catalog** (`product_id`); the `product` table and its hard composite FK are introduced by E007, so this feature treats product identity as an external scope key (FK deferred, integrity held by the repository + RLS until E007 lands).

## Requirements *(mandatory)*

### Technical Requirements *(technical specs only)*

- **TR-001**: System MUST expose a `Signer` interface whose only key-using operation signs a token in the E001 `LIC1` format; the interface MUST NOT define or offer any private-key export or read operation (interface shape — runtime key-material non-leakage is governed by TR-010).
- **TR-002**: System MUST provide a default signer that holds Ed25519 private keys in an encrypted keystore / soft-HSM and loads them only within the custody boundary.
- **TR-003**: System MUST generate a distinct per-product Ed25519 keypair, each identified by a unique `key_id`.
- **TR-004**: System MUST persist signing keys in a `signing_key` registry via the E002 tenant repository, scoped by tenant and product and protected by Row-Level Security.
- **TR-005**: System MUST record, for each signing key, its `key_id`, algorithm, public key, status (active / rotating / retired / revoked), and validity window.
- **TR-006**: System MUST select a product's current **active** key when signing and stamp the token's `key_id` accordingly.
- **TR-007**: System MUST support keyring rotation that activates a new `key_id` while retaining previous keys as trusted within an overlap window, so licenses signed under a prior key remain verifiable.
- **TR-008**: System MUST publish each product's set of currently-trusted public keys (public key + `key_id` + validity only, JWKS-style) for out-of-band verifier pinning.
- **TR-009**: System MUST support revoking a key such that it is removed from the published keyring and never selected for signing, while preserving its audit history.
- **TR-010**: System MUST NOT return, log, or expose private key material on any path, including success responses, error responses, and diagnostics.
- **TR-011**: System MUST fail closed — when the keystore cannot be unlocked or the signing backend is unavailable, signing MUST return a defined error and emit no unsigned or partial token (the precise success/error output contract is defined by TR-018).
- **TR-012**: System MUST gate keystore unlock behind a Shamir k-of-n custodian share threshold configurable at deploy time.
- **TR-013**: System MUST keep the keystore backup separate from its unlock material so neither alone is sufficient to recover a key.
- **TR-014**: System MUST write an append-only audit entry for every key lifecycle event (create, rotate, retire, revoke).
- **TR-015**: System MUST ensure a token signed for one product does not verify against another product's keyring (per-product isolation).
- **TR-016**: System MUST provide an optional cloud-KMS / PKCS#11 signer adapter implementing the same `Signer` interface, selectable by configuration, with the private key never leaving the KMS/HSM boundary. *(P2)*
- **TR-017**: System MUST allow switching signer implementations by configuration without any change to issuance/air-gap callers.
- **TR-018**: The signer MUST return, on any signing call, exactly one of: (a) a complete `LIC1` token that has passed conformance verification against the E001 `verifier-core` **before it is returned**, or (b) a defined error carrying **zero token bytes** (fault triggers per TR-011). Any other output — assembled-but-unsigned, signed-but-not-conformance-verified, or truncated — is an unacceptable partial/unsound output and MUST NOT be returned. *(Note: this sharpens TR-011's "no unsigned or partial token" into a testable output contract; a partial-token test traces here.)*
- **TR-019**: System MUST govern the `retired` key state and the key status machine: a `retired` key MUST NOT be selected for new signing but MUST remain publishable as trusted until explicitly removed, following `active → rotating → retired → removed` (with `any → revoked` as a terminal, audit-retained state). The rotation overlap window (how long a superseded key stays trusted before retirement/removal) MUST be operator-configurable and bounded (time- or count-based), never open-ended, so TR-007 is testable.

### Key Entities *(include for product or technical specs if feature involves data)*

- **signing_key**: A product's Ed25519 signing key record — `key_id`, tenant, product, algorithm, public key, status (active/rotating/retired/revoked), validity window, created-at. The private key is held only in custody (keystore/KMS), never in this record.
- **product keyring**: The set of a product's currently-trusted public keys (one or more `key_id`s during a rotation overlap), published for verifiers to pin.
- **custodian share**: One Shamir share of the keystore unlock material; k of n shares are required to unlock.
- **product**: The trust unit that owns a signing key (referenced from E007 catalog; here it is the scope key for signing and the keyring).

## Assumptions & Risks *(mandatory)*

### Assumptions

- E001's `LIC1` token format and signing input are frozen and stable for the signer to target.
- E002's tenant repository, Row-Level Security, and append-only audit log are available for persistence and audit.
- Operators can supply custodian shares (and, for the optional adapter, KMS/PKCS#11 credentials) out of band via the runtime secrets contract.
- Each product maps to exactly one active signing key at a time, with additional keys trusted only during rotation overlap.

### Risks

- **Signing backend unavailability blocks issuance** *(likelihood: medium, impact: high)*: signing is tier-0; a keystore/KMS outage halts issuance — mitigate with fail-closed behavior plus caching/pre-issue and documented availability handling.
- **Custodian share loss** *(likelihood: low, impact: high)*: losing shares below k could strand a key — mitigate with separate backups, a key-recovery runbook, and n > k redundancy.
- **Signer interface divergence** *(likelihood: medium, impact: medium)*: E008/E010 could fork the signer contract — mitigate by owning the interface here and treating changes as coordinated/breaking.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `signing_key` registry entity (and its relation to product/keyring).
- `MIGRATION` — `signing_key` table, tenant/product-scoped indexes, and Row-Level Security policies added via expand-only migration on the E002 schema.
- `NEW-CONFIG` — signer selection (keystore vs. KMS/PKCS#11), keystore/unlock configuration, Shamir k-of-n custodian shares, rotation/overlap settings.
- `NEW-API` — internal `Signer` interface consumed by issuance/air-gap, plus a public keyring (JWKS-style) publication surface.
- `EXTERNAL-SERVICE` — optional cloud-KMS / PKCS#11 backend for the adapter signer (P2).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A token minted by the default signer verifies offline via `verifier-core`, and no private key material appears in the sign response, logs, or errors for that operation.
- **SC-002** [OBJ2]: Two products provisioned with their own keys have distinct `key_id`s, and a token signed for product A fails verification under product B's key (blast-radius isolation) while a token signed for A verifies under A's key.
- **SC-003** [OBJ2]: A signing-key operation scoped to tenant A cannot read or use tenant B's keys, and every key lifecycle event produces an append-only audit entry with actor, action, and target.
- **SC-004** [OBJ3]: After a product rotates from `key_id` v1 to v2 and re-publishes its keyring, a license signed under v1 still verifies and newly signed licenses carry v2 — with no reissue of the v1 license.
- **SC-005** [OBJ3]: After a key is revoked, the published keyring no longer contains it and no new token is ever signed with it.
- **SC-006** [OBJ4]: With fewer than k custodian shares the signer does not unlock and signs nothing (fail-closed); with the signing backend unavailable, a signing request is refused with a defined error, emitting no partial/unsigned token and no key material in logs.
- **SC-007** [OBJ5]: Switching the deployment from the keystore signer to the cloud-KMS/PKCS#11 adapter requires no change to issuance/air-gap callers and still yields tokens that verify offline. *(P2)*
- **SC-008** [OBJ4]: Neither the keystore backup nor the unlock-material (custodian-share) backup alone can reconstruct a private key — recovery requires both, as verified against the key-recovery runbook (TR-013).

## Compliance Check

Audited against project-instructions.md v1.1.0, ADR-0003, and DDR-003. **Result: PASS** (no CRITICAL violations).

- Principle I (Offline-First): PASS — keystore/soft-HSM default works fully offline/air-gapped; cloud KMS opt-in and P2-gated (TR-002, TR-016, Technical Constraints).
- Principle II (Multi-Tenant Isolation): PASS — signing keys tenant+product-scoped under RLS via the E002 repo; cross-tenant read/use denied (TR-004, SC-003, IP-002).
- Principle III (Single Core, Audited): PASS — signs into E001's frozen `LIC1` with Ed25519 without redefining the format or verification crypto; produced tokens validated via `verifier-core`; all key lifecycle events append-only audited (TR-001, TR-014, SC-001, SC-003).
- Security Requirements: PASS — private keys never returned/exported/logged/in-plaintext-memory, fail-closed, per-product blast-radius isolation, rotatable `key_id` keyring (TR-001, TR-010, TR-011, TR-015).
- ADR-0003: PASS — per-product Ed25519 keys, keystore/KMS custody, overlapping `key_id` rotation, never exposed.
- DDR-003: PASS — pluggable signer, encrypted-keystore/soft-HSM default, optional cloud-KMS/PKCS#11 adapter, Shamir k-of-n custody with backup separated from unlock material (TR-002, TR-012, TR-013, TR-016).
- Traceability: PASS — TR-001…019 and IP-001…007 all homed; no contradiction with E001 (`LIC1`/keyring) or E002 (RLS/audit) contracts.

Non-blocking notes to carry into Plan: DDR cited as `DDR-3` vs the DOD's `DDR-003` (cosmetic, matches the project-plan shorthand); the signer's runtime home (Node/TS `/src/server`) is implied, not stated (plan-phase detail); revocation is modeled as omission from the published keyring — reconcile with E001's per-key `revoked` flag when mapping IP-001 in Plan. TR-013 (keystore backup separate from unlock material) is inspection-type — add an explicit recovery-runbook verification step in Tasks.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Signer | The interface (and its implementations) that mints a signed `LIC1` token for a product without exposing the private key. |
| key_id | The identifier of a specific signing key version, stamped into each token and used by verifiers to select the trusted public key. |
| Keyring rotation | Activating a new signing key while keeping prior keys simultaneously trusted, so already-issued licenses keep verifying (zero-downtime). |
| Public keyring (JWKS) | The published set of a product's currently-trusted public keys (public material + `key_id` + validity only) that verifiers pin out of band. |
| Soft-HSM / encrypted keystore | A software key store that holds private keys encrypted at rest, unlocked at runtime, providing hardware-like custody without a cloud dependency. |
| Shamir k-of-n | A secret-sharing scheme splitting the keystore unlock material into n custodian shares, any k of which reconstruct it. |
| Fail closed | On any custody/availability fault the signer refuses to sign rather than emitting an unsound or unsigned token. |
