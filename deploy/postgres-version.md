# PostgreSQL version & patch policy (TR-014)

The application MUST run against **PostgreSQL 16 at or above the latest security-patched
minor release — minimum 16.4** — and the deployment MUST adopt new Postgres security
patches **within 30 days** of release. This closes known Row-Level-Security CVE exposure
(e.g. policy/optimizer edge cases) that the foundation's tenant isolation depends on.

## Why

Tenant isolation is enforced by RLS under a non-owner, `NOBYPASSRLS` role. RLS has had
edge-case advisories; staying current on minor releases is part of the isolation control,
not optional hygiene.

## Operational notes

- The managed-SaaS instance and self-host bundles pin a base image of `postgres:16.x`
  (current patched minor) and are rebuilt on new minor releases.
- The application connects as the limited role `licensesrv_app`; only the migration runner
  uses the owner/superuser connection.
- Enforcement of the 30-day window is owned by the runtime/packaging epic (E006).
