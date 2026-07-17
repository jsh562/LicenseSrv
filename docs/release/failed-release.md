# Runbook: a release failed — diagnose, remediate, re-tag

**RR-003 · OR-002/OR-009.** The release pipeline is **fail-closed and ordered so that nothing unsigned or unscanned
is ever published.** A failure at any gate stops the run before it reaches the publish/sign/bundle steps. Your job is
to find which gate failed, fix the root cause, and cut a **new** tag — never to force a partial or unsigned artifact out.

## Invariant: no partial publish

The job graph is `preflight-pins → deps-scan → build → scan(Trivy+Grype) → push → sign → attest → self-verify →
provenance → bundles → release`. A partial multi-arch build, a scan finding, or a self-verify mismatch fails the run
**before** `sign`/`release`. There is intentionally **no path** that publishes an image, bundle, or GitHub release
from a failed run. Do not add `continue-on-error`, do not manually `docker push`, do not hand-sign.

---

## 1. Identify the failed gate

Open the failed run in **Actions → release**. Map the failing job/step to a cause:

| Failing gate | What it means | Where to look |
|--------------|---------------|---------------|
| `preflight-pins` | An action ref or the Dockerfile base image is not pinned by SHA/digest | The `::error::` line naming the unpinned `uses:` or base image |
| `deps-scan` (npm/cargo audit) | A HIGH/CRITICAL dependency vulnerability | `npm audit` / `cargo audit` output |
| `build` | Multi-arch build failed (or only one arch built) | buildx logs; confirm both `linux/amd64` + `linux/arm64` |
| Trivy / Grype scan | HIGH/CRITICAL **fix-available** OS/app vuln in the image | The scanner's finding table (package + fixed version) |
| `cosign sign` / `attest` | OIDC/keyless signing failed | Confirm `id-token: write` perm + the OIDC token was issued |
| `self-verify` | The signature/identity we just produced does not verify | Identity regexp vs the actual cert identity |
| `provenance` (SLSA) | Provenance generation/verify failed | slsa-github-generator job logs |

---

## 2. Remediate by cause

- **Pin failure** — SHA-pin the offending action (`uses: org/action@<40-hex-sha> # vX`) or digest-pin the base image
  (`FROM node:22-slim@sha256:<digest>`). Commit to `main`. (The two documented exceptions — the SLSA reusable
  workflow pinned by tag, and `dtolnay/rust-toolchain@<channel>` — are allow-listed in the preflight by design.)
- **Dependency vuln (`deps-scan`)** — bump the offending package to the fixed version (`npm audit fix` / update
  `Cargo.lock`), or, only with a written risk acceptance, add a scoped, expiring ignore. Commit to `main`.
- **Image vuln (Trivy/Grype)** — the gate fires only on **fix-available** HIGH/CRITICAL. Update the base image
  digest (Dependabot normally does this) or the app dependency that pulls in the vuln, then commit. Perpetual
  base-OS noise without a fix is already excluded (`ignore-unfixed` / `only-fixed`).
- **Build failure** — reproduce locally: `docker buildx build --platform linux/amd64,linux/arm64 .`. Fix the
  Dockerfile/source; both arches must build or the release fails (no single-arch fallback).
- **Signing / self-verify / provenance** — usually a permissions or identity drift, not a code bug. Confirm the
  workflow's `permissions:` block still grants `id-token: write` (+ `packages: write`, `contents: write`) and that
  the `--certificate-identity-regexp` in the self-verify/`verify.md` still matches
  `…/release.yml@refs/tags/v.*`. If the signer identity legitimately changed, follow
  [signing-identity-rotation.md](signing-identity-rotation.md).

---

## 3. Re-release with a new tag

Never reuse or move a tag — a moved tag breaks digest/identity expectations and transparency-log continuity.

1. Land the fix on `main` (via PR + the normal CI gates).
2. Cut a **new** semver tag:

   ```bash
   git tag v<next>        # e.g. v1.2.1 — a fresh version, not a re-point of the failed tag
   git push origin v<next>
   ```

3. Watch the `release` run go green through `self-verify`.
4. Confirm the published artifacts verify per [verify.md](verify.md) before announcing the release.

## 4. If a bad tag was already pushed (but the run failed)

Because the run failed before publish, there is no image/release to retract — only the dangling tag. Delete it to
avoid confusion, then re-tag as above:

```bash
git push origin :refs/tags/v<bad>     # delete the remote tag
git tag -d v<bad>                     # delete it locally
```

If — contrary to the invariant — you find any published image or GitHub release from a failed run, treat it as an
incident: delete the GHCR image/release, rotate anything that could have leaked, and open a postmortem.
