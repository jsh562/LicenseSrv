---
feature_branch: "00016-floating-and-concurrent-seats"
created: "2026-07-20"
input: "E015"
spec_type: "product"
spec_maturity: "clarified"
epic_id: "E015"
epic_sources: "{PRD:CAP-010}"
---

# Feature Specification: Floating & Concurrent Seats

**Feature Branch**: `00016-floating-and-concurrent-seats`
**Created**: 2026-07-20
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: clarified
**Epic ID**: E015
**Epic Sources**: {PRD:CAP-010}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Node-lock activation (E009) caps how many *machines* may install a license, but many products are licensed by *simultaneous use* — a pool of N concurrent seats shared across a fleet, where any instance may run as long as a free seat exists and the seat returns when that instance stops. Today LicenseSrv has no way to lease a seat for the duration of a running session, enforce a concurrency cap race-safely, or automatically recover a seat when a machine crashes without releasing it — so vendors who sell floating/concurrent licenses cannot be served, and a crashed client would silently strand a seat forever. This feature adds an online seat-lease model: acquire a seat before use, renew it by heartbeat while in use, release it on exit, and auto-reclaim leases whose heartbeat has lapsed.

## Scope *(mandatory)*

### Included

- Floating seat leases: a licensed application acquires a concurrency seat against an active license, receiving a lease with a server-set expiry (TTL); the number of live leases per license never exceeds the license's concurrency cap (`max_concurrent`).
- Heartbeat renewal: the app periodically renews a held lease, extending its expiry; renewal is idempotent and holds the seat only while the app keeps heartbeating.
- Explicit release: the app releases its lease on graceful exit, freeing the seat immediately for reuse.
- Automatic dead-machine reclamation: a time-driven sweeper reclaims leases whose TTL plus grace has elapsed with no renewal, returning the seat to the pool without operator action.
- Race-safe concurrency accounting: concurrent acquisitions for the last free seat(s) never over-allocate; the live-lease count is authoritative on the server.
- Overage handling: default hard-refuse at capacity, with an optional per-plan soft cap that admits a bounded temporary overage and meters it to the audit log for later true-up.
- Concurrency registry: operators/admins view a license's live leases and concurrency-used-vs-cap, tenant-scoped behind RBAC, and can force-release a specific lease.
- Anti-replay/idempotency, rate limiting, and append-only audit on the runtime lease surface (acquire / renew / release / reclaim / denials).

### Excluded

- Node-lock activation and per-machine seat accounting (`max_activations`) — owned by E009; this epic is the distinct concurrency (`max_concurrent`) dimension and does not change node-lock behavior. A plan may carry both caps; they enforce independently.
- Offline concurrency enforcement — floating seats are inherently an **online** model (the live-lease count is server-authoritative); a fully offline machine cannot participate in a shared concurrency pool. Offline-verifiable node-lock credentials remain E009's job.
- Client-side seat enforcement (a client that keeps running after its lease lapses) — the server is authoritative for the seat count and refuses to renew a reclaimed lease; the client's obligation to stop using a lapsed seat is a documented client responsibility (aligned with E013 online-enforcement client obligations), not enforced on the client here.
- Short-lived online-validation tokens, revocation propagation to clients, and clock-tamper resistance — owned by E013; the lease handle is minted by the E004 signer (FR-022) and this epic does not redefine E013's primitives. E015 does react to a license **revocation event** by proactively reclaiming its own live leases (server-side seat hygiene, FR-024); propagating revocation to offline clients/tokens remains E013's responsibility.
- Setting the concurrency cap value in the catalog UI — the cap is a plan/license attribute this epic consumes and snapshots (like `max_activations`); how operators author plans is E007's surface (this epic adds the attribute and its enforcement, not the plan-authoring form).
- Usage-metered billing and true-up invoicing — overage is *metered* to the audit log here; consumption-based billing/aggregation is E016.

### Edge Cases & Boundaries

- Concurrency cap already reached (hard cap) → the next acquire is refused with a distinct reason naming the cap; no partial lease is recorded.
- Several instances race for the last free seat(s) → exactly the available number acquire; the live-lease count never exceeds the cap.
- A held lease is renewed normally → its expiry extends; no additional seat is consumed (idempotent renew).
- A client crashes/is killed without releasing → its lease lapses; after TTL + grace the sweeper reclaims the seat automatically.
- A renew arrives after the lease was reclaimed or expired → rejected with a distinct reason; the client must acquire a new lease (a stale/late renew never resurrects a reclaimed seat or double-counts).
- Network partition (client alive but cannot heartbeat) → the lease lapses server-side after grace and the seat is reclaimed; on reconnect the client must re-acquire.
- Re-acquire from the same holder while it already holds a live lease → idempotent: the existing lease is returned/renewed, not a second seat consumed.
- Acquire against a suspended, revoked, or expired license → refused with a distinct reason; no seat consumed.
- Replayed/retried acquire request (same idempotency token) → returns the original lease, consuming no second seat.
- Soft cap enabled: acquisitions above the base cap but within the overage allowance → succeed and are metered; beyond the allowance → refused.
- Cross-tenant: an API key or operator from another tenant can neither see nor mutate a license's leases; a cross-tenant lease reference resolves to not found.
- Clock skew: lease expiry is computed from server/monotonic time; a client's wall clock never determines whether a seat is still held. The grace window absorbs transient client/network clock skew, and the reclaim boundary is strictly `expires_at + grace < server_now` — reclamation triggers ONLY strictly after that instant in server time (matching the sweeper predicate in data-model §4), so at the exact expiry instant a not-yet-past-grace lease stays live and a renew still succeeds; the reclaim-vs-renew edge is decided solely by server time, never by a client clock.
- Early release/reclaim vs an already-minted handle → the server frees the seat immediately and stops renewing, but a signed handle already issued stays offline-verifiable until its short TTL lapses; the handle's TTL is kept short (bounded by the heartbeat interval, well within the lease TTL) so the residual offline-verifiable window after an early release/reclaim is at most one heartbeat cycle, during which the server remains the sole authority for the seat count and refuses to renew the ended lease (the client must re-acquire).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Acquire a floating seat with a race-safe concurrency cap (Priority: P1) 🎯 MVP

