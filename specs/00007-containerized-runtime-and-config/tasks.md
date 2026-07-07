# Tasks: Containerized Runtime and Config

**Input**: Design documents from `specs/00007-containerized-runtime-and-config/`
**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `contracts/health-api.openapi.yaml`

**Tests**: Vitest tasks are included — the spec's verification criteria and the plan's Testing Strategy call for them explicitly (config unit, health/entrypoint Testcontainers integration, Docker-gated image/compose smoke).

**Organization**: Operational spec — delivery phases group by Operational Objective (`OBJ#`). The config loader and `<VAR>_FILE` secret resolver are lifted to **Foundational** because they block the entrypoint (OBJ1) and health (OBJ5) that consume them; the OBJ2/OBJ3 phases own the contract's tests, docs, and observability that complete those requirements.

## Project Mode

`Brownfield`

Extends the existing E002 modular-monolith server. No generic bootstrap; reuse `createApp`, `runMigrations`, `makePool`, the `/internal/` auth-exempt convention, and Zod.

## Epic / Capability Map

- `[OBJ1]` → Single production runtime image + real server entrypoint (serve/migrate modes) — **P1**
- `[OBJ2]` → 12-factor validated configuration contract + reference — **P1**
- `[OBJ3]` → File-mounted `<VAR>_FILE` secret injection — **P1**
- `[OBJ4]` → Gated, advisory-locked, idempotent migration job — **P1**
- `[OBJ5]` → Liveness/readiness/startup probes (readiness-gated dependencies) — **P1**
- `[OBJ6]` → Reference docker-compose stack (API + Postgres + migrate) — **P1**
- `[OBJ7]` → Graceful SIGTERM lifecycle — **P2, deferred (non-blocking)**

**MVP gate**: OBJ1 + OBJ2 + OBJ3 + OBJ4 + OBJ5 + OBJ6 (all P1), each independently testable. OBJ7 (P2) is explicitly non-blocking for the P1 gate; every OBJ7 task is tagged `[DEFERRED]` and lives in its own phase after the P1 phases.

## Brownfield Notes

- Existing flows touched: `src/server/app.ts` (`createApp`, `/internal/` auth-exempt preHandler — unchanged); `src/server/db/migrate.ts` (`runMigrations` reused as the migrate command, CLI entry already present); `src/server/db/client.ts` (`makePool`); `src/server/modules/signing/index.ts` (existing signer `ready()` composed into `/internal/health/ready`).
- Config consolidation: fold the ad-hoc `process.env` reads (`DATABASE_URL`, API-key/HMAC secret, `SIGNING_*` via `loadSigningConfig`, `ADMIN_*` via `loadAdminConfig`) into `loadConfig()`; no ambient env reads outside `src/server/config/`.
- Compatibility: no schema change; reuse `schema_migrations` and existing migration files. `tsc` already emits `dist/` (`outDir=dist`, `rootDir=src`) so runtime entry is `dist/server/main.js`, migrate is `dist/server/db/migrate.js` (HINT-001).
- Regression focus: app boot must remain migration-free; `/internal/*` stays unauthenticated; existing signing/admin behavior unchanged.

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 Add container run scripts (start = `node dist/server/main.js`, migrate:dist, DOCKER_SMOKE smoke test) to package.json
- [X] T002 [P] Exclude `__tests__` from the production build so the image ships only runtime dist/, in tsconfig.json

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**Config loader + secret resolver — blocks the entrypoint (OBJ1) and health probes (OBJ5). No work-item label.**

- [X] T003 [P] {OR-008,OR-009} readSecret: resolve `<VAR>_FILE` (read file, trim trailing newline, empty = missing) in src/server/config/secrets.ts → exports: readSecret
- [X] T004 {OR-005,OR-006,OR-017} Validated Zod AppConfig from env (fail-fast, names missing setting) + secret-free summary in src/server/config/index.ts → exports: loadConfig, AppConfig

---

## Phase 3: OBJ1 — Single runtime image + server entrypoint (Priority: P1) 🎯 MVP

