---
feature_branch: "00011-air-gapped-activation"
created: "2026-07-15"
input: "E010"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E010"
epic_sources: "{PRD:CAP-006}"
---

# Feature Specification: Air-Gapped Activation

**Feature Branch**: `00011-air-gapped-activation`
**Created**: 2026-07-15
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E010
**Epic Sources**: {PRD:CAP-006}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Many high-security customers — defense, industrial control, OT, and classified networks — run software on
fully air-gapped machines that will never touch a network. E009's online activation cannot reach them, so
those machines can neither bind a license nor consume a seat, leaving an entire class of customers unable to
activate at all. This feature adds an offline activation path: the air-gapped machine produces a request file,
an operator carries it to an online portal that processes it (consuming a seat and signing a machine-bound
credential), and carries the signed response file back to import — after which the license verifies fully
offline, with no network ever touching the air-gapped machine.

## Scope *(mandatory)*

### Included

- A versioned, portable **request-file format** the offline client produces (a license reference + the machine
  fingerprint as salted signal hashes + a single-use nonce + a produced-at timestamp) and the server parses.
- An authenticated online **portal operation** that ingests a request file, activates the machine through the
  shared E009 seat accounting (race-safe seat cap, K-of-N binding, nonce store-and-replay), and returns a
  signed **response file**.
- A versioned, tamper-evident **response-file format** carrying the machine-bound credential that verifies
  offline via the E001 verifier core.
- Idempotent re-processing of the same request file (by its nonce) — replays the original response, no second
  seat.
- Fail-closed refusals (seat-limit, malformed / stale / unknown-version request, non-active license) that
  return no response file, each with a distinct reason.
- Visibility of air-gap activations in the same E009 activation registry (tenant-scoped, audited).

### Excluded

- Air-gap **deactivation** via file exchange — a dead air-gapped machine's seat is reclaimed by the operator
  through the E009 console reclaim; a deactivation-request-file flow is future.
- The client SDK's internal file production/import/verify logic (E003 bindings / E018) — this epic defines the
  file formats + the server portal; the SDK implements the offline produce/import against them.
- Online validation, heartbeat, and revocation propagation (E013); floating/concurrent seats (E015).
- Emergency CRL / revocation-list file distribution (E013).
- A second activation code path — air-gap reuses the E009 activation service; it adds a file transport +
  formats, not a parallel seat model.

### Edge Cases & Boundaries

- Seats full → the portal refuses with a distinct reason and returns no response file; no seat consumed.
- Same request file re-processed (same nonce) → returns the original response file; no additional seat.
- Malformed, truncated, or unknown-format-version request file → refused with a distinct reason; nothing
  processed (no partial activation).
- Stale request file (produced-at older than the configured freshness window) → refused with a distinct reason.
- Non-active (suspended / revoked / expired) license referenced, or fewer than the minimum fingerprint signals
  → refused; no seat consumed.
- Tampered or wrong-machine response file → rejected at import (the offline verify fails on the bound machine).
- Cross-tenant: a request file referencing another tenant's license under the operator's credential → refused
  / not found.
- The air-gapped machine performs zero network I/O during produce and import — both are pure file operations.

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Activate an air-gapped machine via signed file exchange (Priority: P1) 🎯 MVP

An operator on a fully offline machine produces a request file with the licensed app/SDK, carries it (for
example on a USB stick) to a connected machine, submits it to the online portal, receives a signed response
file, carries it back, and imports it — after which the license is active and verifies offline on that machine
with no network.

**Why this priority**: Core value — without it, air-gapped customers (a first-class market for
high-security / OT / defense software) cannot activate at all.

**Independent Test**: On an isolated machine, produce a request file for an active license; process it through
the portal on a connected machine; import the response file back; confirm the credential verifies offline with
zero network on the isolated machine.

**Acceptance Scenarios**:

1. **Given** an active license and an offline machine, **When** the operator produces a request file and
   submits it to the portal, **Then** the portal returns a signed response file.
