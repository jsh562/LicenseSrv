# Research — E013 Online Enforcement and Revocation

Domain best practices for adding an online-enforcement path to an offline-first, multi-tenant license server. The offline-first model, LIC1 token, license status (active/suspended/revoked), machine activation, KMS/HSM signing, PASETO session tokens, monotonic clock anchor, and online validate p95<120ms SLO are fixed; this covers the "how".

## Short-lived token renewal / silent background renewal
Issue online tokens with a short TTL and renew silently in the background at ~50–70% of TTL (absorbs clock drift/jitter). Set TTL = the maximum acceptable revocation-propagation window; "revoke by ceasing to re-issue" then bounds staleness to one TTL. Offer per-plan TTL so high-tolerance/offline plans get longer windows and server load stays manageable. Avoid: TTLs so short they spike load / fail closed on network blips; renewing only at hard expiry (no skew margin); treating expiry alone as revocation.
Sources: duendesoftware.com (TTL/refresh/revocation); oauth.com access-token-lifetime.

## Revocation propagation models
Make short-TTL renewal the PRIMARY mechanism (bounded, self-healing, no per-request status call) and a signed CRL the FALLBACK for spans between renewals. Mirrors PKI's shift to short-lived certs; worst-case staleness = max(token TTL, CRL next_update). Avoid: OCSP-style per-request online status checks (latency on the p95<120ms path, fails-open when the responder is down); a single mechanism.
Sources: axelspire.com CRL/OCSP; smallstep.com ocsp-vs-crl.

## Heartbeat / lease semantics
Model check-in as a lease: cadence << token TTL, with a grace/tolerance window (allow N missed beats) before lapsing so transient outages don't strand paying users. Each heartbeat re-checks license status, activation/seat validity, expiry, AND entitlement/plan changes, then returns a freshly minted short-lived token. Use a nonce + monotonic counter for idempotency/anti-replay; reject stale/duplicate check-ins. Avoid: heartbeats that only bump expiry without re-checking status/entitlements; no grace window (false lockouts); replayable check-ins.
Sources: keygen.sh offline-licenses; reprisesoftware.com lease/grace.

## Offline-first preservation & bounded staleness disclosure
Never-connected/air-gapped clients keep working on their signed offline token until its own expiry; online enforcement is ADDITIVE and MUST NOT break them. Publish the bounded revocation-staleness window explicitly (= CRL next_update TTL + offline tolerance) and disclose it honestly as the "offline revocation gap." Provide file-based CRL import for air-gapped sites. Avoid: silently degrading air-gapped function; hiding the window; revoked-by-default for offline clients.
Sources: agilicus.com air-gap revocation; keygen.sh offline-first.

## Clock-tamper resistance on renewal
On each check-in persist a monotonic last-seen anchor (highest signed server time observed) and reject any local clock/token whose time precedes it; embed signed server time in the renewed token. Enforce a per-plan offline-tolerance window bounding how long a client runs without a fresh anchor. Avoid: trusting local wall-clock for expiry; assuming rollback is fully detectable offline — a never-connecting client with a frozen/rolled-back clock can't be caught until reconnect, so bound exposure with the tolerance window.
Sources: cicontinuity.co.uk monotonic-time; icnavigator.com secure-rtc time-stamping.

## Signed revocation list distribution
Publish a signed CRL (KMS/HSM key) with a version + next_update; serve via CDN with cache-control aligned to next_update. As revocations grow, move from full lists to delta CRLs and/or a bloom/filter-cascade (CRLite-style) to cap client download size; offer a downloadable file for air-gap import. Avoid: unsigned/unversioned lists; unbounded full-list growth; cache TTLs longer than next_update; no fallback when the CDN is unreachable.
Sources: mozilla.org CRLite filter-cascade; keyfactor.com CRL next_update/delta.

## Summary
Short-TTL silent renewal is the primary revocation path (staleness bounded to one TTL via "cease to re-issue"), backed by a signed, versioned, CDN-distributed CRL with delta/filter scaling as fallback. Preserve air-gapped clients untouched and disclose the bounded staleness window honestly. Anchor expiry to signed server time + a monotonic last-seen counter + a per-plan offline-tolerance window; accept that pure-offline perpetual rollback is only bounded, not eliminated. Heartbeats are leases with grace windows, nonce anti-replay, and full status/entitlement re-checks — not just expiry bumps.

## E008/E009 integration grounding
- E008 `license.status ∈ {active, suspended, revoked}` (revoked terminal) is the online-enforcement gate — the token deliberately omits status (the disclosed offline gap); "revocation/suspension take effect online at activation time (E009/E013)" which read `license.status`. Entitlements are the plan snapshot on the license.
- E009 `activation` (status active/deactivated; `machine_bound_token` = the offline LIC1 credential; seat = COUNT of active activations; `nonce` single-use anti-replay). E013 renews `machine_bound_token` short-lived and re-checks activation status/seat on each beat; a `last_seen`/anchor extends the row (additive migration).
