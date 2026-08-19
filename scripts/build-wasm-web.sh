#!/usr/bin/env bash
# Compile the verifier core to a BROWSER WASM target (the shipped src/bindings/wasm/pkg is a nodejs
# build that can't run in a browser). Output lands in the demo app's src/wasm/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
echo "Building browser WASM (wasm-pack --target web)…"
wasm-pack build src/bindings/ls-ffi --release --target web --out-name licensesrv \
  --out-dir ../../../examples/license-demo-app/src/wasm
echo "✓ examples/license-demo-app/src/wasm/licensesrv.js"