2. **Given** the signed response file, **When** the operator imports it on the originating offline machine,
   **Then** the license is active and the machine-bound credential verifies offline (zero network).
3. **Given** the whole exchange, **When** produce and import run on the air-gapped machine, **Then** that
   machine makes no network call at any point.

### User Story 2 - Air-gap activation consumes a seat, idempotently (Priority: P1) 🎯 MVP

Processing a request file must count against the license's seats exactly like an online activation — one seat
per machine, never over the limit — and re-processing the same request file must not consume a second seat.

**Why this priority**: Air-gap must not be a seat-limit bypass; the epic requires it to consume a seat in the
same accounting as online activation.

**Independent Test**: Process request files for distinct machines up to a 2-seat license's limit; the next
distinct-machine request is refused with no response file; re-processing an already-processed request file
returns the original response and does not change the seat count.

**Acceptance Scenarios**:

1. **Given** an active license with a free seat, **When** a request file is processed, **Then** exactly one
   seat is consumed and the activation appears in the registry alongside online activations.
2. **Given** a license whose seats are full, **When** a new distinct-machine request file is processed,
   **Then** it is refused with a distinct reason, no response file is returned, and no seat is consumed.
3. **Given** an already-processed request file, **When** it is submitted again, **Then** the original response
   file is returned and no additional seat is consumed.

### User Story 3 - Tamper-evident files and fail-closed validation (Priority: P1) 🎯 MVP

The response file must be signed so the offline client can trust it came from the vendor and wasn't altered,
and it must activate only its intended machine; the portal must reject malformed, stale, unknown-version, or
replayed request files with clear reasons.

**Why this priority**: Offline trust rests entirely on file integrity — a forgeable or mis-targeted response
file would defeat licensing, and unvalidated request files invite abuse.

**Independent Test**: Verify a response file imports and verifies offline; then tamper with it (or present it
on a different machine) and confirm import rejects it; submit a malformed / stale / unknown-version request
file and confirm each is refused with a distinct reason.

**Acceptance Scenarios**:

1. **Given** a signed response file, **When** it is altered or presented on a machine whose fingerprint
   doesn't match, **Then** the offline import/verify rejects it.
2. **Given** a malformed, truncated, or unknown-format-version request file, **When** it is submitted,
   **Then** the portal refuses it with a distinct reason and processes nothing.
3. **Given** a request file older than the freshness window, or referencing a non-active license, **When** it
   is submitted, **Then** it is refused with a distinct reason and no seat is consumed.

### User Story 4 - Process an air-gap request from the console (Priority: P2)

A vendor support operator processes a customer's request file through the admin console — upload the request
file, download the signed response file — for customers who cannot reach the portal endpoint directly.

**Why this priority**: A convenience over the authenticated portal endpoint; the MVP works via that endpoint.
Enhances vendor support workflows but is not required for air-gap activation itself.

**Independent Test**: An admin uploads a request file in the console and downloads the resulting response file;
a viewer cannot.

**Acceptance Scenarios**:

1. **Given** an admin in the console, **When** they upload a valid request file, **Then** they can download the
   signed response file and the seat is consumed.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST define a versioned, portable request-file format carrying a license reference (key or
  id), the machine fingerprint as salted signal hashes, a single-use nonce, and a produced-at timestamp, and
  MUST reject a file whose format version is unknown.
- **FR-002**: System MUST expose an authenticated online portal operation that ingests a request file and
  returns a signed response file (or a distinct refusal), authenticated by an `activate`-scope API key (E005).
- **FR-003**: System MUST process a request file by activating the machine through the shared E009 activation
  accounting — consuming a seat, enforcing the seat limit race-safely, binding the K-of-N fingerprint — so an
  air-gap activation is indistinguishable from an online one in the seat count and the registry.
- **FR-004**: System MUST refuse to process a request file when the license's seats are full, returning a
  distinct reason and no response file, and consuming no seat.
- **FR-005**: System MUST make request-file processing idempotent by its single-use nonce: re-submitting the
  same request file returns the original response file and consumes no additional seat; a nonce reused to forge
  a different activation is refused.
