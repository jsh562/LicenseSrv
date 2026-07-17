---
feature_branch: "00012-supply-chain-and-distribution"
created: "2026-07-16"
input: "e011"
spec_type: "operational"
spec_maturity: "draft"
epic_id: "E011"
epic_sources: "{DOD:DDR-1, DDR-2}"
---

# Feature Specification: Supply Chain and Distribution

**Feature Branch**: `00012-supply-chain-and-distribution`
**Created**: 2026-07-16
**Status**: Draft
**Spec Type**: operational
**Spec Maturity**: draft
**Epic ID**: E011
**Epic Sources**: {DOD:DDR-1, DDR-2}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

LicenseSrv ships as a self-host-first, cloud-agnostic container image, but there is no release pipeline that
turns a tagged commit into a trustworthy, distributable artifact. Without one, a self-host or air-gapped
operator has no way to obtain a signed, scanned, provenance-attested image, cannot verify it came from us and
wasn't tampered with before deploying it into a security-sensitive environment, and cannot install it where
there is no outbound internet. This feature builds the CI supply chain — multi-arch build, dependency/image
scanning, SBOM, keyless image + provenance signing — and the signed self-host distribution (compose bundle,
optional Helm chart, offline air-gap bundle) with operator verification instructions.

## Scope *(mandatory)*

### Included

- A release pipeline, triggered by a semver git tag, that builds ONE multi-arch (`linux/amd64` + `linux/arm64`)
  image — the E006 image — scans dependencies and the image, generates an SBOM, and signs the image + build
  provenance with keyless (OIDC) signing.
- Publishing the signed, digest-pinned image + SBOM + signature + provenance to the container registry.
- A signed `docker-compose` self-host bundle the operator applies, and an optional signed Helm chart.
- An offline air-gap bundle (image(s) + SBOM + signatures) that installs with no outbound internet.
- Operator verification instructions + runbooks (verify signature/provenance before deploy; install the
  air-gap bundle; respond to a failed release; rotate the signing identity).
- Supply-chain hygiene: digest-pinned dependencies and CI actions; no long-lived signing key in the build.

### Excluded

- Managed-SaaS deployment / GitOps / CD-to-staging orchestration (the DOD's "Walk"/"Run" managed path) — this
  epic delivers the release artifacts and self-host distribution, not the managed rollout.
- Terraform / IaC modules — deferred to the managed-SaaS build (DOD §Infrastructure).
- The offline license-ACTIVATION flow (E010) — that activates licenses; this epic distributes the SOFTWARE.
  They both serve air-gapped operators but are distinct concerns.
- Edge/CDN fronting of keyring/CRL artifacts (DOD deferred).
- Runtime hosting/observability of a running instance (E006/E012) — this epic ends at a verifiable, installable
  artifact.

### Edge Cases & Boundaries

- The dependency or image scan finds an unresolved high/critical vulnerability → the release FAILS and no signed
  artifact is published (fail-closed).
- The keyless signing backend (OIDC / transparency log / CA) is unavailable → signing fails and the release does
  not publish an unsigned artifact; the failure is surfaced for re-run.
- An operator verifies a tampered image, a wrong signer identity, or a missing/invalid provenance → verification
  FAILS with a clear, non-ambiguous error (fail-closed verify).
- A multi-arch build partially succeeds (one arch fails) → the release does not publish a partial/single-arch
  image as the release.
- The air-gap bundle is installed with no network → it must load and run from the bundle alone (no registry
  pull), and its signature must be verifiable offline.
- A dependency or CI action is referenced by a floating tag → the pipeline must reject/flag it (pinning gate).

## Operational Objectives *(mandatory for operational specs only)*

### Objective 1 - Signed, scanned, multi-arch release image with SBOM + provenance (Priority: P1) 🎯 MVP

On a semver tag, CI builds the multi-arch image, scans dependencies and the image (failing on high/critical),
generates an SBOM, and signs the image + build provenance with keyless signing — publishing the signed,
digest-pinned image, SBOM, signature, and provenance to the registry.

**Why this priority**: The core deliverable and the trust foundation — every downstream bundle and verification
depends on a signed, scanned, provenance-attested image existing.

**Rationale**: DDR-002 / the DOD Supply Chain section: a tagged release must yield a signed multi-arch image
with an attached SBOM and provenance; scanning and pinning make the artifact tamper-resistant and auditable.

**Deliverables**:
- A release CI workflow (semver-tag-triggered) doing build → scan → SBOM → sign → publish.
- A multi-arch (`linux/amd64` + `linux/arm64`) image; a CycloneDX + SPDX SBOM; a cosign signature; SLSA build
  provenance; all attached to the published, digest-pinned image + release.
- Digest-pinned dependencies and CI actions.

**Verification Criteria**:
1. **Given** a semver git tag, **When** the release pipeline runs, **Then** it publishes a signed multi-arch
   image (amd64 + arm64) with an attached SBOM and SLSA provenance to the registry.
2. **Given** a dependency or image scan that reports an unresolved high/critical vulnerability, **When** the
   pipeline runs, **Then** the release FAILS and no signed artifact is published.
3. **Given** the pipeline definition, **When** it is inspected, **Then** all dependencies and CI actions are
   pinned by digest and no long-lived signing key is present (keyless/OIDC).

### Objective 2 - Operator artifact verification before deploy (Priority: P1) 🎯 MVP

A self-host operator can verify the release image's (and bundle's) signature and provenance against our
published signer identity BEFORE deploying, using standard tools (`cosign verify` / `slsa-verifier`), guided by
a shipped verification quickstart.

