# Research — E006 Containerized Runtime and Config

Lightweight pass (epic pipeline hint: `lightweight`, `skip_checklist`). Baseline drawn from the Technical
Context Document (`specs/sad.md` ADR-0006, deployment view) and `specs/dod.md` (DDR-004, DDR-005), which
already fix the operational patterns. Only high-impact, uncovered choices are recorded here.

## Multi-stage Node image
- **Decision**: `node:22-slim` multi-stage — build stage runs `tsc`, final stage copies `dist/` + production
  `node_modules` + `migrations/`, runs as a non-root user. No dev deps or toolchain in the final layer.
- **Why**: small attack surface + fast pulls; glibc base keeps `pg` simple. Distroless deferred (harder
  self-host debugging). Aligns with DOD "slim multi-stage/distroless" cost lever.
- **Sources**: Docker multi-stage build guide; Node.js Docker best-practices.

## 12-factor config + file-mounted secrets
- **Decision**: single Zod-validated `loadConfig()` at boot; secrets via `<VAR>_FILE` (read file, trim
  trailing newline, empty = missing). Fail-fast (non-zero exit) on missing/invalid required settings.
- **Why**: one source of truth; DDR-005 cloud-agnostic secrets; keeps secrets out of image layers and
  `docker inspect`. The `<VAR>_FILE` pattern is the de-facto convention (Postgres/Docker official images).
- **Sources**: 12-factor config; Docker secrets / `_FILE` convention.

## Gated migrations
- **Decision**: run the existing advisory-locked, version-gated, idempotent `runMigrations` as a separate
  image command (`node dist/server/db/migrate.js`); app boot never migrates. Compose orders migrate before
  serve via `depends_on: service_completed_successfully`.
- **Why**: DDR-004 — expand/contract + gated job keeps digest-pinned rollback safe; avoids replica races.
- **Sources**: DDR-004; Compose `depends_on` conditions.

## Health probe semantics
- **Decision**: separate `/internal/health/{live,ready,startup}`. Liveness is dependency-independent;
  readiness runs `SELECT 1` and composes the E004 signer readiness; startup flips ready after `listen`.
- **Why**: ADR-0006 — readiness (not liveness) fails on DB/KMS degradation so orchestrators hold traffic
  without restarting a healthy process. Wrong coupling causes restart storms on transient DB blips.
- **Sources**: Kubernetes liveness/readiness/startup probe guidance; ADR-0006.

## Graceful shutdown (P2)
- **Decision**: on SIGTERM, stop accepting, `app.close()`, `pool.end()` within a bounded window (default 10s).
- **Why**: clean readiness-gated rolling restarts; no dropped in-flight requests.
- **Sources**: Fastify graceful-close docs.
