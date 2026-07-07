# Runbook: Stuck or contended migration job (RR-001)

**Applies to**: the gated migration job (`node dist/server/db/migrate.js` / `npm run migrate`).

## Background

Migrations run as a discrete, advisory-locked step (DDR-004). A single runner holds a Postgres session
advisory lock; concurrent runners block until it releases, then no-op. Each migration applies inside its
own transaction, so a failure leaves no half-applied schema, and the session lock auto-releases if the
runner's connection dies.

## Symptom: the migrate job hangs

Another runner holds the advisory lock, or a previous runner's session is still open.

1. Inspect active locks and sessions:
   ```sql
   SELECT pid, state, wait_event_type, query, age(clock_timestamp(), query_start) AS running_for
     FROM pg_stat_activity
    WHERE query ILIKE '%pg_advisory_lock%' OR query ILIKE '%schema_migrations%';
   SELECT * FROM pg_locks WHERE locktype = 'advisory';
   ```
2. If a legitimate runner is mid-migration, **wait** — do not kill it (its transaction is atomic).
3. If the holder is a dead/abandoned session (e.g. a crashed CI job) that did not release:
   ```sql
   SELECT pg_terminate_backend(<pid>);  -- releases the session advisory lock
   ```
   Then re-run the migrate job; it is idempotent and resumes from `schema_migrations`.

## Symptom: the migrate job exits non-zero (a migration failed)

The failing migration's transaction rolled back; the schema is unchanged for that file.

1. Read the job logs for the failing SQL file and error.
2. Fix the migration (or the data condition) — remember migrations are expand/contract and
   backward-compatible; never make a destructive change here.
3. Re-run the migrate job. Already-applied files are skipped (idempotent).
4. If a rollback is needed, redeploy the previous digest-pinned image — safe because the prior app
   version still runs against the expanded schema.

## Escalation

Repeated lock contention or a migration that cannot complete on a prod-like dataset → treat as a change
that needs review; restore from the latest verified backup as the escape hatch.