A licensed application, before it begins a licensed session, asks the server for a concurrency seat against an active license. If a seat is free, the server records a lease and returns it with an expiry; the app may now run. When all seats are in use, the acquire is refused with a clear reason naming the cap. Under concurrent demand for the last seats, exactly the available number of acquisitions succeed — the live-lease count never exceeds `max_concurrent`.

**Why this priority**: Core value proposition and the security-critical control — without a race-safe concurrency cap there is no floating-license enforcement and the concurrency limit is meaningless.

**Independent Test**: Configure a license with a concurrency cap of 2; acquire two leases successfully; a third concurrent-session acquire is refused with a cap reason; then fire many simultaneous acquires for one free seat and confirm exactly one succeeds.

**Acceptance Scenarios**:

1. **Given** an active license with C free concurrency seats, **When** a licensed app acquires a seat, **Then** a lease is recorded, one seat is consumed, and the app receives the lease with a server-set expiry.
2. **Given** an active license whose concurrency seats are all in use (hard cap), **When** another session attempts to acquire, **Then** it is refused with a reason naming the cap and no lease is recorded.
3. **Given** a license with exactly one free seat, **When** many sessions attempt to acquire concurrently, **Then** exactly one succeeds and the rest are refused — the live-lease count never exceeds the cap.
4. **Given** a suspended, revoked, or expired license, **When** a session attempts to acquire, **Then** it is refused with a distinct reason and no seat is consumed.

### User Story 2 - Renew a lease by heartbeat and release it on exit (Priority: P1) 🎯 MVP

While the app runs it periodically heartbeats to renew its lease, extending the expiry so the seat stays held. Renewal is idempotent — repeated heartbeats keep exactly one seat. When the app exits cleanly it releases the lease, and the freed seat is immediately available to another session. Releasing an already-released or unknown lease succeeds without error.

**Why this priority**: A floating model is unusable if a running session can't keep its seat or a clean exit doesn't return it — heartbeat renewal and prompt release are the normal lifecycle that makes concurrency reuse work.

**Independent Test**: Acquire a lease, renew it and confirm the expiry advances with no extra seat consumed, release it, and confirm a different session can immediately acquire the freed seat; release again and confirm idempotent success.

**Acceptance Scenarios**:

1. **Given** a live lease, **When** the app renews it via heartbeat, **Then** the lease expiry is extended (server-computed) and the live-lease count is unchanged.
2. **Given** a license at its cap with one live lease, **When** that lease is released, **Then** the seat is freed and a different session can immediately acquire it.
3. **Given** an already-released or unknown lease, **When** release is requested again, **Then** it succeeds idempotently and the live-lease count is never driven below zero.
4. **Given** a holder that already has a live lease, **When** it acquires again, **Then** the existing lease is returned/renewed and no second seat is consumed.

### User Story 3 - Automatically reclaim a dead machine's seat (Priority: P1) 🎯 MVP

When a machine crashes, is force-killed, or is partitioned from the network, it never releases its lease. To keep the concurrency pool healthy, the server automatically reclaims a lease once its expiry plus a grace window has passed with no renewal — the seat returns to the pool with no operator action. A late heartbeat arriving after reclamation is rejected, forcing the client to acquire a fresh lease rather than silently reviving a reclaimed seat.

**Why this priority**: Directly satisfies the epic's "an expired lease is reclaimed and the seat becomes available" criterion; without automatic reclamation a single crash permanently strands a seat and the pool bleeds capacity.

**Independent Test**: With a full cap, acquire a lease and stop heartbeating; advance time past TTL + grace; confirm the sweeper reclaims the seat so a new acquire succeeds; then submit a stale renew for the reclaimed lease and confirm it is rejected.

**Acceptance Scenarios**:

1. **Given** a live lease whose expiry plus grace has elapsed with no renewal, **When** the reclaim sweeper runs, **Then** the lease is reclaimed, the seat returns to the pool, and a new acquire can succeed.
2. **Given** a lease that was reclaimed, **When** a late/stale renewal for it arrives, **Then** the renewal is rejected with a distinct reason and no seat is double-counted; the client must acquire anew.
3. **Given** the reclaim sweeper encounters an error on one license, **When** it continues, **Then** acquire/renew/release for other licenses and tenants remain unaffected (reclamation is fail-open and never blocks the live lease surface).