- **FR-006**: System MUST produce a signed, tamper-evident response file carrying the machine-bound credential
  such that the offline client verifies it fully offline (zero network) via the E001 verifier core and only on
  the bound machine.
- **FR-007**: System MUST refuse a malformed, truncated, or unknown-format-version request file with a distinct
  reason, processing nothing (fail-closed — no partial activation).
- **FR-008**: System MUST refuse a request file whose produced-at timestamp is older than a configured
  freshness window, with a distinct reason.
- **FR-009**: System MUST refuse a request file that references a suspended, revoked, or expired license, or
  reports fewer than the minimum required fingerprint signals, with a distinct reason and no seat consumed.
- **FR-010**: System MUST store and log only salted fingerprint hashes / pseudonymous machine identity from the
  request and response files — never raw hardware identifiers, in files, storage, or logs.
- **FR-011**: System MUST isolate air-gap processing by tenant, fail-closed: a request file referencing another
  tenant's license under the operator's credential is refused / not found, and air-gap activations are visible
  only within their tenant's registry.
- **FR-012**: System MUST record an append-only audit entry for every air-gap request processed — activation,
  idempotent replay, and each refusal — capturing actor, action, and reason without raw hardware identifiers or
  secrets.
- **FR-013**: System MUST rate-limit the air-gap portal operation to deter abuse, reusing the runtime
  rate-limit posture (E009).
- **FR-014**: System MUST version both the request and response file formats and reject a cross-version or
  unknown-version mismatch, so the client SDK and server evolve compatibly.
- **FR-015**: System SHOULD let an admin process a request file and obtain the response file through the
  console (upload / download), behind console RBAC. *(P2 — deferred; not required for the MVP.)*
- **FR-016**: System MUST make the response credential verifiable against the product's pinned public keyring
  (published by E004 and distributed with the client SDK), with no network re-check; the response file's
  `keyId` selects the keyring entry so a credential signed by a rotated key still verifies offline, and the
  E004 overlapping keyring keeps credentials signed by a prior key valid through rotation. The key identifier
  that selects the keyring entry lives inside the signed credential (the offline verifier uses that); the
  response envelope may also surface it as informational metadata. This epic defines no new key-distribution
  mechanism.
- **FR-017**: System MUST never expose private signing-key material in the request file, the response file, the
  response envelope, storage, logs, or audit entries — the response file carries only the public machine-bound
  credential plus an opaque `keyId`; signing stays in the E004 signer.
- **FR-018**: System MUST treat the request file under an honest-client threat model — the operator fully
  controls it, so no request-supplied claim is trusted for security; every invariant is enforced server-side at
  processing: the license reference is resolved within the tenant, the fingerprint is matched by the K-of-N
  tolerance, the nonce is checked against the store, and the seat cap is enforced race-safely — none is trusted
  verbatim from the file.
- **FR-019**: System MUST bound the request file to a configured maximum size and refuse an oversize file (an
  oversize / decompression guard) before decoding, with a distinct `validation_error` refusal
  (`details.reason = oversize`), consuming no seat.
- **FR-020**: System MUST apply configurable, quantified security defaults: a request freshness window (default
  7 days), a single-use nonce of at least 128-bit entropy, and a minimum fingerprint signal count equal to the
  E009 K-of-N threshold (default 3). Values are configurable (see Implementation Signals `NEW-CONFIG`).
- **FR-021**: System MUST retain a used nonce via its persisted activation record so idempotent replay and
  nonce-replay rejection hold for the life of the activation, even after the freshness window has elapsed; the
  freshness window gates only the FIRST processing of a not-yet-seen request file — an already-processed request
  file always replays its original response (or is refused `nonce_replayed`) regardless of its age, so the two
  anti-replay controls cannot contradict.
