---
adr_id: ADR-0010
status: accepted
date: 2026-07-18
tags: [online-enforcement, revocation, token-format, licensing, crl, offline-first, clock-tamper, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00014-online-enforcement-and-revocation/spec.md, specs/00010-machine-activation-and-seats/data-model.md, src/server/modules/signing/token.ts]
---

# ADR-0010: Online-Enforcement Token and Revocation Model — Short-TTL LIC1 Renewal (Primary) + Signed CRL (Fallback)

## Status

Accepted.

## Context

The MVP is offline-first: a client holds an offline-verifiable LIC1 credential (E009 `activation.machine_bound_token`) that the in-process E001 verifier core validates locally, with zero network, until the credential's own `exp`. This is a deliberate, disclosed gap — a revoked, suspended, refunded, or deactivated license keeps working even on *connected* machines until that long-lived token expires, so vendors cannot promptly cut off misuse or key-sharing (the offline-revocation gap called out in the E009 data model and the SAD failure paths).

Epic E013 (Online enforcement and revocation) closes this gap for *connected* clients: it must propagate revocation within a bounded window and meet online validate p95 < 120 ms, **without** breaking offline-first — never-connected/air-gapped clients must stay on their existing offline credential to its own expiry and must not be revoked-by-default. This contract is also what the downstream E016 work consumes, making the token FORMAT and the revocation-propagation MODEL a project-wide freeze point rather than a feature-local tradeoff.

The SAD already commits the *high-level* scheme — short-TTL renewal, revoke-by-ceasing-to-reissue, a signed CRL fallback with `next_update`, KMS/HSM signing, and a monotonic clock anchor — and those are NOT re-decided here. Two things remain under-specified and are decided by this ADR:

1. The SAD's Token & Crypto note that "online/session tokens use PASETO v4.public" is ambiguous for licensing: it reads as if the *licensing renewal* token would be a PASETO session token. It should not be — the licensing renewal token must be the offline-verifiable LIC1 credential the client already checks. This ADR fixes the licensing renewal token FORMAT and reserves PASETO v4.public for human/admin sessions (E005) only.
2. The concrete revocation-propagation model (primary vs fallback, and what is explicitly rejected) needs to be pinned so E013 and E016 build on one contract.

## Decision Drivers

- **Offline-first preserved (Principle I)**: reuse the E001 verifier core and the E009 long-lived offline credential unchanged; a never-connected client is unaffected and never revoked-by-default. Online enforcement is strictly additive.
- **Bounded revocation propagation to connected clients**: cut off misuse/refunds within one renewal-window TTL (the CAP-002 "revoke access" promise gaining teeth for online machines).
- **Single security core, no second client verifier (Principle III)**: reuse the existing E004 signer/keyring; introduce no new licensing token type and no new key custody.
- **Online validate p95 < 120 ms (SAD performance goal)**: rules out any per-request, third-party status round-trip on the hot path.
- **SAD consistency**: resolve the "online/session tokens use PASETO v4.public" ambiguity so licensing renewal and human sessions use clearly separated token schemes.
- **Air-gap / self-host fallback**: a signed, versioned artifact that verifies offline and can be imported by file, so the fallback is not a hard SaaS/CDN dependency.

## Considered Options

### Option A: Re-signed short-TTL LIC1 renewal token (reused format) + revoke-by-non-reissue, with a signed versioned CRL fallback

The renewal token is a re-signed SHORT-TTL LIC1 credential — the same format and claims as E009's `machine_bound_token`, minted by the existing E004 signer/keyring — but with a near-term `exp` set to the renewal window and an added signed-server-time anchor claim. The client's EXISTING E001 offline verifier verifies it unchanged. Revocation propagates PRIMARILY by short-TTL non-reissue (online validate/heartbeat reads `license.status` + `activation.status` + expiry and refuses to re-sign a revoked/suspended/expired/deactivated binding, bounding staleness to one renewal-window TTL). A signed, versioned, KMS/HSM-signed CRL with `next_update`, distributed via CDN and as a downloadable file for air-gap, is the FALLBACK. Clock-tamper is handled by the embedded signed server time + a client monotonic last-seen anchor + a per-plan offline-tolerance window.