**Why this priority**: Signing has no value if operators can't (or don't know how to) verify; verification is
the acceptance criterion that lets a security-sensitive customer trust the artifact.

**Rationale**: DOD §Docs (a `cosign verify` quickstart ships with each release) + §Supply Chain (customers
verify before deploy).

**Deliverables**:
- A verification quickstart + runbook (RR-001) shipped with each release: the exact `cosign verify` /
  `slsa-verifier` commands and the expected signer identity / provenance.
- A documented, stable signer identity (the pipeline's OIDC identity) operators pin against.

**Verification Criteria**:
1. **Given** a published release image and the verification quickstart, **When** an operator runs the documented
   verify commands, **Then** the signature + provenance verify successfully against the published identity.
2. **Given** a tampered image, a wrong signer identity, or missing/invalid provenance, **When** the operator
   verifies, **Then** verification FAILS with a clear error (fail-closed) and the operator does not deploy.

### Objective 3 - Signed docker-compose self-host bundle (Priority: P1) 🎯 MVP

The release publishes a signed `docker-compose` bundle a self-host operator applies to run the current release
on their own infrastructure.

**Why this priority**: The default self-host install path (DOD "Crawl" maturity: CI + signed images + compose);
without it there is no supported way for an operator to run the release.

**Rationale**: DDR-001 — distribute the image as a signed `docker-compose` bundle for self-host.

**Deliverables**:
- A signed `docker-compose` bundle pinned to the release image digest, with the config/secret contract (E006).
- Its signature published + verifiable via the same quickstart.

**Verification Criteria**:
1. **Given** the signed compose bundle for a release, **When** a self-host operator verifies then applies it,
   **Then** the current release runs on their infrastructure.

### Objective 4 - Offline air-gap distribution bundle (Priority: P2)

The release produces an offline air-gap bundle — the image(s) (`docker save` / OCI layout), the SBOM, and the
signatures — that an operator installs into an air-gapped environment or private registry mirror with no
outbound internet.

**Why this priority**: Serves the air-gapped self-host market (DOD "Walk" maturity), but the online-registry
path (OBJ1-3) is the MVP; the offline bundle builds on it.

**Rationale**: DDR-001 + the epic constraint — the air-gap bundle includes images + SBOM + signatures and
installs without internet.

**Deliverables**:
- An offline bundle artifact (image OCI/`docker save` + SBOM + signatures + the compose bundle).
- An air-gap install runbook (RR-002).

**Verification Criteria**:
1. **Given** the air-gap bundle on a host with no outbound internet, **When** the operator installs it, **Then**
   the release loads and runs entirely from the bundle (no registry pull).
2. **Given** the air-gap bundle, **When** the operator verifies it offline, **Then** its signature + SBOM verify
   without network access.

### Objective 5 - Signed Helm chart for Kubernetes self-host (Priority: P2)

The release publishes a signed Helm chart so an operator can install the release on Kubernetes.

**Why this priority**: A secondary self-host target (DOD "Walk"); compose (OBJ3) is the MVP self-host path.

**Rationale**: DDR-001 — optional signed Helm chart alongside the compose bundle.

**Deliverables**:
- A signed Helm chart pinned to the release image digest; its signature verifiable via the quickstart.

**Verification Criteria**:
1. **Given** the signed Helm chart, **When** an operator verifies then installs it on Kubernetes, **Then** the
   current release runs.

### Operational Constraints

- Multi-arch: `linux/amd64` + `linux/arm64` (native cross-compile preferred over full-QEMU builds).
- No mandatory cloud dependency for self-host install; the air-gap path must be fully network-independent.
- Keyless (OIDC) signing only — no long-lived signing key in CI or in any published artifact.
- Heavy steps (scan / SBOM / sign) batch at release (tag), not per commit.

## Integration Points *(mandatory for technical and operational specs)*

- **IP-001**: The release pipeline builds and publishes the **E006** container image (the existing Dockerfile +
  multi-arch image + docker-compose stack + config/secret contract) — E011 packages/signs/distributes it.
- **IP-002**: Depends on the **CI platform (GitHub Actions) OIDC** + a **container registry** for keyless signing
  (Fulcio/Rekor) and artifact publishing.
- **IP-003**: Distinct from **E010** (offline license activation): E011 distributes and verifies the SOFTWARE
  artifact; E010 activates LICENSES. Both serve air-gapped operators but do not share a code path.
- **IP-004**: The signed-artifact channel MAY later carry E004 keyring/CRL artifacts (deferred; not in scope).

## Requirements *(mandatory)*

### Operational Requirements *(operational specs only)*

- **OR-001**: The system MUST provide a release pipeline, triggered by a semver git tag, that builds one
  multi-arch (`linux/amd64` + `linux/arm64`) container image (the E006 image).
- **OR-002**: The pipeline MUST scan the dependencies and the built image for known vulnerabilities and MUST
  fail the release (publishing nothing) on an unresolved high/critical finding.
- **OR-003**: The pipeline MUST generate an SBOM (CycloneDX + SPDX) for the release image and attach it to the
  release and as a signed attestation on the image.
- **OR-004**: The pipeline MUST sign the image and produce build provenance using keyless (OIDC) signing, with
  no long-lived signing key present in the build.
- **OR-005**: The pipeline MUST publish the signed, digest-pinned image together with its SBOM, signature, and
  provenance to the container registry.
- **OR-006**: The pipeline MUST pin all build dependencies and CI actions by digest (no floating tags) so the
  build is reproducible and tamper-resistant.
- **OR-007**: The release MUST include a signed `docker-compose` bundle, pinned to the release image digest,
  that a self-host operator can apply to run the release.
- **OR-008**: The release MUST publish operator verification instructions (a `cosign verify` / `slsa-verifier`
  quickstart) and a stable signer identity so an operator can verify the image and bundle signature + provenance
  before deploying.
- **OR-009**: A verification of a tampered artifact, a wrong signer identity, or a missing/invalid provenance
  MUST fail closed (a clear, unambiguous verification failure the operator can detect).
- **OR-010**: The release MUST produce an offline air-gap bundle containing the image(s), the SBOM, and the
  signatures, that installs and runs in an environment with no outbound internet (no registry pull) and whose
  signature is verifiable offline. *(P2)*
- **OR-011**: The release SHOULD publish a signed Helm chart, pinned to the release image digest, for Kubernetes
  self-host. *(P2)*
- **OR-012**: The pipeline MUST NOT embed or expose any long-lived signing key or secret in the build logs or in
  any published artifact.

### Runbook Requirements *(include for operational specs if applicable)*

- **RR-001**: A runbook MUST exist for verifying a release artifact's signature + provenance before deploy (the
  `cosign verify` / `slsa-verifier` quickstart with the expected identity).
