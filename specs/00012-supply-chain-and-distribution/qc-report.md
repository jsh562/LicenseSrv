# QC Report — E011 Supply Chain and Distribution

**Feature**: `00012-supply-chain-and-distribution` | **Epic**: E011 | **Date**: 2026-07-17
**Verdict**: **PASS** (MVP + in-scope P2 delivered; OBJ5 Helm intentionally deferred per plan)

## Scope audited

Operational epic — a CI/CD supply-chain release **pipeline** + signed **distribution** over the EXISTING E006 container image. No application code, schema, API, or migration. The audited "source" is the pipeline + distribution config + operator runbooks:

- `.github/workflows/release.yml` — the `v*`-tag release pipeline (6 jobs).
- `Dockerfile` — base image digest-pinned (OR-006).
- 8 existing `.github/workflows/*.yml` — third-party actions SHA-pinned (OR-006).
- `dist-bundles/docker-compose.release.yml` — digest-pinned self-host bundle (OR-007).
- `docs/release/{verify,air-gap-install,failed-release,signing-identity-rotation}.md` — RR-001..004; README links.

## Method

Two QC sub-agents were delegated (per the implement-qc-loop workflow), plus main-agent local validation:

- **QC Auditor** (`sddp-qc-auditor`) — executed local validation tooling: YAML parse (PyYAML), the shipped `preflight-pins` pin-check logic run verbatim against the real repo, `docker compose config` render of the bundle, change-scope diff, and internal-consistency analysis of the job graph.
- **Story Verifier** (`sddp-story-verifier`) — traced every OBJ / OR / RR / SC in `spec.md` to its implementing file.

## Results

### Local validation (main agent + QC Auditor) — all PASS
| Check | Result | Evidence |
|-------|--------|----------|
| YAML parse (9 workflows + compose bundle) | PASS | all parse via `yaml.safe_load_all` |
| Pin-check (preflight logic, real repo) | PASS | every third-party `uses:` is 40-hex SHA-pinned or a documented exception; Dockerfile base `@sha256:<64hex>` both stages |
| Compose bundle render | PASS | `docker compose config --quiet` exit 0; digest-pinned, no `build:` |
| No app source touched | PASS | zero changes under `src/`, `migrations/`, `package.json`, `Cargo.*` |
| Internal consistency (needs-graph, digest discipline, fail-closed order) | PASS | 6 jobs, no dangling `needs`; downstream refs use the PUSHED digest; scan gate precedes push |
| project-instructions signals (dual scanners, keyless, Principle I) | PASS | Trivy + Grype both present; no signing-key secret (only ephemeral `GITHUB_TOKEN`); pipeline signs the SOFTWARE image, never license keys |

### Story verification (Story Verifier) — PASS-WITH-DEFERRALS
- **OBJ1** (signed, scanned, multi-arch image + SBOM + provenance) — **SATISFIED** (P1).
- **OBJ2** (operator verify before deploy) — **SATISFIED** (P1).
- **OBJ3** (signed docker-compose self-host bundle) — **SATISFIED** (P1).
- **OBJ4** (offline air-gap bundle) — **SATISFIED** (in-scope P2 / epic acceptance).
- **OBJ5** (signed Helm chart, OR-011, SC-008) — **DEFERRED** intentionally (P2, non-MVP; tasks T024–T026 `[DEFERRED]`; no `charts/`). Not a failure.
- Coverage: all 11 in-scope ORs (OR-001..010, OR-012), all 4 RRs, and 9/10 SCs satisfied; the only unmet SC (SC-008) and OR (OR-011) are the deferred Helm chart.
- **MVP gate (OBJ1+OBJ2+OBJ3 P1) MET**; OBJ4 (in-scope P2) satisfied.

## Defect found and remediated

- **HIGH (release-blocking) — image reference not lowercased.** `release.yml` set `IMAGE_NAME: ${{ github.repository }}` and never lowercased it; GHCR/OCI reject uppercase repository paths, and this repo is `jsh562/LicenseSrv`. Every container-ref step (push, SBOM, sign, self-verify, compose inject, provenance) would have failed. Locally proven (`docker build -t ghcr.io/jsh562/LicenseSrv…` → "repository name must be lowercase"; lowercase form succeeds).
  **Fix**: removed `env.IMAGE_NAME`; added a `meta` step deriving `image=${REGISTRY}/${GITHUB_REPOSITORY,,}` and threaded `steps.meta.outputs.image` through all container refs. The case-sensitive OIDC `--certificate-identity-regexp` intentionally still uses raw `${GITHUB_REPOSITORY}`. **Re-verified PASS** by the QC Auditor.

## Follow-ups applied during QC (from Story Verifier findings)

- **T027 provenance self-verify** — added a `verify-release` job (`needs: [release, provenance]`) running `cosign verify` (signature) + `slsa-verifier verify-image` (SLSA provenance) against the published digest/identity. The in-job `self-verify` step still gates BUNDLE publishing on the signature; provenance can only be verified in the second tier because the `provenance` job generates it downstream. Closes T027's "cosign + slsa-verifier the OWN output" claim.
- **Stale pin TODOs** — removed the `# TODO: pin to SHA (DOD)` comments from `server-ci.yml` (the refs were already SHA-pinned).
- **Air-gap smoke scope (T028)** — documented honestly in tasks.md Delivery Notes: the `airgap-smoke` job proves the critical no-pull load+serve; the offline `cosign verify --offline` is authored (`cosign save`) + documented (`air-gap-install.md`) and is CI/environment-gated.

## Accepted non-blocking findings

- **MEDIUM — `.claude/settings.json` modified**: a harness/user permission-config grant (WebFetch allow-domains for `api.github.com`/`hub.docker.com`, used to resolve action SHAs / the base-image digest during implementation). Not an E011 deliverable; a user permission file is not reverted. Out-of-surface note.
- **LOW — `postgres:16-alpine` tag-pinned in the compose bundle**: matches the E006 base compose; outside OR-006's scope (CI actions + release base image). Accepted.
- **INFO** — `COSIGN_EXPERIMENTAL=1` is a no-op on cosign v2 (harmless); the literal `.` in the cert-identity regexp is slightly permissive (no practical exposure).

## Validation reality (honesty note)

A true end-to-end **signed** release runs ONLY in GitHub CI on a real `v*` tag with GHCR + GitHub OIDC (keyless Fulcio/Rekor). The following are **CI-gated** and were NOT executed locally (expected, and documented in `tasks.md` "Validation reality" + `.completed`): the multi-arch buildx build, real Trivy/Grype CVE findings, the skopeo push to GHCR, `cosign sign`/`attest`, the in-job `self-verify`, SLSA L3 provenance generation, the `verify-release` `cosign verify` + `slsa-verifier`, and the air-gap load smoke. Local validation covered authoring correctness, YAML, pin-check logic, and compose render.

## Conclusion

**PASS** for the delivered scope (OBJ1–OBJ4). OBJ5 (Helm chart) is an intentional, documented P2 deferral. No blocking defects remain; the one HIGH defect is fixed and re-verified. `.qc-passed` recorded.
