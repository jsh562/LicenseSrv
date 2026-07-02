# Security Requirements-Quality Checklist: Signing Service and Key Custody

_A unit test for the spec: each item interrogates whether the security requirements are complete, clear, consistent, and traceable — not whether the code behaves._

**Created**: 2026-07-02 | **Feature**: [spec.md](../spec.md)

## Private-Key Confidentiality & Custody Boundary

- [X] CHK001 Are requirements explicit that private key material never appears in any API response, log, or error/diagnostic output, and do they enumerate every path (success, failure, diagnostics) rather than only the happy path? [Completeness, Spec TR-010] — SPEC TR-010 enumerates success responses, error responses, and diagnostics; reinforced by Scope §Edge Cases and SC-001/SC-006.
- [X] CHK002 Is the "custody boundary" beyond which no plaintext private key may exist in application memory defined precisely enough to test (which components/modules are inside vs. outside it)? [Clarity, Plan AD-007] — PLAN AD-007 confines a `KeyMaterial` boundary to the signer (signer.ts/keystore-signer.ts/custody.ts/token.ts); API/audit/errors carry only key_id (HINT-004); data-model §3 confines plaintext key to the keystore/KMS boundary — secret-leakage test asserts it.
- [X] CHK003 Do the requirements state as a hard prohibition — not merely an omission — that the `Signer` interface exposes no private-key export or read operation? [Completeness, Spec TR-001] — SPEC TR-001 hard-prohibits ("MUST NOT expose any private-key export or read operation"); data-model §3 confirms nothing reads `private_key_ref` back to a caller.
- [X] CHK004 Is there a measurable acceptance criterion asserting the absence of private-key bytes specifically on the failure/error path, distinct from the success-path check? [Measurability, Spec SC-001, SC-006] — SPEC SC-006 asserts no key material in logs on the fault path and OBJ1 VC2 covers any failed signing call (response/logs/errors), distinct from SC-001's success-path check.

## Envelope Encryption & Key-at-Rest

- [X] CHK005 Do the requirements state that no plaintext private key is ever persisted — i.e. `private_key_ref` holds only a wrapped blob (keystore) or an opaque handle (KMS), never key bytes? [Completeness, Data-model §3] — data-model §3 ("No column in this schema ever holds an unwrapped private key") + §9 custody invariant: keystore=AES-256-GCM-wrapped blob, KMS=opaque handle, never key bytes.
- [X] CHK006 Are the envelope-encryption parameters (algorithm, e.g. AES-256-GCM, and which master key wraps the private key) fixed as requirements rather than left to implementer discretion? [Clarity, Plan AD-002] — PLAN AD-002 fixes AES-256-GCM envelope under the keystore master key (Shamir-reconstructed); data-model §3 pins `custody_scheme = keystore-aes256gcm-v1`.

## Shamir Custody & Master-Key Handling

- [X] CHK007 Is it unambiguous that the keystore master key is reconstructed only in memory and never persisted in plaintext, and is "never persisted" stated in a way a reviewer can check? [Ambiguity, Plan AD-005, Data-model §5c] — PLAN AD-005/AD-002 + data-model §5c: master key reconstructed in memory at unlock, never persisted; HINT-001 holds it in memory only and zeroizes on shutdown — reviewer-checkable.
- [X] CHK008 Do the requirements define the Shamir k-of-n threshold as deploy-time configurable and specify the exact behavior at k-1 shares (does not unlock, signs nothing, defined error)? [Completeness, Spec TR-012, SC-006] — SPEC TR-012 (threshold configurable at deploy time) + SC-006 / OBJ4 VC1: below k → does not unlock, signs nothing, returns a defined fail-closed error.

## Fail-Closed Operation

- [X] CHK009 Is fail-closed behavior specified for every distinct fault class — keystore unlock failure, signing-backend unavailability, and sub-threshold custodian shares — each returning a defined error and emitting no token? [Coverage, Spec TR-011, SC-006] — SPEC TR-011 (unlock failure + backend unavailability) + SC-006 / OBJ4 VC1 (sub-threshold shares); PLAN Error-Handling table gives each a defined error and emits no token.
- [X] CHK010 Are "no partial token" and "no unsigned token" defined precisely enough that a reviewer can tell what an unacceptable partial/unsound output would look like? [Ambiguity, Spec Edge Cases, TR-011] — RESOLVED: added SPEC TR-018 defining TR-011's "no partial/unsigned token" precisely (a signing call returns either a conformance-verified complete `LIC1` token or a defined error with zero token bytes; any unsigned / not-conformance-checked / truncated output is unacceptable), plus a PLAN coverage-map row for TR-018.

