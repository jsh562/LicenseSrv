---
adr_id: ADR-0012
status: accepted
date: 2026-07-22
tags: [floating-licensing, concurrent-seats, lease, ttl-heartbeat, dead-machine-reclamation, race-safe-accounting, advisory-lock, generation-fence, online-enforcement, signed-lease-handle, concurrency-scope, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00016-floating-and-concurrent-seats/spec.md, specs/00016-floating-and-concurrent-seats/plan.md, specs/00010-machine-activation-and-seats/data-model.md, src/server/modules/signing/token.ts]
---

# ADR-0012: Floating and Concurrent-Seat Leasing Model — Online TTL-Bounded Seat Leases with Race-Safe Accounting and Dead-Machine Reclamation

## Status

Accepted.

## Context

Node-lock activation (E009) caps how many *machines* may install a license via `max_activations`: a per-machine, offline-verifiable binding the in-process E001 verifier checks locally with zero network. That model cannot express **concurrent-use** licensing — a pool of N simultaneous seats shared across a fleet, where any instance may run as long as a free seat exists and the seat returns when that instance stops. A device cap counts installations; a concurrency cap counts *simultaneous use*, and the two are different products a vendor sells.

Epic E015 (Floating & concurrent seats, `{PRD:CAP-010}`) adds the concurrency dimension. It must (a) enforce a shared pool of simultaneous seats with a hard, race-safe cap, (b) recover a seat automatically when a machine crashes, is killed, or is partitioned without releasing it — otherwise a single crash strands a seat forever and the pool bleeds capacity — and (c) do so **without weakening or altering offline node-lock**. This is the first time the system models simultaneous-use occupancy, and the shape of that model is system-shaping rather than feature-local:

- **Concurrency is a NEW, independent seat dimension.** `max_concurrent` is not derived from and does not fall back to `max_activations`; a plan MAY carry both caps and they enforce separately. Whether a "seat" means an install (E009) or a live session (E015) is a project-wide invariant, not an implementation detail of one endpoint.
- **Floating is inherently ONLINE.** The live-lease count is server-authoritative — a fully offline machine cannot participate in a shared concurrency pool. This is a permanent property of concurrent-use enforcement, not an MVP simplification, and it must be recorded so it is never confused with (or allowed to regress) the offline-first node-lock guarantee (Principle I).
- **The pattern reuses the single security core.** The lease grant, if signed, reuses the E004 signer with NO new crypto; the machine-scope holder-key reuses the E009 fingerprint; reclamation reuses the E013/E014 fail-open-worker pattern; the concurrency cap is snapshotted onto the license like E008/E007's `max_activations`. How the system leases, accounts, fences, and reclaims a seat is the freeze point downstream work (e.g. E016 usage-metered true-up) consumes.

The decision must stay consistent with what is already committed and NOT re-decide it:

- **E009 owns node-lock.** The per-machine activation cap, the fingerprint, and the offline LIC1 credential's local verification are E009's and are UNCHANGED here. A floating acquire does not require an activation by default; any activation reference on a lease is informational.
- **E004 owns license signing.** The per-product Ed25519 signer/keyring in KMS/HSM (ADR-0003) is the single crypto core (Principle III). The lease handle reuses that signer with a domain-separated payload; it introduces no new signing surface and no new key custody.
- **E008/E013 own the license lifecycle and its client propagation.** `license.status ∈ {active, suspended, revoked}` and the online validate/heartbeat + signed-CRL propagation model (ADR-0010) are unchanged. E015 READS live license status and REACTS to a revocation event by reclaiming its own live leases (server-side seat hygiene); it does not mutate the lifecycle enum or re-implement client propagation.

What this ADR decides: the **online seat-lease concurrency model** — how a floating seat is leased, renewed, released, reclaimed, accounted race-safely, fenced against double-count, granted, scoped, and tied to license state — as one project-level contract that E015 implements and future concurrency/metering work reuses.

## Decision Drivers