- **RR-002**: A runbook MUST exist for installing the offline air-gap bundle into an air-gapped environment /
  private registry mirror.
- **RR-003**: A runbook MUST exist for responding to a failed release (scan-gate or signing failure) — diagnose,
  remediate, and re-run without publishing a partial/unsigned artifact.
- **RR-004**: A runbook MUST exist for rotating the release signing identity (the keyless/OIDC trust root) and
  communicating the new identity to operators.

### Key Entities *(include for product or technical specs if feature involves data)*

- **Release artifact**: the signed, digest-pinned multi-arch image plus its distribution bundles (compose,
  optional Helm, offline air-gap) for one semver release.
- **SBOM**: the CycloneDX + SPDX software bill of materials for a release image, attached to the release and as
  a signed attestation.
- **Signature / provenance**: the cosign keyless signature over the image/bundles and the SLSA build provenance
  attestation, verifiable by an operator against the published signer identity.

## Assumptions & Risks *(mandatory)*

### Assumptions

- The CI platform is GitHub Actions with OIDC, and a container registry (e.g. GHCR) is available for keyless
  cosign signing (Fulcio/Rekor) and publishing.
- The E006 image (Dockerfile + docker-compose + config/secret contract) exists and is the artifact this pipeline
  builds, signs, and distributes.