## Blast-Radius & Tenant Isolation

- [X] CHK011 Is per-product blast-radius isolation stated as a positive requirement (a product-A token MUST NOT verify under product-B's keyring) with a traceable success criterion? [Traceability, Spec TR-015, SC-002] — SPEC TR-015 positive MUST + traceable SC-002 (a product-A token fails verification under product-B's key; A verifies under A).
- [X] CHK012 Do the tenant-isolation requirements make explicit that `signing_key` persists under forced RLS and denies cross-tenant read/use, including the unscoped-query case where `app.current_tenant` is unset (matches zero rows)? [Completeness, Spec TR-004, Data-model §5] — SPEC TR-004 + data-model §5: FORCE RLS; unset `app.current_tenant` → NULLIF → NULL → predicate matches zero rows (unscoped query refused); SC-003 denies cross-tenant read/use.

## Key Lifecycle Audit

- [X] CHK013 Is every key lifecycle event (create, rotate, retire, revoke) required to produce an append-only audit entry, and are the mandatory audit fields (actor, action, target) specified? [Completeness, Spec TR-014, SC-003] — SPEC TR-014 (append-only entry for every create/rotate/retire/revoke) + SC-003 mandates actor, action, target; data-model §7 enumerates action/target_id per event.
- [X] CHK014 Do the requirements prohibit private key material from appearing in the audit `before`/`after` records? [Edge-Case, Data-model §7] — data-model §7: "No private key material is ever written to `before`/`after`"; create event records `after` = public fields only.

## Keyring Publication, Rotation & Revocation

- [X] CHK015 Is it explicit that the published keyring exposes public material only (public key + `key_id` + validity) and never `private_key_ref` or `custody_scheme`? [Completeness, Spec TR-008, Data-model §5b] — SPEC TR-008 (public key + key_id + validity only, JWKS-style) + data-model §5b: `product_keyring` view never projects `private_key_ref` / `custody_scheme`.
- [X] CHK016 Do the requirements state that rotation keeps prior `key_id`s trusted within an overlap window so already-issued licenses remain verifiable without reissue? [Completeness, Spec TR-007, SC-004] — SPEC TR-007 (new active `key_id`; prior keys retained trusted within an overlap window) + SC-004 (v1 still verifies, v2 for new, no reissue of v1).
- [X] CHK017 Is the overlap window's termination defined (how and when a retired key stops being trusted/published), or is "overlap window" left unquantified? [Ambiguity, Spec TR-007, Data-model §6] — data-model §6 defines termination: a retired key stays published/trusted until the operator explicitly removes it (`DELETE`) or it ages out via `valid_until`; §5b keeps retired in the keyring until removed.
- [X] CHK018 Do the requirements state that revocation removes a key from both signing selection and the published keyring while preserving its audit history, and is this reconciled with E001's per-key `revoked` semantics (omission vs. flag)? [Consistency, Spec TR-009, Plan AD-004] — SPEC TR-009 (removed from keyring + never selected for signing, audit preserved) + PLAN AD-004 reconciles E001 via omission (revoked key absent → client `UnknownKey`), not a flag; data-model §5b/§6 retain the row for audit.

## Single Security Core & Offline Default

- [X] CHK019 Do the requirements make clear that the Ed25519 primitive is a standard implementation (not re-derived) and that the `LIC1` format/verification stays single-sourced by the Rust `verifier-core`, with every minted token conformance-verified against it? [Consistency, Plan Principle III, AD-001] — PLAN Principle III + AD-001: Ed25519 = `node:crypto` (standard, not re-derived); `LIC1` single-sourced by the Rust `verifier-core` as the conformance oracle every minted token MUST verify against (HINT-002); now formalized as SPEC TR-018.
- [X] CHK020 Is it stated that the default signer works fully offline with no cloud dependency, that cloud-KMS/PKCS#11 is opt-in only (P2), and that the adapter must guarantee the private key never leaves the KMS/HSM boundary with no export path? [Completeness, Spec TR-002, TR-016] — SPEC Technical Constraints (default fully offline, cloud opt-in) + TR-002/TR-016 (P2 adapter, key never leaves KMS/HSM boundary) + OBJ5 VC2 (no export path exists).
