#!/usr/bin/env bash
# One-time setup for the NATIVE (no-Docker) path on Linux/macOS/WSL. See docs/native-setup.md.
#
# Creates the `licensesrv` role + database, fills in any missing secret files, and writes `.env.native`.
#
# DESIGN NOTES:
#  * DETECT, NEVER INSTALL. A PostgreSQL or Node install is a system-level change and stays the operator's
#    decision — this script checks for them and prints instructions if they are absent.
#  * IDEMPOTENT. Safe to re-run: existing secrets and an existing role/database are left alone. It never
#    regenerates `secrets/custodian_shares`, because the signing master key is envelope-encrypted under it
#    and replacing it would orphan every provisioned signing key (see scripts/gen-custody.ts).
#  * SHARES SECRETS WITH THE DOCKER PATH. The same `secrets/*` files serve both, so you generate once.
#    Only DATABASE_URL differs, because the Docker path resolves the `db` hostname inside the compose
#    network while a native run needs `localhost`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PG_SUPERUSER="${PGSUPERUSER:-postgres}"
PG_HOST="${PGHOST:-localhost}"
PG_PORT="${PGPORT:-5432}"
DB_NAME="licensesrv"
DB_ROLE="licensesrv"
ENV_FILE=".env.native"

info() { printf '  %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

printf '\n=== LicenseSrv native setup ===\n\n'

# --- 1. Prerequisites ------------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 22 (https://nodejs.org)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old — this project requires >= 22 (package.json engines)."
ok "Node $(node -v)"

if ! command -v psql >/dev/null 2>&1; then
  die "psql not found. Install PostgreSQL 16 client + server, then re-run:
    Debian/Ubuntu   sudo apt install postgresql-16
    Fedora/RHEL     sudo dnf install postgresql16-server
    macOS           brew install postgresql@16 && brew services start postgresql@16"
fi
ok "psql $(psql --version | awk '{print $3}')"

pg_run() { psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 "$@"; }

pg_run -tAc 'SELECT 1' >/dev/null 2>&1 || die "Cannot connect to PostgreSQL at $PG_HOST:$PG_PORT as '$PG_SUPERUSER'.
  Is the server running?   Linux: sudo systemctl status postgresql
  Wrong superuser?         re-run with PGSUPERUSER=<name>
  Needs a password?        export PGPASSWORD=... (or configure ~/.pgpass)
  On Linux the socket-auth route is usually: sudo -u postgres bash scripts/native/setup.sh"
ok "Connected to PostgreSQL at $PG_HOST:$PG_PORT"

# --- 2. Secrets (reuse the Docker path's files) ----------------------------------------------------
mkdir -p secrets

# Node rather than openssl: node is already a hard prerequisite, openssl is not (notably on Windows).
rand_hex() { node -e 'console.log(require("node:crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }

if [ -s secrets/db_password ]; then
  ok "secrets/db_password exists — reusing it"
else
  rand_hex 24 | tr -d '\n' > secrets/db_password
  chmod 600 secrets/db_password
  ok "secrets/db_password generated"
fi
DB_PASSWORD="$(cat secrets/db_password)"

if [ -s secrets/api_key_secret ]; then
  ok "secrets/api_key_secret exists — reusing it"
else
  rand_hex 32 | tr -d '\n' > secrets/api_key_secret
  chmod 600 secrets/api_key_secret
  ok "secrets/api_key_secret generated"
fi

# gen-custody.ts is itself idempotent and refuses to overwrite — call it unconditionally and let it decide.
npx tsx scripts/gen-custody.ts
ok "signer custodian shares ready (secrets/custodian_shares)"

# --- 3. Role + database ----------------------------------------------------------------------------
# Only the OWNER role and the database are created here. The non-owner `licensesrv_app` role that RLS
# depends on is created idempotently by migrations/0002_rls_roles_grants.sql — do not duplicate it.
if [ "$(pg_run -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE'")" = "1" ]; then
  ok "role '$DB_ROLE' exists — updating its password to match secrets/db_password"
  pg_run -c "ALTER ROLE $DB_ROLE WITH LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
else
  pg_run -c "CREATE ROLE $DB_ROLE WITH LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
  ok "role '$DB_ROLE' created"
fi

if [ "$(pg_run -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" = "1" ]; then
  ok "database '$DB_NAME' exists — leaving it alone"
else
  pg_run -c "CREATE DATABASE $DB_NAME OWNER $DB_ROLE" >/dev/null
  ok "database '$DB_NAME' created (owner: $DB_ROLE)"
fi

# --- 4. .env.native -------------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE exists — leaving it alone (delete it to regenerate)"
else
  [ -f .env.native.example ] || die ".env.native.example is missing — cannot generate $ENV_FILE."
  # Pick ports that are actually usable right now rather than assuming the defaults are free — a running
  # `docker compose` stack commonly holds 8080. start.sh re-checks these immediately before serving, since
  # this file may be generated long before the server is first run.
  API_PORT="$(node scripts/native/find-port.mjs 8080)" || die "could not find a free API port"
  METRICS_PORT="$(node scripts/native/find-port.mjs 9464)" || die "could not find a free metrics port"
  [ "$API_PORT" = "8080" ]     || ok "port 8080 is in use — API will use $API_PORT"
  [ "$METRICS_PORT" = "9464" ] || ok "port 9464 is in use — metrics will use $METRICS_PORT"

  # Substitute only the lines we resolve; every other setting keeps the example's documented default.
  URL="postgres://$DB_ROLE:$DB_PASSWORD@$PG_HOST:$PG_PORT/$DB_NAME"
  awk -v url="$URL" -v port="$API_PORT" -v mport="$METRICS_PORT" '
    /^DATABASE_URL=/     { print "DATABASE_URL=" url;       next }
    /^PORT=/             { print "PORT=" port;              next }
    /^OBS_METRICS_PORT=/ { print "OBS_METRICS_PORT=" mport; next }
    { print }
  ' .env.native.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "$ENV_FILE written (gitignored) — API on $API_PORT, metrics on $METRICS_PORT"
fi

printf '\n'
ok "Setup complete."
# Read the port back from the file rather than reusing $API_PORT: that variable is only set on the
# branch that generates the file, so an already-existing .env.native would report a stale value.
FINAL_PORT="$(awk -F= '/^PORT=/ { print $2; exit }' "$ENV_FILE" 2>/dev/null || true)"
info "Next:  npm run start:native      (builds, migrates, then serves on 127.0.0.1:${FINAL_PORT:-8080})"
info "Optional, lower Postgres memory: see scripts/native/postgres-tuning.conf"
printf '\n'
