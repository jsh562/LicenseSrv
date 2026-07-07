# Runbook: Readiness failures & config/secret fail-fast (RR-002)

**Applies to**: the API runtime — health probes and startup configuration.

## Health probe semantics

- `GET /internal/health/live` — the process is alive. Independent of dependencies. A failing liveness
  means the orchestrator should **restart** the container.
- `GET /internal/health/ready` — the process can serve traffic: the database (`SELECT 1`) and, where a
  signer is configured, its composed readiness. A failing readiness means the orchestrator should
  **withhold traffic** but NOT restart the container.
- `GET /internal/health/startup` — initial boot completed (listener bound).

## Symptom: readiness is 503 but liveness is 200

A required dependency is degraded; the container is intentionally kept alive. Inspect the payload:

```json
{ "status": "not-ready", "checks": [ { "name": "database", "status": "down" }, { "name": "signer", "status": "up" } ] }
```

- **`database: down`** — Postgres is unreachable or slow.
  1. Check DB liveness (`pg_isready`), network path, credentials, and connection limits.
  2. Confirm `DATABASE_URL` (or `DATABASE_URL_FILE`) points at the right instance.
  3. Readiness recovers automatically once the DB is reachable; no restart needed.
- **`signer: down`** — the signing keystore is locked (custodian shares unavailable/insufficient).
  1. Verify `SIGNING_CUSTODIAN_SHARES` (or `_FILE`) is mounted and has ≥ k shares.
  2. See the E004 keystore-unlock procedure. The API still serves non-signing paths.

## Symptom: the container exits immediately on start (fail-fast)

Required configuration is missing or invalid. The startup log names the offending setting, e.g.:

```json
{ "level": "error", "msg": "startup failed", "error": "invalid configuration:\n- databaseUrl: DATABASE_URL is required (set DATABASE_URL or DATABASE_URL_FILE)" }
```

1. Provide the named setting via env or its `<VAR>_FILE`.
2. For a secret, confirm the mounted file exists and is **non-empty** (an empty/unreadable secret file is
   treated as missing).
3. Check `<VAR>_FILE` precedence: if both `NAME_FILE` and `NAME` are set, the file wins.
4. Re-deploy. Because config is validated before serving, a bad config never reaches production traffic.

## Preventive

- Validate config in staging with the exact secret-mounting mechanism used in production.
- Wire orchestrator probes: liveness → `/live`, readiness → `/ready`, startup → `/startup`.