- **New concurrency dimension, offline node-lock untouched (Principle I)**: `max_concurrent` is independent of `max_activations`; adding floating must not alter, weaken, or route through the offline-verifiable node-lock path — a never-connected machine's node-lock behaviour is unchanged.
- **Race-safe accounting (security-critical)**: concurrent acquisitions for the last free seat(s) must never over-allocate; the live-lease count is authoritative on the server and must never exceed the cap, even under a thundering herd.
- **Deterministic dead-machine recovery**: a crashed/killed/partitioned client that never releases must have its seat returned automatically within a bounded window, with no operator action and no client cooperation.
- **Reclaim/renew must never double-count**: a late heartbeat racing a reclamation must not revive a reclaimed seat or count it twice.
- **Single security core, no new crypto (Principle III)**: reuse the E004 signer for the lease handle and the E009 fingerprint for machine scope; introduce no new token type and no new key custody.
- **Server-authoritative under an honest-client threat model**: the server (not the client) owns the seat count; server-side accounting, anti-replay, rate limiting, and reclamation bound abuse, but a hostile local user is out of scope (same posture as E009).
- **Commercial flexibility**: per-plan concurrency **scope** (session/machine/user) and hard-vs-soft cap without redesigning enforcement — one invariant governs all modes.
- **Multi-tenant isolation, audit, PII minimization (Principles II/III)**: leases are tenant-scoped fail-closed, every operation is append-only audited, and only a pseudonymous holder-key (never a raw hardware identifier) is stored.
- **Reclamation must never block the live surface**: the sweeper is fail-open — an error on one license or tenant never impedes acquire/renew/release elsewhere.

## Considered Options

### Option A: Online TTL-bounded seat lease — advisory-lock race-safe accounting, generation-fenced reclaim/renew, E004-signed short-TTL handle, per-plan scope + per-reason policy (composite model)

Adopt one concurrency model with six parts:

1. **A floating seat is a TTL-bounded LEASE with a full lifecycle: acquire → heartbeat-renew → release → sweeper-reclaim.** Acquire records a lease against an active license with a server-set expiry (TTL); heartbeat renews it idempotently while the app runs; release frees the seat immediately on graceful exit; a time-driven, fail-open sweeper reclaims a lease whose expiry + grace has elapsed with no renewal. The server is the sole authority for the live count.
2. **`max_concurrent` is a NEW dimension, independent of `max_activations`.** It, the concurrency scope, overage allowance, lifecycle timings, and per-reason live-lease policy are plan attributes snapshotted onto the license at issuance (like `max_activations`). Absent `max_concurrent` ⇒ floating is not entitled and acquire is refused fail-closed with a distinct "no concurrency entitlement" reason — an absent cap is NEVER treated as unlimited and NEVER falls back to `max_activations`.
3. **A per-plan concurrency SCOPE (session | machine | user)** with a hard **"one live lease per (license, holder-key)"** invariant. The holder-key is the salted hash of a client-supplied stable opaque reference keyed per scope (`session` = instance reference (default), `machine` = the E009 fingerprint, `user` = a named-user reference); re-acquire from the same holder-key is idempotent (returns/renews the existing lease, consumes no second seat) regardless of scope.
4. **Race-safe accounting via a per-license `pg_advisory_xact_lock` wrapping count+insert.** Only the hot license row is serialized, in a tiny critical section, so exactly the available number of concurrent acquires succeed and the live count never exceeds `max_concurrent` (+ any soft-cap allowance) — reusing E009's proven race-safe seat pattern with no MVCC row bloat.
5. **Reclaim/renew mutual exclusion via a monotonic generation fence.** Renew updates `WHERE status='live' AND expires_at>now() AND generation=$g` and bumps `generation`; reclaim/release set a terminal status. A late renew arriving after reclamation matches 0 rows and is rejected (`lease_not_renewable`, re-acquire), so a reclaimed seat is never revived or double-counted.
6. **An E004-signed short-TTL lease handle with domain separation `LICSRV-LEASE-v1` (no new crypto), and a per-reason license-state effect.** Acquire/renew return, by default, a tamper-evident public handle + opaque signing-key id (never the signing key), bounded by the lease TTL so a local gate can verify a held lease between heartbeats while the server stays authoritative; a deployment MAY toggle to plain server-side authorization (lease id + expiry). On **revocation** (terminal) the server proactively refuses to renew and reclaims the license's live leases via the sweeper path (near-immediate seat recovery); on **suspension/expiry** the default is lapse-on-timer (live leases keep their seat until TTL + grace, only new acquires are refused). The behaviour is configurable per reason; renew re-checks live license state.

