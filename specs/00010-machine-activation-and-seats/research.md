# Research — E009 Machine Activation and Seat Enforcement

Product research informing story priorities, success criteria, and edge cases — not implementation. This
feature binds `fingerprint` (N signal hashes) + `fpMin` (K) + `maxSkewSecs` into the E001 signed token,
verified OFFLINE by the existing Rust core.

## 1. Machine fingerprinting with drift tolerance
- **Recommend**: collect N stable signals (machine GUID, MAC, CPU, disk serial, board), persist only salted
  per-signal hashes, and re-activate when at least K of N match (fuzzy K-of-N, e.g. 3-of-5). Tolerates a
  RAM/NIC swap; a wholly-different machine (0–1 matches) is treated as new. Salted hashes keep raw
  identifiers off disk for GDPR/PII minimization.
- **Avoid**: exact all-signal match (breaks on any swap); K set too low (distinct machines collide).
### Sources
- https://docs.cryptlex.com/license-management/license-templates — Exact/Fuzzy/Loose strategies + thresholds
- https://wyday.com/limelm/features/why/ — fuzzy matching survives RAM/disk swaps without reactivation

## 2. Race-safe seat counting
- **Recommend**: enforce active-activations ≤ seat limit in one Postgres transaction — take a per-license
  transaction advisory lock (`pg_advisory_xact_lock`) or `SELECT … FOR UPDATE` the license row before
  count+insert. Back it with a UNIQUE (license_id, fingerprint) so idempotent re-activation reuses the seat,
  never a second. N concurrent attempts for S seats then yield exactly S successes.
- **Avoid**: count-then-insert under READ COMMITTED with no lock (classic over-allocation race); advisory
  locks are voluntary, so any code path skipping the lock still races.
### Sources
- https://www.postgresql.org/docs/current/explicit-locking.html — FOR UPDATE row locks + advisory locks
- https://on-systems.tech/blog/128-preventing-read-committed-sql-concurrency-errors/ — count race + FOR UPDATE fix

## 3. Anti-replay & idempotency
- **Recommend**: require a client idempotency key (or nonce) per activate request; store the first result
  keyed by (tenant, license, key) for a bounded TTL and replay it on retry so a seat is never double-counted.
  Rate-limit the runtime activate endpoint per license/IP to deter seat exhaustion and fingerprint
  enumeration. Follow OWASP ASVS: ≥128-bit nonce, short TTL (~300s), keys scoped per client.
- **Avoid**: unbounded nonce storage; unauthenticated or unlimited activate calls.
### Sources
- https://docs.stripe.com/api/idempotent_requests — idempotency-key store-and-replay pattern
- https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — replay/nonce, rate limiting

## 4. Deactivation & seat reclamation
- **Recommend**: support two paths — app self-service deactivation (frees its own seat) and operator/admin
  reclaim of a dead machine's seat from the console. Make deactivation idempotent: deactivating an
  already-free or absent machine succeeds and never drives the count negative.
- **Avoid**: coupling reclamation to liveness here. Time/heartbeat auto-reclaim needs an online channel and a
  monitor window — keep it out of the offline-first activation scope as a separate concern (E013/E015).
### Sources
- https://keygen.sh/docs/choosing-a-licensing-model/node-locked-licenses/ — first-come seats; deactivate to free a slot
- https://github.com/keygen-sh/example-python-machine-heartbeats — heartbeat auto-deactivation is a separate online monitor

## 5. Activation acceptance criteria & edge cases
- **Assert** measurable criteria: (a) activation past the seat cap refused with an explicit
  `machine_limit_exceeded` reason; (b) N concurrent activations for S seats → exactly S succeed; (c) K-of-N
  drift re-activation reuses the same seat (no new consumption); (d) replayed request with the same
  idempotency key returns the prior result, seat unchanged; (e) cross-tenant isolation — one tenant never
  sees or consumes another's seats; (f) activation against suspended/revoked/expired licenses refused with a
  distinct reason.
- **Avoid**: generic "activation failed" errors — each refusal needs a distinct, testable reason code.
### Sources
- https://keygen.sh/docs/activating-machines/ — activation flow, per-license fingerprint uniqueness, limit refusal