- **Pros**: Offline-first preserved — the verifier core and the E009 offline credential behaviour are unchanged, and a never-connected client is untouched; no second offline token type and no new client verifier (the client already validates LIC1); no new key custody (reuses the E004 signer/keyring, Principle III); the primary path is a local DB status read + re-sign, so it meets p95 < 120 ms with no third-party round-trip; the CRL is a signed, offline-verifiable, air-gap-importable belt-and-braces layer that fails open on fetch while token expiry fails closed; the resulting renewal-token contract is exactly what E016 consumes.
- **Cons**: Short-TTL re-signing adds signer load bounded by the renewal cadence (mitigated by per-plan TTL + the heartbeat grace window); the CRL grows as revocations accumulate (mitigated by versioned/delta lists); revocation staleness for connected clients is non-zero (bounded by ≤ one renewal-window TTL and disclosed).

### Option B: A PASETO v4.public session token for licensing renewal

Mint the renewal token as a PASETO v4.public token (the SAD's session-token scheme) instead of a re-signed LIC1 credential.

- **Pros**: A single "online token" scheme shared with human/admin sessions; PASETO is a well-specified token format.
- **Cons**: The client would need a SECOND verifier for a format it doesn't already check — the licensing renewal token is NOT the offline-verifiable LIC1 the E001 core validates, so this breaks the single-core, no-second-verifier property (Principle III) and complicates offline-first; it conflates the licensing enforcement path with human/admin session auth, which have different lifetimes, audiences, and revocation semantics.

### Option C: OCSP-style per-request online status lookup

On each verification, the client queries a responder for the license/activation's current status.

- **Pros**: Near-real-time revocation with no renewal-window staleness.
- **Cons**: Adds a per-request online round-trip that busts the p95 < 120 ms budget and defeats offline-first entirely; the responder is a new tier-0 availability dependency that FAILS OPEN when down (a revoked license keeps working precisely when the check can't be made) — the worst failure mode for an enforcement control.

### Option D: Make online enforcement mandatory / shorten the offline credential

Force periodic connectivity or shrink the E009 credential's `exp` so revocation always lands quickly.

- **Pros**: Tighter maximum staleness across all clients.
- **Cons**: Breaks offline-first (Principle I) and the air-gap story — never-connected and air-gapped clients would be revoked-by-default or forced online; regresses the E009 offline credential behaviour this ADR must keep unchanged; contradicts the honest-disclosure posture (the offline staleness gap is accepted and disclosed, not eliminated by coercing connectivity).

## Decision Outcome

Chosen option: **Option A — a re-signed short-TTL LIC1 renewal token with revoke-by-non-reissue as the primary revocation path and a signed, versioned CRL as the fallback** — because it is the only option that closes the connected-client revocation gap within a bounded window while keeping offline-first, the single security core, and the p95 < 120 ms budget intact, and reusing the existing signer with no new token type or key custody. Concretely:

1. **Renewal token = a re-signed SHORT-TTL LIC1 credential.** Same format and claims as E009's `machine_bound_token` (the `Claims` shape in `src/server/modules/signing/token.ts`, including the `fp`/`fpk`/`sk` machine binding), minted by the existing E004 signer/keyring, but with a near-term `exp` equal to the renewal window and an added signed-server-time anchor claim. The client's EXISTING E001 offline verifier verifies it unchanged — no new token type, offline-first preserved. **PASETO v4.public stays reserved for HUMAN/admin sessions (E005), NOT licensing renewal** — this resolves the SAD ambiguity.
2. **Revocation propagation.** PRIMARY = short-TTL non-reissue ("revoke by ceasing to re-issue"): online validate/heartbeat reads `license.status` + `activation.status` + expiry and refuses to re-sign a revoked/suspended/expired/deactivated binding, so staleness is bounded to one renewal-window TTL. FALLBACK = a signed, versioned CRL (KMS/HSM-signed, with `next_update`) distributed via CDN plus a downloadable file for air-gap import. **NO OCSP-style per-request status lookup.**
3. **Clock-tamper resistance.** Signed server time embedded in the renewed token + a client monotonic last-seen anchor (rejects local time/tokens preceding the highest observed signed time) + a per-plan offline-tolerance window.
4. **Additive / offline-first.** The E001 verifier core and the E009 long-lived activation credential's offline behaviour are UNCHANGED; a never-connected client is unaffected and never revoked-by-default. The bounded revocation-staleness window (= max(short-token TTL, CRL `next_update`) + offline tolerance) is disclosed.

This ADR fixes only the licensing renewal token FORMAT and the revocation-propagation MODEL. The high-level scheme already committed by the SAD (short-TTL renewal, revoke-by-non-reissue, signed CRL fallback, KMS/HSM signing, monotonic clock anchor) is not re-decided here.

## Consequences

### Positive

- Connected clients get bounded-staleness revocation (≤ one renewal-window TTL), giving the CAP-002 "revoke access" promise teeth for online machines.
- Offline-first is preserved: the E001 verifier core is reused as-is, there is no second offline token type, and a never-connected/air-gapped client is unaffected and not revoked-by-default.
- Single security core and no new key custody: the renewal token and the CRL are signed by the existing E004 signer/keyring (Principle III).
- The primary path is a local status read + re-sign with no third-party round-trip, so it fits the online validate p95 < 120 ms budget.
- The CRL is a signed, versioned, air-gap-importable fallback that fails open on fetch (token expiry still fails closed) and scales via versioned/delta lists.
- The renewal-token contract fixed here is exactly what the downstream E016 work consumes, and the SAD's PASETO ambiguity for licensing is resolved.

### Negative

- Short-TTL re-signing adds signer load bounded by the renewal cadence (mitigated by per-plan TTL + the heartbeat grace window).
- The CRL grows as revocations accumulate (mitigated by versioned/delta lists).
- Revocation staleness for connected clients is non-zero (bounded by ≤ one renewal-window TTL and disclosed, per FR-013 / SC-006).

### Neutral

- Pure-offline clock rollback on a never-connecting client is bounded (by the monotonic anchor + per-plan tolerance) but not fully eliminated — an accepted, disclosed limitation, not a defect of this decision.
- PASETO v4.public remains the committed scheme for human/admin sessions (E005); this ADR narrows its scope, it does not remove it.

## Links

- specs/00014-online-enforcement-and-revocation/spec.md — E013 (FR-001..FR-021, US1..US6, SC-001..SC-010); the online validate/heartbeat + CRL contract this ADR concretizes.
- specs/00010-machine-activation-and-seats/data-model.md — E009 `activation.machine_bound_token`, the LIC1 offline credential and the disclosed offline-revocation gap this ADR closes for connected clients.
- src/server/modules/signing/token.ts — the LIC1 `Claims` (`fp`/`fpk`/`sk`) format the short-TTL renewal token re-uses, minted by the E004 signer.
- ADR-0001 (License Token Format & Encoding) — the LIC1 envelope/claims the renewal token reuses unchanged.
- ADR-0002 (Embeddable Verifier Architecture) — the single E001 verifier core that validates the renewal token with no second client verifier.
- ADR-0003 (Signing-Key Custody & Scope) — the per-product KMS/HSM keyring that signs both the renewal token and the CRL (no new key custody).
- ADR-0008 (Admin Console Human Authentication) — PASETO v4.public / session auth stays the human/admin path, distinct from licensing renewal.
- specs/sad.md — Token & Crypto Scheme, Data Management, Integration Strategy (CDN keyring/CRL), and the online validate p95 < 120 ms performance goal.
- PRD CAP-008 (online enforcement) and CAP-002 (revoke access); project-instructions.md Principle I (offline-first) and Principle III (single security core, fully audited).
