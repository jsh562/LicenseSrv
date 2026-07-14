---
feature_branch: "00010-machine-activation-and-seats"
created: "2026-07-12"
input: "e009"
spec_type: "product"
spec_maturity: "draft"
epic_id: "E009"
epic_sources: "{PRD:CAP-005}"
---

# Feature Specification: Machine Activation & Seat Enforcement

**Feature Branch**: `00010-machine-activation-and-seats`
**Created**: 2026-07-12
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: draft
**Epic ID**: E009
**Epic Sources**: {PRD:CAP-005}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

A signed license (E008) grants entitlements but nothing yet binds it to the machines that run it or limits how
many machines may use it — so one license key can be copied onto unlimited computers and per-seat licensing is
meaningless. At the same time, honest customers who replace or reinstall hardware have no supported way to move
a license to a new machine. This feature binds a license to a machine through a drift-tolerant fingerprint,
enforces the plan's seat limit race-safely, and lets a seat be freed by deactivation — while the bound license
keeps verifying fully offline.

## Scope *(mandatory)*

### Included

- Node-lock activation: a licensed application activates a machine against an active license, binding a
  drift-tolerant machine fingerprint and receiving an offline-verifiable, machine-bound credential.
- Race-safe seat enforcement: active activations per license never exceed the license's seat limit
  (`max_activations`), even under concurrent activation attempts.
- Fingerprint drift tolerance: K-of-N signal matching, so minor hardware change re-uses the existing
  activation and seat instead of consuming a new one.
- Deactivation & seat reclamation: app self-service deactivation and operator/admin reclaim of a machine's
  seat via the console; the freed seat is immediately reusable.
- Activation registry: operators/admins browse a license's activations (pseudonymous machine identity, status,
  timestamps, seats-used-vs-limit), tenant-scoped and behind RBAC.
- Anti-replay idempotency and rate limiting on the runtime activation surface; every activation, deactivation,
  and denied attempt audited.

### Excluded

- Online validation / heartbeat / short-lived-token renewal (E013, CAP-008) — activation credentials verify
  offline; periodic online re-checks are a separate epic.
- Revocation propagation to already-activated offline machines (E013) — activation refuses non-active
  licenses, but enforcing a mid-life revocation on an offline machine is out of scope.
- Air-gapped file-exchange activation (E010, CAP-006) — this epic is the online/networked activation path; the
  signed-file flow builds on it.
- Floating/concurrent seat leasing and time/heartbeat-based auto-reclaim of dead machines (E015, CAP-010) —
  reclamation here is explicit deactivation only.
- Raw hardware-signal collection or storage — the client computes salted signal hashes locally; the server
  never receives or persists raw hardware identifiers.

### Edge Cases & Boundaries

- Seat limit already reached → the next distinct-machine activation is refused with a reason naming the limit;
  no partial activation is recorded.
- Re-activating the same machine (≥K bound signals match an active activation) → idempotent: same seat,
  refreshed credential, no new seat consumed.
- Concurrent activations racing for the last free seat(s) → exactly the available number succeed; the seat
  count never exceeds the limit.
- Machine reports fewer than the minimum required signals → activation refused (cannot form a reliable
  binding), with a distinct reason.
- Activation against a suspended, revoked, or expired license → refused with a distinct reason; no seat
  consumed.
- Replayed or retried activation request (reused nonce) → a same-request retry returns the original result; a
  nonce replayed to forge a different activation is rejected; seat count unchanged.
- Deactivating an already-deactivated or unknown activation → idempotent success; the active-seat count never
  goes negative.
- Cross-tenant: an API key or operator from another tenant can neither see nor mutate a license's seats; a
  cross-tenant activation reference resolves to not found.
- A machine sharing fewer than K signals with any existing activation → treated as a new machine (consumes a
  seat only if one is available).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Activate a machine with race-safe seat enforcement (Priority: P1) 🎯 MVP

A licensed application — holding a valid license key and an `activate`-scoped API key — submits the machine's
fingerprint signals to activate. The server confirms the license is active, binds the machine within the seat
limit, and returns a machine-bound credential that the app then verifies fully offline on that machine. When
the seat limit is already reached, activation is refused with a clear, specific reason.