- **FR-022**: System MUST ensure the machine-bound credential the response file carries bounds its own expiry
  to the lesser of the license expiry and the activation credential TTL (per E009), enforced OFFLINE by the
  E001 verifier core against the machine's local clock (the response envelope may also surface this expiry as
  informational metadata); air-gapped clock drift is an accepted offline tradeoff (as documented in E009),
  since no network time check is available.
- **FR-023**: System MUST fail closed when the E004 signer is unavailable — the transaction rolls back, no seat
  is consumed and no activation row is persisted, no response file is returned, and the request is refused
  `503 signer_unavailable`; the operator MAY re-submit the same request file (idempotent).
- **FR-024**: System MUST scope the single-use activation nonce per tenant across ALL activation transports —
  the air-gap path shares the SAME E009 activation nonce store as online activation and adds NO separate nonce
  namespace. A nonce already consumed by an online E009 activation and then presented in an air-gap request file
  (or the reverse) is handled consistently by the shared store: it replays to its original activation
  (`created:false`) or is refused `nonce_replayed` if reused to forge a different activation, and can never be
  double-spent into a second seat.
- **FR-025**: System MUST handle an air-gap re-import whose fingerprint re-matches an existing active machine
  within the E009 K-of-N drift tolerance identically to the online path: it reuses the SAME activation seat (NO
  new seat consumed) and returns `created:false` with a REFRESHED response file re-packaging the machine-bound
  credential for the current fingerprint. This is distinct from the same-request-file idempotent replay
  (FR-005), which re-returns the BYTE-IDENTICAL original response for the SAME nonce — a drift re-import presents
  a NEW nonce, so it is not a nonce replay, yet still consumes no additional seat.
- **FR-026**: System MUST record air-gap provenance SOLELY in the append-only audit log (the `airgap.activated`
  action, FR-012); the E009 activation row, seat count, and registry intentionally carry NO origin marker
  distinguishing air-gap from online (FR-003). The absence of an origin field on the activation row
  is a deliberate decision — "appears in the same registry" (SC-003) is satisfied precisely because the row is
  the same shape as an online bind, and origin auditability is preserved through the audit log rather than the
  data model. No data-model change and no migration.
- **FR-027**: System MUST treat air-gap-originated activation rows and their salted fingerprint hashes /
  pseudonymous `machineId` as the SAME E009 activation records for data retention and GDPR erasure — they fall
  under the E009 retention and erasure path with NO separate air-gap handling or lifecycle, so erasing or
  retaining an activation covers air-gap-originated rows identically to online ones.
- **FR-028**: System MUST leave NO activation row and NO partial seat on ANY refusal — seat full, non-active
  license, stale, malformed, unknown-version, too-few-signals, oversize, or signer-unavailable. File-layer
  validation (the oversize guard, decode, format-version, freshness, structure) runs BEFORE the E009
  seat-consuming transaction, so a file-layer refusal never reaches the seat-consuming step; seat reservation,
  credential signing, and activation-row insert all run inside that single E009 transaction and roll back
  atomically on any business refusal or signer fault (FR-023). No refusal — file-layer or business — can persist
  a partial or duplicated activation.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Air-gap request file** (value): a versioned, portable envelope carrying a license reference, the machine
  fingerprint (salted signal hashes) + optional label, a single-use nonce, and a produced-at timestamp.
  Client-produced offline; never persisted raw; carries no raw hardware identifiers.
- **Air-gap response file** (value): a versioned, signed, tamper-evident envelope carrying the machine-bound
  credential (the E001-verifiable LIC1 token, Ed25519-signed by E004) plus activation metadata (activation id,
  expiry, key id). Self-contained — verifies offline against the pinned public key with no callback.
- **Activation** (E009, consumed): the persisted seat binding; the air-gap path creates or updates the SAME
  activation record as the online path (seat count, registry, audit) — there is no separate air-gap entity.
- **License** (E008) / **signing_key** (E004): the license must be active to process; the response credential
  is signed by the product's active key.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The client SDK (E003 bindings / E018) implements the offline produce (request file) and import/verify
  (response file) against the formats this epic defines; this epic delivers the formats + the server portal,
  not the SDK internals.
