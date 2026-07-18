# Runbook: Tenant-isolation page (RR-001)

**Severity**: SEV1 — security incident. **Pages immediately** (zero error budget).
**Applies to**: the `TenantIsolationViolation` alert (`observability/prometheus/alert-rules.yml`), driven
by the `tenant_isolation_violation_total` counter emitted at the `withTenant()` choke point
(`src/server/observability/isolation-assertion.ts`) and by the synthetic canary
(`src/server/observability/canary.ts`).

## Background

Tenant isolation is a hard invariant (Principle II; DOD SLI/SLO table: cross-tenant access blocked, 100%,
zero budget). RLS at the single `withTenant()` per-transaction choke point is the **authoritative block**:
it drops to the non-owner `licensesrv_app` role and scopes every query to `app.current_tenant`. The
observability layer adds **detection**: a continuous in-memory assertion compares the authenticated
principal's tenant (resolved at the auth seam, carried in the request context) against the tenant GUC being
set, and on any mismatch emits (a) the `tenant_isolation_violation_total` counter — the pageable signal,
independent of trace sampling and OTLP export — and (b) a structured security log event. A synthetic
canary probes a known cross-tenant access on a cadence and increments the same counter if RLS ever fails to
block it.

**The assertion signals; RLS blocks.** A page therefore usually means a *detected mismatch that RLS still
blocked* — but it is treated as a breach until proven otherwise.

## First response (confirm the breach)

Act on **exactly** the signal OR-011 emits — the security log event. Locate it by the fields it carries:

```
event = "tenant_isolation_violation"
security_event = true
request_id            — server-generated correlation id (null for a canary-sourced event)
authenticated_tenant  — the principal's tenant (auth seam)
attempted_tenant      — the app.current_tenant GUC the tx tried to scope to
assertion_location    — where it was detected (withTenant choke point, or the canary probe)
source                — "assertion" (live request) | "canary" (synthetic probe)
outcome               — "blocked" (RLS blocked; assertion path) | "not_blocked" (canary saw a real leak)
```

1. **Filter the logs** for `event="tenant_isolation_violation"` around the alert time. Pull every matching
   line; each is one detected violation.
2. **Classify by `source` and `outcome`:**
   - `source="assertion"`, `outcome="blocked"` — a live request whose authenticated tenant ≠ GUC tenant;
     RLS blocked the rows. Real detection of a wiring/logic fault, **not** a confirmed data leak. High
     priority — a mismatch reaching `withTenant()` means an upstream tenant-resolution bug.
   - `source="canary"`, `outcome="not_blocked"` — the synthetic canary observed a **genuine cross-tenant
     leak**: RLS failed to isolate reserved synthetic tenants. **Confirmed isolation failure** — escalate
     immediately; this is a platform-wide RLS regression, not a single request.
3. **Correlate with `request_id`** (assertion source): pivot to that request's one-per-request log line and
   its trace (via `trace_id`) to see the full path, the route, and the API key / principal involved.
4. **Sanity-check the counter**: on the metrics port, `increase(tenant_isolation_violation_total[10m])`
   gives the volume — one-off vs. sustained.

## Contain

- **Canary `not_blocked` (confirmed RLS failure)** — this is the worst case. Treat as an active breach:
  1. Verify RLS is actually enforced: for each tenant table, `rowsecurity` and `relforcerowsecurity` must
     be true, and the app must connect as `licensesrv_app` (NOBYPASSRLS, non-owner).
     ```sql
     SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('tenant','app_user','role','api_key','audit_log');
     SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'licensesrv_app';
     ```
     If `licensesrv_app` shows `rolbypassrls=true` or `rolsuper=true`, or a table lost FORCE RLS, that is
     the failure — a role/grant/migration regression. Revoke the bypass / re-force RLS immediately.
  2. If the app is somehow connecting as the owner/superuser (bypassing RLS), that is a config/deploy
     regression — roll back to the last known-good digest-pinned image.
- **Assertion `blocked` (mismatch caught, RLS held)** — no data left the tenant boundary, but a
  tenant-resolution defect exists. Identify the offending code path from `assertion_location` + the
  request's route/handler, and gate or roll back the change that introduced it.
- If a specific API key / principal is implicated, **revoke it** and rotate as needed.

## Assess blast radius

1. From the security events, enumerate the DISTINCT (`authenticated_tenant`, `attempted_tenant`) pairs and
   the time window (first ↔ last event) — that scopes *who* and *for how long*.
2. For a canary `not_blocked` event, the blast radius is **platform-wide** (RLS itself failed), not limited
   to the synthetic tenants — assume every tenant boundary was at risk during the window.
3. Cross-reference the tenant-scoped append-only `audit_log` for the implicated tenants to see whether any
   *mutation* occurred under the wrong scope (the isolation counter records blocked *reads*; mutations, if
   any, appear in `audit_log`). Note: the blocked cross-tenant read itself performs no mutation, so its
   forensic record is the security event + counter, not `audit_log` (AD-003).

## Notify & escalate

- Declare a **security incident** per the org policy; page the security on-call in addition to the platform
  on-call. A confirmed canary `not_blocked` is a customer-data-exposure event — follow breach-notification
  obligations (contractual / GDPR) for the tenants in the blast-radius window.
- SEV1 auto-escalates if unacknowledged within 10 min (OR-016). Do not silence the page until RLS
  enforcement is re-verified end-to-end (re-run the canary; confirm `tenant_isolation_violation_total`
  stops increasing).

## Distinguish from the canary dead-man's switch

`TenantIsolationCanaryDown` / `TenantIsolationCanaryAbsent` (SEV2, `category=operational`, `page=false`) are
**not** this page. They mean the canary stopped *completing probes* (infra/transport failure or the worker
not running) — loss of breach *visibility*, not a breach. Restore the canary (check the worker started,
the reserved synthetic tenants are provisioned, DB reachable) and confirm `canary_up == 1` with a fresh
`canary_last_success_timestamp_seconds`. See `docs/runbooks/observability/telemetry-stack-failure.md` for
the general fail-open posture.

## Preventive

- Keep the assertion at the single `withTenant()` choke point — never add a second tenant-scoping path.
- Keep the canary enabled in every environment with reserved synthetic tenants provisioned, so the alert
  path is continuously exercised end-to-end.
- Treat any RLS / role / grant migration as security-critical: re-run the isolation integration test and
  the canary against a prod-like dataset before promoting.