**Why this priority**: Core value proposition and security-critical — without node-lock plus seat enforcement,
a license key runs on unlimited machines and per-seat licensing has no meaning.

**Independent Test**: Issue a 2-seat license; activate two distinct machines and verify each credential offline;
a third distinct-machine activation is refused with a seat-limit reason.

**Acceptance Scenarios**:

1. **Given** an active license with S available seats, **When** a licensed app activates a new machine, **Then**
   the activation is recorded, one seat is consumed, and the returned credential verifies offline on that machine.
2. **Given** an active license whose seats are all consumed, **When** a new distinct machine attempts
   activation, **Then** it is refused with a reason naming the seat limit and no activation is recorded.
3. **Given** a license with exactly one free seat, **When** several machines attempt activation concurrently,
   **Then** exactly one succeeds and the rest are refused — the active-seat count never exceeds the limit.
4. **Given** a suspended, revoked, or expired license, **When** a machine attempts activation, **Then** it is
   refused with a distinct reason and no seat is consumed.

### User Story 2 - Deactivate a machine to free a seat (Priority: P1) 🎯 MVP

When a machine is retired, reinstalled, or replaced, its seat must be recoverable. The licensed app can
deactivate its own machine, and an operator/admin can reclaim a specific machine's seat from the console. The
freed seat immediately becomes available for a new activation.

**Why this priority**: A per-seat model is unusable if seats cannot be recovered — customers replace hardware
routinely; directly satisfies the epic's "deactivating a machine frees a seat" acceptance criterion.

**Independent Test**: Fill a 1-seat license, deactivate the machine, then activate a different machine
successfully into the freed seat.

**Acceptance Scenarios**:

1. **Given** a license at its seat limit with one active machine, **When** that machine is deactivated (by the
   app or by an operator), **Then** the seat is freed and a different machine can immediately activate.
2. **Given** an already-deactivated or unknown activation, **When** deactivation is requested again, **Then** it
   succeeds idempotently and the active-seat count is unaffected (never negative).
3. **Given** an operator viewing the activation registry, **When** the operator reclaims a specific machine's
   seat, **Then** that activation becomes deactivated, the seat frees, and the action is audited.

### User Story 3 - Tolerate minor hardware drift (Priority: P1) 🎯 MVP

An activated machine that undergoes minor hardware change (for example a RAM or NIC swap) must keep working
without a re-purchase. The system recognizes a returning machine when at least K of its N bound signals still
match, re-using the existing activation and seat rather than treating it as new. A wholly different machine
does not match.

**Why this priority**: Directly satisfies CAP-005 "tolerate minor hardware change" — without it, routine
upgrades exhaust seats and cause false lockouts of paying customers.

**Independent Test**: Activate a machine, change one of its five signals, re-activate, and confirm the same
activation and seat are re-used (no new seat consumed); then activate a machine sharing no signals and confirm
it is a new activation.

**Acceptance Scenarios**:

1. **Given** an active machine bound with N signals, **When** the app re-activates after changing fewer signals
   than the tolerance allows (≥K still match), **Then** the existing activation is matched and refreshed with
   no additional seat consumed.
2. **Given** that same active machine after minor drift, **When** it re-verifies its credential fully offline,
   **Then** verification still succeeds on that machine.
3. **Given** a machine sharing fewer than K signals with any existing activation, **When** it activates, **Then**
   it is treated as a new machine and consumes a seat only if one is available.

### User Story 4 - Browse the activation registry (Priority: P1) 🎯 MVP

Operators and licensing admins need to see how a license's seats are being used — which machines are active,
when they activated, and seat usage against the limit — to support customers and reclaim seats. The console
surfaces a per-license activation list, tenant-scoped and behind RBAC, showing only pseudonymous machine
identity (never raw hardware identifiers).

**Why this priority**: Seat management is unusable without visibility; it underpins US2 operator reclaim and
day-to-day customer support.

**Independent Test**: Activate two machines under a license, then open the license's activation registry in the
console and confirm both appear with machine identity, status, timestamps, and a seats-used/limit summary.

