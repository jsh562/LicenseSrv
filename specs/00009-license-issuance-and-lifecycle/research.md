# Research — E008 License Issuance and Lifecycle

Lightweight pass. Issuance is an integration of existing, validated project pieces (E004 signer, E007
effective read model, E001 token, E002 tenancy/audit, E005 console RBAC) plus two new tables; no new
external technology. Baseline from `specs/sad.md` + the E004/E007 implementations. Only design-shaping
choices are recorded.

## Signing seam
- **Decision**: consume E004's published `Signer` interface (`sign(tenantId, claims) → LIC1`, `ready()`)
  via an `app.signer` DI decorator set in `registerSigning` (mirroring the existing `signerReady`
  decorator). E008 builds `Claims` and calls `signer.sign`.
- **Why**: the signer is the single key-using surface (its source comment names E008/E010 as the consumers);
  the signer selects the product's active key, stamps `key_id`, and conformance-verifies the minted token
  against the E003 WASM core before return — so signing + byte-format correctness stay single-sourced in
  E004. Created once (one custody unlock); the private key never crosses the boundary.
- **Sources**: `src/server/modules/signing/signer.ts`, `token.ts` (Claims + LIC1 encoder); project ADR-0001/0003.

## Plan snapshot
- **Decision**: snapshot the plan's effective definition (entitlements + seat limit) into the license at
  issue via E007's `getEffectivePlanDefinition`, extended to also return `productId`+`planId`. Store the
  entitlements as a jsonb map + copy the seat limit; product/plan FKs are provenance-only.
- **Why**: a license must be immutable after issue (FR-006) — later catalog edits (or archival) must not
  change a field license. E007's read model is the designated E008 seam; it returns keys, so it is
  extended with the ids the token claims + signer key-lookup need.
- **Sources**: `src/server/modules/catalog/effective.ts`; spec FR-002/006; E007 AD-006.

## Lifecycle state machine
- **Decision**: app-enforced transitions in one tenant tx (`FOR UPDATE` → validate → update + audit):
  active↔suspended, active/suspended→revoked (terminal), revoke idempotent; invalid → 409
  `invalid_transition`; transfer bounded by a configurable `transferLimit`.
- **Why**: a small, testable state machine with a catch-all invalid-transition guard; DB triggers would
  hide the logic and complicate auditing.
- **Sources**: spec FR-007/008/009/010; E007 lifecycle-guard pattern.

## Customer PII / GDPR
- **Decision**: pseudonymous customers with minimal PII (ref + optional name/email); erasure anonymizes
  (nulls name/email, status `anonymized`) when the customer holds licenses, else hard-deletes.
- **Why**: satisfy the data-subject deletion obligation (FR-019) without orphaning issued licenses (the
  composite FK NO ACTION backstops a hard delete of a referenced customer).
- **Sources**: spec FR-011/019; project GDPR posture (minimal PII, deletable).

## Issuance latency
- **Decision**: synchronous sign on the request path (in-process Ed25519 + WASM conformance verify).
- **Why**: p95 < 1s is achievable in-process (the E004 signer path is already sub-second); a queue would
  add complexity for no MVP benefit.
- **Sources**: PRD issuance SLO (p95 < 1s); E004 signing tests.