- Air-gap processing reuses the E009 activation service (seat accounting, K-of-N, nonce store-and-replay) — it
  is a file transport over the same activation, not a second seat model.
- The response file's tamper-evidence is the Ed25519 signature on the embedded machine-bound credential,
  verified offline by the E001 core against a pinned public key.
- The operator reaches the online portal with an `activate`-scope API key (E005), the same runtime credential
  the online activation uses.
- Reclaiming a dead air-gapped machine's seat is operator/console-driven via the E009 reclaim (the offline
  machine cannot phone home).

### Risks

- **File-format drift** *(likelihood: medium, impact: high)*: an SDK/server format mismatch could break
  exchange — mitigated by explicit format versioning and rejecting unknown/cross versions (FR-001/007/014).
- **Request-file hoarding/replay** *(likelihood: medium, impact: medium)*: an operator could stockpile or
  replay request files — mitigated by the single-use nonce (idempotent replay, no extra seat) plus an optional
  freshness window (FR-005/008).
- **Air-gap seat exhaustion** *(likelihood: low, impact: medium)*: many request files could attempt to fill
  seats — bounded by the shared seat cap (FR-003/004) and rate limiting (FR-013); dead-seat reclaim is
  operator-driven (accepted tradeoff).

## Implementation Signals *(mandatory)*

- `NEW-API` — the air-gap portal operation (ingest request file → signed response file), API-key `activate`
  scope; reuses the E009 activation service (no second seat model).
- `NEW-CONFIG` — request-file freshness window, request/response format versions, air-gap rate limits,
  minimum fingerprint signal count, maximum request-file size.
- `NEW-UI` — (P2, deferred) a console air-gap processing view (admin upload/download).
- No new persisted entity — air-gap reuses the E009 `activation` table; the request/response files are
  transient value objects.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An operator activates a fully offline machine by producing a request file, exchanging it
  via the online portal, and importing the signed response file; the machine-bound credential then verifies
  offline (zero network) on that machine.
- **SC-002** [US1]: During produce and import, the air-gapped machine makes no network call.
- **SC-003** [US2]: Processing a request file consumes exactly one seat via the shared accounting, and the
  resulting activation appears in the same registry as online activations.
- **SC-004** [US2]: When the license's seats are full, the portal refuses the request with a distinct reason
  and returns no response file; no seat is consumed.
- **SC-005** [US2]: Re-processing an already-processed request file returns the original response file and
  consumes no additional seat.
- **SC-006** [US3]: A tampered response file, or a response file presented on a machine whose fingerprint
  doesn't match, is rejected at import.
- **SC-007** [US3]: A malformed, truncated, oversize, or unknown-format-version request file is refused with a
  distinct reason and nothing is processed.
- **SC-008** [US3]: A request file older than the freshness window, or referencing a non-active license, is
  refused with a distinct reason and no seat consumed.
- **SC-009** [US2]: No request file, response file, stored record, or log entry exposes a raw hardware
  identifier — only salted hashes / pseudonymous machine identity.
- **SC-010** [US2]: An air-gap activation is tenant-isolated — a request under one tenant's credential can only
  activate that tenant's license, and its activation is visible only in that tenant's registry.
- **SC-011** [US3]: Every air-gap request — activation, idempotent replay, and each refusal — is recorded as an
  append-only audit entry with no raw hardware identifiers or secrets.
- **SC-012** [US2]: Air-gap portal submissions beyond the configured rate are refused with a distinct reason
  and the throttled attempt is audited (FR-013).
- **SC-013** [US3]: An oversize request file is refused before any processing, with a distinct reason and no
  seat consumed (FR-019).
- **SC-014** [US1]: No request file, response file, stored record, log, or audit entry contains private
  signing-key material — only the public machine-bound credential and its key identifier (FR-017).
- **SC-015** [US3]: When the signer is unavailable, the request is refused and no seat is consumed and no
  activation is recorded; re-submitting the same request file later succeeds unchanged (FR-023).