**Acceptance Scenarios**:

1. **Given** a license with active and deactivated machines, **When** an operator opens the license's
   activations, **Then** each is listed with its pseudonymous machine identity, status, and activation time,
   plus a seats-used-vs-limit summary.
2. **Given** a viewer-role user, **When** they open the registry, **Then** they can read activations but cannot
   deactivate; a deactivation attempt is refused and recorded as a security event.
3. **Given** two tenants, **When** one tenant's operator queries activations, **Then** no other tenant's
   activations are visible and a cross-tenant activation reference resolves to not found.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a licensed application activate a machine against an active license by submitting
  the machine's fingerprint signals, recording an activation bound to that machine.
- **FR-002**: System MUST authenticate the runtime activate and deactivate operations with an
  `activate`-scoped API key (E005) and MUST reject, fail-closed, any call lacking that scope.
- **FR-003**: System MUST ensure the number of active activations per license never exceeds the license's seat
  limit (`max_activations`, snapshotted at issuance) — including under concurrent activation attempts, with no
  over-allocation.
- **FR-004**: System MUST refuse activation when the seat limit is reached, returning a distinct reason that
  identifies the seat limit, and MUST NOT record a partial activation.
- **FR-005**: System MUST bind a machine using a drift-tolerant fingerprint of N stable signals and MUST treat
  a returning machine as the same activation when at least K of N signals match (K-of-N; default 3-of-5),
  re-using its seat.
- **FR-006**: System MUST store only salted hashes of machine signals and MUST NOT persist or log raw hardware
  identifiers.
- **FR-007**: System MUST produce, on successful activation, a machine-bound credential that verifies fully
  offline (zero network) via the E001 verifier core and only on the bound machine within the fingerprint
  tolerance.
- **FR-008**: System MUST refuse activation against a suspended, revoked, or expired license with a distinct
  reason and consume no seat.
- **FR-009**: System MUST require a single-use nonce on each activation request and use it for anti-replay: a
  retry carrying the same nonce for the same (license, machine) returns the original activation result (no
  additional seat consumed), while a nonce replayed to forge a different activation is rejected — so no
  replayed request ever creates a second activation or seat.
- **FR-010**: System MUST support deactivation of a machine — by the licensed application for its own machine
  and by an operator/admin via the console — freeing the seat for reuse.
- **FR-011**: System MUST make deactivation idempotent: deactivating an already-deactivated or unknown
  activation succeeds without error and never drives the active-seat count below zero.
- **FR-012**: System MUST expose a tenant-scoped activation registry listing a license's activations with
  pseudonymous machine identity, status, and timestamps plus seats-used-vs-limit, behind console RBAC (viewer
  reads; admin deactivates).
- **FR-013**: System MUST rate-limit the runtime activation surface to deter seat exhaustion and fingerprint
  enumeration (the concrete keying and thresholds are specified by FR-020).
- **FR-014**: System MUST record an append-only audit entry for every activation, deactivation, and denied or
  limit-exceeded attempt, capturing actor, action, and target without raw hardware identifiers, secrets,
  nonces, or signed credentials.
- **FR-015**: System MUST isolate activations by tenant, fail-closed: an actor or API key from one tenant can
  neither read nor mutate another tenant's activations, and a cross-tenant activation reference resolves to not
  found.
- **FR-016**: System MUST refuse activation when a machine reports fewer than the minimum required signals to
  form a reliable fingerprint — the minimum being the K-of-N match threshold (K, default 3), since a machine
  binding fewer than K signals can never satisfy the match rule — with a distinct reason.
- **FR-017**: System MUST protect every state-changing console/admin operation (operator seat reclaim /
  deactivation) with a double-submit CSRF token, rejecting fail-closed (403) any request whose `X-CSRF-Token`
  header is missing or does not match the CSRF cookie, and MUST record each CSRF failure — like an RBAC denial —
  as an audited security event.
- **FR-018**: System MUST never expose the product signing (private) key: it MUST NOT be returned, logged, or
  included in any response body, header, example, or audit entry; only the public machine-bound LIC1 credential
  and an opaque signing-key id are returned, and the credential only by the activate operation.