- [X] T005 [P] [OBJ1] {OR-001,OR-010,OR-017} Entrypoint: loadConfig→pool→createApp→listen; secret-free startup log; no migrate-on-boot; src/server/main.ts after:T004 → exports: startServer
- [X] T006 [P] [OBJ1] {OR-002,OR-003} Multi-stage Dockerfile: build (tsc) + node:22-slim final (prod deps, dist/, migrations/), non-root USER, minimal writable, in Dockerfile
- [X] T007 [P] [OBJ1] {OR-002} Add .dockerignore (node_modules, source tests, .git, secrets, local env) in .dockerignore
- [X] T008 [OBJ1] {OR-004,OR-011} Define serve (node dist/server/main.js) + migrate (node dist/server/db/migrate.js) commands sharing one config/secret contract in Dockerfile after:T006

---

## Phase 4: OBJ2 — 12-factor configuration contract (Priority: P1) 🎯 MVP

- [X] T009 [P] [OBJ2] {OR-005,OR-006,OR-017} [COMPLETES OR-017] Config unit test: required validation, fail-fast names setting, secret-free summary in src/server/config/__tests__/config.unit.test.ts
- [X] T010 [P] [OBJ2] {OR-007} Configuration reference: every var (name, purpose, required/optional, default, secret?) in docs/config-reference.md

---

## Phase 5: OBJ3 — File-mounted secret injection (Priority: P1) 🎯 MVP

- [X] T011 [P] [OBJ3] {OR-008,OR-009} Secret-file unit tests: `<VAR>_FILE` resolution, empty=missing fail-fast, no secret in summary in src/server/config/__tests__/config.unit.test.ts after:T009
- [X] T012 [P] [OBJ3] {OR-008} Secret-mounting + hygiene guidance (never-bake, `docker inspect`, example secret-file layout) in docs/config-reference.md after:T010

---

## Phase 6: OBJ4 — Gated migration job (Priority: P1) 🎯 MVP

- [X] T013 [OBJ4] {OR-010,OR-011} Adapt migrate CLI to loadConfig + dist migrations path (HINT-001), reuse runMigrations, in src/server/db/migrate.ts after:T004
- [X] T014 [OBJ4] {OR-010} [COMPLETES OR-010] Integration: app boot changes no schema; migrate idempotent + advisory-locked in src/server/__tests__/entrypoint.integration.test.ts after:T005

---

## Phase 7: OBJ5 — Health probes with readiness-gated dependencies (Priority: P1) 🎯 MVP

- [X] T015 [OBJ5] {OR-012} registerHealth: GET /internal/health/{live,ready,startup} (auth-exempt /internal/) in src/server/health/index.ts → exports: registerHealth
- [X] T016 [OBJ5] {OR-013} Readiness = DB SELECT 1 + composed signer readiness; liveness DB-independent; startup ready after listen, in src/server/health/index.ts after:T015
- [X] T017 [OBJ5] {OR-001,OR-012} Wire registerHealth into entrypoint before listen in src/server/main.ts ← T015:registerHealth after:T005
- [X] T018 [OBJ5] {OR-012,OR-013} [COMPLETES OR-012] Int: DB down→ready 503/live 200; up→ready 200; payload status-only, no secret/tenant in src/server/health/__tests__/health.integration.test.ts after:T017

---

## Phase 8: OBJ6 — Reference docker-compose stack (Priority: P1) 🎯 MVP

- [X] T019 [OBJ6] {OR-014} docker-compose stack: api + postgres 16.4+ + one-shot migrate; healthchecks (pg_isready, /internal/health/ready) in docker-compose.yml after:T006
- [X] T020 [OBJ6] {OR-015} Startup ordering: app depends_on migrate service_completed_successfully + db service_healthy (HINT-004) in docker-compose.yml after:T019
- [X] T021 [P] [OBJ6] {OR-014} .env.example + secret-file layout (documented, no real secrets) in .env.example
- [X] T022 [OBJ6] {OR-008,OR-014} [COMPLETES OR-008,OR-014] Smoke (DOCKER_SMOKE): non-root, no secret in image, compose healthy in src/server/__tests__/image.smoke.integration.test.ts after:T008 [CI-gated: image build blocked locally by sandbox npm egress; runs in runtime.yml]

