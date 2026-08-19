#!/usr/bin/env bash
# One-command LicenseSrv licensing demo: unlock the signer, seed, issue a real signed license, and
# verify it OFFLINE with the WASM verifier core (plus tampered/expired negative proofs).
# Prereq: the compose stack is up (`docker compose up -d`) with secrets/ populated, and
# docker-compose.override.yml mounts the custodian shares to the api. Run from repo root: bash scripts/demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "① Generating custodian shares (idempotent)…"
npx tsx scripts/gen-custody.ts

echo "② Restarting api with the signer unlocked…"
docker compose up -d --force-recreate api >/dev/null

echo "③ Waiting for the signer to be ready…"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null localhost:8080/internal/ready/signing 2>/dev/null; then echo "   signer ready"; break; fi
  sleep 1
done

echo "④ Seeding demo tenant + API keys…"
DATABASE_URL="postgres://licensesrv:$(cat secrets/db_password)@localhost:15432/licensesrv" \
API_KEY_SECRET="$(cat secrets/api_key_secret)" \
  npx tsx scripts/seed-demo.ts

echo "⑤ Issuing licenses over the real HTTP API…"
node examples/license-demo/issue-demo.mjs

echo "⑥ Verifying OFFLINE…"
node examples/license-demo/verify.mjs
