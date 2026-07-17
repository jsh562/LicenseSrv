---
description: "Task list for feature implementation: Supply Chain and Distribution (E011)"
---

# Tasks: Supply Chain and Distribution

**Feature**: `00012-supply-chain-and-distribution` | **Epic**: E011 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00012-supply-chain-and-distribution/` (spec.md, plan.md, research.md). No data-model.md / contracts/ (no schema or API surface); no checklists (epic is lightweight / skip_checklist).

**Tests**: The plan's Testing Strategy is CI-side verification, not unit tests — a post-sign self-verify job (cosign verify / slsa-verifier of the pipeline's OWN output), the dual-scanner fail-closed gate, an air-gap load-and-offline-verify smoke, and the existing E006 `DOCKER_SMOKE` image/compose smoke. These are enumerated as jobs inside the objective and Polish phases. Because a true end-to-end signed release only runs in CI on a real `v*` tag with GHCR + OIDC, local validation is: actionlint / YAML lint of `release.yml`, a buildx multi-arch build, local Trivy/Grype/Syft/cosign (dry / `--local`) where feasible, `docker compose config` render of the bundle, and `helm lint` / `helm template` of the chart; the live signed publish is CI-gated.

**Organization**: Grouped by operational objective (`OBJ#`). OBJ1–OBJ3 are P1 (MVP); OBJ4 (offline air-gap bundle) is IN-SCOPE P2 — an epic acceptance criterion (DOD "Walk" / DDR-001), NOT deferred; OBJ5 (Helm chart) is the deferrable P2. Every task edits CI/pipeline config, a distribution bundle, or a runbook — there is NO application code, schema, or API surface.

## Project Mode

`Brownfield` — E011 is a supply-chain PIPELINE + signed DISTRIBUTION over the EXISTING E006 image. **No new application code, no schema, no API, no migration.** The one substantive new file is `.github/workflows/release.yml` (the `v*`-tag release job graph: build → scan → SBOM → sign → publish → bundle → self-verify); plus the signed compose bundle (`dist-bundles/docker-compose.release.yml`), an optional signed Helm chart (`charts/licensesrv/`, P2 deferred), and four operator runbooks under `docs/release/`. Seam edits pin the existing eight `.github/workflows/*.yml` third-party actions by SHA and digest-pin the `Dockerfile` base image (OR-006). The image content is UNCHANGED — E011 only builds, scans, signs, and distributes it.

## Epic / Capability Map

| Work Item | Priority | Slice | Validated by |
|-----------|----------|-------|--------------|
| OBJ1 — Signed, scanned, multi-arch release image + SBOM + provenance | P1 🎯 MVP | buildx amd64+arm64 → dual-scanner fail-closed gate → Syft SBOM → cosign keyless sign + SLSA L3 provenance → GHCR digest-pinned publish | actionlint + buildx build + local Trivy/Grype/Syft/cosign (dry); live signed publish CI-gated on a `v*` tag (SC-001/002/003/010) |
| OBJ2 — Operator artifact verification before deploy | P1 🎯 MVP | `cosign verify` / `slsa-verifier` quickstart + stable signer identity + fail-closed verify semantics | doc review + the Polish self-verify job proves verify passes / fails-closed against the published identity (SC-004/005) |
| OBJ3 — Signed docker-compose self-host bundle | P1 🎯 MVP | digest-pinned `image: ghcr…@sha256:<digest>` (replacing `build: .`) + blob signature + release attach | `docker compose config` render + verify-then-apply via the quickstart (SC-006) |
| OBJ4 — Offline air-gap distribution bundle | P2 · in-scope (epic acceptance) | OCI/`docker save` tar + SBOM + cosign sigs with Rekor proof + Fulcio chain → `cosign verify --offline` + `docker load`, no network | air-gap load smoke on a network-restricted runner (SC-007/009) |
| OBJ5 — Signed Helm chart for Kubernetes self-host | P2 · DEFERRED | digest-pinned chart, cosign-signed, verify-then-install | `helm lint` / `helm template` (SC-008) |
| Polish | — | self-verify job, air-gap load smoke, failed-release (RR-003) + rotation (RR-004) runbooks, README links | CI self-verify + smoke green; runbooks reviewed |

**MVP gate**: OBJ1 + OBJ2 + OBJ3 (all P1). OBJ4 is IN-SCOPE P2 (epic acceptance criterion — offline install must work). OBJ5 is DEFERRED P2 (its tasks carry `[DEFERRED]`). The E006 `Dockerfile` + `docker-compose.yml` + `DOCKER_SMOKE`, GitHub Actions OIDC, and GHCR are the integration seams.