- **Pros**: Enables concurrent-use licensing with a hard, race-safe cap while leaving offline node-lock (E009) completely untouched — the two seat dimensions enforce independently; deterministic dead-machine recovery within TTL + grace with no operator or client action; a late heartbeat can never double-count a reclaimed seat (fence + predicate); reuses the single security core — the E004 signer (domain-separated, no new crypto), the E009 fingerprint, the E013/E014 fail-open-worker pattern, and the E008/E007 snapshot discipline; tenant-isolated, fully audited, and PII-minimized (pseudonymous holder-key only); one "one live lease per (license, holder-key)" invariant governs every scope and both cap modes, so per-plan flexibility needs no enforcement redesign; the lease-accounting/fencing/reclaim contract is exactly what downstream concurrency/metering work reuses.
- **Cons**: Floating is ONLINE-only — an offline machine cannot hold a floating seat (an explicit, disclosed tradeoff); worst-case dead-seat reclamation lag ≈ TTL + grace (a crashed seat is unavailable to others until then); the E004 signer sits on the acquire/renew hot path when the handle is enabled (signer load bounded by heartbeat cadence, and the handle is toggleable off); a new fail-open reclaim worker plus the revoke-reclaim path must be run and monitored; the per-license advisory lock serializes the hot license row (a tiny critical section, but a large lockstep fleet contends).

### Option B: Naive count-check accounting (`WHERE live_count < cap`) with no serialization

Enforce the cap by reading the live-lease count and inserting only if it is below the cap, without a per-license lock.

- **Pros**: Simplest possible accounting; no advisory lock or counter to manage.
- **Cons**: Races and over-allocates — two concurrent acquires both read `count = cap-1`, both pass the check, and both insert, exceeding the cap. This is precisely the security-critical control the model exists to guarantee; a check-then-insert without serialization cannot hold the invariant under concurrency. Rejected.

### Option C: Redis reserved-seat counter as the concurrency accountant

Hold the live-seat count (and reservations) in a Redis atomic counter fronting Postgres, decrementing on acquire and restoring on release/reclaim.

- **Pros**: Very fast atomic increment/decrement; offloads the hot-row contention from Postgres; a natural home for a "reserved" seat state.
- **Cons**: Adds a second stateful store to the critical path that must be kept consistent with the authoritative `lease` rows (dual-write / drift risk), plus new operational and failure surface (Redis availability, reconciliation on divergence) — heavier than the problem needs today. A per-license `pg_advisory_xact_lock` count+insert holds the same invariant against the single source of truth with no extra store. Rejected **for now**, but noted as a viable FUTURE scaling option if per-license advisory-lock contention on very large lockstep fleets ever becomes a measured bottleneck.

### Option D: Plain unsigned authorization (lease id + expiry, no signed handle)

Return only a lease id and an expiry on acquire/renew, with no signed artifact.

- **Pros**: No signer on the hot path; the smallest possible grant payload.
- **Cons**: Less secure and less useful — a local gate cannot verify a held lease between heartbeats without calling the server, and the grant is not tamper-evident. Reusing the E004 signer for a short-TTL, domain-separated handle costs no new crypto and yields an offline-checkable, tamper-evident grant while the server stays authoritative. Rejected as the DEFAULT; retained as a per-deployment opt-out where offline-verifiable handles are not needed.

### Option E: Fixed session-only concurrency scope

Count every running instance as one seat, with no per-plan scope choice.

- **Pros**: One counting rule; nothing to configure.
- **Cons**: Too rigid for real licensing — a vendor selling "N concurrent machines" or "N named users" cannot be expressed, so two instances on one machine (or one user on two devices) always burn two seats. A per-plan `session | machine | user` scope, all governed by the same "one live lease per (license, holder-key)" invariant, adds the flexibility with no change to the enforcement core. Rejected.

### Option F: Lazy on-read reclamation / database TTL expiry

Reclaim a lapsed seat opportunistically when the license is next read, or rely on a DB row-TTL/expiry job, instead of a dedicated sweeper.

- **Pros**: No standalone worker to run; reclamation "happens" as a side effect of reads.
- **Cons**: Non-deterministic recovery — a seat on an idle license (no reads) is never freed, so a crash on a low-traffic license strands the seat indefinitely; DB-TTL semantics vary and give no audit, no revoke-reclaim hook, and no fail-open isolation. A time-driven, fail-open sweeper gives bounded, deterministic recovery (≈ TTL + grace), doubles as the revoke-reclaim path, and mirrors the proven E013 CRL / E014 grace-reclaim worker pattern. Rejected.

## Decision Outcome

Chosen option: **Option A — the composite online seat-lease model: a TTL-bounded lease (acquire → heartbeat-renew → release → sweeper-reclaim) with per-license advisory-lock race-safe accounting, a monotonic generation fence for reclaim/renew mutual exclusion, an E004-signed short-TTL lease handle, a per-plan concurrency scope, and a per-reason license-state effect** — because it is the only option that enforces a hard, race-safe concurrency cap with deterministic dead-machine recovery while leaving offline node-lock untouched, reusing the single security core with no new crypto, and staying tenant-isolated, audited, and flexible per plan. Concretely, the model is fixed as:

