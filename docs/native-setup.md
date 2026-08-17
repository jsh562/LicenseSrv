# Running natively (no Docker)

The API is a plain Node process talking to PostgreSQL, so it runs fine without Docker on Windows, Linux,
or macOS. This is the low-overhead option: on Windows the whole Docker Desktop stack (`vmmem` plus the
Windows-side helpers) was measured holding **~4.8 GB working set / ~8.0 GB private** on a 64 GB host, to run
a workload that itself needs ~120 MB. Removing that layer reclaims nearly all of it.

The Docker path in the [README](../README.md) remains the reference deployment and is unaffected by
anything here. Both paths share the same `secrets/` files, so you generate secrets once.

> **`npm test` still requires Docker.** The integration suites start a real `postgres:16` per test file via
> Testcontainers and pass the container's connection URI directly, with no override hook. This document
> covers **running** the server natively, not testing it. See [Limitations](#limitations).

## Prerequisites

| | Windows | Linux | macOS |
|---|---|---|---|
| Node **≥ 22** | `winget install OpenJS.NodeJS.LTS` | distro package or [nodesource](https://github.com/nodesource/distributions) | `brew install node@22` |
| PostgreSQL **16** | `winget install PostgreSQL.PostgreSQL.16` | `sudo apt install postgresql-16` | `brew install postgresql@16` |

The setup scripts **detect** these and print instructions if they're missing — they never install anything,
since that's a system-level change and your call.

On Windows the PostgreSQL installer does not add `psql` to `PATH`. Add its bin directory first:

```powershell
$env:PATH += ';C:\Program Files\PostgreSQL\16\bin'
```

## Quickstart

```sh
npm ci
npm run setup:native     # creates role + database, fills in secrets, writes .env.native
npm run start:native     # builds, migrates, then serves on 127.0.0.1:8080
```

`setup:native` and `start:native` dispatch to the PowerShell or Bash implementation based on
`process.platform`, so the same npm command works on every OS.

Check it:

```sh
curl -fsS localhost:8080/internal/health/ready
# {"status":"ready","checks":[{"name":"database","status":"up"},{"name":"signer","status":"up"}]}
```

Both checks should read `up`. If `signer` is `down`, see [Troubleshooting](#troubleshooting).

### What setup does

1. Verifies Node ≥ 22 and a reachable PostgreSQL.
2. Generates `secrets/db_password` and `secrets/api_key_secret` if absent — **reusing them if present**, so
   the Docker and native paths stay in sync.
3. Runs `scripts/gen-custody.ts` to produce `secrets/custodian_shares`, which unlocks the signer.
4. Creates the `licensesrv` role and the `licensesrv` database it owns.
5. Writes `.env.native` from `.env.native.example` with `DATABASE_URL` filled in.

Every step is idempotent — re-running is safe. It never regenerates `secrets/custodian_shares`, because the
signing master key is envelope-encrypted under it and replacing it would orphan every provisioned signing
key.

Only the **owner** role is created. The non-owner `licensesrv_app` role that RLS depends on is created by
`migrations/0002_rls_roles_grants.sql`, which runs as part of the migration step.

If your superuser isn't `postgres`, or PostgreSQL isn't on `localhost:5432`:

```sh
PGSUPERUSER=admin PGHOST=10.0.0.5 PGPORT=5433 bash scripts/native/setup.sh   # Linux/macOS
```
```powershell
powershell -File scripts\native\setup.ps1 -SuperUser admin -PgHost 10.0.0.5 -PgPort 5433
```

On Linux, peer authentication usually makes this the simplest route:

```sh
sudo -u postgres bash scripts/native/setup.sh
```

## How native differs from Docker

| | Docker | Native |
|---|---|---|
| **DB host** | `db:5432` (compose network) | **`localhost:5432`** |
| **Secrets** | mounted at `/run/secrets/*` | same files read from `./secrets/*` |
| **Config source** | `environment:` in compose | `.env.native` via Node's `--env-file` |
| **Bind address** | `0.0.0.0` inside the container | **`127.0.0.1`** on the host |
| **Migrations** | one-shot `migrate` service | migration step inside `start:native` |

Two of these deserve emphasis:

**`localhost`, not `db`.** `secrets/database_url` contains `@db:5432`, which only resolves inside the
compose network. `.env.native` therefore sets `DATABASE_URL` as a direct env var instead of reusing that
file. It's the single most common mistake when moving over.

**`127.0.0.1`, not `0.0.0.0`.** A container publishes ports deliberately; a native process binds straight to
the host. Loopback keeps it off your network. Change it only if you mean to expose the API.

Secrets still use the `<VAR>_FILE` convention — `readSecret()` in
[`src/server/config/secrets.ts`](../src/server/config/secrets.ts) resolves `<VAR>_FILE` first and falls back
to a direct `<VAR>`, so no application code differs between the two paths.

## Memory

Measured on Windows 10 (64 GB host), tracing disabled, idle after readiness:

| | Working set | Private |
|---|---|---|
| **Native Node server (Windows)** | **62 MB** | 69 MB |
| Same server in Docker | 86 MiB | — |
| Docker Desktop stack it replaces | 4,763 MB | 8,004 MB |

Add your PostgreSQL instance: ~30-60 MB idle on Linux, more on Windows, where Postgres uses one OS process
per connection and Windows processes cost more than Linux forks. Total native footprint is roughly
**100-130 MB**.

Two settings keep the server end tight, and both are already in `.env.native.example`:

- `NODE_OPTIONS=--max-old-space-size=192` — the service uses ~19 MB of heap; without a bound, V8 sizes its
  heap from total system RAM and GCs lazily, so RSS drifts upward.
- `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) — worth ~37 MB. Empty disables tracing, and the OTel SDK packages
  are then never loaded at all rather than merely unused. See the lazy-loading note at the top of
  [`src/server/observability/tracing.ts`](../src/server/observability/tracing.ts). Setting a real endpoint
  loads them and returns RSS to roughly the Docker figure — expected, and the cost of having tracing.

Optionally right-size PostgreSQL with
[`scripts/native/postgres-tuning.conf`](../scripts/native/postgres-tuning.conf) (`shared_buffers=64MB`,
`max_connections=25`). It mirrors the `db` service settings in `docker-compose.yml`. This is right-sizing,
not a fix — stock Postgres on a small database is already modest, because `shared_buffers` pages are touched
lazily rather than reserved.

## Everyday commands

| Task | Command |
|---|---|
| Build (TypeScript + wasm signer) | `npm run build:native` |
| Run migrations only | `npm run migrate:native` |
| Build, migrate, serve | `npm run start:native` |
| Seed a dev tenant + admin | see [Use the admin console](../README.md#3-use-the-admin-console) |

`start:native` **always rebuilds**. `dist/` is committed to this repository, and committed build output goes
stale whenever a change lands without a rebuild. The Docker path is immune — the image compiles from `src/`
and `.dockerignore` excludes `dist/` — but the native path executes `dist/` directly, so a stale tree would
silently serve old code.

The admin console SPA is unchanged: `cd src/admin-ui && npm install && npm run dev`. Its Vite dev server
proxies `/admin` to `http://localhost:8080`, which the native server serves just as the container did.

## Troubleshooting

**`503 signer_unavailable` from `POST /admin/licenses`, or `signer: down` in the readiness probe.**
Two causes. Either `secrets/custodian_shares` is missing — run `npx tsx scripts/gen-custody.ts` — or
`dist/bindings/wasm/pkg` is missing.

The second is worth understanding. `src/server/modules/signing/token.ts` loads the signer from
`../../../bindings/wasm/pkg/licensesrv.js`, which from the compiled `dist/server/modules/signing/token.js`
resolves to `dist/bindings/wasm/pkg`. That package is prebuilt JS plus a `.wasm` binary, not TypeScript, so
**`tsc` never emits it** — a plain `npm run build` yields a `dist/` that cannot load the signer. The
Dockerfile handles this with its own `COPY` line; natively it's `scripts/copy-wasm.mjs`, which is why you
want `build:native` rather than `build`. Fix: `npm run copy:wasm`.

**`Cannot connect to PostgreSQL`.** Confirm the server is running (`sudo systemctl status postgresql`, or
`Get-Service postgresql*` on Windows), then check the superuser name (`PGSUPERUSER`) and password
(`PGPASSWORD`, or `~/.pgpass` / `%APPDATA%\postgresql\pgpass.conf`).

**`password authentication failed for user "licensesrv"`.** `.env.native` and `secrets/db_password` have
drifted apart. Re-running `npm run setup:native` resets the role's password to match `secrets/db_password`,
but it will **not** rewrite an existing `.env.native` — delete that file first, then re-run.

**Port 8080 already in use.** The compose stack is probably still up. Either `docker compose down`, or set a
different `PORT` in `.env.native`.

**Windows: `running scripts is disabled on this system`.** The npm scripts already pass
`-ExecutionPolicy Bypass`. If you invoke a `.ps1` directly, do the same:
`powershell -ExecutionPolicy Bypass -File scripts\native\setup.ps1`.

## Limitations

- **The test suite needs Docker.** Integration tests use `@testcontainers/postgresql` and pass
  `container.getConnectionUri()` straight into `loadConfig`, with no env override. Unit tests
  (`*.unit.test.ts`), `npm run typecheck`, `npm run lint`, and the admin-ui tests all run without Docker.
- **The image smoke test needs Docker**, by definition — it builds and inspects the image.
- **Postgres upgrades are yours to manage.** The compose path pins `postgres:16-alpine`; a native install
  follows your OS package manager. Keep it on 16 — see
  [`deploy/postgres-version.md`](../deploy/postgres-version.md).
