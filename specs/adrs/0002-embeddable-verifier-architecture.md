---
adr_id: ADR-0002
status: accepted
date: 2026-06-26
tags: [verifier, rust, bindings, crypto]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0002: Embeddable Verifier Architecture (Single Rust Core + Bindings)

## Status

Accepted.

## Context

Customers must integrate license verification into any stack with minimal friction, and verification must run offline with near-zero latency. Re-implementing Ed25519/CBOR verification per language is the dominant source of licensing CVEs and divergent behavior. We need one audited cryptographic implementation reused everywhere, plus an escape hatch for stacks where embedding native code is impractical.

## Decision Drivers

- "Integrate into any stack easily" with little or no SDK burden on the integrator.
- Write-once cryptography to avoid per-language reimplementation and its CVE surface.
- Near-zero offline verification latency.
- A single audited core to satisfy the "single security core" principle.

## Considered Options

### Option A: Per-language reimplementation

- **Pros**: Idiomatic native libraries per ecosystem; no FFI packaging.
- **Cons**: N independent crypto implementations multiply CVE risk and behavioral drift; audit and fuzzing must be repeated per language; violates the single-security-core principle.

### Option B: WASM-only core

- **Pros**: One artifact runs in browsers and many runtimes; strong sandboxing.
- **Cons**: WASM is awkward or heavy for native server stacks; startup/marshalling overhead; not all target runtimes embed WASM cleanly.

### Option C: Rust core + multi-target bindings + REST fallback

- **Pros**: One audited, fuzzed Rust crate owns all crypto; C ABI, WASM, and UniFFI cover native, browser, and mobile/managed ecosystems; a universal REST validate endpoint gives a zero-SDK path for any remaining stack; near-zero native verify latency.
- **Cons**: Cross-language build/release pipeline; cgo/JNI/FFI packaging and distribution cost; more artifacts to version and ship together.

## Decision Outcome

Chosen option: **Rust core + multi-target bindings + REST fallback** — all cryptographic verification is implemented once in a Rust core crate, exposed via C ABI (`cbindgen`), WASM (`wasm-pack`), and UniFFI-generated bindings. A universal REST validate endpoint covers any stack with zero SDK for cases where embedding native code is impractical.

## Consequences

### Positive

- Single audited, fuzzed crypto implementation reused across all bindings; one place to patch CVEs.
- Native, browser, and mobile/managed ecosystems are all covered; integrators get near-zero offline verify latency.
- REST fallback guarantees universal reach with no SDK requirement.

### Negative

- A cross-language build and release pipeline must be maintained.
- cgo/JNI/FFI packaging, signing, and distribution add ongoing engineering cost.

### Neutral

- The REST path trades offline capability for zero-SDK convenience and is a deliberate fallback, not the primary mode.

## Links

- ADR-0001 (token format the core parses and verifies)
- ADR-0003 (keyring the core pins for verification)
- project-instructions.md — Principle III (Single Security Core, Fully Audited); Technology Stack; Source Code Layout
- specs/00001-license-server/plan.md
