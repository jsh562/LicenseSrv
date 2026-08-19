#!/usr/bin/env bash
# Build, migrate, and serve the API natively (no Docker) on Linux/macOS/WSL. See docs/native-setup.md.
#
# WHY IT ALWAYS REBUILDS: `dist/` is committed to this repository, and committed build output goes stale
# whenever a change lands without a rebuild (it was several features behind when this script was written).
# The Docker path is immune — the image compiles from `src/` and `.dockerignore` excludes `dist/` — but the
# native path runs `dist/` DIRECTLY, so a stale tree would silently serve old code. `tsc` is incremental
# enough that rebuilding every time is the right trade against that class of bug.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENV_FILE=".env.native"

ok()  { printf '\033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run setup first:  bash scripts/native/setup.sh"

# 1. Compile TypeScript and copy the wasm signer package into dist/ (see scripts/copy-wasm.mjs for why
#    the copy is a separate, mandatory step — without it the signer cannot load).
npm run build:native
ok "build complete"

# 2. Re-check the port. Setup may have run hours ago and `docker compose up` since then, so the port
#    recorded in .env.native is not necessarily still free. On a collision we relocate, WRITE THE NEW VALUE
#    BACK, and say so loudly — a silently moved port is worse than a loud one, and persisting it is what
#    keeps `migrate:native` and the admin-ui dev proxy (which reads this same file) in agreement.
WANTED_PORT="$(awk -F= '/^PORT=/ { print $2; exit }' "$ENV_FILE")"
WANTED_PORT="${WANTED_PORT:-8080}"
ACTUAL_PORT="$(node scripts/native/find-port.mjs "$WANTED_PORT")" || die "no free port near $WANTED_PORT"

if [ "$ACTUAL_PORT" != "$WANTED_PORT" ]; then
  # Rewrite only the PORT line so every other setting and comment in the file survives untouched.
  # Write to a temp file then mv, so an interrupted run cannot leave a truncated .env.native behind.
  awk -v port="$ACTUAL_PORT" '/^PORT=/ { print "PORT=" port; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  warn "port $WANTED_PORT is in use — relocated to $ACTUAL_PORT (saved to $ENV_FILE)"
else
  ok "port $ACTUAL_PORT is free"
fi

# 3. Migrations are a SEPARATE, GATED step and never run on app boot (DDR-004) — same contract the
#    compose `migrate` job enforces.
node --env-file="$ENV_FILE" dist/server/db/migrate.js
ok "migrations applied"

# 4. Serve. `--import` preloads the tracing module so the OTel SDK can patch pg/fastify/http before the app
#    imports them (HINT-001). With OTEL_EXPORTER_OTLP_ENDPOINT empty this is nearly free: the SDK packages
#    are never loaded at all.
ok "starting API on http://127.0.0.1:$ACTUAL_PORT — Ctrl+C to stop"
exec node --env-file="$ENV_FILE" --import ./dist/server/observability/tracing.js dist/server/main.js