## Brownfield Notes

- **Existing assets reused**: the E006 `Dockerfile` (multi-stage, non-root, `node:22-slim`) + `docker-compose.yml` (`build: .` → digest-pinned bundle) + the `DOCKER_SMOKE` image/compose smoke; the established per-workflow `npm audit --omit=dev --audit-level=high` gate (extended at release with Trivy + Grype + `cargo audit`); the `runtime.yml` workflow shape as the template for `release.yml` jobs.
- **New tag-triggered `release.yml` is SEPARATE from per-commit CI (HINT-001)**: the heavy scan / SBOM / sign steps batch at the `v*` tag ONLY; the existing eight per-commit workflows keep their lighter gates. Do NOT run signing per commit.
- **Keyless-only (HINT-002)**: the release job carries `permissions: { id-token: write, packages: write, contents: write }`; GHCR + OIDC means NO stored registry or signing key — cosign uses the ambient OIDC token (Fulcio cert + Rekor log). No long-lived key/secret in the build, logs, or any published artifact (OR-004/012).
- **Pinning seam (OR-006 / HINT-005)**: existing floating action refs (`actions/checkout@v4`, `actions/setup-node@v4`, `semgrep/semgrep`, …) across the eight `.github/workflows/*.yml` get SHA-pinned; the `Dockerfile` base image (`node:22-slim`) gets digest-pinned for the release build; a pin-check preflight flags any remaining floating ref.
- **No application change**: no `NEW-ENTITY` / `NEW-API` / `MIGRATION` / SPA. Every OBJ1–OBJ5 task touches CI YAML, a distribution bundle, or a runbook. The compose bundle only swaps `build: .` for the published digest; the image itself is byte-for-byte the E006 artifact.

---

## Phase 1: Setup (Repository / Workspace Delta)

**Supply-chain hygiene the whole pipeline rests on (OR-006): SHA-pin every third-party action and digest-pin the release base image so the build is reproducible and tamper-resistant. Distinct files → parallelizable.**

