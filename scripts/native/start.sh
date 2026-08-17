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

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run setup first:  bash scripts/native/setup.sh"

# 1. Compile TypeScript and copy the wasm signer package into dist/ (see scripts/copy-wasm.mjs for why
#    the copy is a separate, mandatory step — without it the signer cannot load).
npm run build:native
ok "build complete"

# 2. Migrations are a SEPARATE, GATED step and never run on app boot (DDR-004) — same contract the
#    compose `migrate` job enforces.
node --env-file="$ENV_FILE" dist/server/db/migrate.js
ok "migrations applied"

# 3. Serve. `--import` preloads the tracing module so the OTel SDK can patch pg/fastify/http before the app
#    imports them (HINT-001). With OTEL_EXPORTER_OTLP_ENDPOINT empty this is nearly free: the SDK packages
#    are never loaded at all.
ok "starting API — Ctrl+C to stop"
exec node --env-file="$ENV_FILE" --import ./dist/server/observability/tracing.js dist/server/main.js
