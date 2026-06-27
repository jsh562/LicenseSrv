---
adr_id: ADR-0001
status: accepted
date: 2026-06-26
tags: [crypto, token, offline]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0001: License Token Format & Encoding

## Status

Accepted.

## Context

License keys must be verifiable fully offline (air-gapped and on-prem), be compact enough to transport as a string, survive signing-key rotation, and resist the algorithm-confusion attacks that plague generic token libraries. The token must be self-describing so a pinned verifier can detect format version and select the correct verification path without any network call. A separate concern — short-lived online/session tokens issued by the server — has different needs (web ecosystem fit, expiry, revocation by short TTL) and should not dictate the license-key format.

## Decision Drivers

- Offline verifiability against a pinned Ed25519 keyring (no network, no `alg` negotiation).
- Compactness and copy-paste-safe transport (URL/email/CLI).
- Rotation-friendliness via an explicit `key_id` and forward-compatible versioning.
- Avoidance of JWT `alg`-confusion and downgrade attacks.
- A parser surface small and rigid enough to fuzz exhaustively.

## Considered Options

### Option A: Raw JWT (EdDSA-pinned)

- **Pros**: Ubiquitous tooling; well-understood; easy server-side issuance.
- **Cons**: `alg` header is attacker-influenced (confusion/`none` downgrade risk); JSON is verbose and non-canonical; header complexity enlarges the parser/fuzz surface.

### Option B: PASETO v4.public

- **Pros**: Algorithm is fixed by version (no `alg` confusion); Ed25519-based; well-specified.
- **Cons**: JSON payload is verbose for a license key; footer/key-id ergonomics are weaker for a pinned multi-key license keyring; optimized for session-style tokens, not long-lived self-describing licenses.

### Option C: Custom CBOR + Ed25519 envelope

- **Pros**: CBOR is compact and binary-canonical; algorithm is implicit and pinned (no negotiation); explicit `version` + `key_id` fields make rotation and format evolution first-class; minimal, rigid parser is straightforward to fuzz; single Rust core owns encode/decode.
- **Cons**: Bespoke format requires us to own versioning, canonicalization, and the test/fuzz harness; no off-the-shelf libraries for third parties.

## Decision Outcome

Chosen option: **Custom CBOR + Ed25519 envelope** — the license key is a versioned, self-describing token: a CBOR-encoded payload signed with Ed25519, distributed as `LIC1.<base64url(version‖payload‖signature)>`. The payload carries `license_id`, `product_id`, `plan_id`, `customer_id`, `issued_at`, `expires_at`, `max_activations`, `fingerprint` binding, `entitlements` (bool|int), `max_version`, `maintenance_until`, `key_id`, `token_version`, and a `nonce`. PASETO v4.public is adopted separately for online/session tokens, where its web-ecosystem fit and short TTLs are the right tradeoff; it is explicitly not used for the license key itself.

## Consequences

### Positive

- License keys verify offline against a pinned keyring with no algorithm negotiation, closing the `alg`-confusion vector.
- Compact, copy-paste-safe tokens; `key_id` enables seamless rotation; `token_version` enables forward-compatible format evolution.
- A small, rigid parser is exhaustively fuzzable, satisfying the security policy.

### Negative

- We own the format: versioning, CBOR canonicalization rules, and the encode/decode test and fuzz harness are our responsibility.
- No third-party off-the-shelf tooling for the license-key format; integrators rely on our bindings or the REST fallback.

### Neutral

- Two token shapes coexist by design (CBOR+Ed25519 license keys; PASETO v4.public session tokens), each scoped to its concern.

## Links

- ADR-0002 (embeddable verifier that parses/verifies this format)
- ADR-0003 (signing-key custody and `key_id` rotation)
- project-instructions.md — Principle I (Offline-First Cryptographic Verification); Security Requirements
- specs/00001-license-server/plan.md