- Self-host operators can run `cosign` / `slsa-verifier` (the runbook provides install/verify steps).
- Multi-arch is `linux/amd64` + `linux/arm64`; a native cross-compile path is available to avoid full-QEMU cost.
- The release signer identity is the pipeline's OIDC identity, published for operators to pin against.

### Risks

- **Keyless-signing backend dependency** *(likelihood: low, impact: high)*: an OIDC / Fulcio / Rekor outage can
  block signing — mitigated by fail-closed (no unsigned publish) + a documented re-run runbook (RR-003).
- **Multi-arch build cost/time** *(likelihood: medium, impact: medium)*: emulated builds are slow/expensive —
  mitigated by native cross-compilation and batching scan/SBOM/sign at release.
- **Air-gap bundle size / staleness** *(likelihood: medium, impact: medium)*: large or outdated offline bundles
  strain operators — mitigated by a bounded supported-version matrix and clear digest-pinned versioning.

## Implementation Signals *(mandatory)*

- `NEW-WORKER` — a release CI pipeline (semver-tag-triggered GitHub Actions workflow) performing build → scan →
  SBOM → sign → publish → bundle.
- `NEW-CONFIG` — release/pipeline configuration: registry target, signer OIDC identity, scan severity gate,
  supported-arch matrix, digest pins.
- `EXTERNAL-SERVICE` — the container registry, the keyless-signing backend (Fulcio/Rekor via GitHub OIDC), and
  the SBOM/scan/verify tooling (Syft, Trivy/Grype, cosign, slsa-verifier).
- (No `NEW-ENTITY` / `MIGRATION` / `NEW-API` / `NEW-UI` — E011 delivers pipeline + artifacts + runbooks, no
  application code or schema.)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [OBJ1]: A semver-tagged release publishes a signed multi-arch image (amd64 + arm64) with an
  attached SBOM (CycloneDX + SPDX) and SLSA provenance to the registry.
- **SC-002** [OBJ1]: A release fails and publishes nothing when the dependency or image scan reports an
  unresolved high/critical vulnerability.
- **SC-003** [OBJ1]: The pipeline uses digest-pinned dependencies and CI actions and contains no long-lived
  signing key (keyless/OIDC).