- **FR-019**: System MUST derive the stored and compared machine signal hashes from a server-provisioned
  activation salt that is per-tenant (or per-product) and distributed to the SDK for offline use, so the client
  recomputes identical salted signal hashes without the server ever seeing raw identifiers (reinforcing FR-006);
  rotating the salt invalidates prior fingerprints and requires affected machines to re-activate. Salt rotation
  is a rare operational event: because a rotated machine's prior fingerprint no longer matches, its superseded
  activation is reclaimed by the operator (FR-010) or purged by the retention sweep so seats are not permanently
  consumed; the epic does not auto-migrate prior activations across a rotation.
- **FR-020**: System MUST rate-limit the runtime activation surface — both the activate and deactivate
  operations — keyed per API key and per license, refusing requests above a configured threshold (default 60
  requests per minute per API-key+license) with `429 rate_limited` and a `Retry-After` header, and MUST audit
  each limit-exceeded event (FR-014); this makes FR-013 concrete.
- **FR-021**: System MUST require each activation nonce to be a single-use, high-entropy value of at least 128
  bits, and MUST retain used nonces for a bounded replay-rejection window (default 24 hours); within that window
  a nonce reused for the same (license, machine) replays the original result and a nonce reused to forge a
  different activation is rejected (FR-009).
- **FR-022**: System MUST bound the machine-bound credential's validity to the license expiry (`exp`) it
  carries; where a separate activation-credential TTL is configured, the effective expiry is `min(license
  expiry, credential TTL)` — whichever is sooner wins.
- **FR-023**: System MUST NOT auto-deactivate, auto-expire, or otherwise mutate existing activation rows
  when their parent license is later suspended, revoked, or expired — the already-issued machine-bound
  credentials keep verifying offline until their own `exp` (the accepted offline-first tradeoff; online
  propagation is E013). The live license status gates only NEW activations, which are refused (FR-008); the
  derived seat count is unchanged by a license-status change, and an operator reclaims a seat only by
  explicit deactivation (FR-010).
- **FR-024**: System MUST preserve referential integrity between an activation and its parent license: a
  license MUST NOT be hard-deleted while any activation row references it — the composite foreign key
  `(tenant_id, license_id) → license` is `ON DELETE NO ACTION` (RESTRICT). Seat reclamation and lifecycle
  changes are soft state transitions (deactivation, status change), never a hard delete of the license or
  its activation rows.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Activation**: a record binding one license to one machine. Attributes: owning tenant, the license it
  belongs to, a pseudonymous machine identity derived from the fingerprint (salted hash), the bound signal
  hashes (N of them) and the K threshold, status (active | deactivated), activated-at, last-updated, and
  deactivated-at, plus the machine-bound credential (or a reference to it). Invariant: at most one active
  activation per (license, machine identity); a license's seat usage is the count of its active activations.
  Activation records are pseudonymized (salted hashes only) and fall under the platform's retention-bounded
  GDPR erasure path (E001), so a customer's machine data can be erased on request. Deactivated (stale)
  activation records are retained for registry history and purged by the platform retention path within a
  bounded, configurable window (default 90 days after deactivation); on erasure the `label` is nulled and the
  salted hashes remain pseudonymous.
- **License** (E008, consumed): must be active to activate; supplies the seat limit (`max_activations`) and the
  entitlements/expiry carried by the bound credential. A suspended, revoked, or expired license blocks new
  activations.
- **Machine fingerprint** (value): the N salted signal hashes plus the K-of-N threshold and a bounded
  clock-skew window, bound into the E001 token claims (`fp` / `fpk` / `sk`). Computed by the client; never
  present in raw form on the server.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The licensed application can collect at least N stable hardware signals and compute salted per-signal hashes
  locally, per the SDK/bindings contract (E003).
- The seat limit is the license's snapshotted `max_activations` from E008; this epic does not change how the
  limit is set.
- Producing the signed machine-bound credential reuses the E004 signer that E008 already consumes (the binding
  must be signed to be tamper-evident).
- The runtime activate/deactivate REST surface is authenticated by an `activate`-scope API key (E005); the
  admin activation registry uses the console session (E005).