---

## Phase 9: OBJ7 — Graceful lifecycle (Priority: P2, non-blocking)

**Non-blocking for the P1 MVP gate.** The MVP deploys and passes health checks without it; these tasks are `[DEFERRED]` and layer onto the entrypoint (T005).

- [ ] T023 [OBJ7] {OR-016} [DEFERRED] SIGTERM/SIGINT: stop accepting, app.close(), pool.end() within bounded window (default 10s) in src/server/main.ts after:T005
- [ ] T024 [OBJ7] {OR-016} [DEFERRED] Integration: in-flight request drains + clean exit within window on SIGTERM in src/server/__tests__/shutdown.integration.test.ts after:T023

---

## Phase 10: Documentation & Runbooks

- [X] T025 [P] {RR-001} Stuck/contended migration runbook (clear held advisory lock, resume after failed migration) in docs/runbooks/stuck-migration.md
- [X] T026 [P] {RR-002} Readiness-failure + config/secret fail-fast runbook (DB-unreachable readiness; missing config/secret) in docs/runbooks/readiness-and-config-failures.md

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T027 [P] Enforce ≥80% line+branch coverage for new config/health/entrypoint modules (thresholds/include) in vitest.config.ts
- [X] T028 CI runtime workflow: config/health/entrypoint + DOCKER_SMOKE image/compose + npm audit --omit=dev --audit-level=high + semgrep + coverage gate in .github/workflows/runtime.yml after:T022
- [X] T029 [P] Container run + docker compose quickstart (serve/migrate modes, secret-file mounting) in README.md

---

## Dependencies

Setup → Foundational → OBJ1 → OBJ2 → OBJ3 → OBJ4 → OBJ5 → OBJ6 → (OBJ7 deferred) → Documentation & Runbooks → Polish.

- **Setup (T001–T002)** has no dependencies.
- **Foundational (T003–T004)**: `T004` (loadConfig) depends on `T003` (readSecret). These block every delivery phase — `loadConfig`/`AppConfig` are consumed by the entrypoint (T005), migrate command (T013), and health readiness (T016).
- **OBJ1 (T005–T008)**: `T005` needs `T004`; `T008` extends the Dockerfile from `T006`. `T005`/`T006`/`T007` are independent (`[P]`).
- **OBJ2 (T009–T010)**: verify + document the foundational config; independent of each other (`[P]`).
- **OBJ3 (T011–T012)**: `T011` appends secret-file cases to the config test created in `T009` (`after:T009`, not `[P]` with it); `T012` extends the reference from `T010` (`after:T010`).
- **OBJ4 (T013–T014)**: `T013` reuses `runMigrations` under the config contract; `T014` proves app boot performs no schema change and migrate is idempotent + advisory-locked (`after:T005`).
- **OBJ5 (T015–T018)**: `T016` extends `T015`; `T017` wires `registerHealth` (from `T015`) into the entrypoint (`T005`); `T018` polls the running probes (`after:T017`).
- **OBJ6 (T019–T022)**: `T020` orders services in the compose file from `T019`; `T022` is the Docker-gated acceptance smoke needing the image commands (`after:T008`), compose ordering, and `.env.example`.
- **OBJ7 (T023–T024, DEFERRED)**: layer onto the entrypoint (`after:T005`); non-blocking for the P1 gate.
- **Documentation & Runbooks (T025–T026)**: independent (`[P]`).
- **Polish (T027–T029)**: `T028` needs the smoke suite (`after:T022`) and the coverage gate (`T027`); `T027`/`T029` are independent (`[P]`).
- Tasks marked `[P]` can run in parallel within their phase. A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the referenced task.