- **SC-004** [OBJ2]: A self-host operator can verify the image + bundle signature and provenance against the
  published identity with the shipped quickstart before deploying.
- **SC-005** [OBJ2]: A tampered artifact, a wrong signer identity, or missing/invalid provenance fails
  verification with a clear error, and the release ships a verification runbook (RR-001).
- **SC-006** [OBJ3]: A self-host operator can verify and apply the signed `docker-compose` bundle to run the
  current release.
- **SC-007** [OBJ4]: An offline air-gap bundle installs and runs the release on a host with no outbound internet
  (loaded from the bundle, no registry pull), and its signature + SBOM verify offline.
- **SC-008** [OBJ5]: A signed Helm chart, verified against the published identity, installs the release on
  Kubernetes.
- **SC-009** [OBJ4]: The air-gap bundle contains the image(s), the SBOM, and the signatures for the release
  digest.
- **SC-010** [OBJ1]: No long-lived signing key or secret appears in the build logs or in any published
  artifact (OR-012).

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| SBOM | Software Bill of Materials — an inventory of the components in a release image (CycloneDX + SPDX). |
| Provenance | A signed, verifiable attestation of how/where an artifact was built (SLSA build provenance). |
| Keyless signing | cosign signing using a short-lived OIDC identity (Fulcio cert + Rekor log) — no long-lived key. |
| Multi-arch image | One image manifest serving multiple CPU architectures (`linux/amd64` + `linux/arm64`). |
| Air-gap bundle | An offline distribution (image(s) + SBOM + signatures) installable with no outbound internet. |
| Digest pin | Referencing a dependency/action/image by its immutable content digest, not a floating tag. |
| Self-host operator | A customer who runs LicenseSrv on their own infrastructure (compose / Helm / air-gap). |

## Compliance Check

**Verdict**: PASS — `project-instructions.md` v1.2.0 (Principles I–IV, Technology Stack/Infrastructure, Testing & Quality Policy) and DOD DDR-001, DDR-002, §Supply Chain Security. No CRITICAL violations.

**Notes**:
- Principle I (offline-first / signing-key custody): upheld. E011 distributes the SOFTWARE image via keyless OIDC image signing; it does NOT distribute or handle license signing keys (Excluded, IP-003 separate E010). Air-gap install and offline signature verification are network-independent (OR-010, SC-007). No contradiction with KMS/HSM/keystore custody.
- Self-host-first / cloud-agnostic: upheld — no mandatory cloud dependency for self-host install (Operational Constraints); managed-SaaS/IaC deferred (Excluded). CI OIDC + registry (IP-002) are build-time only, per DDR-002.
- One signed multi-arch image (amd64+arm64) with fail-closed partial-arch handling: OR-001, SC-001, Edge Cases. Matches DDR-001/DDR-002.
- SBOM (Syft, CycloneDX+SPDX), keyless cosign/OIDC signing, SLSA provenance, HIGH/CRITICAL scan gate (fail-closed, publish nothing), digest-pinned deps+actions: OR-002/003/004/006/012, SC-002/003/010. Matches DOD §Supply Chain Security and DDR-002.
- Air-gap bundle (image(s)+SBOM+signatures, offline install + offline verify) and operator verify-before-deploy (cosign verify / slsa-verifier, fail-closed) present: OR-008/009/010, RR-001, SC-004/005/007/009. Matches DDR-001 and DOD §Docs.
- Principles II and III: N/A — pipeline/distribution spec, no data ops and no crypto reimplementation.

**Advisory (non-blocking; resolve in plan.md)**:
1. State the SLSA target level (DOD targets Build L3 via a hosted isolated builder).
2. Enumerate language dependency audits (`npm audit`, `cargo audit`) alongside Trivy/Grype in the scan gate.
3. Align action-pinning terminology ("by digest" vs DOD "by SHA" for actions — equivalent).
4. Specify offline keyless-verify contents (bundle the Rekor inclusion proof + Fulcio cert chain; cosign `--offline`).
