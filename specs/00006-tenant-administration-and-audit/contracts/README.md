# E005 Tenant Administration & Audit — API Contracts

OpenAPI 3.1 contracts for the **admin console REST surface** of epic E005 (Tenant Administration
and Audit). Built on the E002 Fastify server, tenant repository, RBAC, RLS, and append-only audit
log. Source requirements: `../spec.md` (FR-001..018). Transport per ADR-0007 (REST/JSON).

## Files

| File | Purpose |
|------|---------|
| `admin-api.openapi.yaml` | Interactive auth/session, user & role management, API-key lifecycle, and read-only audit viewing. |

## Auth model (distinct from the machine API)

This API authenticates **humans** via an opaque, **httpOnly + Secure + SameSite session cookie**
(`admin_session`), set by `POST /admin/auth/login` and cleared by `POST /admin/auth/logout`.

- It deliberately does **NOT** use the machine API's `X-API-Key` header (`src/server/auth/apikey.ts`).
  Those are two separate credential paths that both resolve to one tenant scope.
- Security scheme: `sessionCookie` (`type: apiKey`, `in: cookie`, `name: admin_session`) is the
  global default (`security: [ sessionCookie: [] ]`).
- `POST /admin/auth/login` is the **only unauthenticated** endpoint (overrides with `security: []`).
  Its body is `{ tenantSlug, email, password }` — `tenantSlug` selects the tenant because an email is
  unique only per tenant (AD-001 / HINT-002).
- The token is **opaque** (not a JWT), **server-side revocable** and **bounded** (FR-003); it is
  delivered only via `Set-Cookie` and never appears in a response body (FR-017).
- Cookie attributes the server sets: `HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600`
  (a **bounded TTL** — the reference configuration uses `3600` s / 1 hour, injected via runtime
  config, NEW-CONFIG).
- **CSRF defense (AD-006 / HINT-005)**: `SameSite=Strict` is necessary but **NOT sufficient** on its
  own, so every state-changing `/admin` request (POST/PATCH, except `login`) additionally requires a
  double-submit `X-CSRF-Token` header that MUST match the non-HttpOnly CSRF cookie. SameSite +
  double-submit token together defend the cookie-authenticated mutations.

## RBAC

- Roles `owner > admin > viewer` (mirrors `src/server/auth/rbac.ts`).
- Per-operation minimum role is declared with the `x-rbac` extension (`minRole`) and enforced
  server-side, **fail-closed** (FR-004). A denial is recorded as an auditable **security event**
  (FR-005) and returns `403 forbidden`.

| Operation | minRole |
|-----------|---------|
| `POST /admin/auth/login` | (none — unauthenticated) |
| `POST /admin/auth/logout`, `GET /admin/auth/me` | viewer (any authenticated session) |
| `GET /admin/users`, `GET /admin/audit` | viewer |
| `POST /admin/users`, `PATCH /admin/users/{userId}` | admin |
| `GET/POST /admin/api-keys`, `.../rotate`, `.../revoke` | admin |

## Secrecy invariants baked into the schemas

- **No password / hash / session token ever returned** (FR-017). `LoginRequest.password` is
  `writeOnly`; no schema exposes a hash; the session token exists only in the `Set-Cookie` header.
- **API-key secret shown exactly once** (FR-009). The `secret` field lives only on the `ApiKeySecret`
  schema, used solely by `POST /admin/api-keys` (create) and `POST /admin/api-keys/{keyId}/rotate`.
  Every read/list/revoke uses `ApiKeyMetadata`, which has **no** `secret` field.
- **Audit is strictly read-only** (FR-013). Only `GET /admin/audit` exists — there is deliberately
  no create/update/delete on audit entries, flagged with `x-append-only: true`. No role (including
  owner) can mutate the log through the API.

## Tenant scoping

Every endpoint is implicitly scoped to the **session's tenant** (FR-002). There is no tenant
path/query parameter, so a caller can never widen scope; the server derives the tenant from the
session and persists under E002 RLS.

## Error model

Reuses the project-standard `Error { code, message, details }`. `code` is a stable enumerated value:

| HTTP | code(s) | Meaning |
|------|---------|---------|
| 400 | `validation_error` | Malformed body / bad filter value |
| 401 | `unauthenticated` | Missing/expired/revoked session, or bad login credentials |
| 403 | `forbidden` | RBAC deny (below `x-rbac.minRole`) — audited security event (FR-005) |
| 404 | `not_found` | Unknown user / key in this tenant |
| 409 | `last_owner` | Last-owner safeguard tripped (FR-008) |
| 409 | `already_revoked` | API key already revoked |
| 409 | `email_exists` | Duplicate user email on create |
| 429 | `rate_limited` | Login throttle / account lockout (FR-018); carries `Retry-After` |

## Requirement traceability

| Endpoint | Primary requirements |
|----------|----------------------|
| `POST /admin/auth/login` | FR-001, FR-017, FR-018 |
| `POST /admin/auth/logout`, `GET /admin/auth/me` | FR-003 |
| `GET /admin/users` | FR-006, FR-017 |
| `POST /admin/users` | FR-006, FR-014 |
| `PATCH /admin/users/{userId}` | FR-006, FR-007, FR-008, FR-014 |
| `GET /admin/api-keys` | FR-009 |
| `POST /admin/api-keys` | FR-009, FR-014 |
| `POST /admin/api-keys/{keyId}/rotate` | FR-009, FR-010, FR-014 |
| `POST /admin/api-keys/{keyId}/revoke` | FR-010, FR-014 |
| `GET /admin/audit` | FR-011, FR-012, FR-013 |
| All privileged ops (RBAC, audited denial) | FR-004, FR-005 |

## Conventions & unresolved interface decisions

- **Field naming: camelCase** (e.g. `tenantId`, `securityEvent`, `createdAt`). This is the
  Node/TypeScript idiom for this human console surface and matches the field names named in the
  E005 spec/task. It **differs** from the snake_case machine contracts (E004 `signing-keys`). One
  deliberate **intra-API exception**: the error `code` enum **values** are `snake_case` stable
  machine tokens (e.g. `last_owner`, `rate_limited`), not camelCase — they are opaque identifiers,
  not object field names, so the camelCase field convention does not apply to them; the boundary is
  explicit. Flag for Plan: confirm the platform accepts a camelCase human-console API alongside
  snake_case machine APIs, or normalize one way project-wide.
- **`UserStatus` includes `invited`** (created but no credential yet). It reconciles with the
  data-model by mapping `invited` → a NULL `app_user.password_hash`; the data-model `app_user.status`
  domain is reconciled to include `invited` alongside `active`/`deactivated` so contract and schema
  agree.
- **`POST` for revoke/rotate** (verbs on sub-resources) is used for the lifecycle actions rather
  than `PATCH`, matching the E004 signing-keys precedent.
- **Audit pagination** uses opaque `cursor` + `nextCursor` with a `limit` (default 50, max 200).
  Confirm the audit store supports stable cursoring at Plan.
- **SSO (FR-016 / US6, P2)** is intentionally out of this contract — direct-credential login only.

## Validation

`admin-api.openapi.yaml` is a self-contained OpenAPI 3.1 document. Validate with any 3.1 linter
(e.g. `redocly lint`, `spectral lint`, or `swagger-cli validate`).
