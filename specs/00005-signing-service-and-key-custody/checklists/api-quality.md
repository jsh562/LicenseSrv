# API Quality Checklist: Signing Service and Key Custody

> Unit tests for the key-management + public-keyring REST contract requirements — do the schemas, status codes, auth/RBAC, error model, and no-private-material invariant fully and unambiguously define the surface (there is deliberately no `/sign` endpoint), or do gaps remain? (Requirements quality only; not code behavior.)

**Created**: 2026-07-02 | **Feature**: [spec.md](../spec.md)

## Endpoint Request/Response Schemas & Status Codes

- [X] CHK201 Does the contract define a request schema (or explicit no-body) and a response schema with at least one example for every endpoint — provision, rotate, revoke, list, and keyring? [Completeness, contracts §paths] — All five ops covered: provision (`ProvisionSigningKeyRequest`→201 `SigningKeyMetadata`/`activeFirstKey`), rotate (`RotateSigningKeyRequest`→200/`newActive`), revoke (`RevokeSigningKeyRequest`→200/`revoked`), list (GET no-body→200 `SigningKeyList`/`duringRotation`), keyring (GET no-body→200 `Keyring`/`singleActive`,`overlap`) per contracts §paths.
- [X] CHK202 Are the success status codes distinguished per operation (201 for the provision create with a `Location` header, 200 for rotate/revoke/list/keyring) rather than left implicit? [Clarity, Plan §API Surface Summary + contracts §provisionSigningKey 201] — provision returns `201` + `Location` header; rotate/revoke/list/keyring each declare `200` explicitly (contracts §paths); Plan §API Surface Summary mirrors `201 SigningKeyMetadata` vs `200 …`.

## Authentication & RBAC per Endpoint

- [X] CHK203 Does every path require the `apiKey` (`X-API-Key`) security scheme, and is the resolution of that key to a tenant + scopes stated as the auth context? [Completeness, contracts §security + §securitySchemes] — Global `security: [apiKey: []]` applies to all paths; `securitySchemes.apiKey` (header `X-API-Key`) description + `info.description` state it "Resolves to a tenant + capability scopes."
- [X] CHK204 Is the RBAC requirement specified per operation — admin role+scope for the mutations (provision/rotate/revoke) and viewer-or-higher for the reads (list/keyring) — consistent with the `viewer < admin < owner` role/scope model? [Coverage, contracts §x-rbac + README §Auth & RBAC] — `x-rbac` set per op: provision/rotate/revoke `{admin, admin}`; list `{viewer, admin}`; keyring `{viewer, any}`; README §Auth & RBAC states roles `viewer < admin < owner`.

## Error Model Completeness & Consistency

- [X] CHK205 Does the error model enumerate every fault category with a defined status (400 validation, 401 auth, 403 RBAC, 404 unknown product/key, 409 conflict), each mapped to the shared `Error {code, message, details}` shape? [Completeness, Plan §Error Handling Strategy + contracts §responses] — contracts §responses defines `BadRequest`400/`Unauthorized`401/`Forbidden`403/`NotFound`404/`Conflict`409, each `schema: Error {code,message,details}`; Plan §Error Handling Strategy tabulates the same five categories.
- [X] CHK206 Are the declared response-code sets consistent per endpoint class — mutations declaring 400/401/403/404/409 and reads declaring 401/403/404 only — with no endpoint silently omitting an applicable fault? [Consistency, contracts §paths] — provision/rotate/revoke each declare 400/401/403/404/409 (plus 201/200); list and keyring each declare 401/403/404 (plus 200) — no read carries a 400/409, no mutation omits a fault (contracts §paths).
- [X] CHK207 Are the machine-readable error `code` values a stable, enumerated set (e.g. `validation_error`, `unauthorized`, `forbidden`, `product_not_found`, `key_not_found`, `rotation_in_flight`, `already_revoked`) rather than left to implementation discretion? [Measurability, contracts §responses + §examples] — RESOLVED: codes previously appeared only in examples; added `enum: [validation_error, unauthorized, forbidden, product_not_found, key_not_found, rotation_in_flight, already_revoked, conflict]` to the shared `Error.code` schema (contracts/signing-keys.openapi.yaml §components.schemas.Error) so the set is stable and not implementation-defined.

## Private Key Material Exclusion (TR-001 / TR-010)

- [X] CHK208 Does the contract state as an invariant that no request, response, header, example, or error on any endpoint carries private key material, and that no key-export or private-key-read operation exists? [Completeness, contracts §SECURITY INVARIANT + Spec §TR-001/§TR-010] — `info.description` "SECURITY INVARIANT (TR-001/TR-010)" states no request/response/header/example/error carries private material and "There is no key-export or private-key-read path"; README §Security invariants + Spec TR-001/TR-010 concur.
- [X] CHK209 Is it explicit that `SigningKeyMetadata.public_key` and `KeyringKey.x` are the only key fields and that both are the public 32-byte Ed25519 material (base64url), never a private component? [Clarity, contracts §SigningKeyMetadata + §KeyringKey + Spec §TR-005] — `SigningKeyMetadata` description "public_key is the only key field, base64url of the 32-byte Ed25519 public key"; `KeyringKey.x` "base64url (unpadded) of the 32-byte Ed25519 public key" (both `pattern '^[A-Za-z0-9_-]{43}$'`); README §Security invariants states both are the only key fields.
- [X] CHK210 Does the JWKS `KeyringKey` schema forbid a `d` (private) member with a stated "must never be added" invariant, consistent with there being deliberately no `/sign` or export path? [Edge-Case, contracts §KeyringKey + README §Scope boundary] — RESOLVED: the "no `d` member / MUST never be added" invariant was prose-only; added `additionalProperties: false` to `KeyringKey` (contracts/signing-keys.openapi.yaml §components.schemas.KeyringKey) so a `d` (or any undeclared) member now fails schema validation, machine-enforcing the invariant.

