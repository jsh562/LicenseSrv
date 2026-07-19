# Enforcement module (E013 — online enforcement & revocation)

Adds an **online** enforcement path on top of the offline-first core: `POST /v1/validate` and
`POST /v1/heartbeat` re-check a license + activation on every beat and, while valid, re-sign a **short-TTL
LIC1 renewal token** so an admin revocation reaches connected clients within a bounded window. Strictly
additive — the E001 offline verifier and the E009 long-lived `machine_bound_token` credential are unchanged.

## Runtime surface (`/v1`, `validate` scope, rate-limited)

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/validate` | Establish the session; mint the first short-TTL renewal token. |
| `POST /v1/heartbeat` | Silent periodic renewal of that token before it expires. |

Both take the same body (`activationId` and/or `machineBoundKey`, plus a single-use `nonce`) and return the
same `EnforcementResult`. They are the **same** enforcement query — one shared core (`runEnforcement` in
`validate.ts`) — so validate and heartbeat can never drift apart; the only difference is the audit action
(`enforcement.renewed` vs `enforcement.heartbeat`).

## Refusal semantics (AD-001)

Validate/heartbeat are enforcement **queries**, not mutations, so a non-valid outcome is a **`200` +
`verdict`**, never a 4xx:

- `verdict: "valid"` → a fresh `shortLivedToken` (+ `serverTime`, `renewAfter`, `expiresAt`).
- `verdict: "revoked" | "suspended" | "expired" | "deactivated"` → **no token**; renewal is refused by
  ceasing to re-issue, so the outstanding token lapses within its TTL.

The verdict is **re-evaluated every beat with no sticky state** — reinstating a suspended license resumes
renewal on the very next beat (FR-006). Only genuine faults use the error model: `400` (malformed), `401`
(no key), `403` (missing scope), `404` (unknown/cross-tenant), `409 nonce_replayed`, `429 rate_limited`,
`503 signer_unavailable`.

## Offline-first guarantee (FR-012, US5 — additive, non-regression)

E013 does **not** change any offline path:

- A **never-connected** activation (one that never calls validate/heartbeat) is **not revoked-by-default**.
  Its online-anchor columns `last_checkin_at` / `last_anchor_at` stay `NULL`, and its E009
  `machine_bound_token` keeps verifying **offline** via the E001 core to that credential's own `exp`.
- The online path **reads** the E009 credential to identify the activation; it **never writes, overwrites,
  or shortens** `machine_bound_token`. The short-lived renewal token is a **separate public artifact**,
  returned to the client and never persisted.
- The renewal token re-signs the **exact** E001 `LIC1` claims (same machine binding) via the existing E004
  signer — no new token type, no new key custody, no second client verifier ({SAD:ADR-0010}).

## Bounded revocation-staleness disclosure (FR-013, SC-006)

Revocation of a **connected** client is bounded to one renewal window (the token is not re-issued, so it
lapses at its `exp ≤ now + short-token TTL`). The honestly-disclosed **worst-case** staleness across all
clients (connected, CRL-fallback, and offline-tolerance) is returned **in-band** on every
validate/heartbeat response as `stalenessWindow`:

```
stalenessWindow.seconds = max(shortTokenTtl, crlNextUpdate) + offlineTolerance
```

with the three inputs (`tokenTtlSeconds`, `crlNextUpdateSeconds`, `offlineToleranceSeconds`) also disclosed
so the client can see the derivation. This is a disclosed, accepted limitation — not only in documentation
but on the wire.

## Clock-tamper resistance (US6, FR-014/015)

Clock-tamper enforcement is fundamentally **client-side** — only the client can reject its own rolled-back
local clock. The **server** does the three things it can actually enforce, and nothing it cannot:

1. **Signed server time.** Every renewed token embeds the server's signed time: the token `iat` == the wire
   `serverTime` == the check-in anchor. The client advances its own local monotonic anchor to this value.
2. **Short `exp` (fail-closed).** The token expires within one renewal window, so offline runtime can never
   extend past `exp` regardless of the local clock.
3. **Monotonic `last_anchor_at` floor.** `advanceAnchor` is a **guarded UPDATE** that raises the recorded
   anchor to a beat's signed server time **only when non-decreasing** (`last_anchor_at IS NULL OR
   last_anchor_at <= to_timestamp(anchor)`) — never a trigger, never a counter. The server therefore **never
   lowers** a recorded anchor, even if a rolled-back client asserts an earlier time. The pure predicate
   `isMonotonicAnchor(currentFloor, candidate)` expresses this exact rule (unit-tested, and the SAME rule the
   client applies locally); each successful beat records the floor decision (`anchorAdvanced`) in the
   append-only audit (FR-019).

The **per-plan offline-tolerance** window (`stalenessWindow.offlineToleranceSeconds`, FR-015) bounds how long
a client may run without a fresh server anchor before it must **re-anchor** (renew); combined with `renewAfter`
sitting strictly before the fail-closed `expiresAt`, it drives the client's re-anchor gate. A **never-connected**
client's pure-offline rollback is only **BOUNDED** by this window, **not prevented** — a disclosed, accepted
limitation (FR-013, US6-AC3). The server does **not** fabricate a stateful client-side check it cannot perform.

## Check-in retention (platform-owner job)

The `checkin` anti-replay store is **bounded**: a nonce need only be remembered while a token minted for it
could still be valid (≤ the renewal window). Beyond that a replay could only reproduce an already-expired
token (fail-closed), so the row is safe to prune. `pruneExpiredCheckins(q, retainSecs)` performs the age-range
`DELETE`, but the app role holds **SELECT/INSERT only** (no `DELETE`) on `checkin` — so retention pruning is a
**platform-owner scheduled job** run on the privileged (owner) role, NOT from the request-serving app role.
`main.ts` deliberately does **not** schedule a `DELETE` from the app process; deploy the prune as a periodic
owner-role maintenance task (e.g. a cron/`pg_cron` job) using `pruneExpiredCheckins`. The CRL worker (which
only `INSERT`s new signed versions) IS started from `main.ts`, fail-open.

## Signed revocation list (CRL) fallback — US4 (`GET /v1/revocation-list`)

The CRL is the **belt-and-braces fallback** to short-token non-reissue: a signed, versioned artifact a
client can pull for the spans between renewals and for air-gapped sites. It is **per product** (signed by
that product's E004 key, verified against that product's keyring) and **projected on demand** from
`license.status='revoked'` (+ deactivated activations per policy) — there is no materialized revoked table.
Only the **signed, byte-stable, versioned** artifact is stored (`revocation_list`), with `version = max+1`
per `(tenant, product)` computed **inside the generation transaction** (strictly monotonic, FR-022).

- **Signature**: a **detached Ed25519** signature over the canonical bytes of `{ version, generatedAt,
  nextUpdate, revokedIds }`, made through the E004 signer's `signDetached(...)` with a CRL-specific domain
  tag **`LICSRV-CRL-v1`** — domain-separated from the LIC1 token domain (`LICSRV-LICENSE-TOKEN-v1`) so a CRL
  signature can never be confused with (or replayed as) a token signature. Enforcement never touches the
  keystore directly — signing goes through the `Signer` (Principle I / TR-001).
- **Two representations, identical bytes**: `application/json` (default) and `?format=file`
  (`application/octet-stream`, `Content-Disposition: attachment`) serve the **same canonical bytes**, so the
  signature verifies identically whether a client fetched the JSON or the air-gap file.
- **Caching**: `ETag` carries the version (`"v42"`); `Cache-Control`/`Expires` align to `nextUpdate`; a
  matching `If-None-Match` → `304`. An unknown/cross-tenant `productId` or an absent version → `404`.
- **Publication**: the `crl-worker` regenerates a product's CRL when its revoked set **changed** or the
  current version's `nextUpdate` **elapsed**, and audits each publication (`crl.published`). It is
  **fail-open** — a worker fault never crashes the app.

### The three client CRL outcomes (FR-011/022/023) — distinct behaviours

A client MUST distinguish three cases; conflating them is a security bug:

| # | Situation | Client behaviour | Requirement |
|---|-----------|------------------|-------------|
| (a) | **Fetch fails** — the CRL endpoint/CDN is unreachable, or `404` (no CRL published yet) | **Fail OPEN**: fall back to short-token-TTL enforcement. The CRL is belt-and-braces, not the primary path; token **expiry** still fails **closed**. | FR-011 |
| (b) | A fetched CRL is signed and valid but its `version` is **older** than the one already trusted | **Ignore it (anti-downgrade)**: keep the newer version. Apply a CRL only if `version` is strictly greater (`isFresherCrlVersion`). An attacker cannot roll a client back to a stale CRL that omits a since-revoked id. | FR-022 |
| (c) | A fetched CRL's **signature is invalid** (or the key is unknown) | Treat as **UNTRUSTED**: do **not** apply it and do **not** cache it. This is **distinct from (a)** — a tampered/forged CRL is an active attack, not an outage, so it must **not** trigger the (a) fail-open path. Keep enforcing the last trusted state + token TTL. | FR-023 |

## Client responsibilities

- **Beat below the TTL.** Heartbeat at a cadence well under the short-token TTL (research: ~50–70%), so a
  transient outage is absorbed by the grace window (`renewAfter` sits strictly before `expiresAt`) without a
  false lockout (FR-007). `expiresAt` is the **hard, fail-closed** limit — never run past it.
- **Single-use nonce per request.** A retry with the same nonce for the same activation replays the original
  result; reusing a nonce for a different activation is refused `409 nonce_replayed` (FR-008).
- **Persist + enforce a monotonic anchor.** Keep a local monotonic anchor and reject any token/time
  preceding the highest signed `serverTime` observed (client-side clock-tamper resistance; the server keeps
  the matching `last_anchor_at` floor).
- **Honor the disclosed windows.** Treat `stalenessWindow` as the maximum revocation delay; the CRL
  (`GET /v1/revocation-list`, US4) is belt-and-braces — fail **open** on fetch failure, ignore an older
  signed version (anti-downgrade), and treat a signature-invalid CRL as untrusted.