- Default fingerprint tolerance is 3-of-5 signals with a bounded clock-skew window — configurable server
  defaults, not per-request client choices.
- The licensed application is trusted to compute honest salted signal hashes from its real hardware
  (honest-client threat model). Node-lock deters casual license copying and seat over-use, not a fully hostile
  local user who fabricates or replays made-up signal hashes on their own machine. Server-side nonce anti-replay
  (FR-009/FR-021), race-safe seat locking (FR-003), and per-key+license rate limiting (FR-020) bound abuse, but
  local fabrication of fingerprint hashes is out of scope for this epic (deeper hardware attestation would be a
  separate concern).

### Risks

- **Fingerprint instability** *(likelihood: medium, impact: high)*: signals that drift more than expected could
  cause false new-machine activations that exhaust seats — mitigated by K-of-N tolerance and operator-visible
  reclaim.
- **Seat-count race** *(likelihood: medium, impact: high)*: incorrect locking could over-allocate seats under
  concurrency — mitigated by single-writer locking/serialized counting proven by a concurrency test.
- **Offline revocation lag** *(likelihood: high, impact: medium)*: a revoked license's already-activated
  machines keep verifying offline until token expiry — an accepted offline-first tradeoff; online revocation
  propagation is E013.
- **Fingerprint-hash fabrication** *(likelihood: low, impact: medium)*: a hostile local user could compute or
  replay fabricated signal hashes to impersonate a machine or dodge the seat limit — accepted under the
  honest-client threat model (Assumptions); mitigated but not eliminated by nonce anti-replay (FR-009/FR-021),
  race-safe seat locking (FR-003), and per-key+license rate limiting (FR-020); hardware attestation is out of
  scope.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `activation` (license↔machine binding, salted fingerprint, status, seat accounting).
- `NEW-API` — runtime activate/deactivate REST authenticated by an `activate`-scope API key; admin
  activation-registry and deactivate routes behind the console session.
- `NEW-UI` — console "Activations" view (per-license seat usage, machine list, admin deactivate) within the
  Licensing area.
- `MIGRATION` — new `activation` table: tenant-scoped, forced RLS, at most one active activation per
  license+machine, seat-count support.
- `NEW-CONFIG` — fingerprint K/N (default 3-of-5) and clock-skew defaults; the per-tenant/per-product
  activation salt (server-provisioned, SDK-distributed, rotatable — FR-019); activation rate limits (default 60
  req/min per API-key+license — FR-020); activation nonce entropy floor (≥128-bit) and replay-rejection TTL
  (default 24h — FR-021); machine-bound-credential TTL (effective expiry = `min(license exp, credential TTL)` —
  FR-022); and the stale-activation retention window (default 90 days after deactivation).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A licensed app activates a machine against an active license and the returned credential
  verifies offline (zero network) on that machine within the same success path.
- **SC-002** [US1]: For a license with S free seats, exactly S of any number of concurrent activation attempts
  succeed; the active-seat count never exceeds the limit.
- **SC-003** [US1]: An activation beyond the seat limit is refused with a distinct reason naming the limit, and
  no activation record is created.
- **SC-004** [US1]: Activation against a suspended, revoked, or expired license is refused with a distinct
  reason and consumes no seat.
- **SC-005** [US2]: After a machine is deactivated (by app or operator), a different machine can immediately
  activate into the freed seat.
- **SC-006** [US2]: Repeating a deactivation on an already-deactivated or unknown machine succeeds without
  error and never lowers the recorded seat count below the true active count.
- **SC-007** [US3]: A machine that changes a minority of its signals (≥K still match) re-activates into its
  existing seat with no additional seat consumed and still verifies offline.
- **SC-008** [US3]: A machine sharing fewer than K signals with any existing activation is treated as a new
  machine.
- **SC-009** [US4]: An operator can view a license's activations (machine identity, status, timestamps) and
  seats-used-vs-limit; a viewer cannot deactivate and the denied attempt is recorded as a security event.
- **SC-010** [US1]: A replayed activation request (reused nonce) creates no second activation and consumes no
  second seat; a nonce replayed to forge a distinct activation is rejected.
