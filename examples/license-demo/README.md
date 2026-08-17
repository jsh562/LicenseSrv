# LicenseSrv licensing demo

Proves the whole chain works: the server issues a cryptographically **signed** `LIC1.` license, and a
separate client **verifies it fully offline** with the real Rust verifier core (compiled to WASM) —
gating a feature by entitlement, with no network call to check the signature.

## Prerequisites

- The stack is running: `docker compose up -d` with `secrets/{db_password,database_url,api_key_secret}`
  populated (see the repo `README.md`), and `docker-compose.override.yml` in place (exposes Postgres on
  `15432` and mounts the signer custodian shares into the `api` container).

## Run it (one command)

```sh
bash scripts/demo.sh          # or: npm run demo
```

That will: unlock the signer (`scripts/gen-custody.ts`) → restart `api` → seed a tenant + API keys
(`scripts/seed-demo.ts`) → issue a real license over the HTTP API (`issue-demo.mjs`) → verify it offline
(`verify.mjs`).

## What each step does

| Step | Script | What it proves |
|------|--------|----------------|
| Unlock signer | `scripts/gen-custody.ts` → `secrets/custodian_shares` | Shamir k-of-n custody; without it issuance is `503`. |
| Seed | `scripts/seed-demo.ts` | Tenant `acme`, owner `admin@acme.test`, an **admin**-scope + **validate**-scope API key. Writes `.out/env.json`. |
| Issue | `examples/license-demo/issue-demo.mjs` | Real HTTP: login → create product → **provision the product signing key** → plan + entitlements (`pro`=true, `seats`=5) → customer → issue a good + a short-lived license. Writes `.out/tokens.json`. |
| Verify | `examples/license-demo/verify.mjs` | Fetches the public keyring (`GET /v1/products/:id/keyring`) once, then **verifies offline**: good → `code 0` + `pro` unlocked + `seats`=5; tampered → `BadSignature(5)`; expired → `Expired(6)`. |

Expected final line: `✅ Licensing works end to end…` (exit 0 — the demo is self-checking).

## Embedding the verifier in your own app

`verify.mjs` is the reference. In any Node/browser/native app you: fetch the product keyring once,
`new Keyring()` + `keyring.add(kid, publicKeyBytes)` for each key, then
`verify(keyring, token, nowUnix)` and gate on `result.code === 0 && result.has("<entitlement>")`.
The WASM package lives at `src/bindings/wasm/pkg/`; C-ABI, and UniFFI (Python/Kotlin/Swift) bindings are
under `src/bindings/` with the same reason codes. The keyring's `x` values are **base64url (unpadded)**
Ed25519 public keys — decode to 32 raw bytes before `add()`.

## Caveats (dev-only)

- The custodian shares are bundled in one file (`secrets/custodian_shares`) — fine for a local demo, but
  it defeats k-of-n. A real deployment distributes shares to **separate custodians/hosts**.
- Don't regenerate `secrets/custodian_shares` after a signing key is provisioned — the key is
  envelope-encrypted under that master and would be orphaned (`gen-custody.ts` guards against overwrite).
- `secrets/`, `examples/license-demo/.out/`, and printed API keys are dev secrets — keep them out of git.
