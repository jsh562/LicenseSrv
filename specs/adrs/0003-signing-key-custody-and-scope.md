---
adr_id: ADR-0003
status: accepted
date: 2026-06-26
tags: [crypto, kms, key-management, security]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0003: Signing-Key Custody & Scope (Per-Product Keys in KMS/HSM)

## Status

Accepted.

## Context

License-key forgery is only possible by obtaining a private signing key, so custody and blast-radius are the central security decisions. We must decide how many keys exist, who scopes them, where private keys live, and how rotation works from day one. Keys must never appear in application memory as plaintext or in any API response, and a compromise of one key must not invalidate or expose all licenses.

## Decision Drivers

- Blast-radius isolation: a compromised key affects the smallest possible set of licenses.
- Tier-0 availability of signing for license issuance.
- Rotation as a first-class capability from day one (no flag-day re-issuance).
- Private keys never in app memory plaintext, never returned by any API.

## Considered Options

### Option A: Single global key

- **Pros**: Simplest to manage; one public key (or small keyring) for all clients.
- **Cons**: Catastrophic blast radius — one compromise invalidates trust in every license across all products and tenants; no isolation.

### Option B: Per-tenant key

- **Pros**: Tenant-level isolation; aligns with multi-tenant boundaries.
- **Cons**: Key count scales with tenant count (operationally heavy); products span tenants, so it does not match the natural trust boundary of a shipped product; client keyrings grow with the customer base.

### Option C: Per-product key

- **Pros**: Matches the natural trust unit (a product's verifier pins that product's keyring); compromise is contained to one product; manageable key count; clean fit with `key_id` rotation.
- **Cons**: More keys than a single global key; signing depends on KMS/HSM availability.

## Decision Outcome

Chosen option: **Per-product keys in KMS with keyring rotation** — each product owns its own Ed25519 key pair. Private keys live in a cloud KMS/HSM (or an encrypted keystore for self-host), never in application memory as plaintext and never in any API response. Keys are versioned by `key_id` and rotated via an overlapping keyring so old and new keys are simultaneously trusted during a rotation window.

## Consequences

### Positive

- A key compromise is contained to a single product, preserving trust in all other products.
- Hardware-grade custody (KMS/HSM) keeps the only forgery vector under strong control.
- Overlapping `key_id` keyrings enable zero-downtime rotation from day one.

### Negative

- More keys to provision, track, and rotate than a single-key design.
- Signing availability depends on KMS/HSM; an outage blocks issuance unless mitigated.

### Neutral

- Issuance should cache or pre-issue where possible to decouple from momentary KMS latency, accepting added issuance-path complexity.

## Links

- ADR-0001 (`key_id` field and token signature)
- ADR-0002 (verifier pins the per-product public keyring)
- project-instructions.md — Principle I (Offline-First Cryptographic Verification); Security Requirements
- specs/00001-license-server/plan.md
