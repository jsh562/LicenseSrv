# Research: Supply Chain and Distribution (E011)

> Operational-spec grounding for the CI release pipeline + signed self-host distribution. Sources: the project
> DOD (`specs/dod.md` — Supply Chain Security, Deployment, DDR-001/DDR-002) and industry supply-chain practice.
> This epic is `lightweight` — the DOD already fixes the tool choices; captured here for the plan phase.

## 1. Multi-arch image build
- **Decision**: `docker buildx` producing ONE multi-arch image (`linux/amd64` + `linux/arm64`), slim multi-stage
  / distroless, bundling the Node/TS server + the prebuilt Rust verifier-core bindings — the SAME E006 image.
- **Avoid**: QEMU emulation for the whole build (slow/costly) — prefer native cross-compile; batch the heavy
  scan/SBOM/sign steps at release, not per commit.
- **Sources**: dod.md §Deployment (L35-36), §Cost (native cross-compile L205); docker buildx docs.

## 2. Vulnerability scanning (gate)
- **Decision**: scan dependencies AND the built image at release; FAIL the release on unresolved high/critical
  findings (fail-closed). Trivy or Grype (image + fs scan).
- **Avoid**: publishing an image before the scan passes; scanning only deps but not the image.
- **Sources**: dod.md §Supply Chain; the repo's existing `npm audit --omit=dev --audit-level=high` CI gate.

## 3. SBOM
- **Decision**: Syft per release — CycloneDX (security) + SPDX (license/NTIA); attach to the GitHub release AND
  as a cosign attestation on the image.
- **Avoid**: a single-format SBOM; an SBOM not tied to the exact published digest.
- **Sources**: dod.md §Supply Chain (SBOM generation L166).

## 4. Signing + provenance
- **Decision**: cosign **keyless** (OIDC via GitHub Actions → Fulcio cert + Rekor transparency log) to sign the
  image + bundles; SLSA build provenance (target Build L3 via a hosted isolated builder). No long-lived key in
  the build. Operators verify with `cosign verify` / `slsa-verifier` against the pipeline's published identity.
- **Avoid**: a long-lived signing key stored in CI secrets; unpinned/unverifiable identities.
- **Sources**: dod.md §Supply Chain (L168), §Secrets (keyless L65); SLSA framework.

## 5. Distribution & pinning
- **Decision**: distribute a **signed `docker-compose` bundle** (Crawl) + optional **signed Helm chart** (Walk)
  + an **offline air-gap bundle** (`docker save` / OCI layout + SBOM + signatures for a private registry
  mirror, installs with NO outbound internet). Pin ALL deps + CI actions by digest (reproducible, tamper-
  resistant). Ship a `cosign verify` verification quickstart with each release.
- **Avoid**: floating action/dep tags; an air-gap bundle missing the SBOM/signatures; distribution that assumes
  cloud/registry reachability on the self-host side.
- **Sources**: dod.md §Deployment (L36), DDR-001 (L210-214), §Maturity (Crawl/Walk L197-198), §Docs (L191).