## Public Keyring Content Contract

- [X] CHK211 Does the keyring content contract specify exactly which statuses are included (active + rotating + retired-in-overlap, all trusted) and that revoked/removed keys are omitted? [Completeness, contracts §getProductKeyring + Spec §TR-008/§SC-005] — `getProductKeyring` description: "Included statuses: active, rotating, and retired-but-still-in-overlap (all trusted). revoked and removed keys are OMITTED (SC-005)"; `Keyring` schema desc "Revoked/removed keys omitted" (matches data-model §5b view `WHERE status IN (active,rotating,retired)`).
- [X] CHK212 Does each keyring entry require `kid` plus a validity window (`valid_from`/`valid_until`) so verifiers can pin and time-scope trust, and does that map 1:1 to E001's `Keyring`/`KeyEntry`? [Consistency, contracts §KeyringKey + Plan §AD-004/§HINT-005 + Spec §IP-001] — RESOLVED: `kid` was required but the validity window was optional; added `valid_from` and `valid_until` (nullable, `null`=open-ended) to `KeyringKey.required` (contracts/signing-keys.openapi.yaml §components.schemas.KeyringKey) so every entry carries the window, mapping 1:1 to E001 `KeyEntry` per Plan §AD-004/§HINT-005.

## Idempotency & Conflict Semantics

- [X] CHK213 Are the 409 conflict conditions defined precisely and distinctly for rotate (in-flight rotation / no active key to rotate from) and for revoke (already revoked), each carrying its own stable error code? [Clarity, contracts §rotateSigningKey 409 + §revokeSigningKey 409] — rotate 409 describes "a rotation already in flight (unpromoted rotating key) or no active key to rotate from" with code `rotation_in_flight`; revoke 409 describes "already revoked" with distinct code `already_revoked` — two distinct stable codes.
- [X] CHK214 Is revocation specified as terminal and idempotency-guarded — repeating it on an already-revoked key yields a 409, not a silent success — so the repeat semantics are unambiguous? [Ambiguity, contracts §revokeSigningKey + Spec §TR-009] — `revokeSigningKey` description "Revocation is terminal … Fails with 409 if the key is already revoked"; 409 `alreadyRevoked` (code `already_revoked`) confirms a repeat is a conflict, not a silent success (data-model §6: `revoked` terminal/retained).

## Tenant & Product Scoping

- [X] CHK215 Is every path both tenant-scoped (via the `X-API-Key` context under RLS) and product-scoped (`productId` path parameter), with revoke additionally `keyId`-scoped, so no operation can cross a tenant or product boundary? [Coverage, contracts §parameters + README §Tenant + product scoping + Spec §TR-004] — every path takes the `ProductId` path param; revoke adds `KeyId`; `info.description`/README state each path is tenant-scoped via the `X-API-Key` context and keys persist under RLS (TR-004).

## Public-Distribution Deployment Option

- [X] CHK216 Is the keyring's fully-public distribution variant (dropping `security`, serving as a static/CDN artifact) defined as a supported deployment option with the rationale that a keyring carries only public keys? [Completeness, contracts §x-public-distribution-option + README §Keyring auth] — `getProductKeyring` carries `x-public-distribution-option` + description "A fully-public distribution variant (dropping the security requirement, i.e. `security: []`, and/or … static/CDN) is a supported deployment option — publishing public keys carries no secret"; README §Keyring auth concurs.

## List Filtering & Metadata-Only Guarantee

- [X] CHK217 Does the list endpoint define its optional `status` filter (constrained to the status enum) and guarantee that results are public metadata only across all statuses? [Completeness, contracts §listSigningKeys + Spec §TR-005/§TR-010] — `listSigningKeys` declares optional `status` query param `schema: $ref SigningKeyStatus` (enum active/rotating/retired/revoked); description "public metadata only … No private material (TR-010)" and returns `SigningKeyList` of `SigningKeyMetadata` (public fields only).

## Versioning & Content Types

- [X] CHK218 Is the `/v1` prefix applied uniformly to every endpoint and is the keyring response content type specified as `application/jwk-set+json` (with `application/json` noted as an acceptable alternative)? [Consistency, contracts §paths + §getProductKeyring 200] — all four path templates begin `/v1/products/{productId}/…`; `getProductKeyring` 200 uses `content: application/jwk-set+json` with an inline note "Also acceptable as application/json for generic clients."

## Contract ↔ Data-Model Consistency

- [X] CHK219 Are the `SigningKeyStatus` enum values (active/rotating/retired/revoked) and the provision status behavior (first key → active, subsequent → rotating) consistent between the contract, the data model, and the spec's one-active-key-per-product invariant? [Consistency, contracts §SigningKeyStatus + Plan §Data Model Summary + Spec §TR-005] — `SigningKeyStatus` enum = [active,rotating,retired,revoked]; provision desc "no active key yet → active; otherwise → rotating"; matches data-model status `CHECK` + partial-unique `WHERE status='active'` and Spec assumption "exactly one active signing key at a time" (TR-005/TR-006).

## Cross-Cutting Traceability

- [X] CHK220 Does every endpoint trace to its governing requirements (provision → TR-003/004/005/014; rotate → TR-007/SC-004; revoke → TR-009/SC-005; list → TR-005/010; keyring → TR-008/IP-005), with the no-private-material invariant traced to TR-001/010 across all? [Traceability, README §Requirement traceability] — README §Requirement traceability table maps provision→TR-003/004/005/014, rotate→TR-007/014/SC-004, revoke→TR-009/014/SC-005, list→TR-005/010, keyring→TR-008/IP-005, and "All (no private material)→TR-001/010."
