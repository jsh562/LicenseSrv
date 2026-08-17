# LicenseSrv

A multi-tenant license server: an offline-first, cryptographically-signed license verifier plus an
online control plane for issuance, activation, and administration. This repository holds the Rust
verifier core, its language bindings, and the TypeScript/Node (Fastify + PostgreSQL) License API.

## Run it with Docker (E006)

The API ships as a single container image (ADR-0006) driven entirely by environment configuration, with
file-mounted secrets and a gated migration job. The reference stack is `docker-compose.yml`.

### Quickstart

1. Create the secret files (never commit these):

   ```sh
   mkdir -p secrets
   printf '%s' 'a-long-random-password'                                              > secrets/db_password
   printf '%s' 'postgres://licensesrv:a-long-random-password@db:5432/licensesrv'     > secrets/database_url
   printf '%s' "$(openssl rand -hex 32)"                                             > secrets/api_key_secret
   ```

2. Bring up Postgres, run migrations, and start the API:

   ```sh
   docker compose up --build
   ```

   Compose ordering guarantees the API serves only **after** the database is healthy and the one-shot
   migration job has completed (migrations never run on app boot — DDR-004).

3. Check health:

   ```sh
   curl -fsS localhost:8080/internal/health/ready   # 200 once the DB (and signer, if configured) are up
   ```

### Image commands

The same image runs in two modes:

- **serve** (default): `node dist/server/main.js`
- **migrate** (gated job): `node dist/server/db/migrate.js`

### Configuration & secrets

All settings come from the environment; secrets use the `<VAR>_FILE` convention (mounted files, never
baked into the image). See [docs/config-reference.md](docs/config-reference.md) for every variable and
secret-hygiene guidance.

## Run it without Docker

The API is a plain Node process plus PostgreSQL, so it also runs natively on Windows, Linux, and macOS —
useful when you don't want the container runtime's overhead (on Windows, Docker Desktop was measured holding
~4.8 GB working set to run a ~120 MB workload).

```sh
npm ci
npm run setup:native     # creates role + database, fills in secrets, writes .env.native
npm run start:native     # builds, migrates, then serves on 127.0.0.1:8080
```

Both paths share the same `secrets/` files, so secrets are generated once. Full walkthrough, the
`db:5432` → `localhost:5432` difference, measured memory figures, and troubleshooting:
**[docs/native-setup.md](docs/native-setup.md)**.

Note that `npm test` still requires a Docker daemon — the integration suites start Postgres via
Testcontainers. The native path covers running the server, not testing it.

### Health probes

| Probe | Path | Meaning |
|-------|------|---------|
| Liveness | `/internal/health/live` | process is alive (restart if failing) |
| Readiness | `/internal/health/ready` | can serve traffic — DB + composed signer (withhold traffic if failing, do not restart) |
| Startup | `/internal/health/startup` | initial boot completed |

## Try it end-to-end

Once the stack is up (`docker compose up --build`), you can exercise the whole product locally. A
git-ignored `docker-compose.override.yml` (created during setup) exposes Postgres on host `15432` and
mounts the signer custodian shares that the demos need.

### 1. See a license verified — command line

Proves the core value proposition (issue a signed license → verify it **offline** → tampered/expired
rejected), all self-checking:

```sh
npm run demo
```

It unlocks the signer, seeds a tenant + product/plan/license, issues a real `LIC1.` token, and verifies
it offline with the WASM verifier core. Details: [examples/license-demo/README.md](examples/license-demo/README.md).

### 2. See a license gate a real app — browser demo

A mock customer product ("Acme Analytics") whose Pro dashboard **visibly unlocks/locks** based on a
license verified in the browser. Pick Valid / Tampered / Expired / paste-your-own, or issue one live:

```sh
npm run demo-app        # builds the browser WASM, snapshots the license, and serves the app
```

Then open the printed URL. Details: [examples/license-demo-app/README.md](examples/license-demo-app/README.md).

### 3. Use the admin console

Create an admin, then run the console SPA (it proxies `/admin` to the API):

```sh
# create tenant `acme` + owner admin@acme.test / password123!
DATABASE_URL="postgres://licensesrv:$(cat secrets/db_password)@localhost:15432/licensesrv" \
API_KEY_SECRET="$(cat secrets/api_key_secret)" \
  npx tsx scripts/seed-dev.ts

cd src/admin-ui && npm install && npm run dev   # open the printed URL, sign in
```

From the console you can define products/plans/entitlements, issue and manage licenses, and browse the
audit log (catalog, licensing, usage, policy, reseller, users, API keys).

## Verified releases (E011)

Tagged releases (`v*`) publish a **keyless-signed**, multi-arch image to GHCR with an SBOM and SLSA Build L3
provenance, plus signed self-host bundles. The `docker compose up --build` quickstart above builds from source;
for production, deploy the **published, signed** artifact and verify it first (verification is fail-closed — a
failed check means do not deploy):

- **Verify before you deploy** — [docs/release/verify.md](docs/release/verify.md): `cosign verify` /
  `slsa-verifier` quickstart and the exact signer identity to pin against.
- **Self-host from the signed bundle** — [dist-bundles/docker-compose.release.yml](dist-bundles/docker-compose.release.yml):
  the reference stack pinned to the release image digest (no local build).
- **Install offline / air-gapped** — [docs/release/air-gap-install.md](docs/release/air-gap-install.md):
  `docker load` + `cosign verify --offline` + `docker compose up`, with no registry pull.

Operator runbooks: [failed release](docs/release/failed-release.md) · [signing-identity rotation](docs/release/signing-identity-rotation.md).

## Development & testing

```sh
npm ci
npm run typecheck && npm run lint    # fast, no Docker
npm run build                        # tsc -> dist/
```

### Test suites

| Suite | Command | Docker? |
|-------|---------|---------|
| Server — unit + integration | `npm test` | **Yes** — integration tests spin up `postgres:16` per file via Testcontainers (serial; slow but thorough) |
| Server — with coverage gate | `npm run test:cov` | Yes |
| A single module (fast) | `npx vitest run src/server/modules/<mod>` | integration paths need Docker; `*.unit.test.ts` don't |
| Container image smoke | `DOCKER_SMOKE=1 npm run test:docker` | Yes — builds the image, checks non-root + no baked secrets, then `compose up` + readiness |
| Admin console (SPA) | `cd src/admin-ui && npm install && npm run test` (or `test:cov`) | No — jsdom + mocked fetch |

Everything requiring the database runs Postgres via **Testcontainers**, so a running **Docker daemon**
is required for the full server suite; the unit tests and the admin-ui tests run without it.

The two demos are **self-checking**: `npm run demo` exits non-zero if a license fails to issue or
verify, and `examples/license-demo-app` typechecks + builds in CI-style. See
[examples/license-demo/README.md](examples/license-demo/README.md) and
[examples/license-demo-app/README.md](examples/license-demo-app/README.md).

> Local dev artifacts are git-ignored: `secrets/`, `examples/**/.out/`, the generated browser WASM
> (`examples/license-demo-app/src/wasm/`), and `demo-bundle.json`.

Runbooks for operations live in [docs/runbooks/](docs/runbooks/).
