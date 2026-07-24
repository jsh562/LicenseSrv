# Research Report — Floating & Concurrent Seat Leases

**Context**: Best practices for concurrent-use (floating) licensing via seat LEASES in a multi-tenant Node/TS + PostgreSQL license server, offline-first with an online control plane. Extends existing node-locked activation (per-license `max_activations`, E009) with a distinct floating-lease model. Purpose: inform story priorities, acceptance criteria, and pre-identify edge cases for the spec.

## 1. Floating vs node-locked models
Floating caps *simultaneous* sessions regardless of install count (first-come-first-served seat, returned on exit); node-locked is a permanent per-machine activation, offline-capable, cheaper per seat. Coexist on one plan by treating them as separate enforcement dimensions: `max_activations` (installs/devices) vs a new `max_concurrent` (live leases). Model a lease as a transient seat holder distinct from the activation registry. A license/plan may carry both caps independently.
Src: keygen floating-licenses; licenseseat.

## 2. Lease lifecycle & TTL/heartbeat
acquire → renew (heartbeat extends `expires_at`) → release (explicit) → reclaim (TTL lapse). Set TTL ≥ 3× heartbeat interval and ≥ 2× worst client pause (e.g. 10-min heartbeat → ~30-min TTL; keygen default heartbeat 10 min). Add a grace window so a transient glitch doesn't cull a live client. Renew must be idempotent: `expires_at = now + ttl`; repeated renews neither corrupt state nor double-count. Heartbeat on a background scheduler with jitter to avoid renewal storms.
Src: keygen; singhajit lease pattern.

## 3. Dead-machine reclamation
A lease is reclaimable once `expires_at + grace < now` with no renew (a "zombie" seat holder). Reclaim via a periodic sweeper that flips expired leases to released so the seat returns to the pool. Make reclaim vs renew mutually exclusive: guard renew with a status/expiry predicate in the UPDATE `WHERE`, so a renew arriving after reclaim fails and the client must re-acquire. Use a per-lease generation/fencing counter to reject stale renews. Never let a reclaim and a late renew count the same seat twice.
Src: keygen; singhajit.

## 4. Race-safe accounting in PostgreSQL
Enforce `active_leases ≤ capacity` atomically; a `WHERE count(*) < max` check outside a lock races and over-allocates. Options: (a) transactional advisory lock keyed by `license_id` (`pg_advisory_xact_lock`) wrapping count+insert — simplest correctness; (b) `SELECT ... FOR UPDATE` on a per-license seat-counter row, then conditional insert; (c) atomic conditional INSERT gated by a capacity predicate. Advisory locks avoid MVCC row bloat but serialize the hot license row — keep the critical section tiny and lock per-license (never global). This mirrors the race-safe seat locking E009 already proves for activations.
Src: postgresql.org explicit-locking; advisory-lock article.

## 5. Overage / burst handling
Soft cap = allow temporary overage, meter+alert for later true-up (an up-sell signal); hard cap = refuse at capacity. Vendors commonly configure per-policy overage (e.g. a fixed burst allowance or overage percentage above base). Recommend: default hard-refuse at capacity for enforcement integrity; expose an optional per-plan soft-cap/overage allowance that meters overage to the append-only audit log for periodic true-up rather than blocking. Overage priced above base unit is the norm.
Src: keygen; stripe usage-caps.

## 6. Edge cases & failure modes
- Clock skew: compute TTL/expiry server-side (server/monotonic time), never trust client wall clock.
- Never-releasing client (crash/kill): TTL + sweeper reclaims; explicit release optional.
- Partition (client alive, can't heartbeat): grace window, then client must stop using the seat once its local lease lapses and re-acquire on reconnect.
- Lease-stealing / stale renew: fencing token / generation guard rejects it.
- Thundering-herd reacquire after mass expiry: jittered heartbeat + backoff.
- At-exactly-capacity boundary: count+insert must be atomic (topic 4) so the N+1 acquire deterministically refuses.
Src: singhajit; keygen.

## Summary
Model floating seats as TTL-bounded leases (idempotent heartbeat renew, sweeper-based reclaim with grace) kept fully separate from the existing node-locked activation registry, so one plan can enforce device and concurrency caps independently. Correctness hinges on atomic per-license count+insert (advisory lock or FOR-UPDATE counter) and a reclaim-vs-renew guard with fencing/generation to prevent double-counting. Default to hard-refuse at capacity with an optional per-plan metered soft-cap for overage true-up.

## Existing code to reconcile against
Node-locked accounting: `src/server/modules/activation/` (`activate.ts`, `registry.ts`, `deactivate.ts`); heartbeat/online enforcement: `src/server/modules/enforcement/` (`heartbeat.ts`, `checkin-repo.ts`). The floating-lease model sits alongside these, not inside `max_activations`.

## Sources
| URL | Topic |
|-----|-------|
| keygen.sh/docs/choosing-a-licensing-model/floating-licenses/ | 1,2,3,5,6 |
| licenseseat.com/floating-license | 1 |
| singhajit.com/distributed-systems/lease/ | 2,3,6 |
| postgresql.org/docs/current/explicit-locking.html | 4 |
| medium (pg_advisory_xact_lock) | 4 |
| stripe.com/resources/more/usage-caps | 5 |
