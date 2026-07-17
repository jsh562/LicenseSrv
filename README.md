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

### Health probes

| Probe | Path | Meaning |
|-------|------|---------|
| Liveness | `/internal/health/live` | process is alive (restart if failing) |
| Readiness | `/internal/health/ready` | can serve traffic — DB + composed signer (withhold traffic if failing, do not restart) |
| Startup | `/internal/health/startup` | initial boot completed |

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

## Development

```sh
npm ci
npm run typecheck && npm run lint
npm run test:cov          # unit + Testcontainers integration, with the coverage gate
npm run build             # tsc -> dist/
DOCKER_SMOKE=1 npm run test:docker   # image build + compose acceptance smoke (needs Docker)
```

Runbooks for operations live in [docs/runbooks/](docs/runbooks/).
