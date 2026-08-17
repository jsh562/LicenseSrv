# LicenseSrv browser demo app — "Acme Analytics"

A tiny mock customer product whose **Pro dashboard visibly unlocks/locks** based on a license that is
verified **fully in your browser** by the real Rust verifier core (compiled to WASM). This is what
embedding LicenseSrv into a real app looks like — no network call checks the signature.

## One command

```sh
npm run demo-app        # works from the repo root OR from this folder (examples/license-demo-app/)
```

That builds the browser WASM, snapshots the demo license + keyring, and starts the app. Then open the
printed URL.

Already ran it once? The WASM build and `public/demo-bundle.json` are cached, so a bare `npm run dev`
in this folder starts the app instantly (the offline license modes need no running server).

## Or step by step

```sh
# 1. (once) start the stack and issue a demo license
docker compose up -d && npm run demo

# 2. build the browser WASM + snapshot assets
bash scripts/build-wasm-web.sh
node scripts/prepare-demo-app.mjs        # writes public/demo-bundle.json

# 3. run the app
npm --prefix examples/license-demo-app install
npm --prefix examples/license-demo-app run dev
```

## What each control proves

- **Valid license** → Acme's Pro dashboard is live (widgets enabled, "3 / 5 seats"); details show
  `OK · code 0 · pro=true · seats=5`.
- **Tampered** → one signature byte is flipped in-browser → the dashboard locks with "Bad signature";
  details `DENIED · code 5`.
- **Expired** → the short-lived license is verified against a clock past its expiry → locks "expired";
  details `DENIED · code 6`.
- **Paste your own** → verifies any `LIC1.` token you paste.
- **Live issue** (needs the stack up) → logs into the API and issues a *fresh* license, then verifies
  it — the full **issue → verify → gate** round trip.

## How it works (3 steps, same as any embedding app)

1. Fetch the product's public **keyring** once, out-of-band (here it's bundled in `demo-bundle.json`).
2. `new Keyring()` + `keyring.add(kid, publicKeyBytes)` per key, then `verify(keyring, token, now)`
   (the WASM core — `src/verify.ts`).
3. Gate the UI on `code === 0 && has("pro")` and read `limit("seats")`.

## Notes / caveats (dev-only)

- The bundled keyring is **public** key material (safe to ship). The offline modes make **no** server
  calls. Only the "Live issue" tab talks to the API, same-origin through the Vite proxy (the server sets
  no CORS) using the dev login `acme / admin@acme.test / password123!`.
- `src/wasm/` and `public/demo-bundle.json` are generated (git-ignored). Rebuild the WASM with
  `bash scripts/build-wasm-web.sh` (needs `cargo` + `wasm-pack`).
- If the WASM fails to load under Vite, add `vite-plugin-wasm` + `vite-plugin-top-level-await` to
  `vite.config.ts` (the `--target web` build usually works without them).