### User Story 4 - Handle overage at capacity (hard refuse or metered soft cap) (Priority: P2)

Some vendors want strict concurrency (refuse at capacity), while others prefer to admit a short burst above the cap and reconcile it later rather than block a paying customer mid-work. Per plan, the default is a hard cap that refuses at capacity; an optional soft cap admits acquisitions up to a bounded overage allowance above the base cap, and each over-base acquisition is metered to the audit log for periodic true-up. Beyond the allowance, even a soft cap refuses.

**Why this priority**: Significant commercial flexibility and a common enterprise ask, but the MVP concurrency model (US1–US3) works without it; overage is an enhancement layered on the hard cap.

**Independent Test**: With a hard cap, confirm acquire is refused at capacity; enable a soft cap with an allowance of 1, confirm one acquisition above the base cap succeeds and is metered to the audit log, and a further acquisition beyond the allowance is refused.

**Acceptance Scenarios**:

1. **Given** a plan with a hard cap at capacity, **When** a session acquires, **Then** it is refused with the cap reason (no overage).
2. **Given** a plan with a soft cap and a free overage allowance, **When** a session acquires above the base cap, **Then** the lease succeeds and an overage event is recorded to the append-only audit log with the concurrency level reached.
3. **Given** a soft cap whose overage allowance is exhausted, **When** another session acquires, **Then** it is refused with a distinct reason.

### User Story 5 - Operator visibility and force-release of live leases (Priority: P2)

Operators and licensing admins need to see live concurrency — how many seats a license is using against its cap, which sessions hold leases, and when each was acquired, last renewed, and expires — to support customers, plan capacity, and review overage. The console surfaces a per-license lease registry, tenant-scoped and behind RBAC, showing only pseudonymous session/machine identity; an admin can force-release a specific lease to recover a seat immediately.

**Why this priority**: Makes the concurrency model operable and supportable, but day-one enforcement (US1–US3) functions without a UI; visibility and manual force-release are operational value-add.

**Independent Test**: Acquire two leases under a license, open the license's lease registry, and confirm both live leases and a used-vs-cap summary appear; confirm a viewer cannot force-release while an admin can, and a cross-tenant lease reference resolves to not found.

**Acceptance Scenarios**:

1. **Given** a license with live and recently-ended leases, **When** an operator opens the license's leases, **Then** each is listed with pseudonymous session/machine identity, status, and acquired/last-renewed/expires timestamps, plus a concurrency-used-vs-cap summary.
2. **Given** a viewer-role user, **When** they attempt to force-release a lease, **Then** it is refused and recorded as a security event; an admin performing the same force-release succeeds and the seat frees.
3. **Given** two tenants, **When** one tenant's operator queries leases, **Then** no other tenant's leases are visible and a cross-tenant lease reference resolves to not found.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a licensed application acquire a concurrency seat against an active license, recording a **lease** bound to a pseudonymous holder-key — derived from a CLIENT-SUPPLIED stable opaque holder reference that the server salts and hashes (raw never stored), keyed per the configured concurrency scope (FR-023) — and returning the lease with a server-set expiry (TTL) and a signed lease handle (default; a plain-authorization opt-out is available per FR-022).
- **FR-002**: System MUST authenticate the runtime lease operations (acquire, renew, release) with a scoped runtime API key (E005) and MUST reject, fail-closed, any call lacking the required scope.
- **FR-003**: System MUST ensure the number of **live** leases per license never exceeds the license's **effective** concurrency cap — defined as `max_concurrent + concurrency_overage` (the SAME single effective-cap definition used by the overage requirement FR-012 and the Key Entities Lease invariant; under a hard cap `concurrency_overage = 0`, so the effective cap equals `max_concurrent`) — including under concurrent acquisition attempts, with no over-allocation.
- **FR-004**: System MUST refuse an acquire when the concurrency cap is reached under a hard cap, returning a distinct reason that identifies the cap, and MUST NOT record a partial lease.
- **FR-005**: System MUST source the concurrency cap (`max_concurrent`) from the plan/license as a NEW attribute independent of `max_activations`, snapshotted at issuance, and MUST enforce it independently of the node-lock activation cap — a license MAY carry both, each counted separately. When a license has no `max_concurrent` set (floating not entitled), the lease surface MUST refuse acquire fail-closed with a distinct "no concurrency entitlement" reason — never treating an absent cap as unlimited and never falling back to `max_activations`.
- **FR-006**: System MUST refuse an acquire against a suspended, revoked, or expired license with a distinct reason and consume no seat.
- **FR-007**: System MUST let a holder renew (heartbeat) a live lease, extending its expiry to a server-computed value, idempotently — repeated renewals keep exactly one seat and never corrupt lease state.
- **FR-008**: System MUST let a holder release a lease, freeing the seat immediately, and MUST make release idempotent — releasing an already-released or unknown lease succeeds without error and never drives the live-lease count below zero. A release of an unknown or cross-tenant lease id returns an idempotent 200 (under forced RLS a cross-tenant lease is invisible, so the release touches no row) — a deliberate carve-out from the cross-tenant→404 rule (FR-019) that frees nothing outside the tenant and is not an enumeration oracle.
- **FR-009**: System MUST compute lease expiry and reclamation timing from server/monotonic time and MUST NOT trust a client wall clock to determine whether a seat is still held; lease TTL, heartbeat interval, grace window, and sweep interval are configurable per plan with defaults heartbeat 10 min, TTL 30 min, grace 5 min, and sweep 1 min, and the system MUST enforce the invariant TTL ≥ 3× heartbeat interval so a single missed heartbeat never reclaims a live seat.
- **FR-010**: System MUST automatically reclaim a lease whose expiry plus the grace window has elapsed with no renewal, via a time-driven sweeper that returns the seat to the pool; the sweeper MUST be fail-open — an error never blocks acquire/renew/release for any license or tenant. Each sweep run MUST process a BOUNDED batch — a configurable maximum number of leases per run (default 1000) — selecting the **oldest-expired leases first** (ascending `expires_at`), and MUST be idempotent across runs: an already-reclaimed lease is skipped so a re-run never double-reclaims or double-counts, and a lapsed set larger than one batch is drained deterministically across consecutive sweep intervals (mirroring the E013 CRL / E014 grace-reclaim worker sweep bounds).
- **FR-011**: System MUST make reclaim and renew mutually exclusive: a renewal arriving after its lease was reclaimed or expired MUST be rejected with a distinct reason (enforced by an expiry/status predicate and a monotonic fencing/generation guard), so a late renewal never revives a reclaimed seat or double-counts.
- **FR-012**: System MUST support, per plan, a hard cap (default — refuse at capacity) or an optional soft cap whose overage allowance (`concurrency_overage`) is an ABSOLUTE integer seat count above the base cap (default 0 = hard cap), so the effective cap is `max_concurrent + concurrency_overage`; acquisitions within the allowance succeed and beyond it are refused with `seat_capacity_exhausted` (distinguished from the base-cap refusal by its `details`).
- **FR-013**: System MUST record each over-base (overage) acquisition under a soft cap to the append-only audit log, capturing the concurrency level reached for later true-up, without card data or raw hardware identifiers.
- **FR-014**: System MUST make lease acquisition idempotent/anti-replay via a single-use client-supplied token, so a replayed or retried acquire for the same holder returns the original lease and consumes no second seat. The token MUST be unique per tenant (`UNIQUE (tenant_id, nonce)`) and retained on the lease row for the row's retention lifetime (mirroring E009's activation nonce, so a replay is rejected for the full retention window); because a purged token can only belong to a long-terminal (released/reclaimed) lease, any post-retention reuse is handled as a fresh, cap-checked acquire that can never resurrect or double-count a seat.
- **FR-015**: System MUST expose a tenant-scoped lease registry listing a license's live and recently-ended leases (recently-ended shown within a bounded display window, default 24h) with pseudonymous session/machine identity, status, and acquired/last-renewed/expires timestamps plus concurrency-used-vs-cap, behind console RBAC (viewer reads; admin force-releases).
- **FR-016**: System MUST let an operator with the admin role (admin or higher — consistent with FR-015's "admin force-releases") force-release a specific lease via the console over an authenticated console session, freeing the seat, protected by a double-submit CSRF token (reject fail-closed 403 on missing/mismatched token) and recorded as an audited action; a viewer-role attempt is refused and recorded as a security event (SC-010).
- **FR-017**: System MUST rate-limit the runtime lease surface (acquire, renew, release) keyed per API key, refusing requests above a configured threshold with `429 rate_limited` and a `Retry-After` header, with the threshold sized to admit legitimate heartbeat cadence — defined measurably and per-plan configurable as a burst multiple of the API key's expected aggregate (jittered) heartbeat request rate for the seats it serves (default ≥ 2× that rate, so even near-lockstep heartbeats after a mass expiry never trip the limit) — and MUST audit each limit-exceeded event as a security event.
- **FR-018**: System MUST record an append-only audit entry for every acquire, renew, release, reclaim, force-release, and denied or limit-exceeded attempt — including every distinct denial reason (no-entitlement, license-not-active, activation-required, seat-capacity-exhausted, lease-not-renewable, rate-limited) and a transient signer-fault (503, no seat consumed) on the acquire/renew path — capturing actor, action, and target without raw hardware identifiers, secrets, or credentials. Automatic reclamations (the time-driven sweeper and the revoke-reclaim path) MUST be attributed to a synthetic system/worker actor plus the affected lease/license id (mirroring E013/E014's synthetic-actor workers) so every reclamation remains attributable.
- **FR-019**: System MUST isolate leases by tenant, fail-closed: an actor or API key from one tenant can neither read nor mutate another tenant's leases, and a cross-tenant lease reference resolves to not found (the sole exception is the idempotent release route, which returns 200 and touches no row under RLS — FR-008).
- **FR-020**: System MUST store only pseudonymous holder identity (the salted hash of the client-supplied holder reference, per FR-026 — never the raw reference) for a lease and MUST NOT persist or log raw hardware identifiers; lease records fall under the platform's retention-bounded GDPR-erasure path.
- **FR-021**: System MUST preserve referential integrity between a lease and its license (composite foreign key `(tenant_id, license_id) → license`, `ON DELETE NO ACTION`); a license with any lease MUST NOT be hard-deleted — leases end by release or reclamation (soft transitions), never a hard delete.
- **FR-022**: System MUST, by default, return on acquire and renew a signed short-TTL lease handle produced by the E004 signer (a public, tamper-evident artifact plus an opaque signing-key id — NO new crypto), whose validity is bounded by the heartbeat interval (a short window well within the lease TTL) so a local gate can verify a held lease between heartbeats while the server remains the sole authority for the seat count, keeping the residual offline-verifiable window after an early release/reclaim to at most one heartbeat cycle; a deployment MAY configure plain server-side authorization (lease id + expiry, no handle) where offline-verifiable handles are not needed. The signing private key or any lease secret MUST NEVER appear in any response, log, or audit entry — only the public handle and the opaque key id are exposed. If the E004 signer is unavailable while signed-handle mode is on, the acquire path MUST fail closed with NO seat consumed and no lease persisted, and the renew path MUST leave the existing lease and its seat unchanged; a plain-authorization deployment (no handle) is unaffected.
- **FR-023**: System MUST support a per-plan concurrency-counting **scope** — `session` (default; each running instance holds one lease, keyed on a client-supplied session/instance reference), `machine` (keyed on the E009 device fingerprint, so instances on one machine share a seat), or `user` (keyed on a named-user reference, so a user's instances share one seat) — and MUST derive the lease holder-key from the configured scope, enforcing "at most one live lease per (license, holder-key)" so duplicate or over-concurrency acquisition is controlled identically regardless of scope. Re-acquire from the same holder-key is idempotent (FR-007/FR-014).
- **FR-024**: System MUST apply a license-state change to LIVE leases per a configurable, per-reason policy: on **revocation** (terminal) the server MUST proactively refuse to renew and MUST reclaim the license's live leases so the seats free within the sweep interval (near-immediate enforcement); on **suspension** or **expiry** the default is lapse-on-timer (live leases keep their seat until TTL + grace, only new acquires are refused). Renew MUST re-check live license state so a renew against a revoked license is refused. The per-reason behavior (reclaim vs timer) is configurable.
- **FR-025**: System MUST keep the concurrency and node-lock dimensions independent by default — a floating acquire MUST NOT require a node-lock activation, and any activation reference on a lease is informational (FR-005). A plan MAY optionally require a valid current node-lock activation for the same machine to acquire a floating seat ("activated-devices-only" floating) — configurable and off by default. When this gating is enabled, an acquire MUST fail closed — refused with a distinct reason and no seat consumed — whenever no valid current activation resolves for the machine, so an absent, expired, or deactivated activation can never bypass the gate.
- **FR-026**: System MUST derive the pseudonymous holder-key using a per-tenant (or per-product/plan) holder-key salt — server-held and NEVER distributed to the client (unlike E009's SDK-distributed activation salt: floating is online, so the salt+hash is computed server-side from the client-supplied reference) — mirroring E009's per-tenant/per-product activation-salt model to bound cross-tenant and cross-holder correlation. The salt MUST be rotatable as a rare operational event; because renew/release operate on the stored lease row (not a recomputed holder-key), a rotation does NOT disturb LIVE leases — only NEW acquires derive their holder-key under the rotated salt, and any pre-rotation live lease lapses on its own TTL + grace timer (no auto-migration across a rotation, mirroring E009).

### Key Entities *(include for product or technical specs if feature involves data)*

- **Lease**: a transient record that one holder is occupying one concurrency seat of a license. Attributes: owning tenant, the license it belongs to, a pseudonymous holder-key (the salted hash of a client-supplied holder reference, scoped per the configured concurrency scope — session/machine/user, FR-023), status (live | released | reclaimed), acquired-at, last-renewed-at, expires-at (server-computed), a monotonic generation/fence counter for stale-renew rejection, and an optional reference to a node-lock activation when the product is both node-locked and floating. Invariant: at most one live lease per (license, holder-key); a license's live concurrency usage is the count of its live (non-expired, non-reclaimed) leases, which MUST never exceed the effective cap `max_concurrent + concurrency_overage` (FR-003/FR-012). Lease records are pseudonymized and retention-bounded (GDPR-erasable).
- **License** (E008, consumed): must be active to acquire; supplies the concurrency cap (`max_concurrent`), concurrency scope, overage allowance, lifecycle timings, and per-reason live-lease policy, snapshotted at issuance alongside `max_activations`. A suspended or expired license blocks new acquisitions and lets live leases lapse on their own timer (default), while a **revoked** license additionally triggers proactive reclamation of its live leases (configurable per reason, FR-024).
- **Activation** (E009, related): the node-lock binding; a lease MAY reference an activation when a product enforces both a device cap and a concurrency cap. Concurrency (`max_concurrent`) and device (`max_activations`) caps are independent dimensions; by default a floating acquire is not gated on an activation, though a plan may optionally require one (FR-025).

## Assumptions & Risks *(mandatory)*

### Assumptions

- Floating seats are an **online** capability: the licensed application can reach the lease service to acquire, heartbeat, and release; a fully offline machine cannot hold a floating seat (offline node-lock remains E009).
- The concurrency cap (`max_concurrent`) and overage policy are plan/license attributes snapshotted like `max_activations`; this epic adds and enforces the attribute but does not build the plan-authoring UI (E007).
- The runtime lease surface is authenticated by a scoped runtime API key (E005); the admin lease registry/force-release uses the console session + RBAC + CSRF (E005), consistent with E009's activation surfaces.
- Lifecycle timings are per-plan configurable with research-informed defaults: heartbeat interval 10 min, lease TTL 30 min (invariant TTL ≥ 3× heartbeat), grace window 5 min before reclamation, sweep interval 1 min — server/plan settings, not per-request client choices. The E004 signer sits on the acquire/renew path to mint the signed lease handle (FR-022), reusing existing crypto (no new signer).
- The licensed application is trusted to acquire/release honestly (honest-client threat model, same as E009): server-side race-safe accounting, anti-replay, rate limiting, and reclamation bound abuse, but a hostile local user is out of scope; the server (not the client) is authoritative for the seat count.

### Risks

- **Lease-accounting race** *(likelihood: medium, impact: high)*: incorrect locking could over-allocate seats under concurrent acquisition — mitigated by atomic per-license count+insert (advisory lock or FOR-UPDATE counter) proven by a concurrency test, reusing E009's race-safe seat pattern.
- **Reclaim/renew double-count** *(likelihood: medium, impact: high)*: a late heartbeat racing a reclaim could revive a reclaimed seat and exceed the cap — mitigated by the expiry/status predicate plus a monotonic fencing/generation guard (FR-011).
- **Heartbeat storm / rate-limit collision** *(likelihood: medium, impact: medium)*: a large fleet heartbeating in lockstep (or after mass expiry) could trip rate limits or contend on the hot license row — mitigated by jittered client heartbeats, a threshold sized for heartbeat cadence (FR-017), and a tiny per-license critical section.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `lease` (license↔holder concurrency-seat occupancy: pseudonymous scoped holder-key, status, expiry, generation fence, optional activation reference).
- `NEW-API` — runtime lease acquire / renew (heartbeat) / release REST authenticated by a scoped runtime API key; admin lease-registry and force-release routes behind the console session.
- `NEW-UI` — console "Concurrency / Leases" view (per-license live leases, used-vs-cap, admin force-release) within the Licensing area.
- `MIGRATION` — new `lease` table (tenant-scoped, forced RLS, at most one live lease per license+holder-key, race-safe concurrency accounting); add the `max_concurrent` cap, concurrency scope, overage allowance, lifecycle timings, and per-reason live-lease policy to the plan/license snapshot. Sequential migration after `0010_billing.sql`.
- `NEW-WORKER` — time-driven lease-reclaim sweeper (fail-open, unref'd, synthetic-actor audit), mirroring the E013 CRL / E014 grace-reclaim worker pattern.
- `NEW-CONFIG` — per-plan lifecycle timings (heartbeat/TTL/grace/sweep, invariant TTL ≥ 3× heartbeat); per-plan concurrency **scope** (session|machine|user, default session — FR-023); per-plan concurrency cap (`max_concurrent`; absent ⇒ floating disabled, fail-closed — FR-005) and optional integer soft-cap overage allowance (default 0); per-reason live-lease policy on license-state change (revoke ⇒ reclaim, suspend/expire ⇒ timer — FR-024); optional "activated-devices-only" gating (default off — FR-025); signed-lease-handle toggle (default on — FR-022); lease-surface rate limits (sized for heartbeat cadence); acquire idempotency-token settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: A licensed app acquires a seat against an active license and receives a lease with a server-set expiry within the same success path.
- **SC-002** [US1]: For a license with C free seats — C measured against the **effective cap** `max_concurrent + concurrency_overage` (FR-003/FR-012), which is the exact target the concurrency race test asserts exactly-C-of-N against — exactly C of any number of concurrent acquisitions succeed and the live-lease count never exceeds that effective cap.
- **SC-003** [US1]: An acquire beyond a hard cap is refused with a distinct reason naming the cap, and no lease is recorded.
- **SC-004** [US1]: An acquire against a suspended, revoked, or expired license is refused with a distinct reason and consumes no seat.
- **SC-005** [US2]: Renewing a live lease extends its expiry and leaves the live-lease count unchanged; repeated renewals never consume an additional seat.
- **SC-006** [US2]: After a lease is released, a different session can immediately acquire the freed seat; a repeated release on an already-released or unknown lease succeeds without error and never lowers the live count below the true value.
- **SC-007** [US3]: A lease whose expiry plus grace has elapsed with no renewal is reclaimed by the sweeper and its seat becomes available for a new acquire, with no operator action.
- **SC-008** [US3]: A stale renewal arriving after its lease was reclaimed is rejected and no seat is double-counted; the reclaim sweeper failing on one license does not block acquire/renew/release elsewhere.
- **SC-009** [US4]: Under a soft cap, an acquisition within the overage allowance succeeds and is metered to the append-only audit log, while one beyond the allowance is refused with `seat_capacity_exhausted` (distinguished from the base-cap refusal by its `details`); the hard-cap-at-capacity refusal is covered by SC-003.
- **SC-010** [US5]: An operator can view a license's live leases (pseudonymous identity, status, timestamps) and concurrency-used-vs-cap; a viewer cannot force-release and the denied attempt is recorded as a security event, while an admin force-release frees the seat.
- **SC-011** [US1]: A replayed acquire (reused idempotency token) creates no second lease and consumes no second seat.
- **SC-012** [US5]: An actor or API key from one tenant cannot see or mutate another tenant's leases; a cross-tenant lease reference resolves to not found.
- **SC-013** [US5]: A missing or mismatched CSRF token on an admin force-release is refused fail-closed (403) and recorded as a security event.
- **SC-014** [US2]: When lease requests from one API key exceed the configured rate threshold, further requests are refused with `429` + `Retry-After` and each refusal is audited, without impeding legitimate heartbeat cadence.
- **SC-015** [US5]: No lease record, response, log, or audit entry ever contains a raw hardware identifier or a signing private key — only pseudonymous holder-key and, at most, a public signed handle with an opaque key id.
- **SC-016** [US1]: Under `machine` scope two instances on one machine share a single seat, under `session` scope they consume two, and under `user` scope two instances of the same named user share one seat — the configured concurrency scope determines the holder-key and thus the count.
- **SC-017** [US3]: A revoked license's live leases are proactively reclaimed within the sweep interval, while a suspended license's live leases persist until TTL + grace (per-reason live-lease policy, FR-024).
- **SC-018** [US1]: The signed lease handle returned on acquire verifies as tamper-evident against the E004 public key and is bounded by the heartbeat interval (well within the lease TTL), so the residual offline-verifiable window after an early release/reclaim is at most one heartbeat cycle; a tampered handle fails verification.
- **SC-019** [US1]: An acquire against a license with no `max_concurrent` (floating not entitled) is refused fail-closed with a distinct "no concurrency entitlement" reason.
- **SC-020** [US1]: A runtime lease call (acquire/renew/release) is refused fail-closed when the caller lacks the required `lease` scope — a missing or invalid API key returns 401 (unauthenticated) and a resolvable key without the `lease` scope returns 403 (unauthorized) — and no seat is consumed.
- **SC-021** [US1]: When the E004 signer is unavailable while signed-handle mode is on, an acquire is refused fail-closed (503) with no seat consumed and no lease persisted, and a renew leaves the existing lease and its seat unchanged; a plain-authorization deployment is unaffected.
- **SC-022** [US1]: With "activated-devices-only" gating enabled, an acquire whose machine has no valid current node-lock activation is refused fail-closed with a distinct reason and consumes no seat; with gating off, an acquire succeeds without any activation.
- **SC-023** [US1]: The holder-key salt is server-held and never returned to or distributed to the client; rotating the salt leaves every LIVE lease intact (renew/release keep operating on the stored row) while only NEW acquires derive their holder-key under the rotated salt (FR-026).

## Clarifications

### Session 2026-07-22

- Q: Concurrency-counting UNIT (FR-023)? → A: Configurable per-plan scope — `session`/instance (default), `machine` (E009 fingerprint), or `user` — with a hard "one live lease per (license, holder-key)" invariant to control illegal duplicates/over-concurrency regardless of scope.
- Q: License suspend/revoke/expire effect on LIVE leases? → A: Configurable by reason — revocation proactively reclaims live leases (near-immediate); suspension/expiry lapse-on-timer (default); renew re-checks license state (FR-024).
- Q: Lease-grant response shape (signed handle vs plain)? → A: Most-secure-yet-flexible — a signed short-TTL lease handle via the E004 signer (public + opaque key id, no new crypto, tamper-evident, verifiable by a local gate between heartbeats) by default; plain authorization is a per-deployment opt-out (FR-022).
- Q: Who mints the pseudonymous holder identity? → A: Most-secure-yet-flexible — a client-supplied STABLE opaque holder reference, salted+hashed server-side (raw never stored), bound to the single-use anti-replay token so re-acquire dedupes across restarts (FR-001/FR-014/FR-020).
- Q: Soft-cap overage units/default? → A: Absolute integer seat count (`concurrency_overage`), default 0 (hard cap); effective cap = `max_concurrent + concurrency_overage` (FR-012). *[applied default, flexible+secure]*
- Q: Lifecycle timings + rate-limit defaults? → A: Per-plan configurable with research defaults — heartbeat 10 min, TTL 30 min (invariant TTL ≥ 3× heartbeat), grace 5 min, sweep 1 min; rate limit a small multiple of heartbeat cadence per key (FR-009/FR-017). *[applied default]*
- Q: `max_concurrent` absent (floating not sold)? → A: New independent attribute; absent ⇒ floating disabled and acquire refused fail-closed with a distinct "no concurrency entitlement" reason (FR-005). *[applied default, fail-closed]*
- Q: Lease↔node-lock activation coupling for dual-cap products? → A: Independent by default (activation reference informational); optional per-plan "activated-devices-only" gating, off by default (FR-025). *[applied default]*

## Stress-Test Findings

### Session 2026-07-22

- **STF-001** (severity: LOW, category: consistency) [RESOLVED inline]: The Q2 resolution (FR-024) has E015 proactively reclaiming its own live leases on a **revocation** event, which could read as overlapping the Excluded "revocation propagation — owned by E013." Affected: FR-024, License entity, Scope/Excluded. **Given** a reviewer reading Scope/Excluded, **When** they compare it to FR-024, **Then** the boundary between "E015 reclaims its own leases server-side" and "E013 propagates revocation to clients" must be explicit. **Resolution**: clarified the Excluded bullet to state E015 reacts to a revocation event by reclaiming its own leases (server-side seat hygiene) while client/token propagation remains E013's — no functional overlap.

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Floating (concurrent) license | A license that caps simultaneous use — a shared pool of concurrency seats — rather than the number of installed machines. |
| Concurrency cap (`max_concurrent`) | The maximum number of live leases (simultaneous seats) a license permits; independent of the node-lock device cap (`max_activations`). |
| Lease | A transient record that one holder occupies one concurrency seat for a bounded, renewable period; released on exit or reclaimed when it lapses. |
| Lease TTL | The server-set validity window of a lease; a seat is held only until its expiry unless renewed. |
| Heartbeat (renew) | A periodic client call that extends a held lease's expiry, keeping the seat while the session runs. |
| Grace window | Extra time after a lease's expiry before the sweeper reclaims it, absorbing transient client/network glitches. |
| Reclamation | The automatic return of a lapsed lease's seat to the pool by the time-driven sweeper (dead-machine recovery). |
| Overage (soft cap) | An optional bounded allowance to acquire above the base cap, metered to the audit log for later true-up instead of being refused. |
| Fencing / generation guard | A monotonic per-lease counter used to reject a stale renewal that races a reclamation, preventing seat double-counting. |
| Holder / holder-key | The party occupying one concurrency seat, identified by a salted hash of a client-supplied reference scoped per the configured concurrency scope (session/instance, machine, or user). |
| Concurrency scope | The per-plan setting (session \| machine \| user, default session) that determines what a seat is counted against and how the holder-key is derived. |
| Lease handle | The signed, short-TTL, tamper-evident artifact returned on acquire/renew (E004 signer; public + opaque key id) that a local gate can verify between heartbeats; the server remains authoritative for the seat count. |
| Security event | An audit entry flagged as security-relevant (the `security_event` marker) — emitted on an authentication/authorization/RBAC/CSRF denial, a rate-limit breach, or a viewer's denied force-release — as distinct from a routine operational audit entry (a successful acquire/renew/release/reclaim/force-release). Referenced by FR-016/FR-017 and verified by SC-010/SC-013. |

## Compliance Check

**Verdict**: PASS-WITH-NOTES — governance-clean; no CRITICAL project-instructions violation. Non-blocking items to carry into Planning.
**Checked against**: project-instructions.md v1.2.0, AGENTS.md. **Date**: 2026-07-20.

### Non-negotiables verified

- **Principle I (Offline-first; signing key never exposed)**: PASS. Floating seats are scoped as an explicitly ONLINE, server-authoritative concurrency layer that does NOT alter or weaken offline node-lock verification (Scope/Excluded; FR-005 enforces `max_concurrent` independently of `max_activations`; offline-verifiable node-lock credentials remain E009's). FR-022 forbids exposing any signing private key or lease secret, returns only a public artifact + opaque signing-key id, and reuses the E004 signer with NO new crypto; SC-015 reinforces.
- **Principle II (Multi-tenant isolation + RBAC)**: PASS. FR-002 (scoped runtime API key, fail-closed on missing scope), FR-015 (tenant-scoped registry behind console RBAC), FR-016 (double-submit CSRF, fail-closed 403, audited), FR-019 (tenant isolation fail-closed; cross-tenant ref → not found), forced-RLS `lease` table (MIGRATION signal); verified by SC-012/SC-013.
- **Principle III (Single security core + append-only audit)**: PASS. FR-018 append-only audit of every acquire/renew/release/reclaim/force-release/denied/limit-exceeded; FR-013 meters soft-cap overage to the append-only audit; FR-022 reuses the E004 signer with no per-language crypto reimplementation.
- **PII minimization**: PASS. FR-020 stores only pseudonymous holder identity (salted hash / opaque session id), persists/logs no raw hardware identifiers, and places lease records on the retention-bounded GDPR-erasure path; SC-015 verifies.
- **Anti-replay + rate limiting**: PASS. FR-014 single-use client-supplied acquire token (idempotent/anti-replay), with idempotent renew (FR-007) and release (FR-008); FR-017 per-API-key rate limit with `429 rate_limited` + `Retry-After` + audited security event; verified by SC-011/SC-014.
- **Raw-SQL / migration-ordering / src-layout conventions**: PASS. MIGRATION signal sequences after `0010_billing.sql` (highest existing migration confirmed `0010`), so the next slot `0011` is free — no ordering conflict; no ORM introduced (consistent with node-postgres raw-SQL migrations); implementation HOW correctly deferred to Plan.

### Must-reconcile before / during Planning (non-blocking)

- FR-023 concurrency-counting scope was RESOLVED in Clarify (Session 2026-07-22): a per-plan configurable scope (session default / machine / user) with a "one live lease per (license, holder-key)" invariant; the marker is cleared.
- Reserve migration `0011_*.sql` at Plan time and re-verify no parallel epic has claimed `0011` before authoring the schema.
- FR-022's signed-lease-handle is conditional; Plan MUST confirm whether any signed handle is actually required and, if so, reuse the E004 signer only — introduce no new signing surface.