- **SC-011** [US4]: No activation record or log exposes a raw hardware identifier — only salted hashes /
  pseudonymous machine identity are stored.
- **SC-012** [US4]: An actor or API key from one tenant cannot see or mutate another tenant's activations; a
  cross-tenant activation reference resolves to not found.
- **SC-013** [US4]: A missing or mismatched CSRF token on an admin seat-reclaim / deactivation is refused
  fail-closed and recorded as a security event (FR-017).
- **SC-014** [US1]: No activation response, log, or audit entry ever contains the product signing (private)
  key; only the public machine-bound credential and an opaque signing-key id are exposed (FR-018).
- **SC-015** [US1]: When activate/deactivate requests from one API-key+license exceed the configured rate
  threshold, further requests are refused and each refusal is audited (FR-013/FR-020).
- **SC-016** [US1]: A machine-bound credential's effective expiry is never later than the sooner of the
  license expiry and the configured credential TTL (FR-022).
- **SC-017** [US1]: After its license is suspended, revoked, or expired, an already-activated machine's
  credential still verifies offline and the license's seat count is unchanged; only new activations are
  refused (FR-023).
- **SC-018** [US4]: A license with existing activations cannot be permanently deleted; seats are reclaimed by
  deactivation, not deletion (FR-024).
- **SC-019** [US1]: An activation nonce is single-use and at least 128 bits; a nonce reused within the bounded
  replay-rejection window is handled per the anti-replay rule and never yields a second seat (FR-021).
- **SC-020** [US1]: An activate/deactivate call whose API key lacks the `activate` scope is refused
  fail-closed, and no activation state changes (FR-002).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Activation | A record binding one license to one machine; consumes a seat while active. |
| Node-lock | Restricting a license so it runs only on machines that have activated it. |
| Seat | One unit of a license's activation capacity; the seat limit equals the license's `max_activations`. |
| Machine fingerprint | A set of salted hashes of stable hardware signals that identifies a machine. |
| K-of-N tolerance | A match rule accepting a machine when at least K of its N bound signals match, tolerating minor hardware drift. |
| Nonce (activation) | A single-use client-supplied token on an activation request; a retry with the same nonce returns the original result, while a replay forging a different activation is rejected (anti-replay, no double seat consumption). |
| Machine-bound credential | The signed, offline-verifiable artifact returned on activation that verifies only on the bound machine. |

## Compliance Check

**Verdict**: PASS (Policy Auditor, 2026-07-12) — respects all core non-negotiables in `project-instructions.md` v1.2.0. The one must-reconcile advisory was resolved in this spec; two minor notes applied.

**Non-negotiables verified**:
- Offline-first verification, key never exposed (I): FR-007, SC-001 (offline via the E001 core); signer reused from E004 (Assumptions); online validation deferred to E013.
- Multi-tenant isolation + RBAC (II): FR-002, FR-012, FR-015, SC-012; the MIGRATION signal declares a tenant-scoped, forced-RLS `activation` table.
- Single security core + append-only audit (III): FR-007 (E001 core, no per-language crypto); FR-014 records an append-only audit entry for every activation/deactivation/denied attempt.
- PII minimization: FR-006, SC-011 — salted hashes only; no raw hardware identifiers stored or logged; activation records fall under the platform GDPR-erase path (Key Entities).
- Anti-replay nonce + rate limiting: FR-009 (single-use activation nonce, reused-nonce rejected), SC-010, FR-013 — matches the Security Requirements "activation requests MUST carry nonces" clause and the project-plan E009 "nonce anti-replay" constraint.
- No-ORM / raw-SQL migration and `/src` layout: no conflicting assertions (HOW deferred to Plan).

**Resolved from audit**:
1. Anti-replay was reworded from an idempotency key to a **single-use nonce** (FR-009, SC-010, Glossary, NEW-CONFIG), aligning with the named Security-Requirements nonce non-negotiable and the E001 reused-nonce-rejected behavior.
2. FR-014 now states the audit entry is **append-only** (inherited from the platform `audit_log`).
3. A Key-Entities note records that pseudonymized `activation` data is retention-bounded and GDPR-erasable via the E001 path.
