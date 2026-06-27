# Migrations (E002 tenancy & data foundation)

Raw SQL migrations applied by the advisory-locked runner in `src/server/db/migrate.ts`
(TR-006 / TR-007 / TR-015). The runner is the single, gated entry point — **never migrate
on application boot** (replica race).

## Rules

- **Expand/contract only.** A migration may add tables/columns/indexes; destructive changes
  (drop column/table, narrow a type) are deferred **≥ 2 releases** so the previous app
  version still runs against the new schema (safe rollback).
- **Atomic.** Each file runs inside its own transaction; a failure rolls back with no
  half-applied state (TR-015).
- **Single runner.** A session-level `pg_advisory_lock` ensures one runner at a time;
  concurrent runners block then no-op. The lock auto-releases on crash/session end.
- **Ordering.** Files apply in lexical order (`0000_`, `0001_`, …); applied names are
  recorded in `schema_migrations`.

## Files

| File | Purpose |
|------|---------|
| `0000_init.sql` | Foundational schema: tenant, app_user, role, api_key, audit_log |
| `0001_indexes.sql` | `tenant_id`-leading composite indexes (TR-004) |
| `0002_rls_roles_grants.sql` | `licensesrv_app` role, FORCE RLS, tenant-isolation policies, append-only audit grants |

## Run

```
DATABASE_URL=postgres://owner:pw@host:5432/db npm run migrate
```

The connection must be the **owner/superuser** (DDL + role/grant management); the application
itself connects and drops to the non-owner `licensesrv_app` role per transaction.