1. **Floating seat = a TTL-bounded LEASE with the lifecycle acquire → heartbeat-renew → release → sweeper-reclaim.** The server sets the expiry from server/monotonic time (never a client wall clock), and the server is the SOLE authority for the live-lease count. Lifecycle timings are per-plan configurable with research defaults (heartbeat 10 min, TTL 30 min, grace 5 min, sweep 1 min) under the invariant TTL ≥ 3× heartbeat so one missed heartbeat never reclaims a live seat.
2. **`max_concurrent` is a NEW dimension independent of `max_activations`** — it, the scope, overage allowance, timings, and per-reason policy are snapshotted onto the license at issuance; absent `max_concurrent` ⇒ floating not entitled ⇒ acquire refused fail-closed ("no concurrency entitlement"), never treated as unlimited and never falling back to `max_activations`. The node-lock and concurrency caps enforce independently; a plan may carry both.
3. **A per-plan concurrency SCOPE (`session` default | `machine` = E009 fingerprint | `user`)** with the hard invariant **"at most one live lease per (license, holder-key)"**, the holder-key being the salted hash of a client-supplied stable opaque reference keyed per scope (raw never stored). Re-acquire from the same holder-key is idempotent in every scope.
4. **Race-safe accounting = a per-license `pg_advisory_xact_lock` wrapping count+insert** (reusing E009's seat-locking pattern), so under any number of concurrent acquires exactly the available seats are granted and the live count never exceeds `max_concurrent` (+ soft-cap allowance). A hard cap refuses at capacity (`seat_capacity_exhausted`); an optional soft cap admits an ABSOLUTE integer overage allowance above the base cap (default 0), meters each over-base acquire to the append-only audit log, and refuses beyond the allowance.
5. **Reclaim/renew mutual exclusion = a monotonic generation fence + status/expiry predicate.** Renew matches `status='live' AND expires_at>now() AND generation=$g` and bumps `generation`; a late renew after reclaim/expiry touches 0 rows and is rejected (`lease_not_renewable`), so a reclaimed seat is never revived or double-counted. The reclaim sweeper is time-driven and FAIL-OPEN — an error on one license/tenant never blocks the live surface elsewhere.
6. **Grant + license-state effect.** By default acquire/renew return an E004-signed short-TTL lease handle with domain separation `LICSRV-LEASE-v1` (a public, tamper-evident artifact + opaque signing-key id, bounded by the lease TTL — NO new crypto, the signing key never returned or logged); a deployment MAY opt out to plain authorization. On **revocation** the server proactively refuses to renew and reclaims the license's live leases via the sweeper path (near-immediate); on **suspension/expiry** the default is lapse-on-timer; behaviour is per-reason configurable and renew re-checks live license state.

This ADR fixes the online seat-lease concurrency MODEL. It does NOT re-decide the E009 node-lock cap/fingerprint/offline-credential semantics, the E004 signing-key custody, the E008 `license.status` lifecycle, or the E013 client-propagation model — all of which are reused unchanged.

## Consequences

### Positive

- Concurrent-use (floating) licensing is enabled with a hard, race-safe cap: exactly the available seats are granted under concurrent demand and the live count never exceeds `max_concurrent`, giving CAP-010 real enforcement teeth.
- Offline node-lock (E009) is completely untouched: `max_concurrent` and `max_activations` are independent dimensions that enforce separately, so adding floating neither alters nor weakens the offline-verifiable per-machine path (Principle I).
- Dead-machine recovery is deterministic and hands-off: a crashed/killed/partitioned client's seat returns to the pool within ≈ TTL + grace via the fail-open sweeper, with no operator action and no client cooperation.
- A late heartbeat can never double-count a reclaimed seat: the generation fence + status/expiry predicate make reclaim and renew mutually exclusive (a stale renew is rejected and re-acquires).
- The single security core is preserved (Principle III): the lease handle reuses the E004 signer with a domain-separated payload (no new crypto, no new key custody), machine scope reuses the E009 fingerprint, and reclamation reuses the E013/E014 fail-open-worker pattern.
- Leases are tenant-isolated fail-closed, every acquire/renew/release/reclaim/force-release/denial is append-only audited, and only a pseudonymous holder-key (never a raw hardware identifier) is stored on the GDPR-erasable path (Principles II/III).
- One invariant ("one live lease per (license, holder-key)") governs every concurrency scope and both cap modes, so per-plan flexibility (session/machine/user, hard/soft cap, per-reason policy) needs no enforcement redesign, and the lease-accounting/fencing/reclaim contract is directly reusable by downstream concurrency/metering work.

### Negative

- Floating is ONLINE-only: a fully offline machine cannot hold a floating seat because the live-lease count is server-authoritative. This is an explicit, disclosed tradeoff — offline-verifiable enforcement remains node-lock's (E009) job and is unchanged.
- Worst-case dead-seat reclamation lag ≈ TTL + grace: after a crash the seat is unavailable to other sessions until the sweeper reclaims it (bounded and disclosed; tunable per plan via the timings).
- The E004 signer sits on the acquire/renew hot path when the signed handle is enabled — added signer load bounded by the (jittered) heartbeat cadence, mitigated by per-plan TTL and the handle toggle.
- A new fail-open reclaim worker (plus the revocation-triggered reclaim path) must be run, monitored, and kept fail-open — additional operational surface alongside the live lease API.
- The per-license advisory lock serializes each hot license row; the critical section is tiny (count+insert), but a very large fleet heartbeating/acquiring in lockstep can contend on a single popular license.

### Neutral

- A Redis reserved-seat counter (already present in the stack for other uses) remains a viable FUTURE scaling option if per-license advisory-lock contention ever becomes a measured bottleneck; the PG advisory-lock model is sufficient for now and keeps a single source of truth.
- Lifecycle timings (heartbeat/TTL/grace/sweep), the soft-cap allowance, the per-reason live-lease policy, and the lease-surface rate-limit thresholds are per-plan/operator policy choices within this model, not separate architectural decisions.
- The client's obligation to stop using a seat once its lease lapses is a documented client responsibility (aligned with E013's online-enforcement client obligations); the server refuses to renew a reclaimed lease but does not enforce client-side seat behaviour here.
- Overage metered to the audit log under a soft cap is recorded for later true-up; consumption-based billing/aggregation of that metering is E016's scope, not this decision's.

