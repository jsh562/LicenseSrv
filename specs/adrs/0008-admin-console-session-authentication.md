---
adr_id: ADR-0008
status: accepted
date: 2026-07-02
tags: [authentication, sessions, rbac, security, admin-ui, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00006-tenant-administration-and-audit/spec.md]
---

# ADR-0008: Admin Console Human Authentication — Server-Side Cookie Sessions

## Status

Accepted.

## Context

The platform already authenticates machines via the E002 `X-API-Key` credential, but Epic E005 introduces the platform's first *human*-facing admin console (a React SPA). Humans need an interactive login that is tenant-bound, server-side revocable, least-privilege (RBAC), and auditable. A session must grant access to exactly one tenant (Principle II), must end immediately on sign-out, user deactivation, or compromise, and must resist token theft (XSS) — while remaining distinct from, and coexisting with, the machine API-key path.

This human-authentication pattern is project-wide: every admin surface built later — E005 administration, E007 catalog, E008 issuance, and E009 activation UIs — will reuse it. That cross-epic reach makes the choice a project-level architectural decision that warrants a standalone ADR rather than a feature-local `AD-###` entry.

## Decision Drivers

- Tenant-bound sessions: a session grants access to exactly one tenant, with no cross-tenant path (Principle II).
- Server-side revocation: sign-out, user deactivation, or compromise must end access immediately.
- Resistance to token theft: minimize the blast radius of XSS and credential exfiltration.
- Distinct from machine API-key auth, while coexisting with the E002 `X-API-Key` path.
- Auditability: every sign-in and every denial recorded (Principle III).
- Least privilege: RBAC enforced server-side, fail-closed, on every action.

## Considered Options

### Option A: Server-side sessions with an opaque token in an httpOnly + Secure + SameSite cookie

- **Pros**: The token is a random opaque value stored only as a hash in a Postgres `admin_session` table, so a stolen cookie is revocable by deleting (or invalidating) the row and revocation is immediate; `httpOnly` keeps the token out of JS-readable storage so XSS cannot exfiltrate it; session lookup resolves tenant + user + role and then sets the tenant scope, giving a clean single-tenant binding; the server holds authoritative session state; naturally distinct from the machine API-key path.
- **Cons**: Requires a server-side session store to build, index, and expire; cookie-based auth introduces CSRF considerations on state-changing requests (mitigated by `SameSite` plus CSRF protection).

### Option B: Stateless JWT in localStorage / Authorization header

- **Pros**: No server-side session store; self-contained claims; horizontally scalable with no session lookup.
- **Cons**: Hard to revoke server-side before expiry (a denylist reintroduces the server state it was meant to avoid); if held in JS-readable storage it is XSS-exfiltratable; larger blast radius on token theft, and longer-lived bearer tokens widen the compromise window.

### Option C: HTTP Basic authentication

- **Pros**: Trivially simple; no session state to manage.
- **Cons**: Sends credentials on every request (broad, repeated exposure); no session lifecycle — no real sign-out, expiry, or revocation; poor UX and weak security posture; no clean hook for tenant/role resolution or audit.

## Decision Outcome

Chosen option: **Option A — server-side sessions with an opaque token in an httpOnly + Secure + SameSite cookie** — because it is the only option that delivers immediate server-side revocation, a minimal token-theft surface, and a clean single-tenant binding at once.

On sign-in the server validates interactive credentials and issues an opaque session token; only a hash of the token is persisted in the Postgres `admin_session` table, and every request resolves that row to a tenant + user + role before setting the tenant scope. Concretely:

- Passwords are stored with a slow KDF (scrypt / argon2-class), never in plaintext, and are never returned by any API (FR-017).
- The interactive sign-in path throttles / locks out repeated failed attempts to resist credential guessing (FR-018).
- Sessions are bounded (expiry), explicitly revocable (sign-out), and bound to exactly one tenant (FR-001, FR-003).
- RBAC is enforced server-side, fail-closed, on every action (FR-004).
- Every sign-in and every denial is written to the append-only audit log (Principle III).

This human-session path is distinct from, and coexists with, the E002 machine API-key (`X-API-Key`) path; the two never share a credential or a resolution path.

## Consequences

### Positive

- Immediate revocation: sign-out, deactivation, or compromise ends access by invalidating the server-side session row.
- Minimal token-theft surface: the opaque token lives only in an `httpOnly` cookie, unreadable by JavaScript, so XSS cannot exfiltrate it.
- Clean tenant binding: each session deterministically resolves to exactly one tenant scope, upholding Principle II with no cross-tenant path.
- A single, audited human-authentication pattern reused by every admin epic (E005 / E007 / E008 / E009), avoiding per-surface auth divergence.

### Negative

- A server-side session store must be built, indexed, and maintained (including expiry cleanup).
- Cookie-based auth introduces CSRF considerations on state-changing requests — mitigate with `SameSite` plus CSRF protection.

### Neutral

- The SPA and the API either share a single origin or adopt a documented CORS / cookie policy for cross-origin cookie delivery.

## Links

- ADR-0004 (Multi-Tenancy Isolation Model) — the session resolves and binds exactly one tenant scope on top of the shared-schema + RLS model.
- ADR-0007 (Public API Style — REST/JSON First) — the auth/session and admin endpoints follow this REST/JSON surface.
- project-instructions.md — Principle II (Multi-Tenant Isolation + RBAC); Security Requirements.
- E002 (`api_key` machine-auth precedent) — the coexisting, distinct machine-authentication path.
- specs/00006-tenant-administration-and-audit/spec.md — FR-001 / FR-003 / FR-004 / FR-017 / FR-018; Principle III audit obligations.
