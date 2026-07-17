# Install LicenseSrv on an air-gapped host (no internet)

**RR-002 · OR-010.** The offline air-gap bundle carries everything needed to run a release on a host with **no
outbound network**: the multi-arch image as an **OCI archive** (`licensesrv-image.oci.tar`), both SBOMs, a
`cosign save` layout (`cosign-bundle/`) holding the image **plus its signature and attestations with the Rekor
inclusion proof and Fulcio certificate chain embedded** (so `cosign verify --offline` needs no Sigstore network
calls), and the digest-pinned `docker-compose.yml`. Nothing is pulled from a registry.

Bundle asset: `licensesrv-airgap-<tag>.tgz` (+ its detached `licensesrv-airgap-<tag>.tgz.cosign.bundle` signature).

---

## On a networked host — download and verify the bundle

Do the trust check where you have internet, then physically transfer only the verified `.tgz`.

1. Download `licensesrv-airgap-<tag>.tgz` and `licensesrv-airgap-<tag>.tgz.cosign.bundle` from the GitHub release.
2. Verify the bundle signature (fail-closed — see [verify.md](verify.md)):

   ```bash
   cosign verify-blob \
     --bundle licensesrv-airgap-<tag>.tgz.cosign.bundle \
     --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*$" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
     licensesrv-airgap-<tag>.tgz
   ```

   If this does not pass cleanly, **stop** — do not transfer the bundle.
3. Transfer the verified `.tgz` (and, if you want to re-verify offline, `cosign` itself) to the air-gapped host via
   your approved physical media / data-diode process.

---

## On the air-gapped host — verify offline, load, and run

```bash
tar xzf licensesrv-airgap-<tag>.tgz
# contents: licensesrv-image.oci.tar, cosign-bundle/, sbom.*.json, docker-compose.yml, INSTALL.md
```

1. **Load the image + signatures into your internal/local registry** from the offline `cosign save` layout, then
   **verify OFFLINE** — the embedded Rekor proof + Fulcio chain mean no Sigstore/registry network call:

   ```bash
   REF=<internal-registry>/licensesrv@sha256:<digest>     # your on-prem/local registry, e.g. localhost:5000/...
   cosign load --dir cosign-bundle "$REF"                 # pushes image + sig + attestations locally, no internet

   cosign verify --offline \
     --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*$" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
     "$REF"
   ```

   A clean pass is required. Any failure → **do not install** (see the fail-closed table in [verify.md](verify.md)).
   If you have no local registry, verify on the networked side before transfer and rely on the signed `.tgz`
   blob signature (step 2 of the networked section) as the integrity control.

2. **Make the image runnable** — load the OCI archive into the container runtime, no registry pull:

   ```bash
   # multi-arch OCI archive → local Docker daemon (skopeo selects the host arch):
   skopeo copy oci-archive:licensesrv-image.oci.tar docker-daemon:<internal-registry>/licensesrv:<tag>
   # (single-arch hosts without skopeo can instead: docker load < a per-arch docker archive)
   ```

   The compose file pins the image by `@sha256:<digest>`; confirm the loaded digest matches the one you verified,
   and set the compose `image:` to your local reference if it differs from the GHCR path.

3. **Create the secret files** the stack expects (same contract as E006 — see the bundled `.env.example` notes):

   ```
   secrets/db_password        # the Postgres password
   secrets/database_url       # postgres://licensesrv:<db_password>@db:5432/licensesrv
   secrets/api_key_secret     # HMAC secret for API-key + email hashing
   ```

4. **Bring the stack up** — Postgres → gated migration → API, entirely from the loaded image:

   ```bash
   docker compose up -d
   docker compose ps            # api becomes healthy once /internal/health/ready returns 200
   ```

No step above contacts a registry or the internet. If your host has multiple architectures, `docker load` selects
the matching arch from the multi-arch archive automatically.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `cosign verify --offline` fails | Bundle tampered, or wrong identity/tag | Re-transfer from a re-verified download; do not install. |
| `docker load` digest ≠ compose digest | Wrong/edited compose file | Use the compose file **from inside the bundle**; do not hand-edit the image ref. |
| `migrate` container exits non-zero | Bad `database_url` secret | Fix `secrets/database_url`, then `docker compose up` again (migrate is idempotent). |
| `api` never healthy | DB not reachable / migration incomplete | `docker compose logs migrate api`; confirm the migrate job exited 0. |

Recovery from a failed or partial release (before you ever get a bundle): [failed-release.md](failed-release.md).