- [X] T001 [P] {OR-006} Pin all third-party GitHub Actions by full commit SHA across .github/workflows/*.yml (checkout, setup-node, semgrep, etc.)
- [X] T002 [P] {OR-006} Digest-pin the node:22-slim base image (FROM node:22-slim@sha256:<digest>) for the build + runtime stages in Dockerfile

---

## Phase 2: Foundational (Cross-Objective Blocker)

**Create the `release.yml` skeleton every objective phase appends to (trigger + keyless/publish permissions + GHCR env + empty job graph), then wire the pin-check preflight that completes OR-006. This is the only true cross-objective blocker — no schema, no new dependency.**

- [X] T003 Create the release.yml skeleton: v* tag trigger, permissions {id-token: write, packages: write, contents: write}, GHCR env + concurrency, empty job graph in .github/workflows/release.yml
- [X] T004 {OR-006} [COMPLETES OR-006] Add a pin-check preflight job (grep/ratchet): fail on any floating action ref or undigested base image in .github/workflows/release.yml after:T001,T002,T003

---

## Phase 3: OBJ1 — Signed, scanned, multi-arch release image with SBOM + provenance (Priority: P1) 🎯 MVP

**Independent test**: push a `v*` tag → CI builds a multi-arch (amd64+arm64) image, the dual-scanner gate passes (or a HIGH/CRITICAL finding fails the release and publishes NOTHING), the digest-pinned image + SBOM + cosign signature + SLSA L3 provenance land in GHCR, and no key/secret leaks into logs or assets (SC-001/002/003/010). Locally validated by actionlint + a buildx build + local Trivy/Grype/Syft/cosign dry-runs; the live signed publish is CI-gated. All tasks append jobs to the single `release.yml` graph (sequential edits, not `[P]`).

- [X] T005 [OBJ1] {OR-001} [COMPLETES OR-001] buildx multi-arch (amd64+arm64) build of the existing Dockerfile → one OCI manifest for scanning, no push in .github/workflows/release.yml after:T003
- [X] T006 [OBJ1] {OR-002} [COMPLETES OR-002] Dual-scanner gate (Trivy + Grype image+fs + npm audit + cargo audit); fail-closed HIGH/CRITICAL publishes nothing in .github/workflows/release.yml
- [X] T007 [OBJ1] {OR-005} Push the scanned multi-arch image to GHCR digest-pinned; capture the sha256 digest for downstream jobs in .github/workflows/release.yml
- [X] T008 [OBJ1] {OR-003} Generate the Syft SBOM (CycloneDX + SPDX) for the release image + upload as release assets in .github/workflows/release.yml
- [X] T009 [OBJ1] {OR-004} cosign keyless sign the published digest (GitHub OIDC → Fulcio cert + Rekor log; no long-lived key) in .github/workflows/release.yml after:T007
- [X] T010 [OBJ1] {OR-003} [COMPLETES OR-003] cosign SBOM attestation (CycloneDX + SPDX) bound to the image digest in .github/workflows/release.yml after:T008
- [X] T011 [OBJ1] {OR-004} [COMPLETES OR-004] SLSA Build L3 provenance via slsa-github-generator over the published digest in .github/workflows/release.yml after:T007
- [X] T012 [OBJ1] {OR-005} [COMPLETES OR-005] Attach the SBOM + signature + provenance to the GitHub release referencing the digest-pinned image in .github/workflows/release.yml after:T010,T011
- [X] T013 [OBJ1] {OR-012} [COMPLETES OR-012] Assert keyless-only (no key/secret in the workflow) + scan build logs + published assets for leaked secrets in .github/workflows/release.yml

---

## Phase 4: OBJ2 — Operator artifact verification before deploy (Priority: P1) 🎯 MVP

**Independent test**: an operator follows the shipped quickstart, runs the documented `cosign verify` / `slsa-verifier` commands against the published signer identity, and the image + bundle signature and provenance verify; a tampered artifact / wrong identity / missing-or-invalid provenance instead FAILS with a clear error and the operator does not deploy (SC-004/005). Doc-authoring tasks are sequential edits to `verify.md`. The fail-closed behavior is proved end-to-end by the Polish self-verify job (T027).

- [X] T014 [OBJ2] {OR-008,RR-001} Author the verify quickstart: cosign verify (--certificate-identity/--oidc-issuer) + slsa-verifier + expected signer identity in docs/release/verify.md after:T009
- [X] T015 [OBJ2] {OR-008} [COMPLETES OR-008] Document the stable signer identity to pin against + verifying BOTH the image and the compose/Helm bundle sigs in docs/release/verify.md after:T014
- [X] T016 [OBJ2] {OR-009,RR-001} [COMPLETES RR-001] Document fail-closed verify: tamper / wrong identity / bad provenance → hard failure, do not deploy in docs/release/verify.md after:T015

---

## Phase 5: OBJ3 — Signed docker-compose self-host bundle (Priority: P1) 🎯 MVP

**Independent test**: a self-host operator verifies the signed compose bundle via the quickstart, then `docker compose up` runs the current release from the pinned digest (no local build) on their own infrastructure (SC-006). Locally validated by `docker compose config` render; the digest injection + blob signing run in CI at release.

- [X] T017 [P] [OBJ3] {OR-007} Author the compose bundle: pin image ghcr.io/<org>/licensesrv@sha256:<digest> (replace build: .) + E006 secret contract in dist-bundles/docker-compose.release.yml
- [X] T018 [OBJ3] {OR-007} Wire the pipeline to inject the release digest into the compose bundle, cosign-sign (blob), attach as a release asset in .github/workflows/release.yml after:T012,T017
- [X] T019 [OBJ3] {OR-007} [COMPLETES OR-007] Validate render (docker compose config) + document verify-then-apply via the quickstart in dist-bundles/docker-compose.release.yml after:T018

---

## Phase 6: OBJ4 — Offline air-gap distribution bundle (Priority: P2 · in-scope, epic acceptance criterion)

**Independent test**: on a host with NO outbound internet, the operator `docker load`s the bundle, `cosign verify --offline` passes (using the bundled Rekor inclusion proof + Fulcio chain), and `docker compose up` runs the release entirely from the bundle with no registry pull; the bundle contains the image(s) + SBOM + signatures for the release digest (SC-007/009). NOT deferred — offline install is an epic acceptance criterion. The packaging tasks append to `release.yml`; the offline-load proof is the Polish smoke (T028).

- [X] T020 [OBJ4] {OR-010} Add an air-gap packaging job: docker save / buildx OCI layout of the multi-arch image → tar in .github/workflows/release.yml after:T012
- [X] T021 [OBJ4] {OR-010} Add the SBOM + cosign sigs (Rekor proof + Fulcio chain, cosign --bundle) + compose bundle to the air-gap tar for offline verify in .github/workflows/release.yml after:T020
- [X] T022 [OBJ4] {OR-010} Attach the air-gap bundle as a release asset (bounded version matrix, digest-pinned naming) in .github/workflows/release.yml after:T021
- [X] T023 [OBJ4] {RR-002} [COMPLETES RR-002] Air-gap install runbook: docker load + cosign verify --offline + docker compose up (no registry pull) in docs/release/air-gap-install.md after:T022

---

## Phase 7: OBJ5 — Signed Helm chart for Kubernetes self-host (Priority: P2) · DEFERRED

**[DEFERRED — out of the MVP.]** A secondary self-host target (DOD "Walk"); compose (OBJ3) is the MVP self-host path. The chart pins the release image digest and is cosign-signed / verified via the same quickstart; no chart is built in the MVP. Independent test (when built): verify then `helm install` runs the current release on Kubernetes (SC-008).

- [ ] T024 [P] [OBJ5] {OR-011} [DEFERRED] Scaffold the signed Helm chart (Chart.yaml, values, deploy/service/secret templates) pinned to the release image digest in charts/licensesrv/
- [ ] T025 [OBJ5] {OR-011} [DEFERRED] Wire the pipeline to package + cosign-sign the chart (OCI), push to GHCR + attach; helm lint/template gate in .github/workflows/release.yml after:T012,T024
- [ ] T026 [OBJ5] {OR-011} [DEFERRED] [COMPLETES OR-011] Document verify-then-install (cosign verify the chart + helm install) in charts/licensesrv/README.md after:T025

---

## Phase 8: Polish & Cross-Cutting Concerns

**Close out the trust loop: the pipeline verifies its OWN signed output (fail-closed before bundles publish), the air-gap bundle is proven to load + verify offline, and the operational runbooks + README links ship. Distinct-file runbook/README tasks parallelize.**

- [X] T027 {OR-009} [COMPLETES OR-009] Self-verify job: cosign verify + slsa-verifier the OWN output vs published identity; fail before bundles publish in .github/workflows/release.yml after:T012
- [X] T028 {OR-010} [COMPLETES OR-010] Air-gap load smoke (network-restricted): docker load + cosign verify --offline + compose up + health probe, no pull in .github/workflows/release.yml after:T022
- [X] T029 [P] {RR-003} [COMPLETES RR-003] Failed-release runbook: scan-gate / signing failure → diagnose → remediate → re-tag, no partial/unsigned publish in docs/release/failed-release.md
- [X] T030 [P] {RR-004} [COMPLETES RR-004] Rotation runbook: rotate the keyless/OIDC trust root + notify operators of the new identity in docs/release/signing-identity-rotation.md
- [X] T031 [P] Link the verify quickstart + air-gap install runbook from README.md

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → OBJ1 (Phase 3) → OBJ2 (Phase 4) → OBJ3 (Phase 5) → OBJ4 (Phase 6) → OBJ5 (Phase 7, DEFERRED) → Polish (Phase 8)

- **Setup (Phase 1)** has no dependencies; T001 (SHA-pin actions) and T002 (digest-pin base image) are distinct files → `[P]`. Both feed the OR-006 pin-check preflight.
- **Foundational (Phase 2)** creates the `release.yml` skeleton (T003) that every objective phase appends to; the pin-check (T004) completes OR-006 and depends on T001/T002/T003.
- **OBJ1 (Phase 3)** builds the release job graph: build (T005, no push) → scan gate (T006) → push (T007) → SBOM (T008) → sign (T009) / provenance (T011, both after the push T007) → SBOM attestation (T010, after sign+SBOM) → attach (T012, after T010/T011) → leak-scan (T013). All edit `release.yml` → sequential (not `[P]`); adjacent order implies the edge, `after:` is added only for non-adjacent dependencies (the scan-before-push gate is the fail-closed control).
- **OBJ2 (Phase 4)** authors `verify.md` (T014→T015→T016, sequential same-file edits); T014 needs the signer identity established by the sign job (after:T009). Fail-closed verify is proved by the Polish self-verify (T027).
- **OBJ3 (Phase 5)** authors the compose template (T017, distinct file → `[P]`), then wires digest-inject + sign + attach in `release.yml` (T018, after:T012,T017) and validates render (T019, after:T018).
- **OBJ4 (Phase 6)** packages the air-gap tar in `release.yml` (T020→T021→T022, after the publish T012) and authors the install runbook (T023, after:T022). The offline-load proof is the Polish smoke (T028).
- **OBJ5 (Phase 7)** is DEFERRED (P2): scaffold the chart (T024, `[P]`), wire package+sign (T025, after:T012,T024), document verify-then-install (T026, after:T025).
- **Polish (Phase 8)** wires the self-verify job (T027, after:T012 — gates bundle publishing in the job graph) and the air-gap load smoke (T028, after:T022); the failed-release (T029), rotation (T030), and README-link (T031) tasks are distinct files → `[P]`.
- Tasks marked `[P]` run in parallel within their phase (distinct files, no intra-batch dependency). Because T003–T013, T018, T020–T022, T025, T027–T028 all edit the single `.github/workflows/release.yml`, they are sequential edits and are NOT `[P]`.
- A task with `after:T###` is never `[P]`-batched with the task it references.

## Delivery Notes

- **MVP gate**: OBJ1 + OBJ2 + OBJ3 (P1). **OBJ4 (air-gap) is IN-SCOPE P2** — an epic acceptance criterion (DOD "Walk" / DDR-001: offline install must work), so it is NOT deferred. **OBJ5 (Helm) is the deferrable P2** — its tasks carry `[DEFERRED]`; no chart ships in the MVP.
- **Validation reality**: a true end-to-end signed release only runs in CI on a real `v*` tag with GHCR + OIDC (keyless Fulcio/Rekor). Locally, tasks are validated by: actionlint / YAML lint of `release.yml`; a buildx multi-arch build; local Trivy/Grype/Syft/cosign (dry / `--local`) where feasible; `docker compose config` render of the bundle; `helm lint` / `helm template` of the chart. The live signed publish + self-verify + air-gap smoke are CI-gated on the tag.
- **Single-file job graph**: T003–T013, T018, T020–T022, T025, T027–T028 all edit `.github/workflows/release.yml`, building ONE job graph (build → scan → push → sign → attest → provenance → attach → bundles → self-verify → air-gap smoke). Enumerated per task for traceability, they land in that one file as sequential edits; only distinct-file tasks (`Dockerfile`, the existing workflows, the compose bundle, the chart, the runbooks, README) parallelize.
- **Fail-closed ordering** (spec Edge Cases / plan Error Handling): the build produces NO push; the dual-scanner gate (T006) runs before the push (T007), so a HIGH/CRITICAL finding publishes nothing (OR-002); a partial multi-arch build fails the release (no single-arch publish); the self-verify (T027) gates the bundle-publish jobs; the air-gap bundle carries the Rekor inclusion proof + Fulcio chain so `cosign verify --offline` needs no network (OR-010, HINT-004).
- **Self-verify (two tiers, T027)**: (1) an in-job `self-verify` STEP `cosign verify`s the freshly-made signature BEFORE the bundle-assembly steps, so a signature failure fails the release before OBJ3/OBJ4 bundles publish (the fail-closed gate OR-009 needs); (2) a dedicated `verify-release` JOB (`needs: [release, provenance]`) then re-verifies the PUBLISHED image's signature AND runs `slsa-verifier verify-image` on its SLSA provenance against the release identity. Provenance verification lives in the second tier because the `provenance` job (slsa-github-generator reusable) only produces the attestation downstream of `release` — so it cannot exist at the in-job step's time.
- **Air-gap smoke scope (T028)**: the `airgap-smoke` job proves the CRITICAL offline property — the bundled OCI image `docker load`s under a LOCAL tag and the stack serves `/internal/health/ready` with `--pull never` (zero registry access). The offline SIGNATURE verify (`cosign verify --offline` against the bundled `cosign save` layout) is authored in the bundle + documented in `air-gap-install.md`; exercising it live needs a local registry + staged Sigstore trust root, so that specific check is CI/environment-gated rather than run in the smoke.
- **Signer identity**: the pipeline's OIDC identity (repo + `.github/workflows/release.yml` ref) is the stable identity operators pin with `cosign verify --certificate-identity … --certificate-oidc-issuer https://token.actions.githubusercontent.com`; documented in `verify.md` (OBJ2) and rotated per RR-004 (T030).
- **Success-criteria coverage**: OBJ1 → SC-001/002/003/010; OBJ2 → SC-004/005; OBJ3 → SC-006; OBJ4 → SC-007/009; OBJ5 → SC-008.
- **No checklists** (epic lightweight / skip_checklist); **no data-model / contracts** (E011 has no schema or API surface).
