# E004 Signing Service — API Contracts

OpenAPI 3.1 contracts for the **REST surface** of epic E004 (Signing Service and Key Custody).
See `spec.md` (TR-001..017, Integration Points) for the source requirements.

## Files

| File | Purpose |
|------|---------|
| `signing-keys.openapi.yaml` | Key management (provision/rotate/revoke/list) + public JWKS keyring publication. |

## Scope boundary (important)

The **signing operation is NOT a REST endpoint.** Tokens are minted by the in-process `Signer`
interface (TR-001), called directly by issuance (E008) and air-gap (E010). There is deliberately
**no `/sign` endpoint** in this contract. The REST surface here is only:

1. **Key management** — the per-product Ed25519 signing-key lifecycle (admin, tenant-scoped).
2. **Public keyring publication** — JWKS-style trusted-key set for verifiers to pin (E001/E003).

## Security invariants baked into the schemas

- **No private key material anywhere** (TR-001 / TR-010): no request, response, header, example,
  or error carries a private key. `SigningKeyMetadata.public_key` and `KeyringKey.x` are the only
  key fields — both are base64url of the 32-byte Ed25519 **public** key. The JWKS entry
  intentionally has no `d` (private) member. There is no export / private-read operation.
- **Tenant + product scoping** (TR-004): every path is tenant-scoped via the `X-API-Key` auth
  context; keys are product-scoped and persisted under RLS by the E002 repository.
- **Keyring validity-window semantics** (maps 1:1 to E001 `KeyEntry`): each `KeyringKey` carries
  `valid_from` (**inclusive**) and `valid_until` (**exclusive**, `null` = open-ended). These match
  the core's `Keyring`/`KeyEntry` window so a published key's trust interval transfers exactly to
  the offline verifier. Revoked keys are **omitted** from the set (not published with a flag).
- **Structured JSON errors**: all faults use the `Error { code, message, details }` model —
  `400` validation, `401` auth, `403` RBAC, `404` unknown product/key, `409` conflict (e.g. an
  in-flight rotation or an already-revoked key). Fail-closed *signing* faults are internal to the
  `Signer` and are out of scope for this REST contract.

## Auth & RBAC

- Security scheme `apiKey` = header `X-API-Key` (matches `src/server/auth/apikey.ts`).
- RBAC per operation is documented via the `x-rbac` extension (`requiredRole` / `requiredScope`)
  and mirrors `src/server/auth/rbac.ts` (roles `viewer < admin < owner`; scopes include `admin`).
- **Keyring auth**: modeled as readable with any valid tenant API key. Because a keyring contains
  only public keys, a **fully-public distribution variant** (drop `security`, serve as a
  static/CDN artifact) is a supported deployment option — noted on the operation via
  `x-public-distribution-option`.

## Requirement traceability

| Endpoint | Primary requirements |
|----------|----------------------|
| `POST .../signing-keys` (provision) | TR-003, TR-004, TR-005, TR-014 |
| `POST .../signing-keys/rotate` | TR-007, TR-014, SC-004 |
| `POST .../signing-keys/{keyId}/revoke` | TR-009, TR-014, SC-005 |
| `GET .../signing-keys` (list) | TR-005, TR-010 |
| `GET .../keyring` | TR-008, IP-005 |
| All (no private material) | TR-001, TR-010 |

## Validation

`signing-keys.openapi.yaml` is a self-contained OpenAPI 3.1 document. Validate with any OpenAPI
3.1 linter (e.g. `redocly lint`, `spectral lint`, or `swagger-cli validate`).