- **SC-016** [US2]: A nonce already consumed by an online activation cannot be reused by an air-gap request
  file to obtain a second seat (and the reverse) — the two transports share one activation nonce (FR-024).
- **SC-017** [US2]: An air-gap re-import whose fingerprint still matches an existing machine (minor drift)
  reuses the same seat and returns a refreshed response file — no additional seat is consumed (FR-025).
- **SC-018** [US1]: The machine-bound credential's effective expiry is never later than the sooner of the
  license expiry and the configured credential lifetime (FR-022).
- **SC-019** [US1]: A credential signed by a rotated signing key still verifies offline against the pinned
  keyring on the bound machine (FR-016).
- **SC-020** [US2]: An air-gap-originated activation is retention-bounded and erasable through the same path
  as an online activation — erasing a customer's data covers air-gap and online activations identically
  (FR-027).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Air-gapped machine | A computer with no network connectivity, by policy or physical isolation. |
| Request file | The offline-produced envelope the client carries to the portal to request activation. |
| Response file | The signed, portable envelope the portal returns, carrying the machine-bound credential. |
| Portal | The online endpoint that ingests a request file and returns a response file. |
| Machine-bound credential | The signed, offline-verifiable LIC1 token that verifies only on the bound machine (from E009). |
| Nonce (air-gap) | The single-use token in a request file that makes re-submission idempotent (no second seat). |
| Format version | The explicit version tag on each file so the SDK and server evolve compatibly. |

## Compliance Check

**Audited against**: `project-instructions.md` v1.2.0 (Core Principles I–IV, Security Requirements, Tech Stack) and AGENTS.md governance.
**Date**: 2026-07-15
**Verdict**: PASS — no CRITICAL violations. HOW is deferred to planning; only spec-level compliance was judged.

| Non-negotiable | Verdict | Evidence |
|---|---|---|
| Offline-first verification (Principle I) | PASS | FR-006, SC-001/002 — credential verifies fully offline via E001; air-gapped machine does zero network I/O. |
| Signing key never exposed (Principle I / Security Req) | PASS | Response file carries only the public signed LIC1 credential + `key id`; signing stays in E004; no private-key material in any file/entity. |
| Versioned/rotatable keyring (Security Req) | PASS | Response entity carries `key id`; signed by active key; verified against pinned public key. |
| Multi-tenant isolation + RBAC / API-key scope (Principle II) | PASS | FR-002 (`activate` scope), FR-011, FR-015, SC-010 — fail-closed tenant scoping; cross-tenant refused/not found. |
| Single security core, no second crypto (Principle III) | PASS | Reuses E001/E004/E009; Excluded forbids a second activation code path. |
| Append-only audit (Principle III) | PASS | FR-012, SC-011/012 — activation, replay, and each refusal audited; no raw hardware IDs/secrets. |
| PII minimization / salted hashes (Security Req) | PASS | FR-001, FR-010, SC-009 — only salted hashes / pseudonymous identity; no raw hardware identifiers in files, storage, or logs. |
| Anti-replay nonce (Security Req) | PASS | FR-001 single-use nonce; FR-005 idempotent replay; FR-008 freshness window. |
| Rate limiting (Security Req) | PASS | FR-013, SC-012 — air-gap portal op rate-limited (reuses E009 posture). |
| Tamper-evident signed files (Principle I) | PASS | FR-006, US3, SC-006 — altered or wrong-machine response rejected at import. |
| Raw-SQL migrations, no ORM (Tech Stack) | N/A | No new persisted entity; reuses E009 `activation` table; files are transient value objects. |

**Violations**: none.

**Planning follow-ups (non-blocking)**:
- Keep signing in the E004 signer; assert no private-key material in the response envelope or logs (spec covers this only implicitly).
- Enforce the same forced-RLS posture as E009 on all air-gap read/write paths (RLS is a HOW, correctly deferred).
- Confirm E009-inherited GDPR retention/erasure covers air-gap-originated activation records and audit-stored salted hashes.
