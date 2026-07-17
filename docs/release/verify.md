# Verify a LicenseSrv release before you deploy it

**RR-001 · OR-008 · OR-009.** Every LicenseSrv release image is **keyless-signed** with [cosign](https://docs.sigstore.dev/)
(Sigstore) and carries **SLSA Build L3 provenance**. There is **no long-lived signing key** — the signature is
bound to the GitHub Actions workflow identity that built it, recorded in the public Rekor transparency log and
backed by a short-lived Fulcio certificate.

**Verification is fail-closed: if any check below does not pass, do NOT deploy the artifact.** A failure means the
image, bundle, or provenance was not produced by this project's release pipeline — treat it as compromised.

---

## The identity you are pinning against

| Field | Value |
|-------|-------|
| Signer identity (certificate identity) | `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/<tag>` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |
| Registry | `ghcr.io/<owner>/<repo>` |
| Image reference | always by digest — `ghcr.io/<owner>/<repo>@sha256:<digest>` |

Replace `<owner>/<repo>` with this repository's `owner/name` and `<tag>` with the release tag (e.g. `v1.2.0`).
This identity is **stable across releases** except the tag suffix; pin it exactly. If it ever changes, that is a
signing-identity rotation — see [signing-identity-rotation.md](signing-identity-rotation.md) before trusting the new one.

Prerequisites: [`cosign`](https://github.com/sigstore/cosign) ≥ 2.2 and
[`slsa-verifier`](https://github.com/slsa-framework/slsa-verifier) ≥ 2.5.

---

## 1. Verify the image signature (OR-008)

```bash
IMAGE=ghcr.io/<owner>/<repo>@sha256:<digest>

cosign verify \
  --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$IMAGE"
```

A pass prints the verified signature payload (identity + Rekor log index). Any output other than a clean pass —
`no matching signatures`, an identity mismatch, an expired/absent certificate — is a **hard failure: do not deploy**.

Always reference the image **by digest**, never by a floating tag. A tag can be re-pointed; the digest is the content.

## 2. Verify SLSA build provenance (OR-008)

```bash
slsa-verifier verify-image "ghcr.io/<owner>/<repo>@sha256:<digest>" \
  --source-uri "github.com/<owner>/<repo>" \
  --source-tag "<tag>"
```

This proves the image was built by this repository's release workflow on the named tag (SLSA Build L3 — isolated,
non-falsifiable builder). A missing, malformed, or non-matching provenance is a **hard failure: do not deploy**.

## 3. Verify the SBOM attestation (optional, recommended)

The CycloneDX and SPDX SBOMs are attached to the GitHub release AND bound to the image as signed attestations:

```bash
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "ghcr.io/<owner>/<repo>@sha256:<digest>"
```

## 4. Verify a distribution bundle (compose / air-gap) — OR-008

The signed `docker-compose` bundle and the offline air-gap bundle each ship with a detached cosign **blob**
signature (`<bundle>.tgz.cosign.bundle`). Verify the bundle BEFORE extracting or applying it:

```bash
cosign verify-blob \
  --bundle licensesrv-compose-<tag>.tgz.cosign.bundle \
  --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*$" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  licensesrv-compose-<tag>.tgz
```

The same command verifies `licensesrv-airgap-<tag>.tgz` against its `.cosign.bundle`. Only after a clean pass should
you `tar xzf` and `docker compose up`. Inside the bundle, the compose file pins the image by digest — do not edit it
to a floating tag.

---

## Fail-closed summary (RR-001)

| Symptom | Meaning | Action |
|---------|---------|--------|
| `cosign verify` → `no matching signatures` | Not signed by this pipeline (or tampered) | **Do not deploy.** |
| Certificate identity ≠ the pinned identity | Wrong/forged signer, or an unannounced rotation | **Do not deploy.** Check [rotation runbook](signing-identity-rotation.md). |
| `slsa-verifier` fails or provenance absent | Build origin unproven | **Do not deploy.** |
| `verify-blob` fails on a bundle | Bundle tampered in transit | **Do not deploy.** Re-download; if it still fails, report it. |
| Digest in the compose/air-gap file ≠ the verified digest | Bundle points at an unsigned image | **Do not deploy.** |

When verification passes on all applicable checks, the artifact is authentic and you may proceed:
compose self-host → [docker-compose bundle](../../dist-bundles/docker-compose.release.yml);
offline install → [air-gap-install.md](air-gap-install.md).