## Links

- specs/00016-floating-and-concurrent-seats/spec.md — E015 (FR-001..FR-025, US1..US5, SC-001..SC-019); the acquire/heartbeat/release/reclaim, race-safe cap, scope, overage, and registry requirements this ADR fixes the model for.
- specs/00016-floating-and-concurrent-seats/plan.md — the feature-local tradeoffs AD-001..AD-008 (race-safe accounting, reclamation, reclaim↔renew fence, lease-grant shape, scope, cap storage, license-state effect, module placement) that instantiate this project-level model.
- specs/00010-machine-activation-and-seats/data-model.md — E009 node-lock: the per-machine `max_activations` cap, the device fingerprint (reused for `machine` scope and optional gating), and the offline LIC1 credential this ADR leaves unchanged as the distinct, independent seat dimension.
- src/server/modules/signing/token.ts — the E004 signer/keyring reused (with the domain-separated `LICSRV-LEASE-v1` payload) to mint the short-TTL lease handle; only the public artifact + opaque key id are exposed, never the signing key.
- ADR-0010 (Online-Enforcement Token and Revocation Model) — the online enforcement / revocation-propagation model this decision complements; E015 reacts to a revocation event by reclaiming its own live leases (server-side seat hygiene) while ADR-0010 governs client propagation.
- ADR-0011 (Billing-Webhook Integration and the External-Event → License-Lifecycle Model) — the billing-driven lifecycle whose suspend/revoke transitions this model reacts to via the per-reason live-lease policy.
- ADR-0003 (Signing-Key Custody & Scope) — the per-product Ed25519 signer/keyring the lease handle reuses with no new key custody.
- ADR-0004 (Multi-Tenancy Isolation Model) — the tenant-scoping the lease surface inherits (a tenant's actor/API key can neither see nor mutate another tenant's leases; cross-tenant reference → not found).
- ADR-0005 (Architecture Style — Modular Monolith) — the module seams the new `lease` module and the fail-open reclaim worker slot into.
- specs/00015-billing-driven-entitlement-automation/spec.md — E014 lifecycle transitions (suspend/revoke) that drive the license-state effect on live leases.
- specs/00014-online-enforcement-and-revocation/spec.md — E013 online enforcement / revocation propagation and the client-obligation posture this model aligns with.
- PRD CAP-010 (floating & concurrent seats); the E007 plan attributes and E008 license status/snapshot this model consumes; E016 usage-metered billing, which consumes the audit-logged soft-cap overage for true-up; project-instructions.md Principle I (offline-first / signing key never exposed), Principle II (multi-tenant isolation + RBAC), and Principle III (single security core, fully audited).
